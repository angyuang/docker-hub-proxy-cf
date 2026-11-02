-- Docker Hub Proxy · Cloudflare Workers 版 —— D1 数据表结构
-- 初始化：npx wrangler d1 execute docker-proxy-db --remote --file=./schema.sql

-- 代理节点表（对应原项目 ProxyNode）
CREATE TABLE IF NOT EXISTS proxy_nodes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  registry_type  TEXT NOT NULL DEFAULT 'dockerhub',  -- dockerhub / ghcr / gcr / quay / mcr / elastic / nvcr
  route_prefix   TEXT,                               -- 路由前缀，如 ghcr、gcr；Docker Hub 类型为 NULL
  enabled        INTEGER NOT NULL DEFAULT 1,
  latency        REAL NOT NULL DEFAULT 9999,         -- 毫秒，9999 表示不可用
  last_check     TEXT,
  is_default     INTEGER NOT NULL DEFAULT 0,
  username       TEXT,
  password       TEXT,
  failure_reason TEXT,
  download_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_proxy_nodes_enabled ON proxy_nodes (enabled, latency);
CREATE INDEX IF NOT EXISTS idx_proxy_nodes_prefix  ON proxy_nodes (route_prefix);

-- 每日流量统计（对应原项目 TrafficStats，按天 UPSERT 聚合）
CREATE TABLE IF NOT EXISTS traffic_stats (
  date           TEXT PRIMARY KEY,                   -- 北京时间 YYYY-MM-DD
  download_bytes INTEGER NOT NULL DEFAULT 0,
  upload_bytes   INTEGER NOT NULL DEFAULT 0,
  request_count  INTEGER NOT NULL DEFAULT 0
);

-- 镜像拉取记录（对应原项目 PullHistory，仅记录 manifests 请求）
CREATE TABLE IF NOT EXISTS pull_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_time TEXT NOT NULL,                       -- 北京时间
  image        TEXT NOT NULL,
  tag          TEXT NOT NULL,
  client_ip    TEXT
);
CREATE INDEX IF NOT EXISTS idx_pull_history_id ON pull_history (id DESC);
