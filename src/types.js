/**
 * 类型定义（仅 JSDoc，运行时无副作用）。
 *
 * @typedef {Object} Env
 * @property {D1Database} DB                          D1 数据库绑定
 * @property {Fetcher} [ASSETS]                       静态资源绑定（管理界面）
 * @property {string} [ADMIN_USER]                    管理员账号
 * @property {string} [ADMIN_PASS]                    管理员密码（建议 secret）
 * @property {string} [IP_WHITELIST]                  IP 白名单（逗号分隔）
 * @property {string} [IMAGE_WHITELIST_REGEX]         镜像白名单正则
 * @property {string} [IMAGE_BLACKLIST_REGEX]         镜像黑名单正则
 * @property {string} [DEFAULT_UPSTREAM]              兜底上游地址
 * @property {string} [FREE_NODE_SOURCE]              免费节点列表来源
 * @property {string} [REDIRECT_MODE]                 302 处理：passthrough | follow
 * @property {string} [REDIRECT_SIZE_PROBE]           302 时是否 HEAD 探测大小：true | false
 * @property {string} [UPSTREAM_TIMEOUT_MS]           上游响应头阶段超时（毫秒，默认 15000）
 */

/**
 * 代理节点（对应原项目 ProxyNode / 数据表 proxy_nodes）。
 * @typedef {Object} ProxyNode
 * @property {number} id
 * @property {string} name
 * @property {string} url
 * @property {string} registry_type
 * @property {string | null} route_prefix
 * @property {number} enabled            0 / 1
 * @property {number} latency            毫秒，9999 表示不可用
 * @property {string | null} last_check
 * @property {number} is_default
 * @property {string | null} username
 * @property {string | null} password
 * @property {string | null} failure_reason
 * @property {number} download_bytes
 */

/**
 * 新增/更新节点入参。
 * @typedef {Object} NodeInput
 * @property {string} name
 * @property {string} url
 * @property {string} [registry_type]
 * @property {string | null} [route_prefix]
 * @property {string | null} [username]
 * @property {string | null} [password]
 */

export {};
