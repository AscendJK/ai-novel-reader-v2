import { useEffect, useRef, useState, useCallback } from "react";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from "d3-force";
import type { GraphData } from "@/hooks/useSummarizer";
import { Button } from "@/components/ui/button";
import { Maximize2, X, RefreshCw, ZoomIn, ZoomOut, Download } from "lucide-react";

interface Props {
  graphData: GraphData;
  onRegenerate?: () => void;
}

const GROUP_COLORS: Record<string, string> = {
  "主角": "#7c3aed",
  "配角": "#2563eb",
  "反派": "#dc2626",
  "导师": "#059669",
  "恋人": "#ec4899",
  "中立": "#f59e0b",
  "悲剧": "#6366f1",
  "幕后黑手": "#7c2d12",
  "工具人": "#84cc16",
  "其他": "#6b7280",
};

/**
 * 根据 group 名称获取颜色
 * 如果是预定义的颜色，直接返回
 * 否则根据名称生成一致的颜色
 */
function getColor(group: string): string {
  // 预定义颜色
  if (GROUP_COLORS[group]) {
    return GROUP_COLORS[group];
  }

  // 根据名称生成颜色
  const hash = group.split("").reduce((acc, char) => {
    return char.charCodeAt(0) + ((acc << 5) - acc);
  }, 0);
  return `hsl(${Math.abs(hash) % 360}, 70%, 50%)`;
}

interface SimNode { id: string; group: string; description: string; x: number; y: number }
interface SimEdge { source: SimNode; target: SimNode; label: string }

export function CharacterGraph({ graphData, onRegenerate }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [simData, setSimData] = useState<{ nodes: SimNode[]; edges: SimEdge[] } | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [tooltip, setTooltip] = useState<{ desc: string; x: number; y: number } | null>(null);
  const [ttScreen, setTTScreen] = useState<{ sx: number; sy: number }>({ sx: 0, sy: 0 });

  // Pinch-to-zoom state
  const pinchStartDist = useRef(0);
  const pinchStartZoom = useRef(1);

  // Reset on expand/collapse
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [expanded]);

  const handleZoom = useCallback((delta: number) => {
    setZoom((z) => Math.max(0.3, Math.min(5, z + delta)));
  }, []);

  // 导出图片
  const handleExportImage = useCallback(() => {
    const svgEl = svgRef.current || containerRef.current?.querySelector("svg");
    if (!svgEl) return;
    try {
      // 克隆 SVG 以避免修改原始元素
      const cloned = svgEl.cloneNode(true) as SVGSVGElement;
      // 从 viewBox 提取坐标和尺寸
      const vb = (svgEl.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
      const vbX = vb[0] || 0;
      const vbY = vb[1] || 0;
      const vbW = vb[2] || 800;
      const vbH = vb[3] || 600;
      // 设置明确的宽高，确保导出完整内容
      const exportW = Math.max(vbW, 800);
      const exportH = Math.max(vbH, 600);
      cloned.setAttribute("width", String(exportW));
      cloned.setAttribute("height", String(exportH));
      cloned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      // 添加白色背景（覆盖整个 viewBox 区域）
      const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bg.setAttribute("x", String(vbX));
      bg.setAttribute("y", String(vbY));
      bg.setAttribute("width", String(vbW));
      bg.setAttribute("height", String(vbH));
      bg.setAttribute("fill", "#ffffff");
      cloned.insertBefore(bg, cloned.firstChild);

      const svgData = new XMLSerializer().serializeToString(cloned);
      const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        const scale = 2; // 2x 分辨率
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth * scale;
        canvas.height = img.naturalHeight * scale;
        const ctx = canvas.getContext("2d")!;
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `character-graph-${Date.now()}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }
        }, "image/png");
        URL.revokeObjectURL(url);
      };
      img.src = url;
    } catch (err) {
      console.error("Export image failed:", err);
    }
  }, []);

  // 导出 JSON
  const handleExportJson = useCallback(() => {
    if (!graphData) return;
    try {
      const jsonStr = JSON.stringify(graphData, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `character-graph-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export JSON failed:", err);
    }
  }, [graphData]);

  useEffect(() => {
    if (!graphData.nodes.length) return;

    const nodes: SimNode[] = graphData.nodes.map((n) => ({
      ...n, x: (Math.random() - 0.5) * 300, y: (Math.random() - 0.5) * 300,
    }));

    const edges: SimEdge[] = graphData.edges
      .map((e) => ({
        source: nodes.find((n) => n.id === e.source)!,
        target: nodes.find((n) => n.id === e.target)!,
        label: e.label,
      }))
      .filter((l) => l.source && l.target);

    const sim = forceSimulation(nodes)
      .force("link", forceLink<SimNode, SimEdge>(edges).distance(200).strength(0.3))
      .force("charge", forceManyBody().strength(-900))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide(55))
      .stop();

    // Run simulation in chunks to avoid blocking the main thread
    const maxIterations = 300;
    const chunkSize = 50;
    let iteration = 0;
    const runChunk = () => {
      const end = Math.min(iteration + chunkSize, maxIterations);
      for (; iteration < end; iteration++) {
        sim.tick();
        if (sim.alpha() < 0.001) break;
      }
      if (iteration < maxIterations && sim.alpha() >= 0.001) {
        requestAnimationFrame(runChunk);
      } else {
        // Simulation complete, update state
        const finalNodes = nodes.map((n) => ({ ...n }));
        const finalEdges = edges.map((e) => ({
          ...e,
          source: finalNodes.find((fn) => fn.id === (e.source as SimNode).id)!,
          target: finalNodes.find((fn) => fn.id === (e.target as SimNode).id)!,
        }));
        setSimData({ nodes: finalNodes, edges: finalEdges });
      }
    };
    requestAnimationFrame(runChunk);
  }, [graphData]);

  // Mouse drag handlers for panning
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!expanded) return;
    setDragging(true);
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging || !expanded) return;
    setPan({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y,
    });
  };

  const handleMouseUp = () => setDragging(false);

  // Mouse wheel zoom — use native listener to allow preventDefault
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !expanded) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      setZoom((z) => Math.max(0.3, Math.min(5, z + delta)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [expanded]);

  // Touch handlers for pinch-to-zoom
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!expanded) return;
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDist.current = Math.hypot(dx, dy);
      pinchStartZoom.current = zoom;
    } else if (e.touches.length === 1) {
      setDragging(true);
      dragStart.current = { x: e.touches[0].clientX - pan.x, y: e.touches[0].clientY - pan.y };
    }
  }, [expanded, zoom, pan]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!expanded) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const scale = dist / pinchStartDist.current;
      setZoom(Math.max(0.3, Math.min(5, pinchStartZoom.current * scale)));
    } else if (e.touches.length === 1 && dragging) {
      setPan({
        x: e.touches[0].clientX - dragStart.current.x,
        y: e.touches[0].clientY - dragStart.current.y,
      });
    }
  }, [expanded, dragging]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length < 2) setDragging(false);
  }, []);

  if (!graphData.nodes.length) {
    return <div className="text-xs text-muted-foreground text-center py-4">图谱数据为空，请重试</div>;
  }
  if (!simData) {
    return <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">计算布局中...</div>;
  }

  // Compute tight bounds from actual node positions
  const nodesXs = simData.nodes.map((n) => n.x);
  const nodesYs = simData.nodes.map((n) => n.y);
  const pad = expanded ? 80 : 50;
  const minX = Math.min(...nodesXs) - pad;
  const maxX = Math.max(...nodesXs) + pad;
  const minY = Math.min(...nodesYs) - pad;
  const maxY = Math.max(...nodesYs) + pad;
  const viewW = maxX - minX;
  const viewH = maxY - minY;
  const viewBoxStr = `${minX} ${minY} ${viewW} ${viewH}`;

  const fontSize = expanded ? 13 : 9;
  const nodeRadius = expanded ? 24 : 14;

  // Inline container height: dynamic based on aspect ratio, clamped to reasonable range
  const aspectRatio = viewH > 0 ? viewW / viewH : 1;
  const inlineHeight = expanded ? 0 : Math.max(140, Math.min(320, Math.round(280 / aspectRatio)));

  return (
    <>
      {/* Inline graph */}
      <div className="relative border rounded-lg bg-muted/20 overflow-hidden" style={{ height: inlineHeight }}>
        {onRegenerate && (
          <div className="absolute top-1 right-1 z-10">
            <Button variant="ghost" size="icon" className="h-6 w-6 bg-background/80" onClick={onRegenerate} title="重绘">
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
        )}
        <div className="w-full h-full flex items-center justify-center">
          <svg ref={svgRef} viewBox={viewBoxStr}
            className="w-full h-full" preserveAspectRatio="xMidYMid meet">
            {simData.nodes.map((n) => (
              <g key={n.id}>
                <circle cx={n.x} cy={n.y} r={nodeRadius} fill={getColor(n.group)}
                  stroke="var(--background)" strokeWidth={1.5} />
                <text x={n.x} y={n.y} textAnchor="middle" dominantBaseline="middle" dy="0.1em"
                  className="fill-foreground font-medium" fontSize={fontSize}>
                  {n.id}
                </text>
                {n.description && (
                  <circle cx={n.x} cy={n.y} r={nodeRadius * 2} fill="transparent" style={{ pointerEvents: "all", cursor: "pointer" }}
                    onMouseEnter={(e) => { setTooltip({ desc: n.description, x: n.x, y: n.y }); setTTScreen({ sx: e.clientX, sy: e.clientY }); }}
                    onMouseMove={(e) => setTTScreen({ sx: e.clientX, sy: e.clientY })}
                    onMouseLeave={() => setTooltip(null)}
                    onClick={(e) => setTooltip((prev) => prev ? null : { desc: n.description, x: n.x, y: n.y })}
                  />
                )}
              </g>
            ))}
            {simData.edges.map((e, i) => {
              if (!e.source || !e.target) return null;
              const mx = (e.source.x + e.target.x) / 2;
              const my = (e.source.y + e.target.y) / 2;
              return (
                <g key={`e-${i}`}>
                  <line x1={e.source.x} y1={e.source.y} x2={e.target.x} y2={e.target.y}
                    stroke="currentColor" strokeOpacity={0.12} strokeWidth={0.8} />
                  <text x={mx} y={my} textAnchor="middle" dominantBaseline="middle"
                    className="fill-muted-foreground" fontSize={fontSize * 0.85} dy={6}>
                    {e.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        {/* Bottom gradient overlay with info and export buttons */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/50 to-transparent p-2">
          <div className="flex justify-between items-end">
            <div className="text-xs text-white">
              <p>{simData.nodes.length} 人 · {simData.edges.length} 条关系</p>
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="secondary"
                className="h-6 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(true);
                }}
              >
                <Maximize2 className="h-3 w-3 mr-1" />
                大图
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="h-6 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  handleExportImage();
                }}
              >
                <Download className="h-3 w-3 mr-1" />
                导出图片
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="h-6 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  handleExportJson();
                }}
              >
                <Download className="h-3 w-3 mr-1" />
                导出JSON
              </Button>
            </div>
          </div>
        </div>
      </div>
      {/* Inline tooltip - fixed positioning to avoid overflow-hidden clipping */}
      {!expanded && tooltip && (
        <div className="fixed z-[60] px-2 py-1 rounded bg-black/90 text-white text-xs max-w-56 pointer-events-none"
          style={{ left: ttScreen.sx + 12, top: ttScreen.sy - 10 }}>
          {tooltip.desc}
        </div>
      )}

      {/* Expanded fullscreen */}
      {expanded && (
        <div className="fixed inset-0 z-50 bg-background/95 flex flex-col">
          {/* Top bar */}
          <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
            <div className="flex gap-1.5 items-center">
              <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => handleZoom(-0.2)} title="缩小">
                <ZoomOut className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs text-muted-foreground w-10 text-center">{Math.round(zoom * 100)}%</span>
              <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => handleZoom(0.2)} title="放大">
                <ZoomIn className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Button variant="outline" size="icon" onClick={() => setExpanded(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          {/* Scrollable graph area */}
          <div
            ref={containerRef}
            className="flex-1 overflow-auto cursor-grab active:cursor-grabbing"
            style={{ touchAction: "none" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <div
              className="min-w-full min-h-full flex items-center justify-center p-8"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "center center",
              }}
            >
              <svg
                viewBox={viewBoxStr}
                style={{ width: "100%", height: "100%", maxWidth: viewW + 120, maxHeight: viewH + 120 }}
                preserveAspectRatio="xMidYMid meet"
              >
                {simData.edges.map((e, i) => {
                  if (!e.source || !e.target) return null;
                  const mx = (e.source.x + e.target.x) / 2;
                  const my = (e.source.y + e.target.y) / 2;
                  return (
                    <g key={`ee-${i}`}>
                      <line x1={e.source.x} y1={e.source.y} x2={e.target.x} y2={e.target.y}
                        stroke="currentColor" strokeOpacity={0.15} strokeWidth={1.5} />
                      <text x={mx} y={my} textAnchor="middle" dominantBaseline="middle"
                        className="fill-muted-foreground" fontSize={fontSize} dy={8}>
                        {e.label}
                      </text>
                    </g>
                  );
                })}
                {simData.nodes.map((n) => (
                  <g key={n.id}>
                    <circle cx={n.x} cy={n.y} r={nodeRadius} fill={getColor(n.group)}
                      stroke="var(--background)" strokeWidth={2} />
                    <text x={n.x} y={n.y} textAnchor="middle" dominantBaseline="middle" dy="0.1em"
                      className="fill-foreground font-medium" fontSize={fontSize}>
                      {n.id}
                    </text>
                    {n.description && (
                      <circle cx={n.x} cy={n.y} r={nodeRadius * 2} fill="transparent" style={{ pointerEvents: "all", cursor: "pointer" }}
                        onMouseEnter={(e) => { setTooltip({ desc: n.description, x: n.x, y: n.y }); setTTScreen({ sx: e.clientX, sy: e.clientY }); }}
                        onMouseMove={(e) => setTTScreen({ sx: e.clientX, sy: e.clientY })}
                        onMouseLeave={() => setTooltip(null)}
                        onClick={(e) => setTooltip((prev) => prev ? null : { desc: n.description, x: n.x, y: n.y }) as any}
                      />
                    )}
                  </g>
                ))}
                {/* Legend */}
                <g transform={`translate(${maxX - 160}, ${minY + 10})`}>
                  {Object.entries(GROUP_COLORS).slice(0, -1).map(([group, color], i) => (
                    <g key={group} transform={`translate(0, ${i * 18})`}>
                      <circle cx={0} cy={0} r={4} fill={color} />
                      <text x={10} y={3} className="fill-muted-foreground" fontSize={10}>{group}</text>
                    </g>
                  ))}
                </g>
              </svg>
            </div>
            {/* Tooltip */}
            {tooltip && (
              <div className="fixed z-[60] px-2 py-1 rounded bg-black/90 text-white text-xs max-w-56 pointer-events-none"
                style={{ left: ttScreen.sx + 12, top: ttScreen.sy - 10 }}>
                {tooltip.desc}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
