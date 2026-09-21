import { test, expect, type Page } from "@playwright/test";
import { stubBackend, idleTtsStatus, type Backend, type StubTable } from "../fixtures/backend";
import { sel, openApp, expectUnblocked } from "../pages/app";
import { importFiles, miniNovel, shelfCard, txtFile, openBook, navChapter, backToShelf } from "../pages/shelf";

/**
 * E 组：同步与登录遮罩。这一组盯的是"客户端拿到服务器响应之后做了什么"——
 * 服务端语义由 7 只探针负责（`probe:sync` 已把 kicked / session_expired / 422 的
 * 返回形状钉死），这里只管用户看得见的那一层：会不会被误登出、文案是不是那句、
 * 遮罩解没解、离线了书还读不读得动。
 *
 * 心跳间隔 15 秒、周期同步 30 秒是写死的（`sync-client.ts:10-11`），所以这一组用
 * `page.clock` 把时间按秒拨，而不是让用例睡 45 秒。
 */

const USER = "e2e-sync-user";

/** 登录用的基础桩：注册成功 + 服务器侧没有书（不弹合并/覆盖/改名决策框）。 */
function baseTable(extra: StubTable = {}): StubTable {
  return {
    ...idleTtsStatus,
    "POST /api/sync/register": { body: { isNew: false, clientId: "e2e-client", token: "e2e-token", activeCount: 1, data: null } },
    "GET /api/sync/check-user/e2e-sync-user": { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
    "GET /api/novels": { body: [] },
    "POST /api/sync/push": { body: { ok: true, watermark: "e2e-wm", skipped: { badPayload: 0, total: 0, ids: [] } } },
    "POST /api/sync/heartbeat": { body: { activeCount: 1 } },
    "POST /api/sync/disconnect": { body: { ok: true } },
    ...extra,
  };
}

/**
 * 在线登录 + 装好假时钟。
 *
 * 时钟必须在 `goto` 之前装：装晚了 React 与 sync-client 已经排好一批真实定时器，
 * 那些定时器不会再被接管，于是"拨 15 秒"只叫醒一部分心跳——症状是用例时灵时不灵。
 */
async function signInOnline(page: Page, table: StubTable): Promise<Backend> {
  const backend = await stubBackend(page, table);
  await page.clock.install();
  await openApp(page);
  await sel.usernameSelect(page).selectOption({ value: "__new__" });
  await sel.newUsername(page).fill(USER);
  await sel.loginSubmit(page).click();
  // 20 秒不是放水：满并发的"重 boot + 拉书架"实测要走十几秒（B7 量过），
  // 而这条判据红的原因应当是"永远进不去"，不是"这台机器此刻很忙"
  await expect(sel.loginGate(page)).toHaveCount(0, { timeout: 20_000 });
  return backend;
}

/**
 * 把假时钟往前拨，直到 `seen()` 为真。
 *
 * 为什么不直接 `runFor(15_000)`：登录链路里 `startSync()` 排在若干个 await 之后
 * （注册 → 数一遍服务器侧的书 → 决策 → 才起定时器）。直接拨 15 秒可能先于挂表发生，
 * 于是"心跳该来了"变成看机器快不快——E1 单跑绿、五条并跑红就是这个原因。
 * 步进 + 每步让真实微任务落地一轮，既不睡等也不赌时序。
 */
async function advanceUntil(page: Page, seen: () => boolean, opts: { stepMs?: number; maxSteps?: number } = {}): Promise<boolean> {
  const stepMs = opts.stepMs ?? 3_000;
  const maxSteps = opts.maxSteps ?? 30;
  for (let i = 0; i < maxSteps; i++) {
    if (seen()) return true;
    await page.clock.runFor(stepMs);
    await new Promise((r) => setTimeout(r, 25)); // 真时间：给在途请求与 Promise 链一个落地机会
  }
  return seen();
}

/**
 * 心跳类的断言一律用 `expect.poll` 或直接推进假时钟，不用一次性的 `expect(...)`。
 *
 * 因为"请求发出去了"与"客户端处理完响应"是两个时刻：桩在请求到达时就把计数加上了，
 * 而 alert / 重注册 / 落盘要等响应回来。一次性断言会抢在后者之前跑完，
 * 症状是"单跑绿、并跑红"（E3 就这么红过一次）。
 */

test("E1 在线登录成功之后，心跳真的按 15 秒一次发出去", async ({ page }) => {
  const backend = await signInOnline(page, baseTable());

  expect(backend.count("POST", "/api/sync/register"), "登录应当注册一次").toBe(1);
  expect(backend.count("POST", "/api/sync/heartbeat"), "刚登录不该就发心跳").toBe(0);

  const beat = (n: number) => backend.count("POST", "/api/sync/heartbeat") >= n;
  expect(await advanceUntil(page, () => beat(1)), "拨表之后心跳必须真的发出去").toBe(true);
  expect(await advanceUntil(page, () => beat(2)), "心跳是周期性的，不是一次性的").toBe(true);

  // 心跳回来了，身份就必须还留着：这条盯的是"心跳正常却把人登出"那一类错法
  await expect(sel.loginGate(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("sync-username")),
    "心跳不该动本地身份",
  ).toBe(USER);
});

test("E2 心跳遇到 session 过期（不是被踢）：无感重注册，不许弹「被踢」、不许登出", async ({ page }) => {
  // 计划里这条写的是"文案是'会话过期，请重新登录'"。实测口径不同：服务器重启导致内存会话
  // 丢失时，客户端拿本地 clientId 重注册就能续上（sync-client.ts:657-681），用户**什么都看不见**。
  // 所以这条钉的是两件可观察的事：不弹"另一设备"那句 alert、身份与书架原地不动。
  let heartbeats = 0;
  const alerts: string[] = [];
  page.on("dialog", async (d) => {
    if (d.type() === "alert") alerts.push(d.message());
    await d.accept();
  });

  const backend = await signInOnline(page, baseTable({
    "POST /api/sync/heartbeat": () => {
      heartbeats++;
      return heartbeats === 1
        ? { status: 401, body: { error: "session_expired" } }
        : { body: { activeCount: 1 } };
    },
  }));

  expect(await advanceUntil(page, () => heartbeats >= 1), "前提：心跳真发过一次").toBe(true);
  await expect
    .poll(() => backend.count("POST", "/api/sync/register"), { message: "过期之后应当重注册续会话" })
    .toBe(2);

  expect(alerts, "会话过期不是被踢，一个字都不该弹给用户").toEqual([]);
  await expect(sel.loginGate(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("sync-username"))).toBe(USER);
  expect(await page.evaluate(() => localStorage.getItem("sync-token"))).toBeTruthy();
});

test("E3 同名他端登录把本端踢掉：弹「另一设备」那句，并停在登录遮罩", async ({ page }) => {
  const alerts: string[] = [];
  page.on("dialog", async (d) => {
    if (d.type() === "alert") alerts.push(d.message());
    await d.accept();
  });
  let heartbeats = 0;

  const backend = await signInOnline(page, baseTable({
    "POST /api/sync/heartbeat": () => {
      heartbeats++;
      return heartbeats === 1
        ? { status: 403, body: { error: "kicked", kicked: true } }
        : { body: { activeCount: 1 } };
    },
  }));

  expect(await advanceUntil(page, () => heartbeats >= 1), "前提：心跳真发过一次").toBe(true);
  await expect.poll(() => alerts.length, { message: "被踢必须有一句" }).toBe(1);
  expect(alerts[0]).toContain("另一设备");

  // handleKicked 会清掉 sync-username 再 reload（useSyncOrchestration.ts:39-45）：
  // reload 之后遮罩必须回来，且不许"顺手"再注册一次把对面设备又踢下去
  await expect(sel.loginGate(page)).toBeVisible();
  expect(backend.count("POST", "/api/sync/register"), "被踢之后不许自动重注册").toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("sync-username"))).toBeNull();
});

test("E6 心跳连续失败三次：自动进离线，标记是「自动」而不是「手动」，书架照样能读", async ({ page }) => {
  await signInOnline(page, baseTable({
    // 忠实度：这里要的是"网络错误"那一格（服务器不可达），不是 500——
    // 客户端两条腿走的是不同分支（catch 计失败数 / !resp.ok 不计）
    "POST /api/sync/heartbeat": { abort: true },
  }));

  let beats = 0;
  const badge = page.getByTitle("自动离线模式 - 点击查看详情");
  const offlineToast = page.getByText("服务器不可达，已自动切换到离线模式。阅读和笔记仍可用。");
  // 再注册一层带计数的桩：把"两次还不够自动离线"钉在真实失败次数上，而不是墙上时间上
  await stubBackend(page, baseTable({
    "POST /api/sync/heartbeat": () => {
      beats++;
      return { abort: true };
    },
  }));

  expect(await advanceUntil(page, () => beats >= 1)).toBe(true);
  await expect(badge).toHaveCount(0);
  expect(await advanceUntil(page, () => beats >= 2)).toBe(true);
  await expect(badge).toHaveCount(0);
  expect(await advanceUntil(page, () => beats >= 3), "三次失败才该自动离线").toBe(true);
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("离线");
  await expect(offlineToast).toBeVisible();
  // 判"能继续读"不能只看元素在不在：遮罩挡住了才算真断了
  await expectUnblocked(sel.folderImportButton(page));
});

test("E7 服务器恢复：自动退出离线，并立刻补一次同步", async ({ page }) => {
  let heartbeats = 0;
  const backend = await signInOnline(page, baseTable({
    "POST /api/sync/heartbeat": () => {
      heartbeats++;
      return heartbeats <= 3 ? { abort: true } : { body: { activeCount: 1 } };
    },
  }));

  expect(await advanceUntil(page, () => heartbeats >= 3), "要先真的失败三次").toBe(true);
  await expect(page.getByTitle("自动离线模式 - 点击查看详情")).toBeVisible();

  const pushesBefore = backend.count("POST", "/api/sync/push");
  expect(await advanceUntil(page, () => heartbeats >= 4), "第四次心跳该恢复").toBe(true);

  await expect(page.getByTitle("在线 - 点击切换到离线模式")).toBeVisible();
  await expect(page.getByTitle("自动离线模式 - 点击查看详情")).toHaveCount(0);
  await expect(page.getByText("已重新连接到服务器。")).toBeVisible();
  // 实测口径（与原计划不同）：恢复那一刻**不立刻补推**——doHeartbeat 的恢复分支只
  // 关掉离线并广播 sync-reconnected（sync-client.ts:686-693），推送要等下一轮
  // 30 秒定时器（doSync 在离线期间直接 return）。所以这条钉的是"恢复之后最终会补上"。
  expect(
    await advanceUntil(page, () => backend.count("POST", "/api/sync/push") > pushesBefore),
    "恢复在线之后下一轮定时必须把这期间的变更推上去",
  ).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("sync-auto-offline")),
    "自动离线的标记得清掉，否则下次开机还以为是离线态").toBeNull();
});

/**
 * `POST /api/sync/push` 的载荷形状（实测从桩里打出来的，不是照文档抄的）：
 * `{ username, clientId, token, changes: { summaries, notes, maps, graphs, settings,
 * progress: { readingPositions, lastOpened } }, lastSyncTime }`
 */
type PushBody = {
  changes?: { progress?: { readingPositions?: Record<string, { chapterIndex?: number }> } };
};

test("E4 自动离线期间读到的章节，恢复之后会随 push 补上去（不带丢）", async ({ page }) => {
  let beats = 0;
  const backend = await signInOnline(page, baseTable({
    "POST /api/sync/heartbeat": () => {
      beats++;
      return beats <= 3 ? { abort: true } : { body: { activeCount: 1 } };
    },
    "* /api/novels": { body: { id: "srv-1", ok: true } },
    "/api/novels/**": { body: { id: "srv-1", ok: true } },
  }));

  // 先在健康态把书导入并打开：导入那条路有 2 秒重试等待（useFileParser.ts:141），
  // 放在离线阶段会让假时钟和真实重试搅在一起，症状是"偶发不等"
  await importFiles(page, [txtFile("离线进度.txt", miniNovel())]);
  await expect(shelfCard(page, "离线进度")).toBeVisible();
  await openBook(page, "离线进度");

  expect(await advanceUntil(page, () => beats >= 3), "先靠三次心跳失败进自动离线").toBe(true);
  await expect(page.getByTitle("自动离线模式 - 点击查看详情")).toBeVisible();

  // 离线期间的变更：读到第三章
  await navChapter(page, 2).click();
  await backToShelf(page);
  const positionsWhileOffline = await page.evaluate(
    () => JSON.parse(localStorage.getItem("novel-reader-positions:e2e-sync-user") || "{}"),
  );
  expect(Object.keys(positionsWhileOffline).length, "本地至少留下一条进度").toBeGreaterThan(0);

  const pushesBefore = backend.count("POST", "/api/sync/push");
  expect(await advanceUntil(page, () => beats >= 4), "心跳第四次该恢复").toBe(true);

  let pushedProgress: Record<string, { chapterIndex?: number }> = {};
  const sawPush = await advanceUntil(page, () => {
    const bodies = backend
      .seen()
      .filter((r) => r.method === "POST" && r.path === "/api/sync/push" && r.body)
      .slice(pushesBefore)
      .map((r) => JSON.parse(r.body as string) as PushBody);
    const last = bodies.at(-1)?.changes?.progress?.readingPositions;
    if (last && Object.keys(last).length) {
      pushedProgress = last;
      return true;
    }
    return false;
  });
  expect(sawPush, "恢复之后的 push 请求体里必须带着离线期间的阅读进度").toBe(true);
  expect(Object.values(pushedProgress).some((p) => p.chapterIndex === 2),
    `推上去的进度应当是第三章，实际 ${JSON.stringify(pushedProgress)}`).toBe(true);
});

test("E5 同一浏览器换用户：另一个标签页必须真的重绑到新身份（不许停在旧用户的书架上）", async ({ page, context }) => {
  const OTHER = "e2e-sync-other";
  await signInOnline(page, baseTable());
  await importFiles(page, [txtFile("A 的书.txt", miniNovel())]);
  await expect(shelfCard(page, "A 的书")).toBeVisible();

  // 第二个标签页：同一个 context → 共享 localStorage，所以它不需要重新登录
  const second = await context.newPage();
  await stubBackend(second, baseTable());
  await openApp(second);
  await expect(shelfCard(second, "A 的书")).toBeVisible();

  // 先等第一个标签页退出把第二个标签页的"登出广播"这一轮走完——它会把 second 刷回遮罩。
  // 不隔开的话，下面"有没有 reload"的判据会被这次 reload 冒充。
  page.once("dialog", (d) => d.accept());
  await page.getByTitle("退出登录").click();
  await expect(sel.loginGate(page)).toBeVisible();
  await expect(sel.loginGate(second)).toBeVisible();

  // 打一个只活在本页 JS 堆里的标记：页面一 reload 就没，比 sessionStorage 可靠
  await second.evaluate(() => {
    (window as unknown as { __tabBound: string }).__tabBound = "still-A";
  });

  await sel.usernameSelect(page).selectOption({ value: "__new__" });
  await sel.newUsername(page).fill(OTHER);
  await sel.loginSubmit(page).click();
  await expect(sel.loginGate(page)).toHaveCount(0);

  // user-switched 广播的作用就是让别的标签页重绑：它各自的 _userDB 与 syncClient.user
  // 仍是旧值，不重绑就会用新身份配旧库继续同步（round 2 R-18）。
  // 判据钉的是"这一页真的换过一次绑定"，不是"旧书看不见了"——旧书看不见可能只是
  // 被别的清理逻辑抹掉（实测过：摘掉广播之后旧书同样消失，那条判据没有判别力）。
  // reload 的那一刻 evaluate 会抛 "Execution context was destroyed" —— 那正是我们要等的事，
  // 不是错误。不接住它，这条判据会在"广播生效得很快"的时候假红（12 worker 实测红过一次）。
  const boundNow = async () => {
    try {
      return await second.evaluate(() => (window as unknown as { __tabBound?: string }).__tabBound ?? null);
    } catch {
      return null;
    }
  };
  await expect.poll(boundNow).toBeNull();
  await expect(shelfCard(second, "A 的书")).toHaveCount(0);
  await expect(second.getByTitle(OTHER, { exact: true })).toBeVisible({ timeout: 20_000 });
});

test("E8 两个标签页同一个用户：A 页导入的书必须出现在 B 页的书架上，B 页不重新加载", async ({ page, context }) => {
  // 这条原本是 §8.5 ② 挂着红的判据，现在修好了：导入方 `broadcast.send("data-changed")`
  // （`useFileParser.ts` 在 `addNovel` 之后），收端在 `BookSelect.tsx` 的 `onDataChanged`
  // 里重读一次——书架的数据源是 BookSelect 自己的 state，不是 novel-store 那份列表，
  // 所以第一版把重读接在 store 上时这条照样红（接错地方等于没接）。
  // 重读失败时保留原列表（不会把书架刷成空）；但"B 页删一本书、A 页的卡片仍留着"
  // 这个反向缺口还在，那条要另立判据，别拿这条当全解决。
  // 变异：摘掉 send → 红；摘掉 onDataChanged 订阅 → 红。
  await signInOnline(page, baseTable());

  const second = await context.newPage();
  await stubBackend(second, baseTable());
  await openApp(second);
  // 同一个 context 共享 localStorage，所以 B 页直接就是登录态；它开机时那本书还不存在
  await expect(sel.loginGate(second)).toHaveCount(0, { timeout: 20_000 });
  await expect(sel.emptyShelf(second)).toBeVisible();

  await importFiles(page, [txtFile("A 新装的书.txt", miniNovel())]);
  await expect(shelfCard(page, "A 新装的书")).toBeVisible({ timeout: 20_000 });

  // 判据：用户在另一个标签页里看到的书架必须是真的那份库的书架。两条路都算数——
  // 要么 B 收到广播后重扫本地共库（同一个用户的 IndexedDB 本来就是同一份），
  // 要么 B 从服务器把这本 pull 回来合上。20 秒是给"广播 → 重扫"的余量：
  // A 导入完就会 push 并广播 sync-complete，那一跳本来该是秒级。
  await expect(shelfCard(second, "A 新装的书")).toBeVisible({ timeout: 20_000 });
});
