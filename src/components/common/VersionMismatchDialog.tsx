/**
 * VersionMismatchDialog - 前后端版本不一致提示弹窗
 *
 * 它遮罩是 `fixed inset-0`：底下的一切本来就点不到，所以按**真模态**对待，而不是"飘一行提示"——
 * 给 role/aria-modal、把可访问名挂在标题上、打开时焦点进墙里、Tab 在墙里打转、ESC 是第二个出口、
 * 卸载时把焦点还给来路那一个。"不阻止使用"说的是**关掉之后**任何功能都不被降级，不是不用管键盘。
 */

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface VersionMismatchDialogProps {
  frontend: string;
  backend: string;
  onClose: () => void;
}

const TITLE_ID = "version-mismatch-title";
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function VersionMismatchDialog({
  frontend,
  backend,
  onClose,
}: VersionMismatchDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // onClose 走 ref：调用点传的多半是内联箭头函数，把它写进下面那段焦点效果的依赖会让整段
  // "聚焦面板 + 挂监听"在每次父组件重渲染时重来一遍（焦点被抢回面板）。渲染期不许写 ref，
  // 所以每次提交之后再同步最新那一份。
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && panel.contains(active);
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        className="bg-card border rounded-lg shadow-lg max-w-sm mx-4 p-6 space-y-4"
      >
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
          </div>
          <div className="min-w-0">
            <h3 id={TITLE_ID} className="font-semibold text-sm">前后端版本不一致</h3>
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