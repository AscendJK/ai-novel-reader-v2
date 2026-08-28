/**
 * NovelMapSection 组件 - 小说地图区域
 * 与 SubItem 类似，支持展开/折叠，与其他 AI 功能共享 loading 状态
 */

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { ChevronRight, ChevronDown, Map, Loader2, Maximize2, Download, RefreshCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MapData } from "@/agents/types";
import { renderMapToSvg, renderSvgToPng } from "@/components/map/renderMap";
import { sanitizeSvg } from "@/lib/sanitize-svg";
import { PlaceDetail } from "@/components/map/PlaceDetail";

interface NovelMapSectionProps {
  /** 小说 ID */
  novelId: string;
  /** 是否展开 */
  isOpen: boolean;
  /** 点击展开/折叠 */
  onClick: () => void;
  /** 是否正在加载（全局，用于禁用按钮） */
  loading: boolean;
  /** 自身是否正在加载（用于显示转圈图标） */
  selfLoading?: boolean;
  /** 地图数据 */
  mapData: MapData | null;
  /** 更新时间 */
  updatedAt?: number;
  /** 生成地图 */
  onGenerate: () => Promise<void>;
  /** 重新生成地图 */
  onRegenerate: () => Promise<void>;
}

export function NovelMapSection({
  isOpen,
  onClick,
  loading,
  selfLoading,
  mapData,
  updatedAt,
  onGenerate,
  onRegenerate,
}: NovelMapSectionProps) {
  const showSpinner = selfLoading ?? loading;
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const [fullscreenScale, setFullscreenScale] = useState(1);
  const [fullscreenPos, setFullscreenPos] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);

  // 缩放函数（以屏幕中心为基准）
  const handleZoom = useCallback((scaleFactor: number) => {
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    setFullscreenScale(s => {
      const newScale = Math.max(0.3, Math.min(5, s * scaleFactor));
      const ratio = newScale / s;

      // 调整位置，让缩放以屏幕中心为基准
      setFullscreenPos(pos => ({
        x: centerX - (centerX - pos.x) * ratio,
        y: centerY - (centerY - pos.y) * ratio,
      }));

      return newScale;
    });
  }, []);

  // 使用原生事件监听器处理滚轮（支持 preventDefault）
  useEffect(() => {
    const element = fullscreenContainerRef.current;
    if (!element || !showFullscreen) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const scaleFactor = e.deltaY > 0 ? 0.9 : 1.1;
      handleZoom(scaleFactor);
    };

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [showFullscreen, handleZoom]);

  // 触摸状态 ref（原生 touch 仅保留双指 pinch 缩放；单指点击/拖拽统一走 Pointer Events）
  const pinchStartRef = useRef<{ dist: number; scale: number } | null>(null);

  // 使用原生事件监听器处理双指 pinch（Pointer Events 不便于多指缩放，保留原生 touch）
  useEffect(() => {
    const element = fullscreenContainerRef.current;
    if (!element || !showFullscreen) return;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartRef.current = { dist: Math.hypot(dx, dy), scale: fullscreenScale };
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      // 仅在双指 pinch 时 preventDefault，避免破坏单指 tap 的 Pointer/click 事件合成
      if (e.touches.length === 2 && pinchStartRef.current) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        // 增强缩放灵敏度
        const ratio = dist / pinchStartRef.current.dist;
        const enhancedRatio = 1 + (ratio - 1) * 2; // 2 倍灵敏度
        const newScale = Math.max(0.3, Math.min(5, pinchStartRef.current.scale * enhancedRatio));
        setFullscreenScale(newScale);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchStartRef.current = null;
      }
    };

    element.addEventListener("touchstart", handleTouchStart, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: false });
    element.addEventListener("touchend", handleTouchEnd);

    return () => {
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      element.removeEventListener("touchend", handleTouchEnd);
    };
  }, [showFullscreen, fullscreenScale]);

  // 缓存 SVG 渲染结果
  const mapSvg = useMemo(() => {
    if (!mapData) return "";
    return renderMapToSvg(mapData);
  }, [mapData]);

  // 导出图片
  const handleExport = useCallback(async () => {
    if (!mapSvg) return;
    try {
      const blob = await renderSvgToPng(mapSvg);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `novel-map-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
    }
  }, [mapSvg]);

  // 导出 JSON
  const handleExportJson = useCallback(() => {
    if (!mapData) return;
    try {
      const jsonStr = JSON.stringify(mapData, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `novel-map-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export JSON failed:", err);
    }
  }, [mapData]);

  // 处理地点点击
  const handlePlaceClick = useCallback((e: React.MouseEvent) => {
    const target = (e.target as Element).closest(".place-group");
    if (target) {
      const placeId = target.getAttribute("data-id");
      setSelectedPlace(placeId);
    }
  }, []);

  // ---- 统一的指针交互（桌面鼠标 + 移动触摸，替代 onClick/mouse/touch 三套）----
  // 之前难点：① 移动端 touchmove 无条件 preventDefault 会让浏览器判定非 tap，
  // 取消 click 合成、把 pointerup 换成 pointercancel，导致 onClick/onPointerUp 不触发；
  // ② 依赖 e.target.closest 命中 SVG 内节点，真机命中不稳定。
  // 方案：单指点击/拖拽统一走 Pointer Events，用 elementFromPoint 兜底命中节点，
  // 仅在双指 pinch 时才 preventDefault（见原生 touch effect）。
  const pointerStateRef = useRef<{
    id: number;
    x: number;
    y: number;
    placeId: string | null;
    posX: number;
    posY: number;
    isDrag: boolean;
  } | null>(null);

  // 根据屏幕坐标定位 place-group（不依赖事件 target 的命中测试，更可靠）
  const placeIdFromPoint = useCallback((clientX: number, clientY: number): string | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const group = el?.closest?.(".place-group") as Element | null;
    return group?.getAttribute?.("data-id") ?? null;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // 只处理主触点（鼠标左键 / 触摸主触点；右键/附加键排除）
    if (e.button !== 0) return;
    const target = e.target as Element;
    const placeGroup = target?.closest?.(".place-group") as Element | null;
    const placeId = placeGroup?.getAttribute?.("data-id") ?? null;
    pointerStateRef.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      placeId,
      posX: fullscreenPos.x,
      posY: fullscreenPos.y,
      isDrag: false,
    };
    // 只在非节点处准备拖拽
    if (!placeId) {
      setDragStart({ x: e.clientX - fullscreenPos.x, y: e.clientY - fullscreenPos.y });
    }
  }, [fullscreenPos]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const s = pointerStateRef.current;
    if (!s || s.id !== e.pointerId) return;
    // 非节点处，位移超过阈值才进入拖拽（避免 tap 被误判为拖拽）
    if (!s.isDrag && !s.placeId) {
      const dx = Math.abs(e.clientX - s.x);
      const dy = Math.abs(e.clientY - s.y);
      if (dx > 6 || dy > 6) {
        s.isDrag = true;
        setIsDragging(true);
        setDragStart({ x: e.clientX - fullscreenPos.x, y: e.clientY - fullscreenPos.y });
      }
    } else if (s.isDrag) {
      setFullscreenPos({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    }
  }, [fullscreenPos, dragStart]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const s = pointerStateRef.current;
    // 只处理对应的 pointer
    if (!s || s.id !== e.pointerId) return;
    pointerStateRef.current = null;
    // 若刚进行过双指 pinch（第二指抬起时第一指会收到 pointerup），忽略以免误触节点
    if (pinchStartRef.current) {
      setIsDragging(false);
      return;
    }
    if (s.isDrag) {
      setIsDragging(false);
      return;
    }
    const dx = Math.abs(e.clientX - s.x);
    const dy = Math.abs(e.clientY - s.y);
    if (dx > 12 || dy > 12) {
      setIsDragging(false);
      return; // 位移大，非点击
    }
    // 点击：命中节点则弹出描述（优先用按下时解析，兜底用坐标定位）
    const placeId = s.placeId || placeIdFromPoint(e.clientX, e.clientY);
    if (placeId) {
      setSelectedPlace(placeId);
    }
  }, [placeIdFromPoint]);

  const handlePointerCancel = useCallback(() => {
    pointerStateRef.current = null;
    setIsDragging(false);
  }, []);

  // 获取选中的地点
  const selectedPlaceData = mapData && selectedPlace
    ? mapData.places.find((p) => p.id === selectedPlace)
    : null;

  // 空状态：显示生成按钮（与 SubItem 一致）
  if (!mapData && !showSpinner) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          onClick={onGenerate}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors py-0.5"
        >
          <Map className="h-3 w-3" />
          生成小说地图
        </button>
      </div>
    );
  }

  // 加载中状态
  if (!mapData && showSpinner) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          disabled
          className="flex items-center gap-1 text-xs text-muted-foreground py-0.5"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          生成小说地图
        </button>
      </div>
    );
  }

  // 有数据：显示可折叠内容
  return (
    <div>
      {/* 标题栏 */}
      <div className="flex items-center gap-1">
        <button
          onClick={onClick}
          className="flex items-center gap-1 text-xs font-medium hover:text-primary transition-colors flex-1 text-left"
        >
          {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          {showSpinner ? <Loader2 className="h-3 w-3 animate-spin" /> : <Map className="h-3 w-3" />}
          小说地图
        </button>
        <span className="text-[10px] text-muted-foreground">图一乐，切勿当真</span>
        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onRegenerate} disabled={loading}>
          <RefreshCw className={`h-2.5 w-2.5 ${showSpinner ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* 展开内容 */}
      {isOpen && (
        <div className="mt-1 space-y-1.5 pl-4">
          <div className="space-y-2">
            {/* 地图预览 */}
            <div
              className="relative w-full h-48 overflow-hidden rounded border cursor-pointer"
              onClick={handlePlaceClick}
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerUp}
            >
              <div
                className="absolute inset-0"
                dangerouslySetInnerHTML={{ __html: sanitizeSvg(mapSvg) }}
                style={{ transform: "scale(0.35)", transformOrigin: "top left", width: "286%", height: "286%" }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" style={{ pointerEvents: "none" }} />

              <div className="absolute bottom-2 left-2 right-2 flex justify-between items-end">
                <div className="text-xs text-white">
                  {mapData && <p>{mapData.layers?.length ?? 0} 个层级 · {mapData.places?.length ?? 0} 个地点 · {mapData.forces?.length ?? 0} 个势力</p>}
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-6 text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      // 计算居中位置
                      const mapWidth = 900;
                      const mapHeight = 650;
                      const screenWidth = window.innerWidth;
                      const screenHeight = window.innerHeight;
                      setFullscreenPos({
                        x: (screenWidth - mapWidth) / 2,
                        y: (screenHeight - mapHeight) / 2,
                      });
                      setFullscreenScale(1);
                      setShowFullscreen(true);
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
                      handleExport();
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

            {/* 地图信息 */}
            <div className="text-xs text-muted-foreground space-y-0.5">
              {mapData && (
                <>
                  <p>层级：{mapData.layers.map(l => l.name).join(" → ")} · 地点：{mapData.places.length} 个</p>
                  {mapData.forces.length > 0 && (
                    <p>势力：{mapData.forces.map(f => f.name).join("、")}</p>
                  )}
                  {mapData.regions.length > 0 && (
                    <p>区域：{mapData.regions.map(r => r.name).join("、")}</p>
                  )}
                </>
              )}
              {updatedAt && (
                <p>更新时间：{new Date(updatedAt).toLocaleString("zh-CN")}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 地点详情弹窗 */}
      {selectedPlaceData && mapData && (
        <PlaceDetail
          place={selectedPlaceData}
          layers={mapData.layers}
          parentPlace={selectedPlaceData.parentId ? mapData.places.find(p => p.id === selectedPlaceData.parentId) : undefined}
          childPlaces={mapData.places.filter(p => p.parentId === selectedPlace)}
          forces={mapData.forces.filter((f) => f.places.includes(selectedPlace!))}
          onClose={() => setSelectedPlace(null)}
        />
      )}

      {/* 全屏地图 */}
      {showFullscreen && mapData && (
        <div
          ref={fullscreenContainerRef}
          className="fixed inset-0 z-[9999] bg-background flex flex-col"
          style={{ touchAction: "none" }}
        >
          {/* 工具栏 */}
          <div className="flex items-center justify-between p-2 border-b bg-background z-10">
            <div className="flex items-center gap-2">
              {/* 缩放控件（对齐人物关系图样式：缩小 | 百分比% | 放大） */}
              <div className="flex items-center gap-1.5 bg-background px-1 rounded-md">
                <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => handleZoom(0.8)} title="缩小" aria-label="缩小">
                  <ZoomOut className="h-3.5 w-3.5" />
                </Button>
                <span className="text-xs text-muted-foreground w-10 text-center">{Math.round(fullscreenScale * 100)}%</span>
                <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => handleZoom(1.2)} title="放大" aria-label="放大">
                  <ZoomIn className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowFullscreen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* 地图内容 */}
          <div
            className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
            style={{ touchAction: "none" }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={handlePointerCancel}
          >
            <div
              style={{
                transform: `translate(${fullscreenPos.x}px, ${fullscreenPos.y}px) scale(${fullscreenScale})`,
                transformOrigin: "0 0",
                transition: isDragging ? "none" : "transform 0.1s ease",
              }}
              dangerouslySetInnerHTML={{ __html: sanitizeSvg(mapSvg) }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
