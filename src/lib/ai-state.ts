/**
 * 「有没有 AI 活儿」这一位的唯一读口。
 *
 * 它原先是一个谁都能 `setAiRunning(true/false)` 的模块级布尔，而写它的地方在
 * `useSummarizer` 里 —— 面板双挂载（桌面 + 移动抽屉）时是两个实例在写同一个布尔，
 * 没有引用计数；任何一条 `finally` 漏跑（round 3 R-73 就是这种）它就永久粘在 true。
 * 症状不止是转圈：同步链 `sync-client.ts` 拿它当门控，粘住之后界面显示"已同步"
 * 却再也不上传。
 *
 * 现在它是任务队列的派生值，没人能直接写它，所以粘不住。
 */
import { useAiTaskStore, hasAiWork } from "@/stores/ai-task-store";

/** 排队中的任务也算"有活儿"：它迟早要发请求、要落库 */
export function getAiRunning(): boolean {
  return hasAiWork(useAiTaskStore.getState().tasks);
}

/**
 * 订阅运行态变化（只在真的翻转时回调）。当前没有生产代码订阅它，
 * 留着是因为它是这只布尔唯一的"外部想知道"的口子——同步进度条一类要用时从这里接。
 */
export function onAiRunningChange(fn: (running: boolean) => void): () => void {
  let last = getAiRunning();
  return useAiTaskStore.subscribe(() => {
    const next = getAiRunning();
    if (next !== last) {
      last = next;
      fn(next);
    }
  });
}
