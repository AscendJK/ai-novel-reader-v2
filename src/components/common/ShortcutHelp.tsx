import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ShortcutBinding } from "@/hooks/useKeyboardShortcuts";

interface Props {
  shortcuts: ShortcutBinding[];
  onClose: () => void;
}

export function ShortcutHelp({ shortcuts, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border rounded-lg shadow-lg p-5 w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">键盘快捷键</h3>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
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
