// 端到端验证：register → synthesize
const base = "http://127.0.0.1:5173";

async function main() {
  // 1. register 获取 token
  const reg = await fetch(`${base}/api/sync/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "synth-test-3", mode: "join", clientId: "test-client-3" }),
  });
  const regJson = await reg.json();
  console.log("register:", reg.status, regJson.error || "ok");
  if (reg.status !== 200) process.exit(1);
  const token = regJson.token;

  // 2. status
  const st = await fetch(`${base}/api/rag/tts/status`);
  console.log("status:", await st.text());

  // 3. synthesize（首次调用会启动 Python 进程 + 加载模型，可能稍慢）
  const t0 = Date.now();
  const res = await fetch(`${base}/api/rag/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: "各位村民，大家新年好。", sid: 45, speed: 1.0 }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = Date.now() - t0;
  console.log(`synthesize: HTTP ${res.status}, ${buf.length} bytes (${ms}ms)`);
  if (res.status !== 200) {
    console.log("body:", buf.toString("utf8"));
    process.exit(1);
  }
  const sampleRate = buf.readUInt32LE(24);
  const dataSize = buf.readUInt32LE(40);
  console.log(`WAV 头: ${buf.slice(0, 4).toString()}, 采样率: ${sampleRate}, data: ${dataSize} bytes ≈ ${(dataSize / 2 / sampleRate).toFixed(2)}s`);

  // 4. 第二次调用（验证进程常驻 + 速度）
  const t1 = Date.now();
  const res2 = await fetch(`${base}/api/rag/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: "今天天气真不错，我们一起出去走走吧。", sid: 49, speed: 1.2 }),
  });
  const buf2 = Buffer.from(await res2.arrayBuffer());
  const ms2 = Date.now() - t1;
  console.log(`synthesize #2: HTTP ${res2.status}, ${buf2.length} bytes (${ms2}ms) ≈ ${(buf2.readUInt32LE(40) / 2 / 24000).toFixed(2)}s 音频`);
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
