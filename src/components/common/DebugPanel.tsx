import { useState, useEffect, useRef, useCallback } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { useRAGStore } from "@/stores/rag-store";
import { getEngineDisplayName } from "@/rag/engines";
import { getBGEMeta } from "@/rag/index";
import { onRagLog } from "@/lib/logger";
import { subscribeDebugStore, appendDebugLog, getDebugEntries, getDebugLogLines } from "@/lib/debug-store";
import {
  collectFacts, DEVICE_CHECKLIST, loadCheckState, saveCheckState,
  installProbes, buildReport, exportReport, playTone, type Fact,
} from "@/lib/device-check";
import { getActiveTTSManager } from "@/tts/tts-manager";

type Tab = "log" | "check";
const LEVEL_STYLE: Record<Fact["level"], string> = {
  ok: "text-green-300/90",
  warn: "text-yellow-300/90",
  bad: "text-red-300",
  info: "text-gray-300/90",
};

export function DebugPanel() {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const engine = useRAGStore((s) => s.engine);
  const [, setTick] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const logLines = getDebugLogLines();
  const entries = getDebugEntries();
  // 手机上（width<768）以底部抽屉形式占满宽度：iOS 真机清单必须能在手机上逐项核对
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [pos, setPos] = useState(() => ({
    x: Math.max(8, window.innerWidth - (window.innerWidth < 768 ? 340 : 480)),
    y: Math.max(8, window.innerHeight - (window.innerWidth < 768 ? 420 : 360)),
  }));
  const [size, setSize] = useState({ w: 420, h: 300 });
  const dragging = useRef(false);
  const resizing = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const [tab, setTab] = useState<Tab>("log");
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [factsBusy, setFactsBusy] = useState(false);
  const [checks, setChecks] = useState<Record<string, boolean>>(loadCheckState);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [exportHint, setExportHint] = useState("");
  const [runtimeLine, setRuntimeLine] = useState("");

  // 监听 ragLog / console 捕获消息 → 写入 debug-store 日志
  useEffect(() => {
    return onRagLog((message) => {
      appendDebugLog(message);
    });
  }, []);

  // 订阅 debug-store 变化，刷新面板
  useEffect(() => {
    return subscribeDebugStore(() => setTick((t) => t + 1));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines.length]);

  // 记录状态变化
  useEffect(() => {
    const ts = new Date().toLocaleTimeString();
    appendDebugLog(`[${ts}] 引擎切换: ${engine}`);
  }, [engine]);

  useEffect(() => {
    if (currentNovel) {
      appendDebugLog(`打开小说: 《${currentNovel.title}》 (${currentNovel.chapterCount}章)`);
      const meta = getBGEMeta(currentNovel.id, engine);
      if (meta) {
        appendDebugLog(`索引: ${meta.chunkCount}片段 · ${meta.dim}维 · ${meta.buildTime ? (meta.buildTime / 1000).toFixed(1) + "s" : "已缓存"}`);
      } else {
        appendDebugLog(`索引: 尚未构建 (当前引擎: ${engine})`);
      }
    } else {
      appendDebugLog("书架页面");
    }
  }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 自检页开着时：挂时间线探针 + 每 2s 刷一次朗读运行时
  useEffect(() => {
    if (tab !== "check") return;
    const off = installProbes((line) => appendDebugLog(line));
    const tick = () => setRuntimeLine(getActiveTTSManager()?.describeRuntime() ?? "当前没有朗读会话");
    tick();
    const timer = setInterval(tick, 2000);
    return () => { off(); clearInterval(timer); };
  }, [tab]);

  // 拖拽 / 缩放：用 pointer 事件，手机触摸与鼠标同一条路径
  const onDragStart = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).classList.contains("resize-handle")) return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    startPos.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }, [pos]);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    resizing.current = true;
    startPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragging.current) {
        // 绝对定位跟随指针：startPos 已在按下时记录了"指针-面板原点"的偏移
        setPos(() => ({
          x: Math.min(Math.max(0, e.clientX - startPos.current.x), window.innerWidth - 80),
          y: Math.min(Math.max(0, e.clientY - startPos.current.y), window.innerHeight - 40),
        }));
      } else if (resizing.current) {
        const dw = e.clientX - startPos.current.x;
        const dh = e.clientY - startPos.current.y;
        setSize((s) => ({ w: Math.max(280, s.w + dw), h: Math.max(180, s.h + dh) }));
        startPos.current = { x: e.clientX, y: e.clientY };
      }
    };
    const onUp = () => {
      dragging.current = false;
      resizing.current = false;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const meta = currentNovel ? getBGEMeta(currentNovel.id, engine) : null;
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const refreshFacts = useCallback(async () => {
    setFactsBusy(true);
    try {
      const next = await collectFacts();
      setFacts(next);
      appendDebugLog(`环境事实已刷新（${next.length} 项）：${next.filter((f) => f.level === "bad").length} 项异常`);
    } finally {
      setFactsBusy(false);
    }
  }, []);

  const toggleCheck = useCallback((id: string) => {
    setChecks((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveCheckState(next);
      return next;
    });
  }, []);

  const doExport = useCallback(async () => {
    const report = buildReport(facts ?? [], checks);
    const timeline = getDebugLogLines().slice(-120).join("\n");
    const result = await exportReport(`${report}\n\n【最近事件时间线】\n${timeline}`);
    setExportHint(result === "shared" ? "已调起系统分享" : result === "copied" ? "报告已复制到剪贴板" : "浏览器不允许写入剪贴板：请在下方全选后手动复制");
    appendDebugLog(`导出真机自检报告（${result}）`);
  }, [facts, checks]);

  const doTone = useCallback(async () => {
    appendDebugLog("试声：440Hz 短音");
    const msg = await playTone();
    appendDebugLog(`试声结果：${msg}`);
    setExportHint(msg);
  }, []);

  const panelStyle = isMobile
    ? { left: 8, top: Math.max(8, window.innerHeight - 460), width: window.innerWidth - 16, height: Math.min(440, window.innerHeight - 24) }
    : { left: pos.x, top: pos.y, width: size.w, height: size.h };

  return (
    <div
      ref={panelRef}
      className="fixed z-[9999] bg-black/95 border border-gray-700 rounded-lg shadow-2xl overflow-hidden flex flex-col font-mono text-[11px]"
      style={{ ...panelStyle, pointerEvents: "all" }}
    >
      <div className="bg-gray-800 px-2 py-1 flex items-center justify-between cursor-move touch-none shrink-0" onPointerDown={onDragStart}>
        <span className="text-green-400 font-semibold text-[11px]">🔧 调试 {collapsed ? "—" : ""}</span>
        <div className="flex gap-1 items-center">
          <button
            type="button"
            className={`px-1.5 py-0.5 rounded text-[10px] ${tab === "log" ? "bg-green-900/60 text-green-200" : "text-gray-400"}`}
            onClick={() => setTab("log")}
            aria-pressed={tab === "log"}
          >
            日志
          </button>
          <button
            type="button"
            className={`px-1.5 py-0.5 rounded text-[10px] ${tab === "check" ? "bg-green-900/60 text-green-200" : "text-gray-400"}`}
            onClick={() => { setTab("check"); if (!facts && !factsBusy) void refreshFacts(); }}
            aria-pressed={tab === "check"}
          >
            真机自检
          </button>
          <button
            type="button"
            className="text-gray-400 hover:text-white px-1 text-xs"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开面板" : "收起面板"}
          >
            {collapsed ? "□" : "_"}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="px-2 py-0.5 bg-gray-900/50 border-b border-gray-800 text-gray-500 flex gap-4 shrink-0">
            <span>
              引擎: <span className={engine === "tfidf" ? "text-yellow-400" : "text-green-400"}>{getEngineDisplayName(engine)}</span>
            </span>
            {meta && <span>向量: {meta.chunkCount}片 · {meta.dim}维</span>}
            {currentNovel && !meta && <span className="text-yellow-400">索引未构建</span>}
            <span className="ml-auto">{entries.length} 次检索</span>
          </div>

          {tab === "log" ? (
            <>
              <div className="flex-1 overflow-auto px-2 py-1 bg-black text-green-300/90 leading-relaxed">
                {logLines.length === 0 && <div className="text-gray-600 py-4 text-center">等待事件...</div>}
                {logLines.map((line, i) => (
                  <div key={i} className="hover:bg-white/5">{line}</div>
                ))}
                <div ref={bottomRef} />
              </div>

              {entries.length > 0 && (
                <div className="border-t border-gray-800 shrink-0 max-h-32 overflow-auto bg-gray-950">
                  {entries.slice(0, 3).map((e) => (
                    <div key={e.id}>
                      <button
                        type="button"
                        className="w-full text-left px-2 py-0.5 hover:bg-gray-900 text-gray-400 flex justify-between text-[10px]"
                        onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                      >
                        <span className="truncate w-64">{e.query}</span>
                        <span>{e.results.length}条 · {e.engine}</span>
                      </button>
                      {expandedId === e.id && (
                        <div className="px-2 py-0.5 bg-gray-900/50 space-y-0.5 max-h-24 overflow-auto">
                          {e.results.slice(0, 8).map((r, i) => (
                            <div key={i} className="text-gray-500 leading-relaxed text-[10px]">
                              <span className="text-green-500/60">{r.score.toFixed(3)} </span>
                              {r.content.slice(0, 100)}{r.content.length > 100 ? "…" : ""}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 overflow-auto bg-black text-gray-200 leading-relaxed">
              <div className="sticky top-0 bg-gray-900/95 px-2 py-1 flex gap-2 items-center border-b border-gray-800">
                <button type="button" className="px-2 py-0.5 rounded bg-green-900/50 text-green-200 disabled:opacity-50" onClick={() => void refreshFacts()} disabled={factsBusy}>
                  {factsBusy ? "读取中…" : "刷新事实"}
                </button>
                <button type="button" className="px-2 py-0.5 rounded bg-blue-900/50 text-blue-200" onClick={() => void doTone()}>试声</button>
                <button type="button" className="px-2 py-0.5 rounded bg-gray-700 text-gray-100" onClick={() => void doExport()}>导出报告</button>
                {exportHint && <span className="text-[10px] text-yellow-300 truncate">{exportHint}</span>}
              </div>

              <div className="px-2 py-1 space-y-0.5">
                <div className="text-gray-500">朗读运行时（每 2 秒自动刷）：{runtimeLine || "—"}</div>
                {(facts ?? []).map((f) => (
                  <div key={f.label} className={LEVEL_STYLE[f.level]}>
                    <span className="text-gray-500">{f.label}：</span>{f.value}
                  </div>
                ))}
              </div>

              <div className="px-2 py-1 border-t border-gray-800 text-gray-500">
                手动清单 {Object.values(checks).filter(Boolean).length}/{DEVICE_CHECKLIST.length} 已核对（点开条目看怎么做）
              </div>
              <div className="px-2 pb-2 space-y-1">
                {DEVICE_CHECKLIST.map((item) => (
                  <div key={item.id} className="border border-gray-800 rounded p-1.5">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        id={`check-${item.id}`}
                        checked={!!checks[item.id]}
                        onChange={() => toggleCheck(item.id)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-green-500"
                      />
                      <label htmlFor={`check-${item.id}`} className="flex-1 text-gray-200">
                        {item.title}
                      </label>
                      <button
                        type="button"
                        className="text-gray-500 px-1"
                        onClick={() => setOpenItem(openItem === item.id ? null : item.id)}
                        aria-label={`展开 ${item.title} 的说明`}
                      >
                        {openItem === item.id ? "−" : "+"}
                      </button>
                    </div>
                    {openItem === item.id && (
                      <div className="mt-1 text-[10px] text-gray-400 space-y-0.5">
                        <div>怎么做：{item.how}</div>
                        <div>应看到：{item.expect}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="px-2 pb-2">
                <div className="text-gray-500 mb-1">事件时间线（最近 40 条）</div>
                <div className="max-h-32 overflow-auto bg-gray-950 border border-gray-800 rounded p-1 text-[10px] text-green-300/80 space-y-0.5">
                  {logLines.slice(-40).map((line, i) => <div key={i}>{line}</div>)}
                </div>
                <textarea
                  readOnly
                  value={buildReport(facts ?? [], checks)}
                  onFocus={(e) => e.currentTarget.select()}
                  className="mt-1 w-full h-16 bg-gray-950 border border-gray-800 rounded p-1 text-[10px] text-gray-400"
                  aria-label="自检报告纯文本（可手动全选复制）"
                />
              </div>
            </div>
          )}
        </>
      )}

      <div
        className="resize-handle absolute bottom-0 right-0 w-4 h-4 cursor-se-resize touch-none"
        onPointerDown={onResizeStart}
        style={{ background: "linear-gradient(135deg, transparent 50%, #555 50%)" }}
      />
    </div>
  );
}
