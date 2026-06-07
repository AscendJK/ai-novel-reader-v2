/**
 * NovelMap 组件 - 主地图组件
 * 支持拖拽、缩放、全屏、导出、Tooltip
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { ZoomIn, ZoomOut, Download, RefreshCw, FileJson } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MapData } from "@/agents/types";
import { renderMapToSvg, renderSvgToPng } from "./renderMap";
import { sanitizeSvg } from "@/lib/sanitize-svg";
import { PlaceDetail } from "./PlaceDetail";

interface NovelMapProps {
  /** 地图数据 */
  mapData: MapData;
  /** 重新生成回调 */
  onRegenerate?: () => void;
  /** 是否正在加载 */
  loading?: boolean;
}

export function NovelMap({ mapData, onRegenerate, loading }: NovelMapProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);
  const [hoveredPlace, setHoveredPlace] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  // 渲染 SVG
  const svgContent = renderMapToSvg(mapData);

  // 处理缩放
  const handleZoom = useCallback((delta: number) => {
    setScale((prev) => Math.max(0.5, Math.min(3, prev + delta)));
  }, []);

  // 处理拖拽开始
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // 只响应左键
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  }, [position]);

  // 处理拖拽
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  }, [isDragging, dragStart]);

  // 处理拖拽结束
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // 处理滚轮缩放
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    handleZoom(delta);
  }, [handleZoom]);

  // 触摸状态 ref
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const pinchStartRef = useRef<{ dist: number; scale: number } | null>(null);

  // 处理触摸开始
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = {
        x: e.touches[0].clientX - position.x,
        y: e.touches[0].clientY - position.y,
      };
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartRef.current = { dist: Math.hypot(dx, dy), scale };
    }
  }, [position, scale]);

  // 处理触摸移动
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1 && touchStartRef.current) {
      setPosition({
        x: e.touches[0].clientX - touchStartRef.current.x,
        y: e.touches[0].clientY - touchStartRef.current.y,
      });
    } else if (e.touches.length === 2 && pinchStartRef.current) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const newScale = Math.max(0.5, Math.min(3, pinchStartRef.current.scale * (dist / pinchStartRef.current.dist)));
      setScale(newScale);
    }
  }, []);

  // 处理触摸结束
  const handleTouchEnd = useCallback(() => {
    touchStartRef.current = null;
    pinchStartRef.current = null;
  }, []);


  // 处理导出图片
  const handleExportImage = useCallback(async () => {
    try {
      const blob = await renderSvgToPng(svgContent);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `novel-map-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
    }
  }, [svgContent]);

  // 处理导出 JSON
  const handleExportJson = useCallback(() => {
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
    const target = (e.target as HTMLElement).closest(".place-group");
    if (target) {
      const placeId = target.getAttribute("data-id");
      setSelectedPlace(placeId);
    }
  }, []);

  // 处理鼠标悬停（使用原生事件）
  useEffect(() => {
    console.log("[Tooltip] useEffect called");
    const container = mapRef.current;
    console.log("[Tooltip] mapRef.current", container);

    if (!container) {
      console.log("[Tooltip] container is null, retrying...");
      // 延迟重试
      const timer = setTimeout(() => {
        const retryContainer = mapRef.current;
        console.log("[Tooltip] retry container", retryContainer);
        if (retryContainer) {
          attachListeners(retryContainer);
        }
      }, 100);
      return () => clearTimeout(timer);
    }

    attachListeners(container);

    function attachListeners(el: HTMLElement) {
      console.log("[Tooltip] attaching listeners to", el);

      const handleMouseMove = (e: MouseEvent) => {
        const target = e.target as Element;
        console.log("[Tooltip] mousemove", target.tagName, target.className);

        let placeId: string | null = null;

        // 检查当前元素
        if (target.classList?.contains("place-group")) {
          placeId = target.getAttribute("data-id");
        }
        // 检查父元素
        else if (target.parentElement?.classList?.contains("place-group")) {
          placeId = target.parentElement.getAttribute("data-id");
        }
        // 检查祖父元素
        else if (target.parentElement?.parentElement?.classList?.contains("place-group")) {
          placeId = target.parentElement.parentElement.getAttribute("data-id");
        }

        if (placeId) {
          console.log("[Tooltip] found place", placeId);
          setHoveredPlace(placeId);
          setMousePos({ x: e.clientX, y: e.clientY });
        } else {
          setHoveredPlace(null);
        }
      };

      const handleMouseLeave = () => {
        console.log("[Tooltip] mouseleave");
        setHoveredPlace(null);
      };

      el.addEventListener("mousemove", handleMouseMove);
      el.addEventListener("mouseleave", handleMouseLeave);

      // 存储清理函数
      (el as any).__tooltipCleanup = () => {
        el.removeEventListener("mousemove", handleMouseMove);
        el.removeEventListener("mouseleave", handleMouseLeave);
      };
    }

    return () => {
      if ((container as any).__tooltipCleanup) {
        (container as any).__tooltipCleanup();
      }
    };
  }, []);

  // 获取选中的地点
  const selectedPlaceData = selectedPlace
    ? mapData.places.find((p) => p.id === selectedPlace)
    : null;

  return (
    <div
      ref={wrapperRef}
      className="w-full h-full relative"
    >
      {/* 控制按钮 */}
      <div className="absolute top-2 right-2 z-10 flex gap-1">
        <Button size="sm" variant="outline" onClick={() => handleZoom(0.1)} title="放大">
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => handleZoom(-0.1)} title="缩小">
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={handleExportImage} title="导出图片">
          <Download className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={handleExportJson} title="导出 JSON">
          <FileJson className="h-4 w-4" />
        </Button>
        {onRegenerate && (
          <Button size="sm" variant="outline" onClick={onRegenerate} disabled={loading} title="重新生成">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        )}
      </div>

      {/* 缩放比例显示 */}
      <div className="absolute bottom-2 right-2 z-10 text-xs text-muted-foreground bg-background/80 px-2 py-1 rounded">
        {Math.round(scale * 100)}%
      </div>

      {/* 地图容器 */}
      <div
        ref={mapRef}
        className="w-full h-full cursor-grab active:cursor-grabbing"
        style={{ touchAction: "none", overflow: "hidden" }}
        onMouseDown={handleMouseDown}
        onMouseMove={(e) => {
          // 拖拽处理
          if (isDragging) {
            setPosition({
              x: e.clientX - dragStart.x,
              y: e.clientY - dragStart.y,
            });
          }
        }}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          handleMouseUp();
        }}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transformOrigin: "0 0",
            transition: isDragging ? "none" : "transform 0.1s ease",
          }}
          onClick={handlePlaceClick}
          dangerouslySetInnerHTML={{ __html: sanitizeSvg(svgContent) }}
        />
      </div>

      {/* Tooltip */}
      {hoveredPlace && (() => {
        const place = mapData.places.find(p => p.id === hoveredPlace);
        if (!place) return null;

        const layerName = mapData.layers.find(l => l.level === place.level)?.name || "";
        const parentName = place.parentId ? mapData.places.find(p => p.id === place.parentId)?.name : "";

        return (
          <div
            className="fixed z-50 pointer-events-none"
            style={{ left: mousePos.x + 15, top: mousePos.y + 15 }}
          >
            <div className="bg-gray-900/95 border border-gray-700 rounded-lg px-3 py-2 shadow-xl max-w-[300px]">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-medium text-white">{place.name}</span>
                <span className="text-xs text-gray-400">{place.type}</span>
                {place.affiliation && (
                  <span className="text-xs text-blue-400">{place.affiliation}</span>
                )}
              </div>
              {layerName && (
                <div className="text-xs text-gray-500 mb-1">
                  层级：{layerName}
                  {parentName && ` → ${parentName}`}
                </div>
              )}
              <p className="text-xs text-gray-300 leading-relaxed">{place.description}</p>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-gray-500">重要程度：</span>
                <div className="flex gap-0.5">
                  {Array.from({ length: 10 }, (_, i) => (
                    <div
                      key={i}
                      className={`w-1.5 h-1.5 rounded-full ${
                        i < (place.importance || 5) ? "bg-yellow-500" : "bg-gray-600"
                      }`}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 地点详情弹窗 */}
      {selectedPlaceData && (
        <PlaceDetail
          place={selectedPlaceData}
          layers={mapData.layers}
          parentPlace={selectedPlaceData.parentId ? mapData.places.find(p => p.id === selectedPlaceData.parentId) : undefined}
          childPlaces={mapData.places.filter(p => p.parentId === selectedPlace)}
          forces={mapData.forces.filter((f) => f.places.includes(selectedPlace!))}
          onClose={() => setSelectedPlace(null)}
        />
      )}
    </div>
  );
}
