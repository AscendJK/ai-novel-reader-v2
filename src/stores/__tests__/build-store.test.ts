/**
 * 构建状态 store 的清理逻辑（round 2 批次 4 / R-25）
 *
 * 轮询要求 sync-token 且离线时直接 return；一旦中途失联，就再没人给"构建中"的
 * 条目收尾——状态窗口永远转圈、构建按钮永久禁用，直到刷新页面。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useBuildStore } from "../build-store";

const KEY_NOVEL = "novel-1";
const ENGINE = "Xenova/bge-small-zh-v1.5";

function statusOf(novelId = KEY_NOVEL, engine = ENGINE) {
  return useBuildStore.getState().builds.get(`${novelId}-${engine}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
  useBuildStore.setState({ builds: new Map() });
});

describe("cleanupCompleted 对僵死构建的判定", () => {
  it("20 分钟没有任何推进的进行中构建被判为错误", () => {
    const s = useBuildStore.getState();
    s.startBuild(KEY_NOVEL, ENGINE);
    vi.advanceTimersByTime(21 * 60 * 1000);
    useBuildStore.getState().cleanupCompleted();

    const build = statusOf();
    expect(build?.status).toBe("error");
    expect(build?.error).toContain("重新构建");
    expect(useBuildStore.getState().isBuilding(KEY_NOVEL, ENGINE)).toBe(false);
  });

  it("期间有推进的长构建不被误杀", () => {
    const s = useBuildStore.getState();
    s.startBuild(KEY_NOVEL, ENGINE);
    vi.advanceTimersByTime(15 * 60 * 1000);
    s.updateProgress(KEY_NOVEL, ENGINE, { status: "encoding", current: 900, total: 3000, message: "编码中" });
    vi.advanceTimersByTime(10 * 60 * 1000);
    useBuildStore.getState().cleanupCompleted();

    expect(statusOf()?.status).toBe("encoding");
  });

  it("完成超过 1 小时的条目被移出", () => {
    const s = useBuildStore.getState();
    s.startBuild(KEY_NOVEL, ENGINE);
    s.finishBuild(KEY_NOVEL, ENGINE);
    vi.advanceTimersByTime(61 * 60 * 1000);
    useBuildStore.getState().cleanupCompleted();

    expect(statusOf()).toBeUndefined();
  });

  it("刚失败的条目保留（用户要能看到原因并重试）", () => {
    const s = useBuildStore.getState();
    s.startBuild(KEY_NOVEL, ENGINE);
    s.failBuild(KEY_NOVEL, ENGINE, "磁盘满");
    vi.advanceTimersByTime(5 * 60 * 1000);
    useBuildStore.getState().cleanupCompleted();

    expect(statusOf()?.error).toBe("磁盘满");
  });
});
