/**
 * /leave 补发队列测试（round 2 批次 1b / R-17 删除侧）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { userKey } from "@/lib/user-utils";
import { setCurrentUser } from "@/db/database";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { enqueuePendingLeave, getPendingLeaves, clearPendingLeave, flushPendingLeaves } from "../pending-leave";

const KEY = "novel-reader-pending-leave";

beforeEach(() => {
  apiFetchMock.mockReset();
  localStorage.setItem("sync-username", "alice");
  setCurrentUser("alice");
  localStorage.removeItem(userKey(KEY));
});

afterEach(() => {
  localStorage.removeItem(userKey("novel-reader-pending-leave"));
  localStorage.removeItem("sync-username");
});

describe("pending leave 队列", () => {
  it("入队去重并可读回", () => {
    enqueuePendingLeave("n1");
    enqueuePendingLeave("n1");
    enqueuePendingLeave("n2");
    expect(getPendingLeaves()).toEqual(["n1", "n2"]);
  });

  it("网络失败时队列原样保留", async () => {
    enqueuePendingLeave("n1");
    apiFetchMock.mockRejectedValue(new Error("offline"));
    expect(await flushPendingLeaves()).toEqual([]);
    expect(getPendingLeaves()).toEqual(["n1"]);
  });

  it("服务器 404 视为已完成并出队", async () => {
    enqueuePendingLeave("n1");
    apiFetchMock.mockResolvedValue({ ok: false, status: 404 });
    expect(await flushPendingLeaves()).toEqual(["n1"]);
    expect(getPendingLeaves()).toEqual([]);
  });

  it("500 不算完成，留在队列里下次再试", async () => {
    enqueuePendingLeave("n1");
    apiFetchMock.mockResolvedValue({ ok: false, status: 500 });
    expect(await flushPendingLeaves()).toEqual([]);
    expect(getPendingLeaves()).toEqual(["n1"]);
  });

  it("逐个补发，中途断网则已成功的出队、其余保留", async () => {
    enqueuePendingLeave("n1");
    enqueuePendingLeave("n2");
    apiFetchMock
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error("offline"));
    expect(await flushPendingLeaves()).toEqual(["n1"]);
    expect(getPendingLeaves()).toEqual(["n2"]);
  });

  it("队列按用户隔离，不会把别人的待删清单灌进本账号", async () => {
    enqueuePendingLeave("n1");
    setCurrentUser("bob");
    localStorage.setItem("sync-username", "bob");
    expect(getPendingLeaves()).toEqual([]);
    clearPendingLeave("n1"); // bob 名下不该动到 alice 的条目
    setCurrentUser("alice");
    localStorage.setItem("sync-username", "alice");
    expect(getPendingLeaves()).toEqual(["n1"]);
  });
});
