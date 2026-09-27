import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ShortcutBinding } from "@/hooks/useKeyboardShortcuts";

interface Props {
  shortcuts: ShortcutBinding[];
  onClose: () => void;
}

const TITLE_ID = "shortcut-help-title";
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 快捷键说明面板。它的遮罩是 `fixed inset-0`——底下本来就点不到，所以按**真模态**对待：
 * 有 role/aria-modal、可访问名挂在标题上、打开时焦点进墙、焦点掉到墙外时 Tab 把它拉回来、ESC 是第二个出口、
 * 卸载时把焦点还给来路那一个。与 `VersionMismatchDialog` 同一口径（面板里只有关闭按钮一枚可聚焦元素，
 * 所以"在两行之间打转"这一格在这儿没有对象，那份判据在两项面板的浏览器层那一档）。
 *
 * ESC 因此有两条出口：这里自己关，`AppLayout.tsx:76` 那条全局 `Escape` 绑定也会
 * `setShowShortcutHelp(false)`。两边落到同一个 state，一次按键重复置 false 是幂等的——
 * 别为了"只关一次"去 `stopPropagation`：那条 hook 听的是 window，吞不掉它，只会把
 * 设置页/笔记面板的 ESC 一起连坐掉。
 */
export function ShortcutHelp({ shortcuts, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  // onClose 走 ref：调用点给的多半是内联箭头函数（AppLayout.tsx:289），把它写进下面那段焦点
  // 效果的依赖会让整段"聚焦面板 + 挂监听"在每次父组件重渲染时重来一遍，焦点被抢回面板。
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        className="bg-card border rounded-lg shadow-lg p-5 w-full max-w-sm mx-4 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id={TITLE_ID} className="font-semibold">键盘快捷键</h3>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="关闭快捷键说明" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-2">
          {shortcuts.map((s, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{s.description}</span>
              <kbd className="px-2 py-0.5 text-xs rounded border bg-muted font-mono">
                {s.ctrl ? "Ctrl+" : ""}{s.shift ? "Shift+" : ""}{s.alt ? "Alt+" : ""}
                {keyLabel(s.key)}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function keyLabel(key: string): string {
  const map: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Escape: "Esc",
    " ": "Space",
    "+": "+",
    "-": "-",
    "?": "?",
  };
  return map[key] || key.toUpperCase();
}
