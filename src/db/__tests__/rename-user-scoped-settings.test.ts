/**
 * 改用户名时，存在 sharedDB.settings 里的按用户键要跟着搬家。
 *
 * API 配置是这套应用里唯一"永不上服务器"的数据（CLAUDE.md「API key 仅存浏览器」），
 * 所以它一旦落下就再也取不回来——不像小说，重新同步就回来了。
 * `migrateUserData` 把按用户分的 IndexedDB 整本搬进新库，`renameUserScopedKeys` 搬
 * localStorage，而共享库里这两只键谁都没管：症状与"登录后不重读配置"一模一样
 * （设置页显示"暂无 API 配置"），但刷新救不回来，因为键根本没搬。
 * 与 deleteUserData 第 6 步成对：那边按名删，这边按名搬。
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { sharedDB } from "../database";
import { renameUserScopedSettings } from "../repositories";

const OLD = "rename-old-user";
const NEW = "rename-new-user";
const OTHER = "bystander-user";

async function putSetting(key: string, value: unknown) {
  await sharedDB.settings.put({ key, value });
}

async function readSetting(key: string): Promise<{ exists: boolean; value?: unknown }> {
  const record = await sharedDB.settings.get(key);
  return record ? { exists: true, value: record.value } : { exists: false };
}

const PROVIDERS = [
  { id: "p1", name: "商一", apiKey: "sk-单元测试用", baseUrl: "http://a.invalid/v1", model: "m1" },
  { id: "p2", name: "商二", apiKey: "", baseUrl: "", model: "" },
];

beforeEach(async () => {
  await sharedDB.settings.clear();
});

describe("改名迁移 sharedDB 的按用户设置键", () => {
  it("两只 api 键搬到新用户名下，值原样", async () => {
    await putSetting(`api-providers:${OLD}`, PROVIDERS);
    await putSetting(`api-active-provider:${OLD}`, "p1");

    const moved = await renameUserScopedSettings(OLD, NEW);

    expect(moved).toBe(2);
    expect(await readSetting(`api-providers:${NEW}`)).toEqual({ exists: true, value: PROVIDERS });
    expect(await readSetting(`api-active-provider:${NEW}`)).toEqual({ exists: true, value: "p1" });
  });

  it("旧用户名下的键搬完就没了，不在共享库里留残留", async () => {
    await putSetting(`api-providers:${OLD}`, PROVIDERS);
    await putSetting(`api-active-provider:${OLD}`, "p1");

    await renameUserScopedSettings(OLD, NEW);

    expect((await readSetting(`api-providers:${OLD}`)).exists).toBe(false);
    expect((await readSetting(`api-active-provider:${OLD}`)).exists).toBe(false);
  });

  it("值为 null 的记录照样搬（配置存在与'当前未选用'是两件事）", async () => {
    await putSetting(`api-active-provider:${OLD}`, null);

    const moved = await renameUserScopedSettings(OLD, NEW);

    expect(moved).toBe(1);
    expect(await readSetting(`api-active-provider:${NEW}`)).toEqual({ exists: true, value: null });
  });

  it("别人的键一个都不许动", async () => {
    await putSetting(`api-providers:${OTHER}`, PROVIDERS);
    await putSetting(`api-active-provider:${OTHER}`, "pX");
    await putSetting("global-setting-no-username", "keep");

    const moved = await renameUserScopedSettings(OLD, NEW);

    expect(moved).toBe(0);
    expect((await readSetting(`api-providers:${OTHER}`)).value).toEqual(PROVIDERS);
    expect((await readSetting(`api-active-provider:${OTHER}`)).value).toBe("pX");
    expect((await readSetting("global-setting-no-username")).value).toBe("keep");
  });

  it("新用户名下已有配置时保留目标，不许拿旧名的去覆盖（key 毁掉就找不回来）", async () => {
    await putSetting(`api-providers:${OLD}`, PROVIDERS);
    const mine = [{ id: "z", name: "新用户自己的", apiKey: "sk-别覆盖我", baseUrl: "", model: "" }];
    await putSetting(`api-providers:${NEW}`, mine);

    const moved = await renameUserScopedSettings(OLD, NEW);

    expect(moved).toBe(0);
    expect((await readSetting(`api-providers:${NEW}`)).value).toEqual(mine);
    // 来源原样留着：宁可留一份看得见残留，也不静默毁掉任何一边
    expect((await readSetting(`api-providers:${OLD}`)).value).toEqual(PROVIDERS);
  });

  it("旧用户名下什么都没有：不抛错，也不凭空造出记录", async () => {
    await expect(renameUserScopedSettings(OLD, NEW)).resolves.toBe(0);
    expect(await sharedDB.settings.count()).toBe(0);
  });
});
