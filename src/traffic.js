/**
 * 流量统计模块 —— 移植自原项目 app/services/traffic_logger.py。
 *
 * 与原项目的差异（为适应 D1 免费写入额度而设计）：
 *  - traffic_stats 按天 UPSERT 聚合（原项目是读出再写回）；
 *  - 拉取记录的去重缓存仍在 isolate 内存中（15 秒窗口，与原项目一致），
 *    并额外定期清理 2000 条之前的旧记录，防止 pull_history 无限膨胀。
 */
import { shanghaiDate, shanghaiDateTime } from './time.js';

/**
 * 记录流量：按天聚合 + 节点累计流量（与原项目 log_traffic 语义一致）。
 * @param {import('./types.js').Env} env
 * @param {{down?: number, up?: number, count?: number, nodeId?: number | null}} [opts]
 */
export async function logTraffic(env, opts = {}) {
  const date = shanghaiDate();
  const down = Math.max(0, Math.round(opts.down ?? 0));
  const up = Math.max(0, Math.round(opts.up ?? 0));
  const count = Math.max(0, Math.round(opts.count ?? 0));
  try {
    const stmts = [
      env.DB.prepare(
        `INSERT INTO traffic_stats (date, download_bytes, upload_bytes, request_count)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(date) DO UPDATE SET
           download_bytes = download_bytes + ?2,
           upload_bytes   = upload_bytes + ?3,
           request_count  = request_count + ?4`
      ).bind(date, down, up, count),
    ];
    if (opts.nodeId != null && (down > 0 || up > 0)) {
      stmts.push(
        env.DB.prepare('UPDATE proxy_nodes SET download_bytes = download_bytes + ?1 WHERE id = ?2')
          .bind(down + up, opts.nodeId)
      );
    }
    await env.DB.batch(stmts);
  } catch {
    // 统计失败不影响代理主流程
  }
}

/** isolate 内 15 秒去重缓存（HEAD -> GET、digest 请求），与原项目逻辑一致 */
const recentPulls = new Map();
const DEDUP_MS = 15_000;

function isDuplicatePull(image, tag, clientIp) {
  const now = Date.now();
  // 偶发清理过期缓存，防止 Map 无限增长
  if (recentPulls.size > 1000) {
    for (const [k, t] of recentPulls) if (now - t > DEDUP_MS) recentPulls.delete(k);
  }
  const exactKey = `${clientIp}_${image}_${tag}`;
  const imageKey = `${clientIp}_${image}`;
  if (recentPulls.has(exactKey) && now - recentPulls.get(exactKey) < DEDUP_MS) return true;
  if (tag.startsWith('sha256:') && recentPulls.has(imageKey) && now - recentPulls.get(imageKey) < DEDUP_MS) {
    return true;
  }
  recentPulls.set(exactKey, now);
  recentPulls.set(imageKey, now);
  return false;
}

/**
 * 记录一次镜像拉取（仅 manifests 请求会调用）。
 * @param {import('./types.js').Env} env
 * @param {string} image
 * @param {string} tag
 * @param {string} clientIp
 */
export async function logPull(env, image, tag, clientIp) {
  try {
    if (isDuplicatePull(image, tag, clientIp)) return;
    await env.DB.prepare(
      'INSERT INTO pull_history (request_time, image, tag, client_ip) VALUES (?1, ?2, ?3, ?4)'
    ).bind(shanghaiDateTime(), image, tag, clientIp).run();
    // 约 5% 概率顺手清理旧记录，把 pull_history 控制在约 2000 条以内
    if (Math.random() < 0.05) {
      await env.DB.prepare(
        'DELETE FROM pull_history WHERE id <= (SELECT MAX(id) FROM pull_history) - 2000'
      ).run();
    }
  } catch {
    // ignore
  }
}

/**
 * 查询最近 N 天流量统计（按日期倒序）。
 * @param {import('./types.js').Env} env
 * @param {number} [days]
 */
export async function getTrafficStats(env, days = 7) {
  const r = await env.DB.prepare(
    'SELECT date, download_bytes, upload_bytes, request_count FROM traffic_stats ORDER BY date DESC LIMIT ?1'
  ).bind(days).all();
  return r.results ?? [];
}

/**
 * 查询最近 N 条拉取记录。
 * @param {import('./types.js').Env} env
 * @param {number} [limit]
 */
export async function getPullHistory(env, limit = 20) {
  const r = await env.DB.prepare(
    'SELECT id, request_time, image, tag, client_ip FROM pull_history ORDER BY id DESC LIMIT ?1'
  ).bind(limit).all();
  return r.results ?? [];
}
