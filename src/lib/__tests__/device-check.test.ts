/**
 * 真机自检模块的纯逻辑测试（清单/事实/导出/探针）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEVICE_CHECKLIST, buildReport, loadCheckState, saveCheckState,
  installProbes, collectFacts, type Fact,
} from "../device-check";

vi.mock("@/tts/tts-manager", () => ({
  getActiveTTSManager: () => null,
}));

function makeFacts(): Fact[] {
  return [
    { label: "crossOriginIsolated / SharedArrayBuffer", value: "false / true", level: "ok" },
    { label: "存储配额", value: "剩余 120.0MB", level: "warn" },
    { label: "系统语音（Web Speech）", value: "0 个 voice，其中中文 0 个", level: "bad" },
  ];
}

beforeEach(() => {
  localStorage.clear();
});

describe("清单与勾选状态", () => {
  it("每项都有唯一 id 与「怎么做/应看到」两段说明", () => {
    const ids = DEVICE_CHECKLIST.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of DEVICE_CHECKLIST) {
      expect(item.how.length).toBeGreaterThan(5);
      expect(item.expect.length).toBeGreaterThan(5);
    }
  });

  it("清单覆盖批次 5 遗留的 iOS 关键场景", () => {
    const ids = DEVICE_CHECKLIST.map((i) => i.id);
    for (const must of ["resume-after-interrupt", "double-tap-continue", "mute-switch", "background-restore", "auto-next-chapter", "rate-change-while-paused", "offline-cold-start"]) {
      expect(ids).toContain(must);
    }
  });

  it("勾选状态持久化到 localStorage 并可回读", () => {
    expect(loadCheckState()).toEqual({});
    saveCheckState({ "mute-switch": true });
    expect(loadCheckState()["mute-switch"]).toBe(true);
  });
});

describe("buildReport", () => {
  it("导出文本含事实、级别标记与勾选状态", () => {
    const text = buildReport(makeFacts(), { "mute-switch": true });
    expect(text).toContain("环境事实");
    expect(text).toContain("crossOriginIsolated / SharedArrayBuffer: false / true");
    expect(text).toContain("✱ 系统语音");     // bad 级别带醒目前缀
    expect(text).toContain("✅ 侧边静音键两种位置各试一次");
    expect(text).toContain("⬜");
  });

  it("事实尚未采集时也不崩（只有清单）", () => {
    const text = buildReport([], {});
    expect(text).toContain("【环境事实】");
    expect(text).toContain("【手动清单】");
  });
});

describe("collectFacts", () => {
  it("至少给出 COI、存储、IndexedDB、语音、运行时几项，且每项有级别", async () => {
    const facts = await collectFacts();
    const labels = facts.map((f) => f.label).join("|");
    expect(labels).toContain("crossOriginIsolated");
    expect(labels).toContain("IndexedDB 可写");
    expect(labels).toContain("朗读运行时");
    for (const f of facts) expect(["ok", "warn", "bad", "info"]).toContain(f.level);
  });

  it("没有朗读会话时运行时项给出可行动的说明，而不是抛错", async () => {
    const facts = await collectFacts();
    const runtime = facts.find((f) => f.label === "朗读运行时");
    expect(runtime?.value).toContain("没有朗读会话");
  });
});

describe("installProbes", () => {
  let lines: string[];
  beforeEach(() => { lines = []; });
  afterEach(() => { vi.restoreAllMocks(); });

  it("记录可见性与页面存活事件，卸载后不再记录", () => {
    const off = installProbes((l) => lines.push(l));
    expect(lines.some((l) => l.includes("探针已挂载"))).toBe(true);

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("freeze"));
    expect(lines.some((l) => l.includes("visibilitystate") || l.includes("可见性"))).toBe(true);
    expect(lines.some((l) => l.includes("pagehide"))).toBe(true);
    expect(lines.some((l) => l.includes("冻结"))).toBe(true);

    off();
    const n = lines.length;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(lines.length).toBe(n);
  });

  it("未捕获的 Promise 拒绝进入时间线（iOS 上这是唯一线索）", () => {
    const off = installProbes((l) => lines.push(l));
    // 只把 reason 交给监听器；promise 字段用已解决的 promise，否则会造出真·未处理拒绝
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve(),
      reason: new Error("boom"),
    }));
    expect(lines.some((l) => l.includes("boom"))).toBe(true);
    off();
  });
});
