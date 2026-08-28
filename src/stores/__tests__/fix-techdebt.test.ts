import { describe, it, expect, beforeEach } from "vitest";
import { useNovelStore } from "../novel-store";
import { userKey } from "@/lib/user-utils";

describe("技术债修复验证: setCurrentNovel/reloadReadingPositions", () => {
  const novel1: any = {
    id: "novel-1",
    chapters: [
      { id: "c0", index: 0 },
      { id: "c1", index: 1 },
      { id: "c2", index: 2 },
      { id: "c3", index: 3 },
    ],
  };

  beforeEach(() => {
    localStorage.setItem("sync-username", "testuser");
    useNovelStore.setState({ currentNovel: null, novels: [], readingPositions: {} });
    localStorage.removeItem(userKey("novel-reader-positions"));
  });

  it("技术债3: 定位到已有进度时不刷新 updatedAt", () => {
    const T = 1234567;
    useNovelStore.setState({
      novels: [novel1],
      readingPositions: { "novel-1": { chapterId: "c3", chapterIndex: 3, scrollTop: 500, updatedAt: T } },
    });
    useNovelStore.getState().setCurrentNovel(novel1);
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    expect(pos.chapterId).toBe("c3");
    expect(pos.updatedAt).toBe(T); // 关键断言：不再刷新成 Date.now()
  });

  it("技术债3: 无本地进度时(章节变化)仍刷新 updatedAt", () => {
    useNovelStore.setState({ novels: [novel1], readingPositions: {} });
    useNovelStore.getState().setCurrentNovel(novel1);
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    expect(pos.chapterIndex).toBe(0); // 回落到第一章
    expect(pos.updatedAt).toBeGreaterThan(0); // 有新时间戳
  });

  it("技术债2: reloadReadingPositions 按 updatedAt 合并，store 旧进度不覆盖服务器新进度", () => {
    const T_server = 999999;
    const T_local_old = 1; // store 里残留的过旧进度
    // 模拟 applyServerData 已把服务器新进度写入 localStorage
    localStorage.setItem(userKey("novel-reader-positions"),
      JSON.stringify({ "novel-1": { chapterId: "c3", chapterIndex: 3, scrollTop: 100, updatedAt: T_server } }));
    // store 里残留更旧的本地位
    useNovelStore.setState({
      novels: [novel1],
      readingPositions: { "novel-1": { chapterId: "c0", chapterIndex: 0, scrollTop: 999, updatedAt: T_local_old } },
    });
    useNovelStore.getState().reloadReadingPositions();
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    // 服务器进度（updatedAt 更新）应胜出
    expect(pos.chapterId).toBe("c3");
    expect(pos.chapterIndex).toBe(3);
  });

  it("技术债2: reloadReadingPositions 保留更本地的进度（本地 updatedAt 更新）", () => {
    const T_local_new = 999999;
    const T_server = 1;
    localStorage.setItem(userKey("novel-reader-positions"),
      JSON.stringify({ "novel-1": { chapterId: "c1", chapterIndex: 1, updatedAt: T_server } }));
    useNovelStore.setState({
      novels: [novel1],
      readingPositions: { "novel-1": { chapterId: "c3", chapterIndex: 3, scrollTop: 50, updatedAt: T_local_new } },
    });
    useNovelStore.getState().reloadReadingPositions();
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    // 本地（updatedAt 更新）应胜出，且保留本地独有字段 scrollTop
    expect(pos.chapterId).toBe("c3");
    expect(pos.chapterIndex).toBe(3);
    expect(pos.scrollTop).toBe(50);
  });

  it("技术债2: reloadReadingPositions 合并保留各自独有字段", () => {
    const T = 100;
    localStorage.setItem(userKey("novel-reader-positions"),
      JSON.stringify({ "novel-1": { chapterId: "c1", chapterIndex: 1, scrollTop: 10, updatedAt: T } }));
    useNovelStore.setState({
      novels: [novel1],
      readingPositions: { "novel-1": { chapterId: "c1", chapterIndex: 1, chapterOffset: 20, updatedAt: T } },
    });
    useNovelStore.getState().reloadReadingPositions();
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    expect(pos.scrollTop).toBe(10); // 来自 loaded
    expect(pos.chapterOffset).toBe(20); // 来自 store
  });
});
