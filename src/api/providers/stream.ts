/**
 * SSE (Server-Sent Events) 流式响应解析工具
 * 用于读取 chat/completions 流式响应，解析所有 data: 行
 */

// 空闲看门狗：距上次收到数据超过该时长即判定连接死亡。
// 中间设备（NAT/代理）静默丢弃 TCP 连接时 reader.read() 永不 resolve，
// 没有看门狗任务会永久停在"生成中"，夜间批量总结会整批卡死。
const IDLE_TIMEOUT_MS = 90_000;
// 首 token 前的预算更长：推理型模型（思考类）出首字前可合法静默数分钟，
// 统一用 90s 会掐死合法的慢启动流
const FIRST_TOKEN_TIMEOUT_MS = 180_000;

/** 读取 SSE 流式响应体，解析所有 data: 行的 JSON */
export async function readSSEData(response: Response): Promise<{ events: unknown[]; raw: string }> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("API 响应没有可读的 body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  const events: unknown[] = [];

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleReject: ((e: Error) => void) | null = null;
  const idle = new Promise<never>((_, reject) => {
    idleReject = reject;
  });
  let gotFirstChunk = false;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    const budget = gotFirstChunk ? IDLE_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS;
    idleTimer = setTimeout(
      () => idleReject?.(new Error(`流式响应超时（${budget / 1000} 秒未收到数据，连接可能已中断）`)),
      budget
    );
  };

  try {
    armIdle();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), idle]);
      if (done) break;
      gotFirstChunk = true;
      armIdle();
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;

      // 按行解析
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            events.push(JSON.parse(data));
          } catch {
            // 忽略无法解析的行（如空行/注释）
          }
        }
      }
    }
    // flush 解码器残留：流恰好在多字节 UTF-8 序列中间截止时不丢尾部字符
    const tail = decoder.decode();
    if (tail) {
      raw += tail;
      buffer += tail;
    }
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    // 不 await cancel()：连接黑洞（NAT 静默丢包、半开 TCP）时 cancel 本身可能
    // 永不 resolve，那样看门狗虽然 reject 了，调用方却仍卡在 finally 里出不来，
    // 任务永远显示"生成中"——正好把要修的问题留在原地（round 2 R-55）
    void Promise.race([
      reader.cancel().catch(() => { /* 流已结束/已锁定 */ }),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }

  // 处理 buffer 中残留的最后一行
  const lastLine = buffer.trim();
  if (lastLine.startsWith("data:")) {
    const data = lastLine.slice(5).trim();
    if (data !== "[DONE]") {
      try {
        events.push(JSON.parse(data));
      } catch {
        // ignore
      }
    }
  }

  return { events, raw };
}
