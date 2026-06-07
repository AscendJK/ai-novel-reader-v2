/**
 * PlaceDetail 组件 - 地点详情弹窗
 */

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface PlaceDetailProps {
  /** 地点信息 */
  place: {
    id: string;
    name: string;
    type: string;
    level: number;
    parentId: string;
    description: string;
    importance: number;
    affiliation: string;
  };
  /** 层级信息 */
  layers: Array<{
    level: number;
    name: string;
    description: string;
  }>;
  /** 父级地点 */
  parentPlace?: {
    id: string;
    name: string;
    type: string;
  };
  /** 子级地点 */
  childPlaces: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  /** 相关势力 */
  forces: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  /** 关闭回调 */
  onClose: () => void;
}

export function PlaceDetail({ place, layers, parentPlace, childPlaces, forces, onClose }: PlaceDetailProps) {
  // 获取层级名称
  const layerName = layers.find(l => l.level === place.level)?.name || `层级 ${place.level}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <Card className="w-full max-w-md mx-4">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle className="text-lg">{place.name}</CardTitle>
              <Badge variant="outline">{place.type}</Badge>
              <Badge variant="secondary">{layerName}</Badge>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 描述 */}
          <p className="text-sm text-muted-foreground">{place.description}</p>

          {/* 重要程度 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">重要程度：</span>
            <div className="flex gap-0.5">
              {Array.from({ length: 10 }, (_, i) => (
                <div
                  key={i}
                  className={`w-2 h-2 rounded-full ${
                    i < place.importance ? "bg-primary" : "bg-muted"
                  }`}
                />
              ))}
            </div>
          </div>

          {/* 所属势力 */}
          {place.affiliation && (
            <div>
              <span className="text-xs text-muted-foreground">所属势力：</span>
              <Badge variant="secondary" className="ml-1">{place.affiliation}</Badge>
            </div>
          )}

          {/* 父级地点 */}
          {parentPlace && (
            <div>
              <span className="text-xs text-muted-foreground">上级区域：</span>
              <Badge variant="outline" className="ml-1">{parentPlace.name}</Badge>
            </div>
          )}

          {/* 子级地点 */}
          {childPlaces.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">下级地点：</p>
              <div className="flex flex-wrap gap-1">
                {childPlaces.map((child) => (
                  <Badge key={child.id} variant="outline">
                    {child.name} ({child.type})
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* 相关势力 */}
          {forces.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">相关势力：</p>
              <div className="flex flex-wrap gap-1">
                {forces.map((force) => (
                  <Badge key={force.id} variant="outline">
                    {force.name} ({force.type})
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
