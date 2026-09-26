/**
 * server 文件 → 该跑哪只探针。空数组 = 没有已证的探针看着它。
 *
 * 两只脚本共用，别再抄第二份：
 *  - `audit-discrimination.mjs`：改了这些文件时该跑哪几只探针（还原法量判别力）；
 *  - `audit-import-graph.mjs`（覆盖地板）：静态 import 图**跨不过"探针另起进程跑后端、
 *    再发真 HTTP"这条边界**，所以映射过的文件在这里也算"有人看着"，标 `探针映射:` 前缀
 *    与真 import 分开。
 *
 * 判据与 verification-matrix §6 同源；新增探针时要一起改。
 *
 * 底下 `routes/index.js` / `routes/novels.js` / `routes/version.js` / `middleware/index.js`
 * 四只是 2026-09-23 补的，各自手工变异发跑过 `probe:boot`（一次一处，跑完立刻 `git restore`）：
 *  - 去掉 version 处理器 → "服务器启动并响应 /api/version" 红（探针对"起没起来"的判断本身就
 *    打在这个端点上，CORS 三态也走它）；
 *  - novels 列表回 500 → 26/27；
 *  - 两只 re-export 桶少一个名字 → 服务端 import 直接 SyntaxError，起不来。
 * `middleware/index.js` 顺带量到一件事：五个再导出里只有 `rateLimit` 有人从这个桶拿
 * （`routes/sync.js:19`），其余四个名字大家都直接 import `middleware/auth.js`。
 */
export const PROBE_FOR = {
  "server/index.js": ["probe:boot", "probe:proxy"],
  "server/admin.js": ["probe:boot"],
  "server/sync-handler.js": ["probe:maps", "probe:sync"],
  "server/routes/index.js": ["probe:boot"],
  "server/routes/novels.js": ["probe:boot"],
  "server/routes/version.js": ["probe:boot"],
  "server/middleware/index.js": ["probe:boot"],
  // 2026-09-26：`probe:boot` 现在**直接 import** 这一只并在进程内驱动假 req/res（27 条判据，
  // 台账在 probe-server-boot.mjs 那段注释里），所以它已经不只是"映射可达"，是有直接判据了。
  // 下面 rateLimit.js 同理：18 条进程内判据（假 req/res + 可控钟），13 刀台账在同一段注释里；
  // 其中"清扫真的删掉了过期条目"那一格**判不到**（闭包私有，删与不删对客户端不可区分），
  // 那一格留给仓库外长跑，别把这里读成"清扫逻辑全被看着"。
  "server/middleware/auth.js": ["probe:boot"],
  "server/middleware/rateLimit.js": ["probe:boot"],
  "server/routes/sync.js": ["probe:sync"],
  "server/routes/proxy.js": ["probe:proxy"],
  "server/routes/rag.js": ["probe:rag"],
  "server/rag-builder.js": ["probe:rag"],
  "server/database.js": ["probe:backup", "probe:maps", "probe:reupload"],
  "server/lib/engine-config.js": [],
  // 建索引时要真嵌入模型（23MB 权重），repo 三档都跑不到它的 happy path：探针只发坏输入，
  // 全在入 worker 之前就被路由拒了。但**真逻辑不在这儿**——分块/归一化/维度那些在
  // `server/lib/rag-worker-core.mjs`，它有单测 `src/rag/__tests__/rag-worker-core.test.ts`
  // 盯着（所以它不在地板里）。剩下这 38 行外壳（下载 → pipe → postMessage）真看着它的是
  // 仓库外第五档：R-C1 真拉权重并把索引建成、维度对上，R-C2 进度按服务端 current/total 推，
  // R-C3 检索第一条就命中目标章。别把这里的 [] 读成"完全没人管"。
  "server/rag-worker.mjs": [],
};
