/**
 * 核心代理模块 —— 移植自原项目 app/routers/docker_proxy.py。
 *
 * 工作流程（与原项目一致）：
 *   1. Docker 客户端请求 /v2/...，Worker 先按 IP 白名单 / 镜像黑白名单过滤；
 *   2. 选出延迟最低的可用节点，透明转发；
 *   3. 上游返回 401 时，解析 WWW-Authenticate，向其 realm 自动获取 Bearer token
 *      （节点配置了用户名密码则带上 Basic 认证，否则匿名），拿到后重试；
 *   4. 若最终仍为 401（如私有仓库），把响应里的 realm 重写为
 *      {当前域名}/token?_upstream_realm=<urlsafe_base64>，
 *      让客户端回到本代理的 /token 端点完成认证；
 *   5. 响应流式回传并统计下载流量；302 默认透传给客户端（可选 follow 模式）。
 */
import { parseWwwAuthenticate, encodeUpstreamRealm, decodeUpstreamRealm, extractImageName, normalizeBaseUrl, json } from './pure.js';
import { getBestProxy, fallbackNode } from './nodes.js';
import { logTraffic, logPull } from './traffic.js';

const DEFAULT_AUTH_URL = 'https://auth.docker.io/token';

/**
 * 仅限制"响应头阶段"的超时：连接挂起/上游无响应时快速失败；
 * 响应头到达后立即解除（clearTimeout），镜像层大文件流式传输不受影响。
 */
async function fetchWithHeaderTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`${timeoutMs}ms 内未收到上游响应头`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * isolate 内 token 缓存（240 秒，token 实际有效期一般 300 秒）。
 * 同一 isolate 内的重复请求可少一次 token 往返；isolate 回收后自动失效。
 */
const tokenCache = new Map();
const TOKEN_TTL_MS = 240_000;

/**
 * 向上游认证服务器获取 token（移植原 get_upstream_token）。
 * @param {string} realm          上游认证地址（来自 WWW-Authenticate）
 * @param {string|undefined} service
 * @param {string|undefined} scope
 * @param {string|null} username  节点凭据（可选）
 * @param {string|null} password
 * @returns {Promise<string|null>}
 */
export async function fetchUpstreamToken(realm, service, scope, username, password) {
  const cacheKey = `${realm}|${service ?? ''}|${scope ?? ''}|${username ?? ''}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.token;

  try {
    const u = new URL(realm);
    if (service) u.searchParams.set('service', service);
    if (scope) u.searchParams.set('scope', scope);
    const headers = new Headers();
    if (username && password) {
      headers.set('Authorization', `Basic ${btoa(`${username}:${password}`)}`);
    }
    const r = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(10_000) });
    if (r.status !== 200) {
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return null;
    }
    const data = await r.json();
    const token = data?.token ?? data?.access_token ?? null;
    if (token) tokenCache.set(cacheKey, { token, expires: Date.now() + TOKEN_TTL_MS });
    return token;
  } catch {
    return null;
  }
}

/** 不应转发给上游的请求头 */
const STRIP_REQUEST_HEADERS = new Set([
  'host', 'content-length', 'connection', 'keep-alive',
  'transfer-encoding', 'te', 'trailer', 'upgrade',
]);

/** 不应回传给客户端的响应头 */
const STRIP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
]);

/** 构造转发头：过滤 hop-by-hop、host、content-length 及 CF 注入头 */
function buildForwardHeaders(request) {
  const h = new Headers();
  request.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(k) || k.startsWith('cf-')) return;
    h.set(key, value);
  });
  return h;
}

/** 构造响应头：过滤 hop-by-hop；非 HEAD 请求去掉 content-length（流式回传） */
function filterResponseHeaders(r, method) {
  const h = new Headers();
  r.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(k)) return;
    if (k === 'content-encoding') return; // Workers 已自动解压
    if (k === 'content-length' && method !== 'HEAD') return;
    h.set(key, value);
  });
  return h;
}

async function cancelBody(r) {
  try { await r.body?.cancel(); } catch { /* ignore */ }
}

/**
 * /token 端点：代理认证 token 请求（移植原 proxy_token）。
 * `_upstream_realm` 查询参数（urlsafe base64）指定真实上游 realm，
 * 其余查询参数与请求头（含 Basic Authorization）原样转发。
 */
export async function handleToken(request, env) {
  let authUrl = DEFAULT_AUTH_URL;
  const raw = new URL(request.url).searchParams.get('_upstream_realm');
  if (raw) {
    const decoded = decodeUpstreamRealm(raw);
    if (decoded && /^https?:\/\//.test(decoded)) authUrl = decoded;
  }

  const upstream = new URL(authUrl);
  const url = new URL(request.url);
  url.searchParams.forEach((v, k) => {
    if (k !== '_upstream_realm') upstream.searchParams.set(k, v);
  });

  try {
    const r = await fetch(upstream.toString(), {
      method: 'GET',
      headers: buildForwardHeaders(request),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(r.body, { status: r.status, headers: filterResponseHeaders(r, 'GET') });
  } catch (e) {
    return json({ error: `Auth Error: ${e?.message || e}` }, 500);
  }
}

/**
 * /v2/* 代理主入口（移植原 proxy_v2）。
 * @param {Request} request
 * @param {import('./types.js').Env} env
 * @param {ExecutionContext} ctx
 * @param {string} rawPath /v2/ 之后的路径（如 "library/nginx/manifests/latest"），根 ping 为 ''
 */
export async function handleV2(request, env, ctx, rawPath) {
  const method = request.method.toUpperCase();

  // ---- 1. IP 白名单（对应原 config.get_ip_whitelist）----
  const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const whitelist = (env.IP_WHITELIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (whitelist.length && !whitelist.includes(clientIp)) {
    return json({ errors: [{ code: 'UNAUTHORIZED', message: 'IP not in whitelist' }] }, 403);
  }

  // ---- 2. 镜像黑白名单（与原项目一致，作用于前缀剥离前的原始路径）----
  const imageName = extractImageName(rawPath);
  if (imageName) {
    if (env.IMAGE_BLACKLIST_REGEX && new RegExp(env.IMAGE_BLACKLIST_REGEX).test(imageName)) {
      return json({ errors: [{ code: 'UNAUTHORIZED', message: 'Image blacklisted' }] }, 403);
    }
    if (env.IMAGE_WHITELIST_REGEX && !new RegExp(env.IMAGE_WHITELIST_REGEX).test(imageName)) {
      return json({ errors: [{ code: 'UNAUTHORIZED', message: 'Image not in whitelist' }] }, 403);
    }
  }

  // ---- 3. 选最优节点（前缀路由 + 最低延迟）----
  const { node: bestNode, adjustedPath } = await getBestProxy(env, rawPath);
  const node = bestNode ?? fallbackNode(env);
  const upstreamUrl = `${normalizeBaseUrl(node.url)}/v2/${adjustedPath}${new URL(request.url).search}`;

  // ---- 4. 构造转发头 / 请求体 ----
  const fwdHeaders = buildForwardHeaders(request);
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    body = await request.arrayBuffer();
  }

  // 流量统计：请求数 + 上行字节（manifest 拉取记录去重后落库）
  ctx.waitUntil(logTraffic(env, { up: body?.byteLength ?? 0, count: 1, nodeId: node.id }));
  if ((method === 'GET' || method === 'HEAD') && rawPath.includes('/manifests/')) {
    const [image, tag] = rawPath.split('/manifests/');
    if (image && tag) ctx.waitUntil(logPull(env, image, decodeURIComponent(tag), clientIp));
  }

  /** 发起上游请求（对应原项目 send_request，异常统一转 502） */
  const headerTimeoutMs = Number(env.UPSTREAM_TIMEOUT_MS ?? 15_000) || 15_000;
  const send = (headers) =>
    fetchWithHeaderTimeout(upstreamUrl, {
      method, headers, body,
      redirect: 'manual', // 保持 302 透传（对应原 httpx follow_redirects=False）
    }, headerTimeoutMs).catch((e) => {
      throw new Error(`连接上游失败: ${e?.message || e}`);
    });

  // ---- 5. 首次透明转发 ----
  let r;
  try {
    r = await send(fwdHeaders);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 502);
  }

  // ---- 6. 401 自动认证（Bearer / Basic，与原项目一致）----
  if (r.status === 401) {
    const wwwAuth = r.headers.get('www-authenticate') ?? '';
    if (wwwAuth.includes('Bearer')) {
      const info = parseWwwAuthenticate(wwwAuth);
      if (info.realm) {
        const token = await fetchUpstreamToken(info.realm, info.service, info.scope, node.username, node.password);
        if (token) {
          await cancelBody(r);
          const retryHeaders = new Headers(fwdHeaders);
          retryHeaders.set('Authorization', `Bearer ${token}`);
          try {
            r = await send(retryHeaders);
          } catch (e) {
            return json({ error: String(e?.message || e) }, 502);
          }
        }
      }
    } else if (wwwAuth.includes('Basic') && node.username && node.password) {
      await cancelBody(r);
      const retryHeaders = new Headers(fwdHeaders);
      retryHeaders.set('Authorization', `Basic ${btoa(`${node.username}:${node.password}`)}`);
      try {
        r = await send(retryHeaders);
      } catch (e) {
        return json({ error: String(e?.message || e) }, 502);
      }
    }
  }

  // ---- 7. 302 重定向 ----
  if (r.status >= 300 && r.status < 400) {
    const location = r.headers.get('location');
    if (location) {
      // follow 模式：Worker 内跟随重定向，流式回传（适用于上游 CDN 客户端直连不通的场景）
      if ((env.REDIRECT_MODE || 'passthrough') === 'follow') {
        await cancelBody(r);
        const followHeaders = new Headers();
        const range = request.headers.get('range');
        if (range) followHeaders.set('range', range);
        try {
          r = await fetchWithHeaderTimeout(location, { headers: followHeaders, redirect: 'follow' }, 60_000);
        } catch (e) {
          return json({ error: `Upstream redirect error: ${e?.message || e}` }, 502);
        }
        return streamResponse(env, r, method, node);
      }
      // passthrough 模式（默认，与原项目一致）：302 透传，后台 HEAD 估算 blob 大小
      if ((env.REDIRECT_SIZE_PROBE ?? 'true') !== 'false') {
        ctx.waitUntil(estimateRedirectSize(env, location, node.id));
      }
      return new Response(r.body, { status: r.status, headers: filterResponseHeaders(r, method) });
    }
  }

  // ---- 8. 最终仍为 401：重写 realm 指回本代理的 /token 端点 ----
  const headers = filterResponseHeaders(r, method);
  if (r.status === 401) {
    const wwwAuth = r.headers.get('www-authenticate');
    if (wwwAuth) {
      const m = wwwAuth.match(/realm="([^"]+)"/);
      if (m) {
        const origin = new URL(request.url).origin;
        const newRealm = `${origin}/token?_upstream_realm=${encodeURIComponent(encodeUpstreamRealm(m[1]))}`;
        headers.set('www-authenticate', wwwAuth.replace(m[1], newRealm));
      }
    }
  }

  // ---- 9. 流式回传 ----
  return new Response(r.body, { status: r.status, headers });
}

/**
 * 带流量计数的流式响应：透传字节流的同时累计下载量，结束后写入 D1。
 * HEAD / 空响应体直接返回。
 */
function streamResponse(env, r, method, node) {
  const headers = filterResponseHeaders(r, method);
  if (!r.body) return new Response(null, { status: r.status, headers });

  let down = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      down += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      void logTraffic(env, { down, nodeId: node.id });
    },
  });
  return new Response(r.body.pipeThrough(counter), { status: r.status, headers });
}

/** 透传 302 时用 HEAD 请求估算镜像层大小（对应原 log_redirect_size 后台任务） */
async function estimateRedirectSize(env, location, nodeId) {
  try {
    const r = await fetch(location, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    const size = Number(r.headers.get('content-length') ?? 0);
    try { await r.body?.cancel(); } catch { /* ignore */ }
    if (size > 0) await logTraffic(env, { down: size, nodeId });
  } catch {
    // 探测失败不影响主流程
  }
}
