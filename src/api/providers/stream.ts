/**
 * SSE (Server-Sent Events) 流式响应解析工具
 * 用于读取 chat/completions 流式响应，解析所有 data: 行
 */

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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
