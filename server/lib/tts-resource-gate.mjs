/**
 * TTS 资源的"全服务器只下一趟"闸门（从 routes/rag.js 抽出）
 *
 * 322MB 的模型和 WASM 各只需要下载一次，所有人共用同一趟：第一个人点「启用」，
 * 其余人拿同一只 promise（进度经 /tts/prepare 的 SSE 推给各自浏览器）。这套状态机
 * 一旦收尾不完整，症状都不是"这次下载失败"，而是**以后所有人都再也下不了、只能重启
 * 后端**：失败时没把 promise 扔掉，后来者就会永远 await 一只已经死掉的 promise。
 * 所以失败路径必须同时做三件事——扔掉票、记下失败时间（冷却）、掐掉内部下载。
 *
 * 另两条容易被"顺手改好"的规则：
 *  - 调用方的 signal 被刻意忽略：某个标签页离开设置页不该打断全服务器共用的下载，
 *    否则所有人重下 + 各自吃一次冷却（断开只影响事件推送，由 /tts/prepare 负责）。
 *  - force 只在"当前没有下载在跑"时生效：另起一份会和在跑的那次写同一批临时文件，互相踩坏。
 */
export function createResourceGate({ download, isReady = () => true, cooldownMs = 30000, now = () => Date.now() }) {
  let ready = false;
  let pending = null;
  let lastFailure = 0;

  return {
    /**
     * @param {Function} [onProgress] - 只有真正起跑的那次下载会用它（后来者共享同一趟）
     * @param {{ signal?: AbortSignal, force?: boolean }} [options]
     */
    async ensure(onProgress, { signal, force = false } = {}) {
      void signal; // 见文件注释：调用方的断开不打断共享下载
      if (force && !pending) ready = false;
      // `ready` 只是"本进程成功过一次"的记忆，文件归磁盘管：进程活着的时候被人清掉
      // 缓存目录（手动腾盘、容器换卷），还当它就绪的话 SSE 会立刻报完成而盘上什么都没有，
      // 界面上就是"点启用没反应，只能重启后端"。所以每次都拿真实存在性复核一次。
      if (ready && isReady()) return;
      if (ready) ready = false;
      if (pending) { await pending; return; }
      if (now() - lastFailure < cooldownMs) {
        throw new Error(`上次下载失败，请 ${Math.round(cooldownMs / 1000)} 秒后重试`);
      }

      const internal = new AbortController();
      pending = download(onProgress, { signal: internal.signal, force })
        .then(() => {
          ready = true;
          // 成功后也要把票扔掉：`!pending` 是"当前没有下载在跑"的判据，留着就变成
          // "本进程成功过一次之后 force 永久失效"——重新下载那个按钮会静默什么都不做
          pending = null;
        })
        .catch((e) => {
          lastFailure = now();
          pending = null;
          internal.abort();
          throw e;
        });
      await pending;
    },
  };
}
