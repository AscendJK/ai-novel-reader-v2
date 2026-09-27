/**
 * `config/version.ts` 的首次直接判据（地板第 1 档·最后一只空壳）。
 *
 * 5 行、一只出口：`APP_VERSION: string = __APP_VERSION__`，由 `vite.config.ts:21` 的
 * `define: { __APP_VERSION__: JSON.stringify(pkg.version) }` 在构建期把 package.json 的
 * 版本号内联进来。**六处调用点**（实测）：`UsernameLogin.tsx:354`（登录页"前端版本 v…"）、
 * `ApiSettings.tsx:391`（设置页那行 `v{APP_VERSION}`）、`check-version.ts:27/37/44/45/56`
 * （跟后端报的版本用字符串 `===` 比，决定要不要弹"版本不一致"）、`device-check.ts:200/370`
 * （真机自检的事实表与导出文本）、`main.tsx:15`（控制台那条 banner）。
 *
 * 为什么这只壳一直没人看着：唯一从版本比对这条链判它的 `check-version.test.ts:17`
 * **把整只 `vi.mock` 成了 `"2.1.8"`**——注入有没有生效、值长什么样，那一档一条都判不到。
 * 浏览器层 `a-smoke.spec.ts:13` 自己在测试里重读了一遍 package.json 当基准（A5 那一条），
 * 但那要跑构建产物；jsdom 这一层此前一句直接指着都没有（实测 audit 第 1 档只剩这一只，就是它）。
 *
 * 判这四格：
 * 1. **与 package.json 的 version 一字不差**——"同源"的定义就在这。`check-version.ts:44` 拿
 *    字符串 `===` 比后端返回的版本，前端这只一旦与包里的号错开（或多带前缀/空白），
 *    用户每次打开应用都弹"版本不一致"，而那是一只会拦住正常使用的模态。
 * 2. **形状是 x.y.z 起步、不含空白、不自带前导 v**——`v` 是三处调用点自己加的，
 *    值里再多一个就成了 `vv2.4.0`；带空白就永远比不中。
 * 3. **是非空字符串**——`define` 整个漏掉时构建期直接 `ReferenceError`（模块加载就炸），
 *    但配成空串这类坏法是运行时的空值，症状是界面显示"前端版本 v"。
 * 4. **这只文件只交出一个出口**——绊线，性质与那两只桶那两档同一条。
 *
 * 明处记两格：
 * - **"不许硬编码"当场判不住，只能靠格1 当绊线**：写成 `= "2.4.0"` 与写成
 *   `= __APP_VERSION__` 今天的读数一模一样，只有下次版本号一跳（`2.4.0 → 2.4.1`）格1
 *   才会红。真要当场验"注入生效"，得先改 package.json 的版本再跑——那要连带动四件事
 *   （版本号那套发布约定），不为一把刀去动它，所以这一格记在账上、不写进判据。
 * - **构建期那条 `define` 本身不判**：测试吃的是同一份 vite 配置，判它等于判 vite。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import * as versionModule from "../version";
import { APP_VERSION } from "../version";

// vitest 里 import.meta.url 不是 file: 协议，按项目根读（与 a-smoke.spec.ts:13 同一口径）
const pkgVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

describe("config/version 的 APP_VERSION", () => {
  it("1 与 package.json 的 version 一字不差（同源的定义就在这）", () => {
    expect(APP_VERSION).toBe(pkgVersion);
  });

  it("2 形状是 x.y.z 起步：三段数字、不含空白、不自带前导 v（v 是调用点加的）", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(APP_VERSION.startsWith("v")).toBe(false);
    expect(APP_VERSION).toBe(APP_VERSION.replace(/\s/g, ""));
  });

  it("3 是非空字符串（空值会让界面显示成「前端版本 v」）", () => {
    expect(typeof APP_VERSION).toBe("string");
    expect(APP_VERSION.length).toBeGreaterThan(0);
    expect(APP_VERSION.trim()).toBe(APP_VERSION);
  });

  it("4 这只文件只交出一个出口", () => {
    expect(Object.keys(versionModule).sort()).toEqual(["APP_VERSION"]);
  });
});

/**
 * 判别力台账（2026-09-27 本机，`CI=1 npx vitest run src/config/__tests__/version.test.ts`，
 * 红名一律从落盘日志数）。基线：`src/config/version.ts` = sha256 `92f67158…`（157 字节），
 * **产品代码一行没动**：五刀每刀之后 `cp` 回基线并 `cmp` + 重核 sha，最后一刀跑完
 * `git diff --numstat` 为空。**没有一刀 0 红。** 判据短号 1..4 按书写顺序。
 *
 *  Q1 硬编码一个旧号（`= "2.3.9"`）                     → **1 红**（格1）
 *  Q2 值里自带前导 v（`= "v" + __APP_VERSION__`）        → **2 红**（格1 格2）
 *  Q3 只留两段（`.split(".").slice(0, 2).join(".")` → "2.4"）→ **2 红**（格1 格2）
 *  Q4 空串（`= ""`）                                    → **3 红**（格1 格2 格3）
 *  Q5 顺手多挂一只出口（`export const APP_NAME = "…"`）  → **1 红**（格4）
 *     Q5 是一处语义改动、只多一行；`git diff -U0` 把原来那行也列成 `-/+` 一对，别误读成两刀。
 *
 * 对照取证：把 Q1 那一刀原样打进**全量** `CI=1 npx vitest run`——**187 只文件 / 2569 条里
 * 只有本档这 1 条红**。`check-version.test.ts:17` 把它 mock 成 `"2.1.8"`，`ApiSettings` 与登录页
 * 那两档判的是"这一行有没有渲染"而不是"号对不对"，所以版本号坏成那样时全仓一声不响；
 * 浏览器层 A5（`a-smoke.spec.ts:13`）才拿 package.json 当基准，而那要跑构建产物。
 * 这一档把这条链在 jsdom 层钉住了。
 *
 * 过程账一条：本档第一次跑是 `no tests`——`readFileSync(new URL("../package.json", import.meta.url))`
 * 在 vitest 下报 `The URL must be of scheme file`（模块的 URL 不是 file: 协议）。改成按项目根读
 * `readFileSync("package.json")`，与 `a-smoke.spec.ts:13` 同一口径。**"0 条测试"也可能是模块
 * 根本没加载成功**，这条老坑又踩了一次。
 */
