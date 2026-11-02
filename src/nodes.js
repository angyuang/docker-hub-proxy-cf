/**
 * 节点管理模块 —— 移植自原项目 app/services/proxy_manager.py。
 * 数据存储从 SQLite(SQLModel) 换成 Cloudflare D1。
 */
import { normalizeBaseUrl, stripRoutePrefix } from './pure.js';

/** 与原项目一致的仓库类型清单（status.anye.xyz 的 type 名） */
export const HUB_TYPES = ['hub', 'ghcr', 'quay', 'mcr', 'gcr', 'elastic', 'nvcr'];

/** status.anye.xyz type -> registry_type */
const REGISTRY_TYPE_MAP = {
  hub: 'dockerhub',
  ghcr: 'ghcr',
  quay: 'quay',
  mcr: 'mcr',
  gcr: 'gcr',
  elastic: 'elastic',
  nvcr: 'nvcr',
};

/** 全部节点，按延迟升序（不可用的沉底） */
export async function listNodes(env) {
  const r = await env.DB.prepare('SELECT * FROM proxy_nodes ORDER BY latency ASC, id ASC').all();
  return (r.results ?? []);
}

/**
 * 新增节点（url 校验 + 去尾部斜杠）。
 * @returns {Promise<Object|null>} 新节点，url 非法时返回 null
 */
export async function addNode(env, input) {
  const url = normalizeBaseUrl(input?.url);
  if (!/^https?:\/\//.test(url)) return null;
  const r = await env.DB.prepare(
    `INSERT INTO proxy_nodes (name, url, registry_type, route_prefix, username, password)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING *`
  ).bind(
    input?.name || '未命名节点',
    url,
    input?.registry_type || 'dockerhub',
    input?.route_prefix || null,
    input?.username || null,
    input?.password || null
  ).run();
  return r.results?.[0] ?? null;
}

/**
 * 更新节点；延迟重置为 9999（等测速刷新），随后调用方一般会立即补一次单点测速。
 * @returns {Promise<Object|null>} 更新后的节点，不存在返回 null
 */
export async function updateNode(env, id, input) {
  const url = normalizeBaseUrl(input?.url);
  if (!/^https?:\/\//.test(url)) return null;
  const r = await env.DB.prepare(
    `UPDATE proxy_nodes
       SET name = ?1, url = ?2, registry_type = ?3, route_prefix = ?4,
           username = ?5, password = ?6, latency = 9999, enabled = 1, failure_reason = NULL
     WHERE id = ?7
     RETURNING *`
  ).bind(
    input?.name || '未命名节点',
    url,
    input?.registry_type || 'dockerhub',
    input?.route_prefix || null,
    input?.username || null,
    input?.password || null,
    id
  ).run();
  return r.results?.[0] ?? null;
}

/** 删除节点，返回是否删除成功 */
export async function deleteNode(env, id) {
  const r = await env.DB.prepare('DELETE FROM proxy_nodes WHERE id = ?1').bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * 选择最优节点（移植原 get_best_proxy）：
 *   1. 在 enabled=1 且 latency<9999 的节点中找最长匹配的 route_prefix（ghcr/... 等前缀路由）；
 *   2. 否则取第一个无前缀的通用节点（按延迟升序）；
 *   3. 都没有则返回 null，由调用方使用兜底节点。
 * @returns {Promise<{node: Object|null, adjustedPath: string}>}
 */
export async function getBestProxy(env, path) {
  const clean = String(path).replace(/^\/+/, '');
  const r = await env.DB.prepare(
    'SELECT * FROM proxy_nodes WHERE enabled = 1 AND latency < 9999 ORDER BY latency ASC'
  ).all();
  const proxies = r.results ?? [];

  let best = null;
  let bestLen = -1;
  let bestPath = clean;
  for (const p of proxies) {
    if (!p.route_prefix) continue;
    const stripped = stripRoutePrefix(clean, p.route_prefix);
    if (stripped !== null) {
      const len = String(p.route_prefix).trim().length;
      if (len > bestLen) {
        best = p;
        bestLen = len;
        bestPath = stripped;
      }
    }
  }
  if (best) return { node: best, adjustedPath: bestPath };

  for (const p of proxies) {
    if (!p.route_prefix) return { node: p, adjustedPath: clean };
  }
  return { node: null, adjustedPath: clean };
}

/** 兜底节点（对应原项目 "Fallback Official"），不落库 */
export function fallbackNode(env) {
  return {
    id: null,
    name: '官方直连',
    url: env.DEFAULT_UPSTREAM || 'https://registry-1.docker.io',
    registry_type: 'dockerhub',
    route_prefix: null,
    enabled: 1,
    latency: 0,
    last_check: null,
    is_default: 1,
    username: null,
    password: null,
    failure_reason: null,
    download_bytes: 0,
  };
}

/**
 * 测单个节点延迟：GET {url}/v2/，HTTP 200/401 均视为存活（与原项目一致）。
 * @returns {Promise<{latency: number, error: string | null}>}
 */
export async function checkProxyLatency(node) {
  const url = normalizeBaseUrl(node.url) + '/v2/';
  const headers = new Headers();
  if (node.username && node.password) {
    headers.set('Authorization', 'Basic ' + btoa(`${node.username}:${node.password}`));
  }
  const start = Date.now();
  try {
    const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(5000) });
    if (r.status === 200 || r.status === 401) {
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return { latency: Date.now() - start, error: null };
    }
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return { latency: 9999, error: `HTTP ${r.status}` };
  } catch (e) {
    return { latency: 9999, error: e?.message || '连接失败' };
  }
}

/** 测速并更新单节点状态（对应原 check_and_update_proxy） */
export async function checkAndUpdateProxy(env, node) {
  const { latency, error } = await checkProxyLatency(node);
  const enabled = latency < 9999 ? 1 : 0;
  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE proxy_nodes SET latency = ?1, failure_reason = ?2, last_check = ?3, enabled = ?4 WHERE id = ?5'
  ).bind(latency, error, now, enabled, node.id).run();
  return { ...node, latency, failure_reason: error, enabled, last_check: now };
}

/**
 * 全量测速（仅启用节点，与原项目 run_speed_test 一致）。
 * 注意：Workers 免费版每次调用最多约 50 个子请求，这里按 20 个/批分批并发；
 * 节点数超过约 45 个时，单次执行只覆盖靠前的部分，剩余由下一轮 cron 继续。
 */
export async function runSpeedTest(env) {
  const nodes = await listNodes(env);
  const targets = nodes.filter((n) => n.enabled === 1);
  const updated = [];
  for (let i = 0; i < targets.length; i += 20) {
    const chunk = targets.slice(i, i + 20);
    const results = await Promise.all(chunk.map((n) => checkAndUpdateProxy(env, n)));
    updated.push(...results);
  }
  return updated;
}

/**
 * 从 status.anye.xyz 抓取免费公共节点（移植原 fetch_and_update_proxies，
 * 过滤规则一致：仅 selectable 且 access=public，按 url 去重）。
 * @returns {Promise<number>} 新增节点数
 */
export async function fetchFreeNodes(env) {
  const base = normalizeBaseUrl(env.FREE_NODE_SOURCE || 'https://status.anye.xyz');
  const results = await Promise.allSettled(
    HUB_TYPES.map(async (t) => {
      const r = await fetch(`${base}/status/${t}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) {
        try { await r.body?.cancel(); } catch { /* ignore */ }
        return [];
      }
      return r.json();
    })
  );

  const existing = new Set((await listNodes(env)).map((n) => normalizeBaseUrl(n.url)));
  let added = 0;
  for (let i = 0; i < HUB_TYPES.length; i++) {
    const settled = results[i];
    if (settled.status !== 'fulfilled' || !Array.isArray(settled.value)) continue;
    const hubType = HUB_TYPES[i];
    for (const item of settled.value) {
      if (!item?.selectable) continue;
      if (item?.access !== 'public') continue;
      if (!item?.url) continue;
      const url = normalizeBaseUrl(String(item.url));
      if (existing.has(url)) continue;
      await addNode(env, {
        name: item.name || '未知节点',
        url,
        registry_type: REGISTRY_TYPE_MAP[hubType] ?? hubType,
        route_prefix: hubType === 'hub' ? null : hubType,
      });
      existing.add(url);
      added++;
    }
  }
  return added;
}
