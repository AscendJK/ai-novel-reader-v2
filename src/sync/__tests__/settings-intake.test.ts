/**
 * 服务器下发进来的 settings 落不落进这台机器（`sync-bridge.ts` 的 `applyServerData`）
 *
 * 这是"后端有问题或被换掉"时**最后那道客户端闸门**：钥匙与"请求发去哪"只能由用户自己在
 * 界面上填。写这一档之前它一条判据都没有（同名的 `sync-bridge.test.ts` 那 82 行判的是
 * dedup 工具函数），而它挡的形状是"外来一把 key，这台机器之后所有 AI 请求的去向被人改走"。
 * 备份导入那一侧的同一判点有 e2e 的 D15 盯着，同步这一侧没有——所以两边都得有。
 *
 * 口径（制作人 2026-09-24 定，`lib/export.ts:172` 那段注释是同一口径）：**丢弃要数得出来，
 * 不许静默**。导入那一侧已经做到（回执文案带条数），同步这一侧原先只有一行
 * `console.warn`——本批先立红的就是这一格：屏上得看得见。
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setCurrentUser, sharedDB } from "@/db/database";
import { applyServerData } from "../sync-bridge";

const showToast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast-store", () => ({ showToast }));

const USER = "intake-user";
/** 外来的那一把：值里带 key 与 baseUrl，正是"改掉请求去向"需要的两样东西 */
const INCOMING_PROVIDERS = [
  { name: "外来服务商", apiKey: "sk-外来钥匙", baseUrl: "https://attacker.invalid/v1" },
];

const rows = async () => (await sharedDB.settings.toArray()).map((r) => r.key).sort();

describe("同步下发的 settings：敏感的一律不落地，并且要当着用户的面丢", () => {
  beforeEach(async () => {
    showToast.mockClear();
    setCurrentUser(USER);
    localStorage.setItem("sync-username", USER);
    await sharedDB.settings.clear();
  });

  it("带钥匙与地址的服务商配置不许进这台机器的库", async () => {
    await applyServerData({
      settings: { [`api-providers:${USER}`]: INCOMING_PROVIDERS },
    } as never);
    expect(await sharedDB.settings.get(`api-providers:${USER}`), "钥匙进了库=这台机器的请求去向被改走").toBeUndefined();
  });

  it("没带用户名前缀的那种写法同样要挡住（判点与前缀无关）", async () => {
    await applyServerData({
      settings: { "api-providers": INCOMING_PROVIDERS, "api-active-provider": "外来服务商" },
    } as never);
    expect(await rows(), "裸键与带 `:用户名` 的键是同一道闸门").toEqual([]);
  });

  it("同一包里正常的设置照常落地，还要按用户加前缀（不许把整包一起丢掉）", async () => {
    await applyServerData({
      settings: { theme: "dark", [`font-size:${USER}`]: 18 },
    } as never);
    expect(await rows()).toEqual([`font-size:${USER}`, `theme:${USER}`]);
  });

  it("丢了东西就要在屏上说，并且报出条数", async () => {
    await applyServerData({
      settings: {
        theme: "dark",
        [`api-providers:${USER}`]: INCOMING_PROVIDERS,
        [`api-active-provider:${USER}`]: "外来服务商",
      },
    } as never);
    const calls = showToast.mock.calls.map((c) => String(c[0]));
    expect(calls.join(" | "), `丢了两条敏感配置必须给回执，实际：${JSON.stringify(calls)}`).toMatch(/API 配置/);
    expect(calls.join(" | ")).toMatch(/2/);
  });

  it("一条都没丢时不许凭空弹回执", async () => {
    await applyServerData({ settings: { theme: "dark" } } as never);
    expect(showToast).not.toHaveBeenCalled();
  });
});
