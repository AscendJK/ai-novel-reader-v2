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
  novelId,
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
      const newScale = Math.max(0.3, Math.min(3, s * scaleFactor));
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

  // 触摸状态 ref
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const pinchStartRef = useRef<{ dist: number; scale: number } | null>(null);

  // 使用原生事件监听器处理触摸（支持 preventDefault）
  useEffect(() => {
    const element = fullscreenContainerRef.current;
    if (!element || !showFullscreen) return;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        // 检查目标是否是地点元素
        const target = e.target as Element;
        const placeGroup = target?.closest?.(".place-group");
        const placeId = placeGroup?.getAttribute?.("data-id");

        touchStartRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
        };
        (touchStartRef.current as any).posX = fullscreenPos.x;
        (touchStartRef.current as any).posY = fullscreenPos.y;
        (touchStartRef.current as any).placeId = placeId || null;

        if (!placeId) {
          setIsDragging(true);
        }
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartRef.current = { dist: Math.hypot(dx, dy), scale: fullscreenScale };
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault(); // 阻止浏览器默认行为
      if (e.touches.length === 1 && touchStartRef.current && !(touchStartRef.current as any).placeId) {
        // 计算手指移动距离，乘以 3 倍系数提高灵敏度
        const dx = (e.touches[0].clientX - touchStartRef.current.x) * 3;
        const dy = (e.touches[0].clientY - touchStartRef.current.y) * 3;
        setFullscreenPos({
          x: (touchStartRef.current as any).posX + dx,
          y: (touchStartRef.current as any).posY + dy,
        });
      } else if (e.touches.length === 2 && pinchStartRef.current) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        // 增强缩放灵敏度
        const ratio = dist / pinchStartRef.current.dist;
        const enhancedRatio = 1 + (ratio - 1) * 2; // 2 倍灵敏度
        const newScale = Math.max(0.3, Math.min(3, pinchStartRef.current.scale * enhancedRatio));
        setFullscreenScale(newScale);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      // 检测是否是点击（移动距离小于 10px）
      if (touchStartRef.current && e.changedTouches.length === 1) {
        const dx = Math.abs(e.changedTouches[0].clientX - touchStartRef.current.x);
        const dy = Math.abs(e.changedTouches[0].clientY - touchStartRef.current.y);
        if (dx < 10 && dy < 10) {
          // 是点击，检查是否有地点 ID
          const placeId = (touchStartRef.current as any).placeId;
          if (placeId) {
            setSelectedPlace(placeId);
          }
        }
      }
      setIsDragging(false);
      touchStartRef.current = null;
      pinchStartRef.current = null;
    };

    element.addEventListener("touchstart", handleTouchStart, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: false });
    element.addEventListener("touchend", handleTouchEnd);

    return () => {
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      element.removeEventListener("touchend", handleTouchEnd);
    };
  }, [showFullscreen, fullscreenPos, fullscreenScale]);

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
            >
              <div
                className="absolute inset-0"
                dangerouslySetInnerHTML={{ __html: sanitizeSvg(mapSvg) }}
                style={{ transform: "scale(0.35)", transformOrigin: "top left", width: "286%", height: "286%" }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />

              <div className="absolute bottom-2 left-2 right-2 flex justify-between items-end">
                <div className="text-xs text-white">
                  <p>{mapData.layers.length} 个层级 · {mapData.places.length} 个地点 · {mapData.forces.length} 个势力</p>
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
              <p>层级：{mapData.layers.map(l => l.name).join(" → ")} · 地点：{mapData.places.length} 个</p>
              {mapData.forces.length > 0 && (
                <p>势力：{mapData.forces.map(f => f.name).join("、")}</p>
              )}
              {mapData.regions.length > 0 && (
                <p>区域：{mapData.regions.map(r => r.name).join("、")}</p>
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
              {/* 视图缩放 */}
              <Button size="sm" variant="outline" onClick={() => handleZoom(1.2)}>
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleZoom(0.8)}>
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground">{Math.round(fullscreenScale * 100)}%</span>
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
            onMouseDown={(e) => {
              if (e.button === 0) {
                setIsDragging(true);
                setDragStart({ x: e.clientX - fullscreenPos.x, y: e.clientY - fullscreenPos.y });
              }
            }}
            onMouseMove={(e) => {
              if (isDragging) {
                setFullscreenPos({
                  x: e.clientX - dragStart.x,
                  y: e.clientY - dragStart.y,
                });
              }
            }}
            onMouseUp={() => setIsDragging(false)}
            onMouseLeave={() => setIsDragging(false)}
            onClick={handlePlaceClick}
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
