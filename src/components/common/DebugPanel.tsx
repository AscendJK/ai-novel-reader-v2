import { useState, useEffect, useRef, useCallback } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { useRAGStore } from "@/stores/rag-store";
import { getEngineDisplayName } from "@/rag/engines";
import { getBGEMeta } from "@/rag/index";
import { onRagLog } from "@/lib/logger";
import { subscribeDebugStore, appendDebugLog, getDebugEntries, getDebugLogLines } from "@/lib/debug-store";

export function DebugPanel() {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const engine = useRAGStore((s) => s.engine);
  const [, setTick] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const logLines = getDebugLogLines();
  const entries = getDebugEntries();
  const [pos, setPos] = useState({ x: window.innerWidth - 480, y: window.innerHeight - 360 });
  const [size, setSize] = useState({ w: 420, h: 300 });
  const dragging = useRef(false);
  const resizing = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });

  // 监听 ragLog 消息 → 写入 debug-store 日志
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

  // 拖拽 / 缩放
  const onDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains("resize-handle")) return;
    dragging.current = true;
    startPos.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }, [pos]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    resizing.current = true;
    startPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({ x: e.clientX - startPos.current.x, y: e.clientY - startPos.current.y });
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
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const meta = currentNovel ? getBGEMeta(currentNovel.id, engine) : null;
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      ref={panelRef}
      className="fixed z-[9999] bg-black/95 border border-gray-700 rounded-lg shadow-2xl overflow-hidden flex flex-col font-mono text-[11px]"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h, pointerEvents: "all" }}
    >
      <div className="bg-gray-800 px-2 py-1 flex items-center justify-between cursor-move shrink-0" onMouseDown={onDragStart}>
        <span className="text-green-400 font-semibold text-[11px]">
          {`🔧 RAG Debug `}
          {collapsed ? "—" : ""}
        </span>
        <div className="flex gap-1">
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
      )}

      <div
        className="resize-handle absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
        onMouseDown={onResizeStart}
        style={{ background: "linear-gradient(135deg, transparent 50%, #555 50%)" }}
      />
    </div>
  );
}
