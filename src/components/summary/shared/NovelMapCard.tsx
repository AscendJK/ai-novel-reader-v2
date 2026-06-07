/**
 * NovelMapCard 组件 - 地图卡片
 * 显示在全书分析 Tab 中，支持生成、查看、导出地图
 */

import { useState, useEffect, useCallback } from "react";
import { Map, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MapData } from "@/agents/types";
import { sanitizeSvg } from "@/lib/sanitize-svg";
import { mapAgent } from "@/agents/map-agent";
import { NovelMap } from "@/components/map";

interface NovelMapCardProps {
  /** 小说 ID */
  novelId: string;
  /** 是否正在加载 */
  loading?: boolean;
}

export function NovelMapCard({ novelId, loading }: NovelMapCardProps) {
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFullMap, setShowFullMap] = useState(false);

  // 从缓存加载
  useEffect(() => {
    try {
      const cached = localStorage.getItem(`map-data-${novelId}`);
      if (cached) {
        setMapData(JSON.parse(cached));
      }
    } catch {
      // 缓存无效，忽略
    }
  }, [novelId]);

  // 生成地图
  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);

    try {
      const result = await mapAgent.run({ novelId });
      if (result.success && result.data) {
        const data = (result.data as { mapData: MapData }).mapData;
        setMapData(data);
        // 缓存 JSON 数据
        localStorage.setItem(`map-data-${novelId}`, JSON.stringify(data));
      } else {
        setError(result.error || "生成地图失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成地图失败");
    } finally {
      setGenerating(false);
    }
  }, [novelId]);

  // 重新生成
  const handleRegenerate = useCallback(() => {
    localStorage.removeItem(`map-data-${novelId}`);
    setMapData(null);
    handleGenerate();
  }, [novelId, handleGenerate]);

  const isLoading = generating || loading;

  return (
    <>
      <Card className="shadow-none">
        <CardHeader className="p-2 pb-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Map className="h-4 w-4 text-primary" />
              <CardTitle className="text-xs">小说地图</CardTitle>
            </div>
            {mapData && (
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => setShowFullMap(true)}
                >
                  查看大图
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={handleRegenerate}
                  disabled={isLoading}
                >
                  重新生成
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-2 pt-0">
          {!mapData ? (
            <div className="text-center py-4">
              <Button
                size="sm"
                onClick={handleGenerate}
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    生成中...
                  </>
                ) : (
                  <>
                    <Map className="h-3 w-3 mr-1" />
                    生成小说地图
                  </>
                )}
              </Button>
              {error && (
                <p className="text-xs text-destructive mt-2">{error}</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {/* 小地图预览 */}
              <div
                className="relative w-full h-48 overflow-hidden rounded border cursor-pointer"
                onClick={() => setShowFullMap(true)}
              >
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ transform: "scale(0.3)", transformOrigin: "center center" }}
                  dangerouslySetInnerHTML={{
                    __html: sanitizeSvg(renderMapToSvg(mapData)),
                  }}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
                <div className="absolute bottom-2 left-2 text-xs text-white">
                  点击查看大图
                </div>
              </div>

              {/* 地图信息 */}
              <div className="text-xs text-muted-foreground">
                <p>类型：{mapData.novelInfo.type}</p>
                <p>地点：{mapData.places.length} 个</p>
                <p>势力：{mapData.forces.length} 个</p>
                <p>区域：{mapData.regions.length} 个</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 全屏地图弹窗 */}
      {showFullMap && mapData && (
        <div className="fixed inset-0 z-50 bg-background" style={{ touchAction: "none" }}>
          <NovelMap
            mapData={mapData}
            onRegenerate={handleRegenerate}
            loading={isLoading}
          />
          <Button
            className="absolute top-4 left-4 z-10"
            size="sm"
            variant="outline"
            onClick={() => setShowFullMap(false)}
          >
            关闭
          </Button>
        </div>
      )}
    </>
  );
}

// 临时渲染函数（用于小地图预览）
function renderMapToSvg(mapData: MapData): string {
  // 简化版渲染，只显示基本结构
  const places = mapData.places.map((p) =>
    `<circle cx="${p.x * 0.9}" cy="${p.y * 0.65}" r="3" fill="#8b5cf6" />`
  ).join("");

  return `<svg width="900" height="650" viewBox="0 0 900 650">
    <rect width="900" height="650" fill="#1a1510" />
    ${places}
  </svg>`;
}
