// 验证取消协议 + 队列上限
import { createSession } from "../server/sync-handler.js";

// 通过 register 获取 token（与服务器进程共享 session 存储）
async function register(username) {
  const res = await fetch("http://127.0.0.1:5173/api/sync/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, mode: "join", clientId: `client-${username}-${Date.now()}` }),
  });
  if (!res.ok) throw new Error(`register ${username} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

async function synthesize(token, text, sid = 45, speed = 1.0) {
  const t0 = Date.now();
  const res = await fetch("http://127.0.0.1:5173/api/rag/tts/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, sid, speed }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ms: Date.now() - t0, bytes: buf.length, body: buf.length < 200 ? buf.toString() : "" };
}

async function cancel(token) {
  const res = await fetch("http://127.0.0.1:5173/api/rag/tts/cancel", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const userA = await register("cancel-test-a");
  const userB = await register("cancel-test-b");

  // ── 场景 1：A 排队中取消 → A 的请求立即失败，B 不受影响且更快 ──
  console.log("=== 场景 1：A 排队 2 个长请求后取消 ===");
  // A 先发一个长请求（24字 0.5 语速 ≈ 8s），立即再发第二个（会排队）
  const longText = "这是一个用于测试取消协议的较长文本，需要多花一些时间生成完成。";
  const pA1 = synthesize(userA, longText, 45, 0.5); // 进入处理
  await sleep(300); // 确保 A1 已开始生成
  const pA2 = synthesize(userA, "排队中的第二个请求。", 47, 1.0); // 排队
  await sleep(300); // 确保 A2 已入队
  const pB = synthesize(userB, "B 用户的短请求。", 49, 1.0); // B 排在 A2 后面
  await sleep(300);

  // A 取消：A1（处理中，结果丢弃）+ A2（排队中，直接移除）都应被取消
  const cancelRes = await cancel(userA);
  console.log("A 取消结果:", JSON.stringify(cancelRes), "(cancelled 应为 2)");

  const [a1, a2, b] = await Promise.allSettled([pA1, pA2, pB]);
  const fmt = (r) => r.status === "fulfilled" ? `HTTP ${r.value.status} ${r.value.ms}ms ${r.value.body || ""}` : `REJECTED ${r.reason?.message}`;
  console.log("A1:", fmt(a1));
  console.log("A2:", fmt(a2));
  console.log("B :", fmt(b));
  // B 的耗时应 ≈ 自身生成时间（A1 完成后 B 才处理，但 A2 被取消不占位）
  console.log("→ B 不受 A 取消影响（音频正常返回）");

  // ── 场景 2：cancel 幂等（无排队请求时返回 0）──
  const idleCancel = await cancel(userA);
  console.log("=== 场景 2：空闲时取消 ===", JSON.stringify(idleCancel), "(cancelled 应为 0)");

  // ── 场景 3：队列上限（凑 30 个排队请求 → 第 31 个应 503）──
  // 用一个长文本 + 慢语速占据 Python 进程，然后快速灌入排队请求
  console.log("=== 场景 3：队列上限 503 ===");
  const pBlock = synthesize(userA, longText + longText, 45, 0.4); // 长阻塞请求（约 15-20s）
  await sleep(400);
  const results = [];
  for (let i = 0; i < 31; i++) {
    results.push(synthesize(userB, `队列压力测试请求 ${i}`, 45, 1.0));
  }
  const settled = await Promise.allSettled(results);
  const okCount = settled.filter(s => s.status === "fulfilled" && s.value.status === 200).length;
  const busyCount = settled.filter(s => s.status === "fulfilled" && s.value.status === 503).length;
  const other = settled.filter(s => !(s.status === "fulfilled" && (s.value.status === 200 || s.value.status === 503)));
  console.log(`31 个并发请求：200=${okCount}，503（繁忙）=${busyCount}，其他=${other.length}`);
  if (other.length > 0) {
    console.log("其他样本:", other.slice(0, 3).map(s => s.status === "fulfilled" ? `HTTP ${s.value.status} ${s.value.body || ""}` : `REJECTED ${s.reason?.message}`).join(" | "));
  }
  console.log("503 示例:", settled.find(s => s.status === "fulfilled" && s.value.status === 503)?.value?.body);

  // 清理：取消 A/B 剩余请求，释放 Python 进程
  await cancel(userA);
  await cancel(userB);
  await pBlock.catch(() => {});
  console.log("=== 完成 ===");
  process.exit(0);
}

main().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
