/**
 * refreshSession：给非同步链路（AI 代理）用的会话续期入口。
 *
 * 后端会话在内存 Map 里，重启即全灭；此时 localStorage 还留着旧 token，
 * 于是"看着登录着、每个要登录的请求都 401"。同步链路自己会重注册，AI 链路
 * 需要同一个能力——但必须单飞：一次生成会并发发好几个请求，各自 401 后统统去
 * 重注册，就会变成注册风暴。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api-client";
import { SyncClient } from "../sync-client";

const mockFetch = vi.mocked(apiFetch);

function scriptRegister(tokenPrefix = "tok") {
  let calls = 0;
  mockFetch.mockImplementation(async (path: string) => {
    if (String(path).includes("/register")) {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return {
        ok: true,
        status: 200,
        json: async () => ({ clientId: "device-1", token: `${tokenPrefix}-${calls}`, activeCount: 1 }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
  return () => calls;
}

beforeEach(() => {
  localStorage.clear();
  mockFetch.mockReset();
});

describe("SyncClient.refreshSession", () => {
  it("未登录（无 username）时直接 false，不发任何请求", async () => {
    expect(await new SyncClient().refreshSession()).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("并发续期只重注册一次，且两路都拿到成功", async () => {
    localStorage.setItem("sync-username", "session-user");
    localStorage.setItem("sync-clientId", "device-1");
    const registerCalls = scriptRegister();
    const client = new SyncClient();

    const [a, b] = await Promise.all([client.refreshSession(), client.refreshSession()]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(registerCalls()).toBe(1);
    expect(localStorage.getItem("sync-token")).toBe("tok-1");
  });

  it("注册失败时返回 false（调用方据此报「会话失效」，不能谎报成功）", async () => {
    localStorage.setItem("sync-username", "session-user");
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);

    expect(await new SyncClient().refreshSession()).toBe(false);
  });
});
