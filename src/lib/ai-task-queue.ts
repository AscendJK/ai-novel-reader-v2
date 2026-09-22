/**
 * AI 任务队列：同书串行、异书并行，任务的命不在组件手里
 *
 * 背景（2026-09-22 实测）：`SummaryPanel` 桌面端是条件渲染，折叠即卸载，而卸载时
 * 有一行 `abortAll()` —— 于是那枚「收起 AI 分析面板」按钮实际上是六个 agent 的总闸。
 * 它当初是为了防两件事：① 后台继续生成白烧额度；② 重开面板拿到全新 hook 实例
 * （`isRunning=false`）后再点一次，形成同书双任务并发。
 * 第 ② 件事的正解不是"卸载时把活儿掐了"，而是"排队这件事不住在组件里"：
 * 同书槽位由本模块持有，谁发起都排到同一条队列上，面板重挂多少次都不会多出第二个并发任务。
 *
 * 三条不变量（逐条有单测钉着，见 `src/lib/__tests__/ai-task-queue.test.ts`）：
 *   1. 一个 novelId 同时最多一个 running，其余按发起顺序排队；不同 novelId 互不等待。
 *   2. `AbortSignal` 由队列拥有，只有显式 `cancelTask`/`cancelAllAiTasks` 会 abort 它
 *      —— 组件挂载与否不参与取消判断。
 *   3. 槽位一定回收：body 正常返回、抛错、被取消都要放行下一个；而"赖着不走的 body"
 *      不许把 `getAiRunning()` 永久钉在 true（同步链读它当门控，粘住的症状是
 *      "AI 按钮全灰、界面显示已同步却永不再上传"）。
 */
import { useAiTaskStore, type AiTaskView } from "@/stores/ai-task-store";
import { uuid } from "@/parsers/utils";

export interface AiTaskContext {
  id: string;
  novelId: string;
  /** 队列拥有；只有显式取消会 abort。body 应当在各处 await 之间检查它 */
  signal: AbortSignal;
  /** 更新界面状态文案（任务已收尾后调用是空操作） */
  status: (message: string) => void;
  /** 批量类任务的推进（任务已收尾后调用是空操作） */
  progress: (p: { current: number; total: number } | null) => void;
  /** 记录本次实际用的检索引擎，面板那行「检索引擎:」读它 */
  usedEngine: (engine: string) => void;
}

interface Entry {
  novelId: string;
  body: (ctx: AiTaskContext) => Promise<unknown>;
  settle: (value: unknown) => void;
  reject: (err: unknown) => void;
  controller: AbortController | null;
}

const entries = new Map<string, Entry>();
/** novelId -> 排队中的任务 id，先进先出 */
const waitingByNovel = new Map<string, string[]>();
/** novelId -> 正在跑的任务 id。有它就说明这本书的槽位被占着 */
const runningByNovel = new Map<string, string>();

function nameOf(id: string | undefined): string | null {
  if (!id) return null;
  return useAiTaskStore.getState().tasks.find((t) => t.id === id)?.name ?? null;
}

/** 排队文案要说清"在等谁"，否则用户只看到按钮灰着、不知道还要等多久 */
function queueMessage(novelId: string, selfId: string): string {
  const ahead = useAiTaskStore.getState().tasks.filter((t) => t.novelId === novelId && t.id !== selfId);
  const head = runningByNovel.get(novelId) ?? ahead[0]?.id;
  const headName = nameOf(head) ?? "前一个任务";
  return ahead.length > 1 ? `排队中：前面还有 ${ahead.length} 个任务（下一个：${headName}）` : `排队中：等「${headName}」跑完`;
}

/** 排在后面的那些重新算一遍"在等谁"（前一个跑完或被人取消之后） */
function retargetQueue(novelId: string) {
  for (const id of waitingByNovel.get(novelId) ?? []) {
    useAiTaskStore.getState().patchTask(id, { message: queueMessage(novelId, id) });
  }
}

function start(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  const { novelId } = entry;
  const controller = new AbortController();
  entry.controller = controller;
  runningByNovel.set(novelId, id);
  useAiTaskStore.getState().patchTask(id, { status: "running", message: "", startedAt: Date.now() });
  retargetQueue(novelId);

  const ctx: AiTaskContext = {
    id,
    novelId,
    signal: controller.signal,
    status: (message) => useAiTaskStore.getState().patchTask(id, { message }),
    progress: (progress) => useAiTaskStore.getState().patchTask(id, { progress }),
    usedEngine: (engine) => useAiTaskStore.getState().setNovelEngine(novelId, engine),
  };

  // 直接 await 而不是 Promise.resolve().then(...)：任务在拿到槽位的那一刻就开始，
  // 不需要先转一圈微任务队列（发起方同步观察"跑没跑起来"是有用的）
  const settleWith = (fn: () => void) => {
    if (runningByNovel.get(novelId) === id) runningByNovel.delete(novelId);
    entries.delete(id);
    entry.controller = null;
    useAiTaskStore.getState().removeTask(id);
    fn();
    pump(novelId);
  };

  void (async () => {
    try {
      const value = await entry.body(ctx);
      settleWith(() => entry.settle(value));
    } catch (err) {
      settleWith(() => entry.reject(err));
    }
  })();
}

function pump(novelId: string) {
  if (runningByNovel.has(novelId)) return;
  const queue = waitingByNovel.get(novelId);
  while (queue?.length) {
    const nextId = queue.shift()!;
    // 排队期间被取消的条目已经从 entries 里删掉了，跳过它继续找下一个
    if (entries.has(nextId)) {
      start(nextId);
      return;
    }
  }
  if (queue?.length === 0) waitingByNovel.delete(novelId);
}

/**
 * 发起一个 AI 任务。同书则排在现有任务之后，异书立即并行开跑。
 *
 * @returns body 的返回值；在排队期间被取消则为 `null`（body 一次都不会跑）。
 *          body 抛出的错误原样向上 reject —— 调用方原有的 catch/错误文案逻辑不变。
 */
export function runAiTask<T = unknown>(
  init: { novelId: string; name: string; type: string },
  body: (ctx: AiTaskContext) => Promise<T>
): Promise<T | null> {
  const { novelId } = init;
  const id = uuid();
  const busy = runningByNovel.has(novelId);

  let settle!: (value: unknown) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T | null>((res, rej) => {
    settle = (value: unknown) => res(value as T | null);
    reject = rej;
  });
  entries.set(id, { novelId, body: body as (ctx: AiTaskContext) => Promise<unknown>, settle, reject, controller: null });

  const task: AiTaskView = {
    id,
    novelId,
    name: init.name,
    type: init.type,
    status: busy ? "queued" : "running",
    message: "",
    progress: null,
    queuedAt: Date.now(),
    startedAt: busy ? 0 : Date.now(),
  };
  useAiTaskStore.getState().addTask(task);

  if (busy) {
    const queue = waitingByNovel.get(novelId) ?? [];
    queue.push(id);
    waitingByNovel.set(novelId, queue);
    task.message = queueMessage(novelId, id);
    useAiTaskStore.getState().patchTask(id, { message: task.message });
    return promise;
  }
  start(id);
  return promise;
}

/** 取消一个任务：在跑的走 abort（body 自己决定怎么收尾），排队的直接除名 */
export function cancelTask(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  const view = useAiTaskStore.getState().tasks.find((t) => t.id === id);
  if (view?.status === "queued") {
    entries.delete(id);
    const queue = waitingByNovel.get(entry.novelId);
    if (queue) {
      const at = queue.indexOf(id);
      if (at >= 0) queue.splice(at, 1);
    }
    useAiTaskStore.getState().removeTask(id);
    entry.settle(null);
    retargetQueue(entry.novelId);
    return;
  }
  entry.controller?.abort();
}

/** 「停止」按钮：取消这本书的在飞任务，并让排队的活儿不再开始 */
export function cancelNovelTasks(novelId: string) {
  for (const task of [...useAiTaskStore.getState().tasks]) {
    if (task.novelId === novelId) cancelTask(task.id);
  }
}

/**
 * 作废全部 AI 活儿：退出登录与切换用户时调用。
 *
 * 除了 abort，还要把台账整个清掉 —— 否则一个不响应 abort 的 body 会让
 * `getAiRunning()` 永久为真，而同步链拿它当门控。任务自己落库时按发起者锚定，
 * 所以迟到的那一发不会写进下一位用户的库（见 repositories 的 username 参数）。
 */
export function cancelAllAiTasks() {
  for (const entry of entries.values()) entry.controller?.abort();
  entries.clear();
  waitingByNovel.clear();
  runningByNovel.clear();
  useAiTaskStore.getState().resetAll();
}
