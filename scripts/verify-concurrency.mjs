// 并发验证：多个前端同时请求服务端推理
// 验证点：
// 1. 参数隔离：不同 sid/speed/text 的请求互不串扰（返回各自对应的音频）
// 2. 排队行为：Python 进程串行处理，后来的请求等待前者完成
// 3. 总耗时与单请求耗时的关系
import { createSession } from "../server/sync-handler.js";

const base = "http://127.0.0.1:5173";

async function register(username) {
  const res = await fetch(`${base}/api/sync/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, mode: "create", clientId: `client-${username}` }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`register ${username} failed: ${res.status} ${JSON.stringify(data)}`);
  return data.token;
}

function synthesize(token, text, sid, speed) {
  const t0 = Date.now();
  return fetch(`${base}/api/rag/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, sid, speed }),
  }).then(async (res) => {
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - t0;
    const sampleRate = buf.length > 44 ? buf.readUInt32LE(24) : 0;
    const dataSize = buf.length > 44 ? buf.readUInt32LE(40) : 0;
    return { http: res.status, bytes: buf.length, durSec: +(dataSize / 2 / sampleRate).toFixed(2), ms };
  });
}

async function main() {
  // 模拟 3 个不同前端（不同用户 token）
  const [tA, tB, tC] = await Promise.all([
    register("conc-a"), register("conc-b"), register("conc-c"),
  ]);

  // 同时发出 3 个请求：不同文本长度 / 音色 / 语速
  console.log("=== 并发 3 请求（不同参数，同时发出）===");
  const t0 = Date.now();
  const [rA, rB, rC] = await Promise.all([
    synthesize(tA, "你好。", 45, 1.0),
    synthesize(tB, "今天天气真不错，我们一起去公园散步吧，感受一下春天的气息。", 49, 1.5),
    synthesize(tC, "服务器推理共享一个 Python 进程，请求会排队处理。", 47, 0.9),
  ]);
  const totalMs = Date.now() - t0;
  console.log(`A(2字,sid45,1.0):   ${JSON.stringify(rA)}`);
  console.log(`B(24字,sid49,1.5):  ${JSON.stringify(rB)}`);
  console.log(`C(18字,sid47,0.9):  ${JSON.stringify(rC)}`);
  console.log(`总耗时: ${totalMs}ms（串行 = 三耗时之和；并行 ≈ 最长单个）`);

  // 串行基线：单独发一个同样长度的请求测单个耗时
  const t1 = Date.now();
  const solo = await synthesize(tA, "今天天气真不错，我们一起去公园散步吧，感受一下春天的气息。", 49, 1.5);
  console.log(`\n=== 单请求基线（同 B 文本）===`);
  console.log(`solo(24字): ${JSON.stringify(solo)} (${Date.now() - t1}ms)`);

  // 验证参数隔离：不同 sid 返回的音频字节/时长应不同（同文本不同音色）
  console.log("\n=== 参数隔离验证（同文本，不同 sid）===");
  const [v1, v2] = await Promise.all([
    synthesize(tA, "测试音色差异。", 45, 1.0),
    synthesize(tB, "测试音色差异。", 50, 1.0),
  ]);
  console.log(`sid45: ${JSON.stringify(v1)}`);
  console.log(`sid50: ${JSON.stringify(v2)}`);
  console.log(`字节不同: ${v1.bytes !== v2.bytes}（不同音色音频长度/内容应有差异）`);
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
