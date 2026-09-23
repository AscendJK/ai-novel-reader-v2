// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * 备份导出与导入。
 *
 * 为什么单独钉：这条链是"用户把全部家当交出去、再原样收回来"的那一条，而覆盖地板量下来它
 * 一行判据都没有（`lib/export.ts` 在浏览器层只被加载过、没人断言过它说过的话）。里面躺着两处
 * 已经修过的病因：round 2 R-16（`maps`/`graphs`/阅读进度此前不在备份范围内，用备份恢复过的人
 * 图谱与位置静默消失）与"结构校验先于事务"（一份被截断的 JSON 直接进事务会炸在半途，留下
 * 半成品库）。
 */
import { exportAllAsJSON, exportNovelAsTXT, importFromJSON } from "@/lib/export";
import { setCurrentUser, getUserDB, sharedDB } from "@/db/database";

const ME = "export-import-me";
const OTHER = "export-import-other";

const blobOf = async (b: Blob) => await b.text();
let captured: Blob[] = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem("sync-username", ME);
  setCurrentUser(ME);
  captured = [];
  // jsdom 没有 createObjectURL；不接住的话 download() 第一步就抛，测不到真正要判的东西
  URL.createObjectURL = ((b: Blob) => {
    captured.push(b);
    return "blob:captured";
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as unknown as typeof URL.revokeObjectURL;
  const udb = getUserDB();
  await Promise.all([udb.novels.clear(), udb.chapters.clear(), udb.summaries.clear(), udb.notes.clear(), udb.maps.clear(), udb.graphs.clear()]);
  await sharedDB.settings.clear();
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.restoreAllMocks();
});

const jsonFile = (obj: unknown) => new File([JSON.stringify(obj)], "backup.json", { type: "application/json" });

describe("备份导出", () => {
  it("全盘备份里不许有 API 配置与 Key，但图谱/地图/阅读进度必须在（R-16）", async () => {
    const udb = getUserDB();
    await udb.novels.put({ id: "b1", title: " book one ", chapterCount: 2 } as never);
    await udb.maps.put({ id: "m1", novelId: "b1", title: "地图" } as never);
    await udb.graphs.put({ id: "g1", novelId: "b1", title: "图谱" } as never);
    localStorage.setItem(`novel-reader-positions:${ME}`, JSON.stringify({ b1: { chapter: 3 } }));
    await sharedDB.settings.bulkPut([
      { key: "theme", value: "dark" },
      { key: `api-providers:${ME}`, value: [{ apiKey: "sk-绝不外流" }] },
      { key: `api-active-provider:${ME}`, value: "p1" },
    ] as never);

    await exportAllAsJSON();
    expect(captured).toHaveLength(1);
    const data = JSON.parse(await blobOf(captured[0]));
    // 敏感那一半：整份文本里不许出现 Key，连键名也不许（键名带着用户名）
    expect(JSON.stringify(data)).not.toContain("sk-绝不外流");
    expect(data.settings.map((s: { key: string }) => s.key)).toEqual(["theme"]);
    // 曾经静默消失的那一半
    expect(data.maps).toHaveLength(1);
    expect(data.graphs).toHaveLength(1);
    expect(data.readingPositions).toEqual({ b1: { chapter: 3 } });
    expect(data.username).toBe(ME);
  });

  it("TXT 导出按章节 index 排，不按插入顺序", async () => {
    const udb = getUserDB();
    await udb.novels.put({ id: "b1", title: "书名", author: "作者" } as never);
    // 故意先插第二章
    await udb.chapters.bulkPut([
      { id: "c2", novelId: "b1", index: 1, title: "第二章", content: "潮落" },
      { id: "c1", novelId: "b1", index: 0, title: "第一章", content: "风起" },
    ] as never);

    await exportNovelAsTXT("b1");
    const text = await blobOf(captured[0]);
    expect(text.indexOf("第一章")).toBeLessThan(text.indexOf("第二章"));
    expect(text).toContain("作者: 作者");
    expect(text).toContain("风起");
  });
});

describe("备份导入：坏输入不许留下半成品库", () => {
  it("JSON 语法就坏了 → 报「格式无效」，库里一条不动", async () => {
    const udb = getUserDB();
    await udb.novels.put({ id: "keep", title: "原有的书" } as never);
    await expect(importFromJSON(new File(["{不是 JSON"], "b.json"))).rejects.toThrow(/格式无效/);
    expect(await udb.novels.get("keep")).toBeTruthy();
    expect(await udb.novels.count()).toBe(1);
  });

  it("某字段不是数组 → 中止，且明确说未改动任何数据", async () => {
    const udb = getUserDB();
    await udb.novels.put({ id: "keep", title: "原有的书" } as never);
    await expect(
      importFromJSON(jsonFile({ novels: [{ id: "新来的", title: "新来的" }], maps: { 不是: "数组" } })),
    ).rejects.toThrow(/maps 不是数组，已中止导入（未改动任何数据）/);
    // 这句承诺要真兑现：novels 排在校验列表前面，先校验后写才谈得上"未改动"
    expect(await udb.novels.count()).toBe(1);
    expect(await udb.novels.get("新来的")).toBeUndefined();
  });

  it("既没书也没章节 → 不像本应用的备份，直接拒", async () => {
    await expect(importFromJSON(jsonFile({ settings: [{ key: "theme", value: "x" }] }))).rejects.toThrow(/不像本应用的备份文件/);
  });

  it("正常备份：计数如实，缺 updatedAt 的地图/图谱要补上（否则同步永远收不到）", async () => {
    const udb = getUserDB();
    const counts = await importFromJSON(
      jsonFile({
        novels: [{ id: "b1", title: "回来的书" }],
        chapters: [{ id: "c1", novelId: "b1", index: 0, title: "第一章", content: "风" }],
        summaries: [{ id: "s1", novelId: "b1", chapterId: "c1", content: "总结" }],
        notes: [{ id: "n1", novelId: "b1", content: "笔记" }],
        maps: [{ id: "m1", novelId: "b1", title: "地图" }],
        graphs: [{ id: "g1", novelId: "b1", title: "图谱" }],
      }),
    );
    expect(counts).toEqual({ novels: 1, chapters: 1, summaries: 1, notes: 1, maps: 1, graphs: 1 });
    for (const [table, id] of [["summaries", "s1"], ["notes", "n1"], ["maps", "m1"], ["graphs", "g1"]] as const) {
      const row = await udb[table].get(id);
      expect(typeof row?.updatedAt, `${table} 的 updatedAt`).toBe("number");
    }
    // 备份里已带 updatedAt 的不许被覆盖成"现在"（`novels: []` 是为了过"既没书也没章节"那道闸）
    const stamp = 1_600_000_000_000;
    await importFromJSON(jsonFile({ novels: [], maps: [{ id: "m2", novelId: "b1", updatedAt: stamp }] }));
    expect((await udb.maps.get("m2"))?.updatedAt).toBe(stamp);
  });

  it("阅读进度一律落在当前登录用户名下，备份里那个 username 不许把进度灌进本账号", async () => {
    const reload = vi.fn();
    const store = await import("@/stores/novel-store");
    vi.spyOn(store.useNovelStore, "getState").mockReturnValue({ reloadReadingPositions: reload } as never);
    localStorage.setItem(`novel-reader-positions:${ME}`, JSON.stringify({ mine: { chapter: 1 } }));

    await importFromJSON(
      jsonFile({ novels: [{ id: "b1", title: "别人的书" }], username: OTHER, readingPositions: { theirs: { chapter: 9 } } }),
    );

    // 键必须是当前用户那一份：写进 `${OTHER}` 等于两个人共用一份进度
    const mine = JSON.parse(localStorage.getItem(`novel-reader-positions:${ME}`) ?? "{}");
    expect(mine).toEqual({ mine: { chapter: 1 }, theirs: { chapter: 9 } });
    expect(localStorage.getItem(`novel-reader-positions:${OTHER}`)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
