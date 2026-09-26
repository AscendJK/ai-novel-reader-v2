/**
 * `rag/chunk-utils` 的判据（地板第 1 档·唯一函数）。
 *
 * `normalizeChunks` 是**服务端/缓存里的 chunks → 检索器认的 Chunk** 的唯一一道转换，
 * 五个调用点全在检索主链上：`build-index.ts:229`（建索引时把服务端回的行落定），
 * `index.ts:91`／`index.ts:114`（从 IndexedDB 的 ragCache 复原嵌入／TF-IDF 两套缓存），
 * `index.ts:366`（重建前先读旧记录），外加 `index.ts:14` 把它再导出一次。
 * 全仓没有一句判据直接指着它（`rag/__tests__/index.test.ts` 那批走的是别的路径）。
 *
 * 它只有 12 行，但三条线都是从"错了没人看得见"的边上走过来的：
 * 1) **id 不许留空**：`retriever.ts:184` 是把结果按 **id 字符串**找回 chunk 的
 *    （`this.chunks.find((c) => c.id === id)`）。一旦有一批 id 相同或为空，每个命中都
 *    指到**同一只** chunk——分数是对的、内容是错的，界面上一条错误都不出。
 *    所以 `c.id || String(i)` 用的是 `||` 不是 `??`：空串也算"没给 id"。
 * 2) **chapterIndex 原样、不许编 0**：`embedding-retriever.ts:259` 用
 *    `chunks.some(c => typeof c.chapterIndex === "number")` 判"这份索引能不能按章节范围筛"，
 *    `index.ts:478` 那段注释写的就是"旧实现把缺 chapterIndex 的 chunk 也放进来"造成的降级。
 *    把 undefined 补成 0，等于把一份全书索引谎报成"全都属于第 0 章"。
 * 3) **条数与顺序一字不动**：向量是按**位置**跟 chunks 配对的
 *    （`EmbeddingRetriever.fromArrayBuffer(buffer, chunks, …)`，`retriever.ts:143` 也是
 *    `chunks[i].id` 逐位建 DocVector）。这里筛掉或重排一条，之后整条向量的归属全错位。
 *
 * 一格不判，写在明处：**对象里没有 `content`** 那一支——类型上 `content` 是必填
 * （`Array<string | {id?; content: string; chapterIndex?}>`），五个调用点的数据源要么是自
 * 家建的（`index.ts:160/178` 每条都带 content）要么是服务端定形回包，全仓没有一条活路径
 * 给它传过无 content 的对象（实测）。给不可达的分支写判据＝替未来的 bug 预铺一条"看着有测试"
 * 的路，按老规矩不写。
 *
 * **8 条判据、8 把刀，逐条读数记在文件末尾**（短号 J1..J8 / U1..U8）。
 */

import { describe, it, expect } from "vitest";

import type { Chunk } from "../retriever";
import { normalizeChunks } from "../chunk-utils";

/** build-index / 缓存里真实会来的两种形状。 */
const OBJ_ROWS = [
  { id: "n1-0", content: "第一章正文片段", chapterIndex: 0 },
  { id: "n1-1", content: "第二章正文片段", chapterIndex: 1 },
  { id: "n1-2", content: "第三章正文片段", chapterIndex: 2 },
];

describe("normalizeChunks：id 一律给得出、且不重复", () => {
  it("字符串那支：id 用下标，content 照原样，也不许凭空多出一个 chapterIndex", () => {
    const out = normalizeChunks(["第一段", "第二段", "第三段"]);
    expect(out.map((c) => c.id)).toEqual(["0", "1", "2"]);
    expect(out.map((c) => c.content)).toEqual(["第一段", "第二段", "第三段"]);
    // 判的是值域而不是键在不在：embedding-retriever 用 typeof==="number" 决定
    // "这份索引能不能按章节筛"，字符串那支没有章节信息，补 0 就是谎报。
    expect(out.every((c) => typeof c.chapterIndex !== "number")).toBe(true);
  });

  it("对象给过 id 就照原样用（建索引那条路径靠它跟 DocVector 对上号）", () => {
    const out = normalizeChunks(OBJ_ROWS);
    expect(out.map((c) => c.id)).toEqual(["n1-0", "n1-1", "n1-2"]);
    expect(out.map((c) => c.content)).toEqual(OBJ_ROWS.map((r) => r.content));
  });

  it("没给 id 与给了空串都退回下标——判的是 || 而不是 ??", () => {
    // 空串留在 id 上，retriever.ts:184 的 find(c => c.id === "") 会把每个命中都指到同一只。
    const out = normalizeChunks([
      { content: "甲" },
      { id: "", content: "乙" },
      { id: "given", content: "丙" },
    ]);
    expect(out.map((c) => c.id)).toEqual(["0", "1", "given"]);
    expect(new Set(out.map((c) => c.id)).size).toBe(3);
  });

  it("两种形状混在一批里各走各的那支，顺序照进来时", () => {
    const out = normalizeChunks(["裸串", { id: "x", content: "带 id 的", chapterIndex: 7 }, "又一根裸串"]);
    expect(out.map((c) => c.id)).toEqual(["0", "x", "2"]);
    expect(out.map((c) => c.content)).toEqual(["裸串", "带 id 的", "又一根裸串"]);
  });
});

describe("normalizeChunks：chapterIndex 原样、位置不动", () => {
  it("带章节的照原样留下（范围过滤唯一的依据就是它）", () => {
    const out = normalizeChunks(OBJ_ROWS);
    expect(out.map((c) => c.chapterIndex)).toEqual([0, 1, 2]);
    // 第 0 章那条尤其关键：假值 0 一旦被当成"没给"，整份索引会被误判成旧数据
    expect(out[0].chapterIndex).toBe(0);
  });

  it("没给章节的就是没给：不许被补成 0", () => {
    const out = normalizeChunks([{ content: "旧数据里没有章节" }, { content: "也没有", chapterIndex: undefined }]);
    expect(out.map((c) => c.chapterIndex)).toEqual([undefined, undefined]);
    expect(out.every((c) => typeof c.chapterIndex !== "number")).toBe(true);
  });

  it("条数与顺序一字不动（向量按位置配对，筛掉或重排一条就整条错位）", () => {
    const rows = [
      "一",
      { id: "b", content: "二", chapterIndex: 1 },
      "三",
      { content: "四" },
      { id: "e", content: "五", chapterIndex: 4 },
    ];
    const out = normalizeChunks(rows);
    expect(out.length).toBe(5);
    expect(out.map((c) => c.content)).toEqual(["一", "二", "三", "四", "五"]);
  });

  it("交出去的是新对象，传进来的那批不被就地改", () => {
    const input: Array<{ id?: string; content: string; chapterIndex?: number }> = [
      { content: "甲" },
      { id: "keep", content: "乙", chapterIndex: 2 },
    ];
    const before = JSON.parse(JSON.stringify(input)) as typeof input;
    const out: Chunk[] = normalizeChunks(input);
    expect(input).toEqual(before);
    expect(out[0]).not.toBe(input[0]);
    expect(out[1]).not.toBe(input[1]);
  });
});

/**
 * 判别力台账（2026-09-27 本机，`CI=1 npx vitest run src/rag/__tests__/chunk-utils.test.ts`）。
 * 基线：`src/rag/chunk-utils.ts` = sha256 `b5760d21…`（658 字节），**产品代码一行没动**：
 * 8 刀每刀之后 `cp` 回基线并 `cmp` + 重核 sha，最后一刀跑完 `git diff --numstat` 为空。
 * **没有一刀 0 红。** 判据短号 J1..J8 按书写顺序。
 *
 *  J1 字符串支：id 下标/content 原样/不造章节号   J2 对象支：给过 id 就照原样
 *  J3 缺 id 与空串都退回下标（|| 而非 ??）        J4 混合两种形状各走各支
 *  J5 章节号照原样（含 0 那格）                   J6 没给章节不许补 0
 *  J7 条数与顺序一字不动                          J8 交出去的是新对象、不就地改
 *
 *  U1 `c.id || String(i)` → `c.id ?? String(i)` → **1 红**（J3）——空串这一格只有 `||` 认。
 *  U2 字符串支 `id: String(i)` → `id: ""` → **2 红**（J1 J4）
 *  U3 对象支摘掉 `chapterIndex: c.chapterIndex` → **1 红**（J5）
 *  U4 `c.chapterIndex` → `c.chapterIndex ?? 0` → **1 红**（J6）
 *     ★与 U3 相反方向：补 0 会让"这份索引没有章节信息"被谎报成"全属于第 0 章"，
 *     范围过滤那条降级路径（index.ts:478 的注释）就再也走不到。
 *  U5 字符串支也补一个 `chapterIndex: 0` → **1 红**（J1）
 *  U6 `.map(...)` 后面接 `.reverse()` → **6 红**（J4 J7 目标，其余按顺序取的全体倒）
 *     这一把是"位置配对"有多脆的实测：向量按位跟 chunks 配对，动一次顺序就是一条链一起错。
 *  U7 改成就地改（`c.id = …; return c`）→ **1 红**（J8）
 *  U8 对象支 `c.id || String(i)` → 只 `String(i)`（不认调用方给的 id）→ **3 红**（J2 目标 + J3 J4 连带）
 *
 * 每条判据都至少有一把自己名下的刀；J3/J4 在多把刀里同时红是它们与 id 那条路共用形状，
 * 已在上面的"目标/连带"里分开记。
 */
