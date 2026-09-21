/**
 * 真机自检（iOS/Android 上连不了 devtools 时的现场取证）
 *
 * 三块内容：
 * - 环境事实：把"这台设备到底缺什么"变成可读文本（COI/SAB/配额/私密模式/语音列表/朗读运行时…）
 * - 手动清单：只有人眼能判的观察项（有没有出声、中断后是否恢复），勾选状态存本地
 * - 事件时间线：页面可见性、AudioContext 状态变化、未捕获拒绝——中断类问题要有时序证据
 *
 * 纯逻辑部分（collectFacts/清单/导出文本）与 DOM 探针分开，前者可单测。
 */
import { getActiveTTSManager } from "@/tts/tts-manager";
import { APP_VERSION } from "@/config/version";
import { COI_RELOAD_KEY, MAX_COI_RELOADS } from "@/lib/sw-update";

export type FactLevel = "ok" | "warn" | "bad" | "info";

export interface Fact {
  label: string;
  value: string;
  level: FactLevel;
}

const CHECK_STATE_KEY = "novel-reader-device-check";

export interface ChecklistItem {
  id: string;
  title: string;
  how: string;
  expect: string;
}

/** 与 docs/fix-plan 批次 5 的"iOS 真机清单"一一对应，另加导入/离线两项 */
export const DEVICE_CHECKLIST: ChecklistItem[] = [
  {
    id: "resume-after-interrupt",
    title: "来电 / Siri / 闹钟打断后按“继续”",
    how: "朗读一段 → 打断（拨入电话或叫 Siri）→ 回页面按“继续”，连点两次",
    expect: "要么真的继续出声，要么提示“请点击页面后重试”且按钮仍显示暂停态；不能显示播放中却无声",
  },
  {
    id: "double-tap-continue",
    title: "暂停后连点两下“继续”",
    how: "暂停 → 快速连点“继续”两次",
    expect: "只有一份声音，不出现两段叠着念（混播）",
  },
  {
    id: "mute-switch",
    title: "侧边静音键两种位置各试一次",
    how: "静音键开 → 朗读；静音键关 → 朗读",
    expect: "记录哪种位置有声。iOS 上静音键可能压住 WebAudio 输出，若只此现象属系统行为",
  },
  {
    id: "background-restore",
    title: "切后台 30 秒再回来",
    how: "朗读中按 Home / 切到别的应用 → 30 秒后回来",
    expect: "从离开的位置继续；不跳章、不双重朗读、控件状态与声音一致",
  },
  {
    id: "lockscreen",
    title: "锁屏后解锁",
    how: "朗读中锁屏 10 秒 → 解锁回页面",
    expect: "同上；若系统接管了播放，锁屏控件也应只对当前这一段",
  },
  {
    id: "auto-next-chapter",
    title: "章末自动翻下一章",
    how: "开着“自动下一章”听到一章结束",
    expect: "下一章接着出声，不长期停在“正在生成”（浏览器推理首章加载需几秒属正常）",
  },
  {
    id: "rate-change-while-paused",
    title: "暂停中改倍速后继续",
    how: "暂停 → 改倍速 → 继续，听后续段落",
    expect: "后续段落是新语速；不出现同一章里一段快一段慢",
  },
  {
    id: "seek-paragraph",
    title: "点击段落跳转",
    how: "朗读中点某个段落跳转",
    expect: "从该段开始读，不出现两段同时响",
  },
  {
    id: "offline-cold-start",
    title: "离线冷启动首屏",
    how: "已“添加到主屏幕”→ 开飞行模式 → 完全退出后重开",
    expect: "页面能打开（不是白屏），已缓存的小说能翻开阅读；RAG/TTS 需联网的部分应有明确提示",
  },
  {
    id: "import-big5",
    title: "导入一本繁体 Big5 .txt",
    how: "书架导入 → 若乱码就在“TXT 编码”里选 Big5 重新导入",
    expect: "正文无乱码、章节划分正常；选 Big5 后必须变好",
  },
  {
    id: "server-offline-fallback",
    title: "服务器不可达时的朗读",
    how: "关掉后端（或选“浏览器推理/系统语音”）后朗读",
    expect: "按所选引擎工作；选服务端推理而服务器不在时应报错并可切引擎，不永久卡在“生成中”",
  },
  {
    id: "long-chapter-memory",
    title: "长章连续朗读 10 分钟",
    how: "找一章 2000 字以上，用浏览器推理连续听 10 分钟",
    expect: "页面不被系统回收、不中断；如中断，记下发生在第几分钟（内存压力线索）",
  },
];

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const mb = n / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${mb.toFixed(1)}MB`;
}

/** 私密浏览下 IndexedDB 打不开或写不进——iOS Safari 私密模式是这个 app 的头号杀手 */
async function probeIndexedDBWritable(): Promise<string> {
  if (typeof indexedDB === "undefined") return "无 IndexedDB";
  try {
    const name = `probe-${Date.now()}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("s"); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("s", "readwrite");
      tx.objectStore("s").put("x", "k");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await new Promise<void>((resolve) => {
      const del = indexedDB.deleteDatabase(name);
      del.onsuccess = () => resolve();
      del.onerror = () => resolve();
      del.onblocked = () => resolve();
    });
    return "可读写";
  } catch (e) {
    return `不可用：${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 收集环境事实。全部是只读探测（IndexedDB 探针用后即删），
 * 唯一"有副作用"的是试声按钮，那是单独函数。
 */
export async function collectFacts(): Promise<Fact[]> {
  const facts: Fact[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const coi = g.crossOriginIsolated === true;
  const sab = typeof SharedArrayBuffer !== "undefined";
  // 刷到上限之后页面会**永久**停在非隔离态（`main.tsx` 的计数），而手机上开不了
  // devtools：这一行得把"还在刷"和"已经放弃"分开，不然症状只是"浏览器朗读起不动
  // 模型"，排查全靠猜。
  let coiReloads = 0;
  try {
    coiReloads = Number(sessionStorage.getItem(COI_RELOAD_KEY) ?? "0") || 0;
  } catch { /* 隐私模式下 sessionStorage 直接抛 */ }
  facts.push({
    label: "crossOriginIsolated / SharedArrayBuffer",
    value: `${coi} / ${sab}（为等 SW 接管已自刷 ${coiReloads} 次${coiReloads >= MAX_COI_RELOADS ? "，到上限不再刷" : ""}）`,
    // 浏览器推理（Kokoro wasm）没有 SAB 就起不来；系统语音不受影响
    level: sab ? "ok" : "bad",
  });
  facts.push({
    label: "Service Worker 已接管",
    value: navigator.serviceWorker?.controller ? "是（COI 头才可能生效）" : "否（首次安装后需再进一次页面）",
    level: navigator.serviceWorker?.controller ? "ok" : "warn",
  });
  facts.push({
    label: "运行形态",
    value: matchMedia("(display-mode: standalone)").matches ? "PWA 独立窗口" : "浏览器标签页",
    level: "info",
  });
  facts.push({
    label: "设备 / UA",
    value: `${navigator.platform || "?"} · ${Math.round(innerWidth)}×${Math.round(innerHeight)} dpr${devicePixelRatio} · ${isIOSLike() ? "iOS 判定=是" : "iOS 判定=否"}`,
    level: "info",
  });
  facts.push({ label: "App 版本", value: APP_VERSION, level: "info" });

  try {
    const est = await navigator.storage?.estimate?.();
    const free = est?.quota && est.usage !== undefined ? est.quota - est.usage : undefined;
    facts.push({
      label: "存储配额（TTS 模型约 380MB）",
      value: `已用 ${fmtBytes(est?.usage ?? 0)} / 配额 ${fmtBytes(est?.quota ?? 0)} · 剩余 ${free === undefined ? "未知" : fmtBytes(free)}`,
      level: free === undefined ? "info" : free < 600 * 1048576 ? "warn" : "ok",
    });
  } catch (e) {
    facts.push({ label: "存储配额", value: `探测失败：${String(e)}`, level: "warn" });
  }

  facts.push({ label: "IndexedDB 可写", value: await probeIndexedDBWritable(), level: "info" });

  let voices = 0;
  let zhVoices = 0;
  try {
    const list = speechSynthesis?.getVoices?.() ?? [];
    voices = list.length;
    zhVoices = list.filter((v) => /^zh/i.test(v.lang)).length;
  } catch { /* 无 Web Speech */ }
  facts.push({
    label: "系统语音（Web Speech）",
    value: `${voices} 个 voice，其中中文 ${zhVoices} 个`,
    level: zhVoices > 0 ? "ok" : voices > 0 ? "warn" : "bad",
  });

  const manager = getActiveTTSManager();
  facts.push({ label: "朗读运行时", value: manager ? manager.describeRuntime() : "当前没有朗读会话（先开始一次朗读再看这里）", level: "info" });

  try {
    const { isCacheReady } = await import("@/tts/tts-cache");
    const { getWorkerPoolSize, isModelLoaded } = await import("@/tts/zipvoice-engine");
    facts.push({
      label: "TTS 模型缓存 / worker 池",
      value: `缓存清单校验=${await isCacheReady() ? "通过" : "未通过（需重新拉取）"} · 模型已加载=${isModelLoaded()} · 池大小=${getWorkerPoolSize()}`,
      level: "info",
    });
  } catch (e) {
    facts.push({ label: "TTS 模型缓存", value: `探测失败：${String(e)}`, level: "warn" });
  }

  return facts;
}

function isIOSLike(): boolean {
  const ua = navigator.userAgent || "";
  const uaIOS = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ 的桌面 UA 伪装成 Macintosh，用多点触控辅助识别
  const uaIPadOS = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  return uaIOS || uaIPadOS;
}

export function loadCheckState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CHECK_STATE_KEY);
    return raw ? JSON.parse(raw) as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

export function saveCheckState(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(CHECK_STATE_KEY, JSON.stringify(state));
  } catch { /* 私密模式写不进：勾选只保持到刷新 */ }
}

/** 试声：一段 440Hz 短音，用来把"静音键/音量/自动播放拦截"三件事分开 */
export async function playTone(): Promise<string> {
  const Ctor = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctor) return "此浏览器没有 AudioContext";
  try {
    const ctx = new Ctor();
    const before = ctx.state;
    try { await ctx.resume(); } catch { /* 被拦截时下面按状态判定 */ }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
    await new Promise<void>((resolve) => { osc.onended = () => resolve(); setTimeout(() => resolve(), 900); });
    const after = ctx.state;
    await ctx.close().catch(() => undefined);
    return `播放前后 ctx 状态：${before} → ${after}` +
      (after === "running" ? "（若仍无声：查静音键/侧边开关/系统音量，而非网页问题）" : "（被自动播放策略拦截：需在用户手势里再试一次）");
  } catch (e) {
    return `试声失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 时间线探针：面板打开期间挂着，返回卸载函数。
 * 只记对判断有意义的事件，不记高频量（滚动/指针移动等）。
 */
export function installProbes(push: (line: string) => void): () => void {
  const onVisibility = () => push(`可见性 → ${document.visibilityState}${document.hidden ? "（页面已隐藏）" : ""}`);
  const onPageHide = () => push("pagehide（iOS 上后台化常从这里开始）");
  const onPageShow = (e: PageTransitionEvent) => push(`pageshow（persisted=${e.persisted}，从 bfcache 恢复）`);
  const onFreeze = () => push("页面被冻结（CFL freeze）");
  const onResume = () => push("页面从冻结恢复（CFL resume）");
  const onReject = (e: PromiseRejectionEvent) => push(`未捕获的 Promise 拒绝：${e.reason instanceof Error ? e.reason.message : String(e.reason)}`);
  const onError = (e: ErrorEvent) => push(`未捕获错误：${e.message}`);

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("freeze", onFreeze);
  window.addEventListener("resume", onResume);
  window.addEventListener("unhandledrejection", onReject);
  window.addEventListener("error", onError);
  push("自检探针已挂载（可见性 / 冻结 / 未捕获错误）");

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("freeze", onFreeze);
    window.removeEventListener("resume", onResume);
    window.removeEventListener("unhandledrejection", onReject);
    window.removeEventListener("error", onError);
  };
}

/** 导出成一段可直接粘贴/截图的文字报告 */
export function buildReport(facts: Fact[], state: Record<string, boolean>): string {
  const lines: string[] = [];
  lines.push(`AI 小说精读助手 v${APP_VERSION} 真机自检 ${new Date().toLocaleString()}`);
  lines.push("");
  lines.push("【环境事实】");
  for (const f of facts) {
    lines.push(`  ${f.level === "bad" ? "✱" : f.level === "warn" ? "△" : "·"} ${f.label}: ${f.value}`);
  }
  lines.push("");
  lines.push("【手动清单】（✅ 已试 / ⬜ 未试）");
  for (const item of DEVICE_CHECKLIST) {
    lines.push(`  ${state[item.id] ? "✅" : "⬜"} ${item.title}`);
  }
  return lines.join("\n");
}

/** 分享 → 剪贴板 → 都不行则返回 false（UI 退化为可选全文文本框） */
export async function exportReport(text: string): Promise<"shared" | "copied" | "manual"> {
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (typeof nav.share === "function") {
    try {
      await nav.share({ title: "真机自检报告", text });
      return "shared";
    } catch { /* 用户取消或不支持：继续走剪贴板 */ }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "manual";
  }
}
