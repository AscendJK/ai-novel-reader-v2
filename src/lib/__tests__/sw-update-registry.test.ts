/**
 * lib/sw-update — 这三格"跨文件同名字"首次有直接判据（23 行，但没有一个是本地的）
 *
 * 这只文件自己不做事，它做的事全在**两侧对不对得上**：
 * - `setUpdateSW` 由 `main.tsx:57` 写、`getUpdateSW` 由 `UpdateBanner.tsx:30` 读；
 * - `COI_RELOAD_KEY` 与 `MAX_COI_RELOADS` 由 `main.tsx:31-33` 写计数、`device-check.ts:177/181`
 *   读同一格给真机自检面板那一行。
 * 两侧各改各的，**TypeScript 不会报错**（键名是字符串、常量是数字），症状是
 * "更新按钮按了没反应（退回整页刷）"和"手机上那句『到上限不再刷』永远不出现"——
 * 而手机上开不了 devtools，那一行就是唯一的线索。
 *
 * 判的四格：
 * 1. 没注册之前 `getUpdateSW()` 是 `null`（`UpdateBanner` 靠它决定走 updateSW 还是退回
 *    `window.location.reload()`——**注册与未注册是两个相反的值，两侧都取样**）；
 * 2. 注册进去的那个函数，取出来还是同一个（不是包装、不是副本）：`UpdateBanner.tsx:31` 拿它
 *    直接 `await updateSW(true)`，中间套一层就丢参数；
 * 3. 后注册覆盖先注册（`main.tsx` 只调一次，但 `registerSW` 的返回被换掉时不许留旧的）；
 * 4. 两个常量的**字面值**：键名 `coi-reload-count`、上限 `3`。
 */
import { describe, it, expect, vi } from "vitest";
import { COI_RELOAD_KEY, MAX_COI_RELOADS, getUpdateSW, setUpdateSW } from "../sw-update";

describe("updateSW 那一格注册与取回", () => {
  it("没注册之前取到的是 null（UpdateBanner 就靠这一格退回整页刷）", async () => {
    // 这一格判的是模块级状态，**不能靠"它排在第一条"**：谁在中间加一条注册用例，这条就悄悄
    // 变成"注册之后取回 null"的反面判据。所以重开一份模块再取。
    vi.resetModules();
    const fresh = await import("../sw-update");
    expect(fresh.getUpdateSW()).toBeNull();
  });

  it("注册进去的就是取出来的那一个（同一引用，不套壳、不复制）", () => {
    const fake = vi.fn(async () => {});
    setUpdateSW(fake);
    expect(getUpdateSW()).toBe(fake);
    expect((getUpdateSW() as typeof fake).mock).toBeTruthy();
  });

  it("取出来直接带参数调用，走的就是注册那支函数本体（reloadPage 不许在这一层被吃掉）", async () => {
    const seen: unknown[] = [];
    setUpdateSW(async (reloadPage?: boolean) => { seen.push(reloadPage); });
    const fn = getUpdateSW();
    expect(fn).toBeTruthy();
    await fn!(true);
    await fn!(false);
    expect(seen).toEqual([true, false]);
  });

  it("后注册的覆盖先注册的（同一格只留最后一个）", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    setUpdateSW(first);
    setUpdateSW(second);
    expect(getUpdateSW()).toBe(second);
    await getUpdateSW()!();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("整条注册链下来不许在 sessionStorage 留下任何东西（这一层只存函数，没有副作用）", () => {
    // 第一版写成"注册前后长度不变"，被 W6b 打出 **0 红**——同一支注入的键在前一条用例里
    // 已经写过一次，长度对比正好被抵掉。判副作用要判"一共留下了什么"，不是"这一次变了没有"。
    setUpdateSW(async () => {});
    setUpdateSW(async () => {});
    expect(sessionStorage.length, `留下了：${JSON.stringify(sessionStorage)}`).toBe(0);
  });
});

describe("跨文件同名的那两个常量", () => {
  it("键名字面量就是 coi-reload-count（写方 main.tsx、读方 device-check.ts 都拼这一个串）", () => {
    expect(COI_RELOAD_KEY).toBe("coi-reload-count");
  });

  it("上限是 3：够兜住「已经接管却拿不到隔离」，又不至于把页面刷成闪屏", () => {
    expect(MAX_COI_RELOADS).toBe(3);
  });

  it("键名与上限都不许是空值/NaN（写进 sessionStorage 的那一格会被静默变成字符串）", () => {
    expect(typeof COI_RELOAD_KEY).toBe("string");
    expect(COI_RELOAD_KEY.length).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_COI_RELOADS)).toBe(true);
    expect(MAX_COI_RELOADS).toBeGreaterThan(0);
  });
});

// 这一只文件没有模块级状态需要隔离：`_updateSW` 是**故意跨调用留着**的（注册在 main、读取在
// 组件里），所以"每条用例重建模块"反而是错的判法——上面几条按注册顺序写成一条链。

// ── 变异台账（基线 sha256=48a8a51d… / 718 B；一刀一跑一还原，每轮核 markers=1、
//    transform_failed=0、markers_left=0、diff_lines=0、sha 回到基线）────────────────────
//
// 8 条用例、9 记有效刀：8 记咬红，1 记 0 红**并且是判据自己没牙**（W6b → 加强 → W6c 才咬住）。
// 对照：W0b / W0d / W0e = 8 绿（改一次判据重跑一次对照）。
//
// W1  `getUpdateSW` 恒返回 null         3 红：同一引用 ／ 带参数调用 ／ 后注册覆盖
// W8  `setUpdateSW` 那一行是空的        3 红：同上三条——**存与取两半各下一刀**，红名相同但刀标签
//     不同，才说明这一格两头都在（只打一头会被"另一头还留着"糊过去）
// W7/W7b 没注册也造一支假函数            1 红：只有"没注册之前是 null"那条。
//     W7b 是重打：那一格原本靠"它排在第一条"才判得到，改成 `vi.resetModules()` + 动态 import
//     重开一份模块之后，谁在中间加注册用例都糊不到它。
// W2  键名少一个字母（`coi-reload-coun`）1 红：**只有字面量那条**——写方与读方都 import 同一常量，
//     改值不会让任何行为测试红。这条断言不是装饰，是这一格唯一的哨兵。
// W3  上限从 3 挪到 2                    1 红：同上，只有字面量那条。
// W4  存的是包装（`async () => fn()`）    3 红：同一引用 ／ 参数被吃掉 ／ 后注册覆盖。
//     （台账行当时把标签写成 W3b，标记 `MUT-W4` 在文件里，归属以标记为准。）
// W5  只留第一个、后注册不覆盖            2 红：带参数调用那条 ／ 后注册覆盖那条
// W6b 注册这一步顺手写 sessionStorage     **0 红**——不是等价变异，是**我那条判据写错了**：
//     它比的是"这一次调用前后长度变没变"，而同一支键在排在它前面的用例里已经被写过一次，
//     长度抵住不动。加强成"整条注册链下来 sessionStorage 必须一个字都没留"→ W6c = 1 红。
//     记下来这一族：**判副作用要判"留下了什么"，不是"这一次变了没有"**（跨用例共享的
//     模块级状态：sessionStorage、_updateSW 本身，都会把"前后差"型断言抵掉）。
//
// 作废的读数：W0 首跑 `transform_failed=1 / sum[] 空`——用例标题里写了嵌套的直引号，
// 整只测试文件没解析成功（老坑新患，见项目台账）；W6 那一轮 `markers=2`（一条消息里连发两次
// Edit = 同一盘两刀），按口径作废重打。
