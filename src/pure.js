/**
 * 纯函数工具集 —— 不依赖 Workers 运行时专属 API，
 * 可直接用 Node.js 运行冒烟测试（test/smoke.mjs）。
 */

/**
 * 解析 WWW-Authenticate 响应头，提取 realm / service / scope。
 * 与原项目 parse_www_activate() 逻辑一致。
 * @param {string} header
 * @returns {{realm?: string, service?: string, scope?: string}}
 */
export function parseWwwAuthenticate(header) {
  const info = {};
  for (const key of ['realm', 'service', 'scope']) {
    const m = header.match(new RegExp(`${key}="([^"]+)"`));
    if (m) info[key] = m[1];
  }
  return info;
}

/** 字节串 -> urlsafe base64（等价原项目 base64.urlsafe_b64encode） */
function b64UrlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * 上游 realm -> urlsafe base64 字符串（用于拼到 /token?_upstream_realm=... ）。
 * 保留 '=' padding，再由调用方 encodeURIComponent。
 * @param {string} realm
 */
export function encodeUpstreamRealm(realm) {
  return b64UrlEncode(new TextEncoder().encode(realm));
}

/**
 * urlsafe base64 -> 上游 realm 字符串（自动补齐 padding，等价原项目解码逻辑）。
 * 解析失败返回 null。
 * @param {string} encoded
 * @returns {string | null}
 */
export function decodeUpstreamRealm(encoded) {
  try {
    let std = String(encoded).replace(/-/g, '+').replace(/_/g, '/');
    const missing = std.length % 4;
    if (missing) std += '='.repeat(4 - missing);
    const bin = atob(std);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** 去掉 base url 尾部的斜杠 */
export function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * 从 /v2/ 之后的路径提取镜像名（/manifests/ 或 /blobs/ 之前的部分）。
 * 无匹配返回 null。
 * @param {string} path
 * @returns {string | null}
 */
export function extractImageName(path) {
  if (path.includes('/manifests/')) return path.split('/manifests/')[0] || null;
  if (path.includes('/blobs/')) return path.split('/blobs/')[0] || null;
  return null;
}

/**
 * 路由前缀匹配：path 以 "prefix/" 开头时返回剥离前缀后的子路径；
 * path 恰好等于前缀时返回 ''（兼容 /v2/ghcr/ 的 ping）；
 * 不匹配返回 null。
 * @param {string} path
 * @param {string} prefix
 * @returns {string | null}
 */
export function stripRoutePrefix(path, prefix) {
  const p = String(path).replace(/^\/+/, '');
  const pre = String(prefix).trim().replace(/^\/+|\/+$/g, '');
  if (!pre) return null;
  if (p === pre) return '';
  if (p.startsWith(pre + '/')) return p.slice(pre.length + 1);
  return null;
}

/**
 * 输出 JSON 响应。
 * @param {unknown} data
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
