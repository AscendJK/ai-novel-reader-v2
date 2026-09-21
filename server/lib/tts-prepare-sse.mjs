/**
 * `/tts/prepare` 的 SSE 处理器：把「确保 WASM + 模型就绪」这一步一步推给浏览器。
 *
 * 为什么单独抽出来：这段的死法都只在真 HTTP 连接上才看得见——
 *  - 少一次 `res.end()`，前端的 EventSource 就永远停在那儿转圈，界面上是"卡住"而不是"报错"；
 *  - 把断开监听挂在 `req` 上（而不是 `res`），GET 无体时 Node 几乎立刻 emit close，
 *    这条流在第一帧之前就自我判定为已断开，用户再也收不到任何进度（实测：响应永远不结束）；
 *  - 断开之后继续 `res.write` 会抛，抛出来就是个没人接的 uncaughtException。
 * 所以 `ensureWasmReady` / `ensureModelReady` 从外面注入，用例拿真假下载函数 +
 * 真 `node:http` 服务（回环端口，不出本机）跑完整的一条流。
 */
export function createTtsPrepareHandler({ ensureWasmReady, ensureModelReady }) {
  return async function ttsPrepare(req, res) {
    // 自己解析 query：这条路由挂在 express 上，但判据不该依赖 req.query 才存在
    const force = new URL(req.url || "/", "http://internal").searchParams.get("force") === "true";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // ACAO 由全局 cors() 白名单设置，这里不手写 "*"
    res.flushHeaders();

    let clientDisconnected = false;
    const abortController = new AbortController();
    // ⚠️ 断开只能认 res：round 2 R-66 挂在 req 上时，GET 无体的请求"读完"就 emit close，
    // 这条流在第一帧之前就被自我判定为已断开，前端再也收不到进度（真浏览器 + express 实测）。
    // 注：本机 Node 24 配 undici 客户端复现不出来（req/res 两只 close 都在 socket 关掉那刻
    // 触发），所以本地用例钉的是"断开→掐下载""正常收尾→不算断开"这两半；这半靠形状保持。
    res.on("close", () => {
      if (res.writableEnded) return; // 正常写完，不是断开
      clientDisconnected = true;
      abortController.abort();
    });

    function sendEvent(type, data) {
      if (clientDisconnected) return;
      try {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      } catch { /* 已经断开了，写不进去是预期的 */ }
    }

    try {
      sendEvent("step", { step: "开始", detail: "检查 TTS 资源..." });

      sendEvent("step", { step: "WASM 引擎", detail: "检查中..." });
      await ensureWasmReady((step, detail) => {
        sendEvent("step", { step: `WASM: ${step}`, detail });
      }, { signal: abortController.signal, force });
      if (clientDisconnected) return;
      sendEvent("step", { step: "WASM 引擎", detail: "就绪 ✓" });

      sendEvent("step", { step: "语音模型", detail: "检查中..." });
      await ensureModelReady((step, detail) => {
        sendEvent("step", { step: `模型: ${step}`, detail });
      }, { signal: abortController.signal, force });
      if (clientDisconnected) return;
      sendEvent("step", { step: "语音模型", detail: "就绪 ✓" });

      sendEvent("done", { success: true });
    } catch (e) {
      if (!clientDisconnected) sendEvent("error", { message: e.message });
    }

    res.end();
  };
}
