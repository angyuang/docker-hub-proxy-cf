

# Docker Hub Proxy · Cloudflare Workers 版

本项目是 [xingfeng7788/docker-hub-proxy](https://github.com/xingfeng7788/docker-hub-proxy)（Python/FastAPI + SQLite）的 **JavaScript 重写版**，运行在 **Cloudflare Workers** 上，数据存 **Cloudflare D1**，无需任何服务器，也无需自己准备 SSL 证书。

## 功能对照（原项目 → 本项目）

| 功能 | 原项目 | 本项目 |
| --- | --- | --- |
| Docker Registry 代理（`/v2/*`） | FastAPI + httpx 流式转发 | Workers `fetch` 流式透传 ✅ |
| 401 自动认证（Bearer/Basic，节点凭据） | ✅ | ✅ 逻辑 1:1 移植 |
| `WWW-Authenticate` realm 重写（`/token?_upstream_realm=`） | ✅ | ✅ 逻辑 1:1 移植 |
| 多仓库前缀路由（ghcr / gcr / quay / mcr / elastic / nvcr） | `route_prefix` | ✅ 相同机制 |
| 最优节点选择（延迟最低优先） | SQLite | ✅ D1 |
| 免费节点一键抓取（status.anye.xyz） | ✅ | ✅ 相同来源与过滤规则 |
| 定时测速 | 服务内定时器 | ⏰ Cron Triggers（每 30 分钟） |
| IP 白名单 / 镜像黑白名单 | 环境变量 | ✅ 相同 |
| 流量统计（按天）+ 拉取历史（15 秒去重） | SQLite | ✅ D1（按天 UPSERT 聚合） |
| Web 管理界面（Vue 单页） | 端口 8000 | ✅ 纯静态单页（Workers Assets 托管，Basic 认证） |
| HTTPS 8443 端口 + 自签证书 + SSL 证书下载脚本 | ✅ | ❌ 不再需要：自定义域名由 Cloudflare 自动签发证书 |

## 架构

```
docker 客户端
   │  docker pull registry.example.com/library/nginx:latest
   ▼
Cloudflare Worker（本项目，单 Worker）
   ├─ GET /v2/*          → 选最优节点 → 401 自动认证代办 → 流式转发（302 默认透传）
   ├─ GET /token         → realm 重写回环端点（urlsafe base64 编解码，同原项目）
   ├─ /admin/api/*       → 管理 API（HTTP Basic 认证）
   ├─ GET /              → 管理界面（public/index.html）
   └─ Cron Triggers      → 每 30 分钟测速；每天 UTC 18:00 抓免费节点
   └─ D1（SQLite）       → proxy_nodes / traffic_stats / pull_history 三张表（同原项目）
```

## 部署步骤

### 0. 准备

```bash
# 需要 Node.js 18+
npm install
```

### 1. 创建 D1 数据库并初始化表结构

```bash
npx wrangler d1 create docker-proxy-db
# 复制输出的 database_id，填入 wrangler.toml 中 [[d1_databases]] 的 database_id

npx wrangler d1 execute docker-proxy-db --remote --file=./schema.sql
```

### 2. 配置管理员密码

推荐使用 secret（不进代码库）：

```bash
npx wrangler secret put ADMIN_PASS    # 按提示输入密码
```

或在 `wrangler.toml` 的 `[vars]` 里直接写 `ADMIN_PASS = "你的密码"`（不推荐明文提交）。
`ADMIN_USER` 默认 `admin`，可在 `[vars]` 修改。**两者任一未配置时，管理 API 与界面数据接口都会拒绝访问。**

### 3. 部署

```bash
npx wrangler deploy
```

部署成功后会输出 `https://docker-hub-proxy.<你的子域>.workers.dev`，这就是你的镜像代理地址。

### 4.（推荐）绑定自定义域名

`workers.dev` 域名在国内部分网络不可直连，建议绑定自有域名：

> Cloudflare Dashboard → Workers & Pages → docker-hub-proxy → Settings → Domains & Routes → Add → Custom Domain，填入如 `registry.example.com`（域名需已托管在该 Cloudflare 账号）。

证书由 Cloudflare 自动签发，替代了原项目的 8443 端口 + 自签证书方案。

### 5. 打开控制台

浏览器访问 `https://你的域名/`，输入管理员账号密码即可管理节点、查看流量与拉取记录。

## Docker 拉取使用

```bash
# Docker Hub 镜像
docker pull registry.example.com/library/nginx:latest

# GHCR（经前缀路由自动转发到 GHCR 节点）
docker pull registry.example.com/ghcr/owner/image:tag

# GCR / Quay / MCR 等同理
docker pull registry.example.com/gcr/<project>/<image>:tag
```

也可以把代理配置为 Docker Hub 的 registry mirror（仅对 Docker Hub 生效），编辑 `/etc/docker/daemon.json`：

```json
{
  "registry-mirrors": ["https://registry.example.com"]
}
```

然后 `sudo systemctl restart docker`。

## 环境变量（wrangler.toml [vars]）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_USER` | `admin` | 管理界面账号 |
| `ADMIN_PASS` | （空） | 管理界面密码；**建议用 `wrangler secret put` 配置**；与 `ADMIN_USER` 任一为空则管理功能关闭 |
| `IP_WHITELIST` | （空） | 逗号分隔的 IP 白名单，留空不限制（对 `/v2/*` 生效） |
| `IMAGE_WHITELIST_REGEX` | （空） | 镜像白名单正则，如 `^(library\|nginx\|redis)` |
| `IMAGE_BLACKLIST_REGEX` | （空） | 镜像黑名单正则 |
| `DEFAULT_UPSTREAM` | `https://registry-1.docker.io` | 无可用节点时的兜底上游 |
| `FREE_NODE_SOURCE` | `https://status.anye.xyz` | 免费节点来源（与原项目一致） |
| `REDIRECT_MODE` | `passthrough` | 302 处理：`passthrough` 透传给客户端；`follow` 由 Worker 跟随重定向流式回传（上游 CDN 客户端直连不通时使用） |
| `REDIRECT_SIZE_PROBE` | `true` | 透传 302 时是否 HEAD 探测镜像层大小用于流量统计（与原项目一致） |
| `UPSTREAM_TIMEOUT_MS` | `15000` | 上游"响应头阶段"超时（毫秒），超时返回 502；响应头到达后不再计时，不影响大镜像层流式下载 |

## 管理 API

均需 Basic 认证（`ADMIN_USER` / `ADMIN_PASS`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/nodes` | 节点列表 |
| POST | `/admin/api/nodes` | 新增节点（添加后自动测速） |
| PUT | `/admin/api/nodes/:id` | 更新节点（更新后自动测速） |
| DELETE | `/admin/api/nodes/:id` | 删除节点 |
| POST | `/admin/api/nodes/speedtest` | 全量测速 |
| POST | `/admin/api/nodes/fetch-free` | 抓取免费公共节点 |
| GET | `/admin/api/stats/traffic?days=7` | 近 N 天流量 |
| GET | `/admin/api/stats/pulls?limit=20` | 最近 N 条拉取记录 |
| GET | `/healthz` | 健康检查（无需认证） |

## 定时任务（wrangler.toml [triggers]）

- `*/30 * * * *`：对所有**启用**节点测速，更新延迟/可用状态（失败节点自动禁用，与原项目一致）
- `0 18 * * *`：每天 UTC 18:00（北京时间凌晨 2 点）从 status.anye.xyz 抓取免费公共节点

## 限额与注意事项

- **Workers 免费版**：每天 10 万次请求、每次请求最多 50 个子请求。镜像层走流式转发几乎不消耗 CPU 时间，个人使用完全够用。
- **D1 免费版**：每天约 10 万次写入。本代理每个 `/v2/*` 请求写 1 次流量统计（manifest 拉取再多 1 条历史记录），一次 `docker pull` 约产生 8~20 次写入，即免费额度约支持每天数千次拉取。若用量更大，可购买 Workers 付费版（D1 额度同步提升），或把流量统计改为 Cloudflare Analytics Engine。
- **测速子请求限制**：免费版单次 cron 最多约 50 个子请求，本项目按 20 个/批并发、单次最多测约 45 个节点；节点更多时下一轮 cron 会继续覆盖。
- **Token 缓存**：认证 token 在 isolate 内存缓存 240 秒，isolate 回收后自动失效，不影响正确性。
- **国内访问速度**：Cloudflare 边缘节点国内直连质量因运营商而异，绑定自有域名并做优选 IP 可显著改善。
- **Push 场景**：与原项目定位一致，本项目面向 pull 加速；push 上传大 layer 未做优化。

## 本地开发

```bash
npm install
npm run db:init:local                       # 初始化本地 D1（.wrangler 目录）
cp .dev.vars.example .dev.vars              # 本地测试口令 admin / admin123
npm run dev                                 # http://localhost:8787
npm test                                    # 纯函数冒烟测试
```

本地验证代理是否工作：

```bash
curl http://localhost:8787/healthz
curl http://localhost:8787/v2/              # 应返回 401/200，说明 registry 协议可达
```

## 项目结构

```
docker-hub-proxy-cf/
├── wrangler.toml        # Workers 配置（D1 / Cron / vars / assets）
├── schema.sql           # D1 三张表（对应原项目 models.py）
├── public/index.html    # 管理界面（纯静态，零外部依赖）
├── src/
│   ├── index.js         # 入口：路由分发 + 定时任务（对应原 main.py）
│   ├── proxy.js         # /v2 代理 + /token + 认证代办 + realm 重写（对应 docker_proxy.py）
│   ├── nodes.js         # 节点 CRUD / 测速 / 免费节点抓取（对应 proxy_manager.py）
│   ├── traffic.js       # 流量统计 + 拉取记录（对应 traffic_logger.py）
│   ├── pure.js          # 纯函数工具（可单测）
│   ├── time.js          # 北京时间工具（对应 get_shanghai_time）
│   └── types.js         # JSDoc 类型定义
└── test/smoke.mjs       # 冒烟测试（node 直接运行）
```

## 致谢

- 原项目：[xingfeng7788/docker-hub-proxy](https://github.com/xingfeng7788/docker-hub-proxy)
- 同类思路参考：[ciiiii/cloudflare-docker-proxy](https://github.com/ciiiii/cloudflare-docker-proxy)
- 容器镜像监控：[容器镜像监控](https://status.anye.xyz)
````

---
# 功能及验证
✅ **全部 16 个文件交付完毕**。最终核对清单：

| # | 文件 | # | 文件 |
|---|---|---|---|
| 1 | `wrangler.toml` | 9 | `src/traffic.js` |
| 2 | `schema.sql` | 10 | `src/nodes.js` |
| 3 | `package.json` | 11 | `src/proxy.js` ⭐核心 |
| 4 | `.gitignore` | 12 | `src/admin.js` |
| 5 | `.dev.vars.example` | 13 | `src/index.js` |
| 6 | `src/pure.js` | 14 | `public/index.html` |
| 7 | `src/time.js` | 15 | `test/smoke.mjs` |
| 8 | `src/types.js` | 16 | `README.md` |

保存好文件后，按 README 的三步走：`npm install` → `wrangler d1 create`（填 database_id）→ `secret put ADMIN_PASS` → `wrangler deploy`，即可上线。

本地部署用的是 **wrangler dev**（模拟完整的 Workers + 本地 D1，**不需要 Cloudflare 账号、不需要真实 database_id**），所有功能都能在上线前验证到位。下面是完整的「部署 + 逐项验证」手册。

# 一、本地部署（约 5 分钟）

```bash
cd docker-hub-proxy-cf
npm install                          # 安装 wrangler（Node.js 18+）
npm test                             # 先跑冒烟测试，应输出 17 个 ✓
cp .dev.vars.example .dev.vars       # 本地口令 admin / admin123
npm run db:init:local                # 初始化本地 D1（建 3 张表，存在 .wrangler/state 下）
npm run dev                          # 启动！默认 http://localhost:8787
```

启动成功会显示 `Ready on http://localhost:8787`。此时终端就是实时日志窗口，后面每条请求都会打印在这里。

> 说明：本地模式下 `wrangler.toml` 里的 `database_id` 占位符不用改；`.dev.vars` 里的变量会**覆盖** `wrangler.toml [vars]`（后面验证黑白名单/502 就靠它）。

# 二、功能验证（12 项，按模块）

以下命令均为 bash（Windows 用 Git Bash / WSL 执行），管理口令默认 `admin:admin123`。

## A. 基础层

**① 纯函数单测**（已跑过，此处存档）

```bash
npm test        # 预期：17 个 ✓ + 「全部冒烟测试通过 ✔」
```

**② 健康检查**

```bash
curl http://localhost:8787/healthz        # 预期：ok
```

## B. 管理面（Basic 认证 + 节点管理）

**③ 管理 API 认证**

```bash
curl -i http://localhost:8787/admin/api/nodes
#   预期：HTTP 401 + {"error":"需要管理员认证..."}（未带凭据被拒）

curl -u admin:admin123 http://localhost:8787/admin/api/nodes
#   预期：HTTP 200 + []（空节点列表）
```

**④ 节点增 / 查 / 改 / 删（添加后自动测速）**

```bash
# 新增（返回的 JSON 里 latency 应为实测毫秒数，如 200~800，而不是 9999）
curl -u admin:admin123 -X POST http://localhost:8787/admin/api/nodes \
  -H 'content-type: application/json' \
  -d '{"name":"官方直连","url":"https://registry-1.docker.io"}'

# 更新（id=1，返回 latency 已重新测速）
curl -u admin:admin123 -X PUT http://localhost:8787/admin/api/nodes/1 \
  -H 'content-type: application/json' \
  -d '{"name":"改名节点","url":"https://registry-1.docker.io"}'

# 删除
curl -u admin:admin123 -X DELETE http://localhost:8787/admin/api/nodes/1
```

**⑤ 抓取免费公共节点**（需能访问 status.anye.xyz）

```bash
curl -u admin:admin123 -X POST http://localhost:8787/admin/api/nodes/fetch-free
# 预期：{"added":N,"nodes":[...]}，N 为新增个数；列表里会出现 ghcr/gcr/quay 等带前缀节点
```

**⑥ 全量测速**

```bash
curl -u admin:admin123 -X POST http://localhost:8787/admin/api/nodes/speedtest
# 预期：{"tested":N,...}，每个节点 latency/last_check 被刷新，挂掉的节点 enabled 变 0
```

**⑦ 直查本地 D1（验证数据真的落库）**

```bash
npx wrangler d1 execute docker-proxy-db --local \
  --command "SELECT id,name,url,registry_type,route_prefix,latency,enabled FROM proxy_nodes"
npx wrangler d1 execute docker-proxy-db --local --command "SELECT * FROM traffic_stats"
```

## C. 代理面（核心协议，最重要的 4 项）

**⑧ `/v2/` ping + realm 重写**（验证 401 challenge 被改写指回本代理）

```bash
curl -si http://localhost:8787/v2/ | grep -i www-authenticate
```

预期：

```
Www-Authenticate: Bearer realm="http://localhost:8787/token?_upstream_realm=aHR0cHM6...",service="registry.docker.io"
```

把 `_upstream_realm=` 后面的值解码，应还原出 `https://auth.docker.io/token`：

```bash
python3 -c "import base64,urllib.parse;s=urllib.parse.unquote('把realm值粘贴到这里');print(base64.urlsafe_b64decode(s+'='*(-len(s)%4)).decode())"
```

**⑨ `/token` 回环端点**（token 代办）

```bash
curl -s "http://localhost:8787/token?service=registry.docker.io&scope=repository:library/nginx:pull"
# 预期：返回 {"token":"eyJhbGciOi...","expires_in":300,"issued_at":...}
```

**⑩ 经代理拉取 manifest（验证 401 自动认证代办）**——匿名 curl 就能拿到，因为 Worker 在内部自动取 token 重试了：

```bash
curl -s http://localhost:8787/v2/library/nginx/manifests/latest \
  -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json' \
  | head -c 300
# 预期：{"schemaVersion":2,"mediaType":"image/index...","manifests":[...]}
#（若你的网络无法直连 docker.io，这里会返回 502 JSON —— 恰好证明了错误路径，见第 ⑮ 项）
```

**⑪ blob 层 302 透传（passthrough 默认模式）**

```bash
# 先取 manifest 里任意一个 digest
DIGEST=$(curl -s http://localhost:8787/v2/library/nginx/manifests/latest \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['manifests'][0]['digest'])")

# GET blob：预期 HTTP 307/302 + location 指向 production.cloudflare.docker.com（302 原样透传给客户端）
curl -s -D - -o /dev/null "http://localhost:8787/v2/library/nginx/blobs/$DIGEST" | head -6
```

再验证 **follow 模式**：往 `.dev.vars` 追加一行 `REDIRECT_MODE=follow`，重启 `npm run dev`，重跑上面这条 —— 预期变为 `HTTP/1.1 200` 且开始流式返回镜像层数据（Worker 内部跟随重定向）。测完把该行删掉。

## D. 流量统计与策略

**⑫ 流量统计 + 拉取记录 + 15 秒去重**

```bash
# 连续拉两次同一 manifest（间隔 1 秒，< 15 秒去重窗口）
for i in 1 2; do curl -s -o /dev/null \
  "http://localhost:8787/v2/library/nginx/manifests/latest" \
  -H 'Accept: application/vnd.oci.image.index.v1+json'; sleep 1; done

# 拉取记录应只有 1 条（去重生效），且 request_count >= 2
curl -u admin:admin123 "http://localhost:8787/admin/api/stats/pulls?limit=5"
curl -u admin:admin123 "http://localhost:8787/admin/api/stats/traffic?days=7"
npx wrangler d1 execute docker-proxy-db --local \
  --command "SELECT * FROM pull_history ORDER BY id DESC LIMIT 5"
```

**⑬ IP 白名单**（本地没有 `cf-connecting-ip`，clientIp 固定为 `unknown`，正好两个分支都能验证）——在 `.dev.vars` 里加一行，重启后测：

```bash
IP_WHITELIST=1.2.3.4      # 加到 .dev.vars → curl /v2/ 预期 403 "IP not in whitelist"
IP_WHITELIST=unknown      # 改成这个   → curl /v2/ 预期正常通过（放行分支）
```

**⑭ 镜像黑名单 / 白名单**（同样改 `.dev.vars`，测完删掉）

```bash
IMAGE_BLACKLIST_REGEX=^library/nginx
# → curl .../v2/library/nginx/manifests/latest 预期 403 "Image blacklisted"

IMAGE_WHITELIST_REGEX=^redis$
# → library/nginx 预期 403 "Image not in whitelist"，library/redis 可通过
```

**⑮ 502 兜底路径**：先用 SQL 清空节点让代理走兜底上游，再把兜底指向一个死地址：

```bash
npx wrangler d1 execute docker-proxy-db --local --command "DELETE FROM proxy_nodes"
# .dev.vars 加一行：DEFAULT_UPSTREAM=https://nonexistent.invalid
curl -s http://localhost:8787/v2/library/nginx/manifests/latest
# 预期：{"error":"连接上游失败: ..."} + HTTP 502（而不是 500 HTML）
```

## E. 定时任务与界面

**⑯ Cron 触发**（`wrangler dev` 不会自动跑定时任务，用内置端点手动触发）：

```bash
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
# wrangler 终端预期打印：[cron] 测速完成：N 个节点

curl "http://localhost:8787/__scheduled?cron=0+18+*+*+*"
# 预期打印：[cron] 免费节点新增：N 个
```

**⑰ Web 管理界面**：浏览器打开 `http://localhost:8787/`，弹出登录框输入 `admin / admin123`，逐一确认：4 张统计卡片有数字、节点表格能编辑/删除、「一键测速」「获取免费节点」按钮有 toast 反馈、7 天流量柱状图出现当天柱子、最近拉取表里有第 ⑫ 步的记录、页面每 60 秒自动刷新。

**⑱（可选）真实 docker pull**（需本机装有 Docker）：

```bash
docker pull localhost:8787/library/nginx:latest
```

若报 `server gave HTTP response to HTTPS client`，在 Docker 设置（daemon.json）加 `"insecure-registries": ["localhost:8787"]` 并重启 Docker（Docker 对 localhost 默认放行 HTTP，多数情况不用配）。

# 三、本地与线上的差异（4 点须知）

| 差异点 | 本地 | 线上 |
|---|---|---|
| 客户端 IP | 无 `cf-connecting-ip`，恒为 `unknown` | 真实 IP，白名单按真实 IP 生效 |
| 定时任务 | 不自动执行，需 `__scheduled` 手动触发 | 按 crons 自动执行 |
| D1 | 本地 SQLite 文件（`.wrangler/state`），与线上数据**不通** | 云端 D1，需 `--remote` 初始化 |
| 上游连通性 | 取决于你本机网络能否直连 docker.io 等 | Cloudflare 边缘必然可达上游 |

# 四、常见问题

- **端口被占用**：`npm run dev -- --port 8788`
- **重置本地数据**：删掉 `.wrangler/state` 目录后重跑 `npm run db:init:local`
- **第 ⑧~⑪ 项全部 502**：说明你本机网络直连不到 docker.io（被墙/无代理）。这本身就是 502 错误路径的验证；代理核心逻辑（realm 重写、token 回环）不受影响照常可测，完整的拉取验证放到部署到 Cloudflare 之后做即可
- **测完记得还原**：`.dev.vars` 里临时加的 `IP_WHITELIST / IMAGE_*_REGEX / REDIRECT_MODE / DEFAULT_UPSTREAM` 测完删除并重启

---

按顺序跑完 ①~⑰，就覆盖了**全部功能路径**：协议层（ping / manifest / blob / 302 / token 回环）、管理面（认证 / CRUD / 测速 / 免费节点）、统计面（流量 / 拉取记录 / 去重）、策略面（IP / 黑白名单）、容错面（502）、定时任务和 UI。之后线上部署只需 `d1 create`（填 id）→ `secret put ADMIN_PASS` → `wrangler deploy` 三步。验证过程中哪一步输出和预期不符，把命令和返回贴给我，我帮您排查。
