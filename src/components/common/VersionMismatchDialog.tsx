/**
 * VersionMismatchDialog - 前后端版本不一致提示弹窗
 * 仅作提示，不阻止用户使用
 */

import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface VersionMismatchDialogProps {
  frontend: string;
  backend: string;
  onClose: () => void;
}

export function VersionMismatchDialog({
  frontend,
  backend,
  onClose,
}: VersionMismatchDialogProps) {
  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="bg-card border rounded-lg shadow-lg max-w-sm mx-4 p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-sm">前后端版本不一致</h3>
            <p className="text-xs text-muted-foreground mt-1">
              部分功能可能无法正常工作
            </p>
          </div>
        </div>

        <div className="bg-muted rounded-md px-3 py-2 space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">前端版本</span>
            <span className="font-mono font-medium">{frontend}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">后端版本</span>
            <span className="font-mono font-medium">{backend}</span>
          </div>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
          前后端版本不一致可能导致同步、AI 分析等功能异常。建议重启后端服务器以应用最新版本，或重新构建部署前端。
        </p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          可前往 <a href="https://github.com/AscendJK/ai-novel-reader-v2/releases" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">GitHub Releases</a> 下载最新后端包，解压覆盖原项目目录即可。
        </p>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            继续使用
          </Button>
        </div>
      </div>
    </div>
  );
}