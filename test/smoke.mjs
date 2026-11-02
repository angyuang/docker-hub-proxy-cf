/**
 * 冒烟测试：验证纯函数逻辑（无需 Workers 运行时，直接 node 运行）。
 * 运行：npm test
 */
import {
  parseWwwAuthenticate,
  encodeUpstreamRealm,
  decodeUpstreamRealm,
  extractImageName,
  stripRoutePrefix,
  normalizeBaseUrl,
} from '../src/pure.js';

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

/* ---- parseWwwAuthenticate（对应原项目解析 401 challenge）---- */
eq(
  '解析 Bearer challenge',
  parseWwwAuthenticate('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"'),
  { realm: 'https://auth.docker.io/token', service: 'registry.docker.io', scope: 'repository:library/nginx:pull' }
);
eq('解析无 scope 的 challenge', parseWwwAuthenticate('Bearer realm="https://auth.example.com/token",service="reg"'), {
  realm: 'https://auth.example.com/token',
  service: 'reg',
});
eq('Basic 头同样能提取 realm（与原 Python 版行为一致，仅 Bearer 分支会调用）', parseWwwAuthenticate('Basic realm="x"'), { realm: 'x' });

/* ---- realm 编解码回路（对应原项目 _upstream_realm base64 逻辑）---- */
const realm = 'https://auth.docker.io/token?service=registry.docker.io&scope=a:b:c';
eq('realm 编解码回路', decodeUpstreamRealm(encodeUpstreamRealm(realm)), realm);
eq('含中文的 realm 回路', decodeUpstreamRealm(encodeUpstreamRealm('https://auth.example.com/token?x=中文')), 'https://auth.example.com/token?x=中文');
eq('去 padding 也能解码', decodeUpstreamRealm(encodeUpstreamRealm('https://a.io/t').replace(/=+$/, '')), 'https://a.io/t');
eq('非法 base64 返回 null', decodeUpstreamRealm('!!!not-base64###'), null);

/* ---- extractImageName（黑白名单作用对象）---- */
eq('提取 manifests 镜像名', extractImageName('library/nginx/manifests/latest'), 'library/nginx');
eq('提取 blobs 镜像名', extractImageName('ghcr/owner/img/blobs/sha256:abc'), 'ghcr/owner/img');
eq('根 ping 无镜像名', extractImageName(''), null);
eq('tags/list 无镜像名', extractImageName('library/nginx/tags/list'), null);

/* ---- stripRoutePrefix（前缀路由，对应原 get_best_proxy 的前缀剥离）---- */
eq('剥离 ghcr 前缀', stripRoutePrefix('ghcr/owner/img/manifests/latest', 'ghcr'), 'owner/img/manifests/latest');
eq('路径恰好等于前缀（ping）', stripRoutePrefix('ghcr', 'ghcr'), '');
eq('前缀不匹配返回 null', stripRoutePrefix('library/nginx', 'ghcr'), null);
eq('前缀是路径开头但非边界', stripRoutePrefix('ghcrx/img', 'ghcr'), null);
eq('前缀带多余斜杠', stripRoutePrefix('gcr/img/tags', '/gcr/'), 'img/tags');

/* ---- normalizeBaseUrl ---- */
eq('去尾部斜杠', normalizeBaseUrl('https://registry-1.docker.io/'), 'https://registry-1.docker.io');
eq('去多个尾部斜杠', normalizeBaseUrl('https://mirror.gcr.io///'), 'https://mirror.gcr.io');

/* ---- 汇总 ---- */
if (failed) {
  console.error(`\n${failed} 个测试失败`);
  process.exit(1);
}
console.log('\n全部冒烟测试通过 ✔');
