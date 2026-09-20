/**
 * TTS 资源的下载器（从 routes/rag.js 抽出）
 *
 * 这条路径上最贵的两个失败都不体现在"这次下载失败"上：
 *  - 跨境链路中途断流时 `reader.read()` 会永久挂起且不报错，没有空闲看门狗，
 *    整条下载通道（全服务器共享同一个 promise）就卡死到进程重启；
 *  - 失败后不删残缺文件，下一次 `minSize` 校验会把半截包当成有效缓存放行。
 * 所以要能"观察到掐断与清理"，fetch / fs / 两段超时都可注入。默认值与抽出前一致。
 */
import defaultFs from "node:fs";

export function createDownloader(options = {}) {
  const {
    fetchImpl = (url, init) => fetch(url, init),
    fsImpl = defaultFs,
    headerTimeoutMs = 300000,   // 响应头超时：5 分钟
    stallMs = 60000,            // 响应体空闲看门狗：60 秒没有新字节就掐
    logger = console,
  } = options;

  /**
   * 从 URL 下载文件（流式写入磁盘，带超时、大小校验、进度回调）
   */
  return async function downloadFile(url, destPath, minSize = 1024, onProgress, { signal } = {}) {
    logger.log(`[tts-proxy] 下载: ${url}`);
    const controller = new AbortController();
    // 响应头超时；拿到响应头后清除，改用响应体"空闲看门狗"
    const timeout = setTimeout(() => controller.abort(), headerTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    let bodyWatchdog = null;
    // 函数作用域声明：下载完成后 minSize 校验在 try/finally 之外引用它
    let received = 0;
    try {
      const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`);

      const contentLength = parseInt(response.headers.get("content-length") || "0");
      const reader = response.body.getReader();
      const ws = fsImpl.createWriteStream(destPath);
      // 写失败当场记住：只等最后 end() 的 error 事件的话，中途坏掉的流还会继续被
      // 喂数据，最后那个 error 也未必还发得出来
      let wsError = null;
      ws.on("error", (e) => { wsError = e; });
      // 背压：write() 返回 false 是流在说"内部队列满了"。不理会就是边收网络边把没
      // 落盘的字节全堆在堆外（实测一卷 80MB，--max-old-space-size 拦不住）。
      // 等 drain 必须同时等 error/close/abort——流报错之后 drain 永远不会来，只等
      // drain 就等于把"涨内存"换成"永久挂死"。abort 那一路尤其要紧：卡在 write 上
      // 时循环不再调用 reader.read()，空闲看门狗没有着力点，除非它能把这次等待叫醒。
      const waitDrain = () => new Promise((resolve) => {
        const onInternalAbort = () => resolve();
        const done = () => {
          ws.removeListener("drain", done);
          ws.removeListener("error", done);
          ws.removeListener("close", done);
          controller.signal.removeEventListener("abort", onInternalAbort);
          resolve();
        };
        ws.on("drain", done);
        ws.on("error", done);
        ws.on("close", done);
        controller.signal.addEventListener("abort", onInternalAbort, { once: true });
      });
      const armBodyWatchdog = () => {
        if (bodyWatchdog) clearTimeout(bodyWatchdog);
        bodyWatchdog = setTimeout(() => {
          logger.error(`[tts-proxy] 下载停滞超过 ${stallMs / 1000}s，中断: ${url}`);
          controller.abort();
        }, stallMs);
      };

      try {
        armBodyWatchdog();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          armBodyWatchdog(); // 收到数据即重置
          if (!ws.write(Buffer.from(value))) await waitDrain();
          if (wsError) throw wsError;   // 走下面的 catch：destroy + 删掉残缺文件
          received += value.length;
          if (onProgress && contentLength > 0) {
            onProgress(Math.round((received / contentLength) * 100));
          }
        }
        ws.end();
        if (!wsError) {
          await new Promise((resolve, reject) => { ws.on("finish", resolve); ws.on("error", reject); });
        }
        if (wsError) throw wsError;
      } catch (e) {
        ws.destroy();
        // 下载中断/失败时删除残缺文件，避免后续 size 校验误判为有效缓存
        try { fsImpl.unlinkSync(destPath); } catch { /* 还没建出来 */ }
        throw e;
      } finally {
        if (bodyWatchdog) clearTimeout(bodyWatchdog);
      }
    } finally {
      clearTimeout(timeout);
      // 调用方的 signal 是全服务器共用的那个 controller：监听不移除就会一次连接
      // 挂一个，反复重试后把 MaxListeners 刷爆并且旧闭包一直引着 buffer
      signal?.removeEventListener("abort", onAbort);
    }

    if (received < minSize) {
      throw new Error(`下载的文件太小 (${received} 字节)，可能不是有效文件`);
    }
    logger.log(`[tts-proxy] 已下载: ${(received / 1024 / 1024).toFixed(1)} MB`);
  };
}
