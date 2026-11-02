/**
 * Worker 入口 —— 对应原项目 app/main.py。
 * 原项目是 web(8000) + proxy(8443) 双服务，Cloudflare 上合并为单 Worker：
 *   /v2/*           镜像仓库代理（给 docker 客户端用）
 *   /token          认证 token 代理（由 /v2 的 401 challenge 自动引导）
 *   /admin/api/*    管理 API（Basic 认证）
 *   /               管理界面（public/index.html，由 assets 自动托管）
 *   /healthz        健康检查
 *   scheduled       定时测速 + 抓取免费节点
 */
import { handleV2, handleToken } from './proxy.js';
import { handleAdmin } from './admin.js';
import { runSpeedTest, fetchFreeNodes } from './nodes.js';

/** 与 wrangler.toml [triggers].crons 中"抓取免费节点"的表达式保持一致 */
const FREE_FETCH_CRON = '0 18 * * *';

export default {
  /**
   * @param {Request} request
   * @param {import('./types.js').Env} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/healthz') return new Response('ok');

    // ---- Docker Registry 协议 ----
    if (path === '/token') return handleToken(request, env);
    if (path === '/v2' || path === '/v2/') return handleV2(request, env, ctx, '');
    if (path.startsWith('/v2/')) return handleV2(request, env, ctx, path.slice(4));

    // ---- 管理 API ----
    if (path.startsWith('/admin/api/')) return handleAdmin(request, env, ctx);

    // ---- 管理界面 ----
    if (request.method === 'GET' && (path === '/admin' || path === '/admin/')) {
      return env.ASSETS
        ? env.ASSETS.fetch(new Request(url.origin + '/'))
        : new Response('管理界面未配置（缺少 assets 绑定）', { status: 404 });
    }

    // 其余 GET 请求交给静态资源兜底（正常情况下 "/" 由 assets 直接响应，不会到这里）
    if (request.method === 'GET' && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },

  /**
   * 定时任务：每 30 分钟测速；每天 UTC 18:00 抓取免费节点。
   * @param {ScheduledController} event
   * @param {import('./types.js').Env} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runSpeedTest(env)
        .then((nodes) => console.log(`[cron] 测速完成：${nodes.length} 个节点`))
        .catch((e) => console.error('[cron] 测速失败:', e))
    );
    if (event.cron === FREE_FETCH_CRON) {
      ctx.waitUntil(
        fetchFreeNodes(env)
          .then((added) => console.log(`[cron] 免费节点新增：${added} 个`))
          .catch((e) => console.error('[cron] 抓取免费节点失败:', e))
      );
    }
  },
};
