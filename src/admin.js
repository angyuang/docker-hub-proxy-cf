/**
 * 管理 API —— 对应原项目 app/routers/web_ui.py 的接口层。
 * 使用 HTTP Basic 认证（ADMIN_USER / ADMIN_PASS，未配置时拒绝访问）。
 */
import { json } from './pure.js';
import { listNodes, addNode, updateNode, deleteNode, runSpeedTest, fetchFreeNodes, checkAndUpdateProxy } from './nodes.js';
import { getTrafficStats, getPullHistory } from './traffic.js';

/** 校验 Basic 认证 */
function authorized(request, env) {
  const user = env.ADMIN_USER ?? '';
  const pass = env.ADMIN_PASS ?? '';
  if (!user || !pass) return false; // 未配置管理员凭据 -> 管理功能关闭
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(':');
    return decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass;
  } catch {
    return false;
  }
}

function unauthorized() {
  return json({ error: '需要管理员认证（ADMIN_USER / ADMIN_PASS）' }, 401, {
    'www-authenticate': 'Basic realm="docker-hub-proxy-admin"',
  });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * 管理 API 路由入口。
 * 路由：
 *   GET    /admin/api/nodes               节点列表
 *   POST   /admin/api/nodes               新增节点（添加后自动测速）
 *   PUT    /admin/api/nodes/:id           更新节点（更新后自动测速）
 *   DELETE /admin/api/nodes/:id           删除节点
 *   POST   /admin/api/nodes/speedtest     全量测速
 *   POST   /admin/api/nodes/fetch-free    抓取免费公共节点
 *   GET    /admin/api/stats/traffic?days  近 N 天流量（默认 7）
 *   GET    /admin/api/stats/pulls?limit   最近 N 条拉取记录（默认 20）
 */
export async function handleAdmin(request, env, ctx) {
  if (!authorized(request, env)) return unauthorized();

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // ---- 节点集合 ----
  if (path === '/admin/api/nodes') {
    if (method === 'GET') return json(await listNodes(env));
    if (method === 'POST') {
      const input = await readJsonBody(request);
      if (!input?.url) return json({ error: '缺少 url 字段' }, 400);
      const node = await addNode(env, input);
      if (!node) return json({ error: 'url 无效（需以 http(s):// 开头）' }, 400);
      const checked = await checkAndUpdateProxy(env, node); // 添加后自动测速（与原项目一致）
      return json(checked);
    }
    return json({ error: 'Method Not Allowed' }, 405);
  }

  // ---- 测速 ----
  if (path === '/admin/api/nodes/speedtest') {
    if (method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
    const updated = await runSpeedTest(env);
    return json({ tested: updated.length, nodes: await listNodes(env) });
  }

  // ---- 抓取免费节点 ----
  if (path === '/admin/api/nodes/fetch-free') {
    if (method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
    const added = await fetchFreeNodes(env);
    return json({ added, nodes: await listNodes(env) });
  }

  // ---- 单节点 ----
  const idMatch = path.match(/^\/admin\/api\/nodes\/(\d+)$/);
  if (idMatch) {
    const id = Number(idMatch[1]);
    if (method === 'PUT') {
      const input = await readJsonBody(request);
      if (!input?.url) return json({ error: '缺少 url 字段' }, 400);
      const node = await updateNode(env, id, input);
      if (!node) return json({ error: '节点不存在' }, 404);
      return json(await checkAndUpdateProxy(env, node)); // 更新后立即补测速
    }
    if (method === 'DELETE') {
      const ok = await deleteNode(env, id);
      return ok ? json({ ok: true }) : json({ error: '节点不存在' }, 404);
    }
    return json({ error: 'Method Not Allowed' }, 405);
  }

  // ---- 统计 ----
  if (path === '/admin/api/stats/traffic' && method === 'GET') {
    const days = Number(url.searchParams.get('days') ?? 7);
    return json(await getTrafficStats(env, Math.min(90, Math.max(1, days || 7))));
  }
  if (path === '/admin/api/stats/pulls' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 20);
    return json(await getPullHistory(env, Math.min(200, Math.max(1, limit || 20))));
  }

  return json({ error: 'Not Found' }, 404);
}
