/**
 * `PlaceDetail` 本体的直接判据（地板第 1 档·地点详情弹窗）
 *
 * 这只弹窗是地图那条链最后落到屏上的一张卡：`NovelMapSection.tsx:480` 把选中地点连同
 * `layers` / 父级 / 子级 / 相关势力一起交进来。它坏了以后**没有任何报错**，只是屏上少一句
 * 或者多一句假话——所以第 1 档里它一直算"没人直接看着"（浏览器层只有 G4b 量越界与滚到关闭）。
 *
 * 这里只判这只组件**自己替调用点做的六个决定**：
 * 1) **层级名按 `level` 查，不按数组顺序**（`:52`）。模型给的 `layers` 顺序不保证按 level 升序，
 *    而 `place.level` 是它自己报的数——按 index 取的症状是"第二级地点顶上写着第三层"。
 * 2) **查不到要兜底成 `层级 N`**（`:52` 的 `||`）。`level` 越界／`layers` 为空都是模型真会给的
 *    形状，兜底那一支不许是空串，也不许把 `undefined` 拼上去。
 * 3) **重要程度恒十格，实心数跟着 `importance`**（`:84-91`）。`1-10` 只是提示词里的约定
 *    （`map-agent.ts:266`），界面拿不到校验；越界与 0 都得有确定的形状。
 * 4) **三块"有内容才出现"的门槛各判各的**：`affiliation` 空串、`parentPlace` 是 `undefined`
 *    （上级没找到时调用点就是交 `undefined`——`parentMissing` 那条口径的另一半）、两个数组为空。
 *    症状都一样：**标签孤零零挂在屏上**（"上级区域："后面什么都没有），用户会以为数据丢了。
 * 5) **头部三处数据来源不许串**：标题是 `place.name`、两枚徽章分别是 `place.type` 与层级名。
 * 6) **关闭出口要能叫得出名字**（`:71` 的 `aria-label="关闭"`）——G4b 就是拿它 `getByLabel` 的。
 *
 * 量不到／判到别处去的，写在明处（不是"没想到"）：
 * - **"能不能真滚到关闭按钮""超长描述会不会把卡片撑宽"这两样 jsdom 判不了**：它没有布局，
 *   `scrollHeight`/`clientWidth` 恒 0。后果由浏览器层 **G4b** 判（`e2e/specs/g-narrow.spec.ts`：
 *   1200 字描述 + 一串不带空格的长 URL，滚到关闭 → 点得到 → 内部 `scrollWidth-clientWidth ≤ 1`）。
 *   这里只判遮罩与卡片那**四个类**还在不在（`overflow-y-auto` / 没有 `items-center` / `my-auto`
 *   / `shrink-0` / `break-words`）——它们是 G4b 那次修复的形状，形状退回去 G4b 未必在每个机型上都红。
 * - `Card` / `Badge` / `Button` 三只是 `ui/` 的壳，各自有契约判据，这里不重判。
 * - `place.description` 原样上屏（无截断无加工），没立判据：改坏它的唯一路径是 `MarkdownRenderer`
 *   那类加工被加进来，而这里连 import 都没有。
 *
 * ## 变异台账：21 刀全部打在基线 `6902acbe79d25026b304d293d41acb320ed44d18d89633bc3b9e710ca2cc98b4`
 * （4939 字节 / 25 条全绿，**产品代码一行没动**）
 *
 * 每刀手动一次一处 → 跑 → `cp /tmp/pd.baseline.tsx` 字节还原 → 核 `restored_sha` 回基线。
 * 21 轮全部 `markers=1 markers_left=0 transform_failed=0 skipped=0`。红了哪几条用本文件的用例名。
 *
 * - **M1** 层级名改成按数组下标取（`layers.find(l => l.level === place.level)` → `layers[place.level - 1]`）
 *   → **3 红**（"取的是 level 相等那一条" / "换 level 徽章跟着换" / "撞名时取第一条"）。夹具里
 *   `LAYERS` 的顺序故意是 3,1,2——按 index 取一定拿到错的那一格。
 * - **M2** 去掉「层级 N」兜底（`|| \`层级 ${level}\`` → `?? ""`）→ **2 红**（level 越界 / layers 空数组）。
 *   与 M1 各打一半：M1 管"查得对不对"，M2 管"查不到时说不说得出话"。
 * - **M3** 圆点格数跟着 importance 走 → **3 红**（恒十格 / 实心数 / 越界 12 全实心）。
 * - **M4** 实心判据边界挪一格（`i <` → `i <=`）→ **2 红**（实心数 / **0 与负数全暗**）。
 *   ⚠ M3 打不到"0 与负数"那一格（格数 0、实心 0，恰好也满足断言），M4 才咬到它——两条不是重复。
 * - **M21** 把暗色类提到公共前缀（两套类合流）→ **2 红**（实心数 / 类不串）。
 *   **第一版这一刀是无效变异**：JSX 注释直接跟在属性后面造成语法错，跑出来
 *   `reds=0 / transform_failed=1`——那不是"0 红"，是刀根本没落下。挪成兄弟节点注释重打才红（M21b）。
 * - **M5** `place.affiliation &&` → `!== null`（空串也算有内容）→ **1 红**（affiliation 空串那条）。
 * - **M6** 上级门槛同样放宽 → **1 红**，而红的方式值得记：不是多出一句标签，是
 *   `TypeError: Cannot read properties of undefined (reading 'name')`——**整只弹窗当场抛**。
 *   "少一层守卫"的症状是白屏，不是丑屏。
 * - **M7 / M8** 子级、势力两道门槛各改成恒真 → **各只红自己那一条**：两块门槛是真两条判据，不是同一条凑两次。
 * - **M9** 子级徽章丢掉「(类型)」→ **2 红**（文案那条 + "有几条画几条"，后者找的正是 `属城5 (县)`）。
 * - **M10** 子级 `slice(0, 3)` → **1 红**（有几条画几条）。M9 与 M10 咬同一条用例的不同断言。
 * - **M11** 上级那一格也带上类型 → **1 红**（"只有名字，不带类型"）。
 * - **M12** 标题槽位换成 `place.type` → **1 红**（不互换那条：`text-lg` 是槽位的记号）。
 * - **M13** 描述槽位换成 `place.name` → **2 红**（描述原样 + 不互换那条，因为"洛阳"当场出现两次）。
 * - **M14 / M15** 分别摘掉 `aria-label="关闭"` 与 `onClick={onClose}` 的接线 → **各只红同一条用例的一半**
 *   （名字 / 调用）。同一条判据两半各有一把刀。
 * - **M16** 遮罩换回旧的"垂直居中、自己不滚"形状 → **1 红**（遮罩那条，两个断言一起）。
 * - **M17** 卡片摘掉 `shrink-0` → **1 红**；**M18** 摘掉 `break-words` → **1 红**。
 * - **M19** 摘掉 `data-testid="place-detail"` → **3 红**：三条用例都拿它定位那张卡（e2e 的 G4b 是第四个
 *   使用者）。这不是判据重叠，是"那个属性一掉，四件事一起没抓手"的形状。
 * - **M20** "简化"掉「下级地点：」那一句标题（下面徽章都还在）→ **只红"地基"那一条**——即
 *   "全都齐着时四块都在"有自己的哨兵，它不是恒真的开场白。
 *
 * **没打到的**：`Badge` / `Card` / `Button` 三只壳的内部（各自有契约判据，见 `ui/__tests__`）；
 * `variant` 写错（`outline` ↔ `secondary`）——颜色差一级，本文件没有一条判据看颜色，**如实记着**；
 * 遮罩的 `z-[10000]` 与 `bg-black/50`（谁盖住谁是浏览器层的事，jsdom 里恒真）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlaceDetail } from "../PlaceDetail";

type Place = Parameters<typeof PlaceDetail>[0]["place"];
type Layer = Parameters<typeof PlaceDetail>[0]["layers"][number];
type Mini = { id: string; name: string; type: string };

const PLACE: Place = {
  id: "p-1",
  name: "洛阳",
  type: "都城",
  level: 2,
  parentId: "p-0",
  description: "九朝古都，漕运的起点。",
  importance: 6,
  affiliation: "朝廷",
};

/** 顺序**故意**不按 level 升序：按数组下标取层级名的写法在这里必红 */
const LAYERS: Layer[] = [
  { level: 3, name: "府县", description: "" },
  { level: 1, name: "天下", description: "" },
  { level: 2, name: "道", description: "" },
];

const CHILD: Mini[] = [
  { id: "c-1", name: "河南府", type: "府" },
  { id: "c-2", name: "洛阳县", type: "县" },
];
const FORCE: Mini[] = [{ id: "f-1", name: "东都漕帮", type: "帮会" }];

function detail(over: Partial<Parameters<typeof PlaceDetail>[0]> = {}) {
  const onClose = vi.fn();
  const { container } = render(
    <PlaceDetail
      place={PLACE}
      layers={LAYERS}
      parentPlace={{ id: "p-0", name: "关东道", type: "道" }}
      childPlaces={CHILD}
      forces={FORCE}
      onClose={onClose}
      {...over}
    />
  );
  return { container, onClose };
}

/** 重要程度那一行：从标签走到那一排圆点（整页只有这一处 `div.rounded-full` 挂在标签同一行里） */
function dots(): HTMLElement[] {
  const row = screen.getByText("重要程度：").parentElement as HTMLElement;
  return [...row.querySelectorAll("div.rounded-full")] as HTMLElement[];
}
const litCount = () => dots().filter((d) => d.className.includes("bg-primary")).length;

beforeEach(cleanup);
afterEach(cleanup);

describe("层级名：按 level 查、查不到要兜底", () => {
  it("取的是 level 相等那一条的名字，不是数组里第 level 个", () => {
    detail();
    expect(screen.getByText("道")).toBeTruthy();
    expect(screen.queryByText("府县"), "按 index 取就会拿到 0 号那一格").toBeNull();
  });

  it("同一批层级里换 level，徽章跟着换（证明真的在查表）", () => {
    detail({ place: { ...PLACE, level: 3 } });
    expect(screen.getByText("府县")).toBeTruthy();
    cleanup();
    detail({ place: { ...PLACE, level: 1 } });
    expect(screen.getByText("天下")).toBeTruthy();
  });

  it("level 越界（模型报了个 layers 里没有的层）时兜底成「层级 N」，不许空白也不许 undefined", () => {
    detail({ place: { ...PLACE, level: 7 } });
    const badge = screen.getByText("层级 7");
    expect(badge).toBeTruthy();
    expect(badge.textContent).not.toMatch(/undefined|null/);
  });

  it("layers 是空数组时同样兜底（不炸、不空）", () => {
    detail({ layers: [] });
    expect(screen.getByText("层级 2")).toBeTruthy();
  });

  it("level 撞名时取找到的第一条（find 的口径，别改成最后一条）", () => {
    detail({
      layers: [
        { level: 2, name: "道·前", description: "" },
        { level: 2, name: "道·后", description: "" },
      ],
    });
    expect(screen.getByText("道·前")).toBeTruthy();
    expect(screen.queryByText("道·后")).toBeNull();
  });
});

describe("重要程度：恒十格，实心数跟着 importance", () => {
  it("不管 importance 是几，都画十格", () => {
    detail();
    expect(dots()).toHaveLength(10);
    cleanup();
    detail({ place: { ...PLACE, importance: 12 } });
    expect(dots()).toHaveLength(10);
  });

  it("实心数＝importance，剩下的是暗的", () => {
    detail({ place: { ...PLACE, importance: 3 } });
    expect(litCount()).toBe(3);
    expect(dots().filter((d) => d.className.includes("bg-muted"))).toHaveLength(7);
  });

  it("越界向上（12）时十格全实心", () => {
    detail({ place: { ...PLACE, importance: 12 } });
    expect(litCount()).toBe(10);
  });

  it("0 与负数都是全暗（实心那一支不许在 importance=0 时亮起来）", () => {
    detail({ place: { ...PLACE, importance: 0 } });
    expect(litCount()).toBe(0);
    cleanup();
    detail({ place: { ...PLACE, importance: -3 } });
    expect(litCount()).toBe(0);
  });

  it("明暗两套类不串：实心的那一格不许同时带暗色类", () => {
    detail();
    expect(dots().filter((d) => d.className.includes("bg-primary") && d.className.includes("bg-muted")))
      .toHaveLength(0);
  });
});

describe("四块内容各自的条件：没内容时连标签都不许留下", () => {
  it("全都齐着时四块都在（这一条是下面几刀的地基：少画一块先在这里红）", () => {
    detail();
    for (const label of ["所属势力：", "上级区域：", "下级地点：", "相关势力："]) {
      expect(screen.getByText(label), label).toBeTruthy();
    }
  });

  it("affiliation 空串 ⇒ 整块不出现（调用点给的就是空串，不是 undefined）", () => {
    detail({ place: { ...PLACE, affiliation: "" } });
    expect(screen.queryByText("所属势力：")).toBeNull();
    expect(screen.queryByText("朝廷")).toBeNull();
  });

  it("parentPlace 是 undefined ⇒ 没有「上级区域：」这句（上级没找到时按顶级放置）", () => {
    detail({ parentPlace: undefined });
    expect(screen.queryByText("上级区域：")).toBeNull();
    expect(screen.queryByText("关东道")).toBeNull();
  });

  it("childPlaces 空数组 ⇒ 标题句也不出现", () => {
    detail({ childPlaces: [] });
    expect(screen.queryByText("下级地点：")).toBeNull();
  });

  it("forces 空数组 ⇒ 标题句也不出现", () => {
    detail({ forces: [] });
    expect(screen.queryByText("相关势力：")).toBeNull();
  });
});

describe("徽章文案与数据来源：不许串、不许截", () => {
  it("子级与势力都写「名 (类型)」，半角括号带一个空格", () => {
    detail();
    expect(screen.getByText("河南府 (府)")).toBeTruthy();
    expect(screen.getByText("东都漕帮 (帮会)")).toBeTruthy();
  });

  it("子级有几条画几条（不许学别处 slice(0, 3)）", () => {
    detail({
      childPlaces: Array.from({ length: 6 }, (_, i) => ({ id: `c-${i}`, name: `属城${i}`, type: "县" })),
    });
    expect(screen.getByText("属城5 (县)")).toBeTruthy();
  });

  it("上级那一格只有名字，不带类型（与子级两行的形状不是一回事）", () => {
    detail();
    expect(screen.getByText("关东道")).toBeTruthy();
    expect(screen.queryByText("关东道 (道)")).toBeNull();
  });

  it("标题取 place.name、类型徽章取 place.type，两处不互换", () => {
    detail();
    // 串了的形状是"洛阳"掉进徽章那一格：`text-lg` 只写在 CardTitle 上，所以拿它当槽位的记号
    expect(screen.getAllByText("洛阳")).toHaveLength(1);
    expect(screen.getAllByText("都城")).toHaveLength(1);
    expect(screen.getByText("洛阳").classList.contains("text-lg")).toBe(true);
    expect(screen.getByText("都城").classList.contains("text-lg")).toBe(false);
  });

  it("描述原样上屏", () => {
    detail({ place: { ...PLACE, description: "原样的一句话" } });
    expect(screen.getByText("原样的一句话")).toBeTruthy();
  });
});

describe("关闭出口与那张卡的形状", () => {
  it("关闭按钮有可访问名「关闭」，点它调 onClose 一发", () => {
    const { onClose } = detail();
    const btn = screen.getByRole("button", { name: "关闭" });
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("卡上有 data-testid=place-detail（浏览器层 G4b 靠它定位）", () => {
    detail();
    expect(screen.getByTestId("place-detail")).toBeTruthy();
  });

  it("遮罩自己能纵向滚，且不再用 items-center 居中（那是关不掉的弹窗的形状）", () => {
    const { container } = detail();
    const mask = container.firstElementChild as HTMLElement;
    expect(mask.classList.contains("overflow-y-auto")).toBe(true);
    expect(mask.classList.contains("items-center")).toBe(false);
  });

  it("卡片带 my-auto + shrink-0（空间够时居中、不够时从顶部排）", () => {
    detail();
    const card = screen.getByTestId("place-detail");
    expect(card.classList.contains("my-auto")).toBe(true);
    expect(card.classList.contains("shrink-0")).toBe(true);
  });

  it("长词折断写在卡上，不在遮罩上（overflow-wrap 是继承属性，一处管住标题徽章和描述）", () => {
    const { container } = detail();
    const mask = container.firstElementChild as HTMLElement;
    expect(screen.getByTestId("place-detail").classList.contains("break-words")).toBe(true);
    expect(mask.classList.contains("break-words")).toBe(false);
  });
});
