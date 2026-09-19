/**
 * SyncClient 水位与门控语义测试（批次 6：R-13 R-51 客户端侧）
 *
 * R-13：服务端因小说缺失而拒收（孤儿）时水位不提交，等补传后重试。
 *       但父小说既不在服务器也不在本地时补传永久无望——旧实现于是每轮重收重推
 *       同一批、水位与 last-push-time 永久不动，整条同步静默空转。
 *       现在最多让 3 轮，之后强制推进水位并留 warn。
 * R-51：登录冲突决策窗口的定时器同步门控必须可解除（客户端侧语义）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ merged: true, data: {} }) })),
}));

import { apiFetch } from "@/lib/api-client";
import { SyncClient } from "../sync-client";
import type { GatherResult } from "../sync-bridge";
import type { SyncData } from "../types";

const mockFetch = vi.mocked(apiFetch);

const USER = "watermark-user";
const SYNC_TIME_KEY = `novel-reader-last-sync-time:${USER}`;
const LAST_PUSH_KEY = `novel-reader-last-push-time:${USER}`;

function makeGather(): GatherResult {
  return {
    data: { summaries: [{ id: "s1", novelId: "n1", updatedAt: 5_000 }] } as Partial<SyncData>,
    hasMore: false,
    maxUpdatedAt: 5_000,
  };
}

function newClient(gather: () => Promise<GatherResult>) {
  localStorage.setItem("sync-username", USER);
  localStorage.setItem("sync-clientId", "device-1");
  localStorage.setItem(SYNC_TIME_KEY, "0");
  localStorage.removeItem(LAST_PUSH_KEY);
  const client = new SyncClient();
  client.start({
    gatherChanges: gather,
    applyData: async () => {},
    isAiRunning: () => false,
    onKicked: () => {},
  });
  return client;
}

/** 让 push 响应带上（或不带）孤儿小说 */
function respondWithOrphans(novelIds: string[] | undefined) {
  mockFetch.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ merged: true, data: {}, orphanedNovelIds: novelIds }),
  } as unknown as Response));
}

beforeEach(() => {
  localStorage.clear();
  mockFetch.mockClear();
  respondWithOrphans(undefined);
});

describe("R-13 孤儿水位", () => {
  it("孤儿最多让 3 轮不提交水位，第 4 轮强制推进并留日志", async () => {
    const gather = vi.fn(async () => makeGather());
    const client = newClient(gather);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respondWithOrphans(["missing-novel"]);

    for (let round = 1; round <= 3; round++) {
      expect(await client.syncOnce({ force: true })).toBe(true);
      expect(localStorage.getItem(SYNC_TIME_KEY)).toBe("0");   // 仍在等补传
    }

    expect(await client.syncOnce({ force: true })).toBe(true);
    expect(localStorage.getItem(SYNC_TIME_KEY)).not.toBe("0"); // 水位已推进
    expect(localStorage.getItem(LAST_PUSH_KEY)).not.toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain("孤儿记录");

    warn.mockRestore();
    client.stop();
  }, 20000);

  it("孤儿消失后计数归零：下一批孤儿仍可先等补传，不是一次性烧完额度", async () => {
    const gather = vi.fn(async () => makeGather());
    const client = newClient(gather);

    respondWithOrphans(["n-x"]);
    await client.syncOnce({ force: true });
    await client.syncOnce({ force: true });

    // 补传成功的一轮：无孤儿 → 提交水位并把计数清零
    respondWithOrphans(undefined);
    localStorage.setItem(SYNC_TIME_KEY, "0");
    expect(await client.syncOnce({ force: true })).toBe(true);
    expect(localStorage.getItem(SYNC_TIME_KEY)).not.toBe("0");

    // 再遇孤儿：应重新享有 3 轮等待额度，而不是立刻提交
    localStorage.setItem(SYNC_TIME_KEY, "0");
    respondWithOrphans(["n-y"]);
    expect(await client.syncOnce({ force: true })).toBe(true);
    expect(localStorage.getItem(SYNC_TIME_KEY)).toBe("0");

    client.stop();
  }, 20000);

  it("积压分批（hasMore）期间不提交水位，也不消耗孤儿额度", async () => {
    const gather = vi.fn(async (): Promise<GatherResult> => ({
      ...makeGather(),
      hasMore: true,
    }));
    const client = newClient(gather);
    respondWithOrphans(["n-z"]);

    for (let i = 0; i < 5; i++) {
      await client.syncOnce({ force: true });
    }
    expect(localStorage.getItem(SYNC_TIME_KEY)).toBe("0");

    client.stop();
  }, 20000);
});

describe("R-51 登录门控（客户端侧）", () => {
  it("门控只挡定时器驱动的同步，显式 force 与解除门控后照常同步", async () => {
    const gather = vi.fn(async () => makeGather());
    const client = newClient(gather);

    client.setTimerSyncGate(true);
    expect(await client.syncOnce()).toBe(false);
    expect(gather).not.toHaveBeenCalled();
    expect(await client.syncOnce({ force: true })).toBe(true);
    expect(gather).toHaveBeenCalledTimes(1);

    client.setTimerSyncGate(false);
    expect(await client.syncOnce()).toBe(true);
    expect(gather).toHaveBeenCalledTimes(2);

    client.stop();
  }, 20000);
});
