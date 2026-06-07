import { useEffect } from "react";

export interface ShortcutBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: () => void;
  description: string;
  when?: () => boolean;
}

export function useKeyboardShortcuts(bindings: ShortcutBinding[]) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      for (const b of bindings) {
        if (e.key === b.key && !!e.ctrlKey === !!b.ctrl && !!e.shiftKey === !!b.shift && !!e.altKey === !!b.alt) {
          if (b.when && !b.when()) continue;
          e.preventDefault();
          b.action();
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bindings]);
}
