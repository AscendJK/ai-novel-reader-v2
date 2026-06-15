import { useEffect, useRef } from "react";

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
  const bindingsRef = useRef(bindings);
  // 每次渲染更新 ref，保持 handler 引用稳定
  bindingsRef.current = bindings;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      for (const b of bindingsRef.current) {
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
  }, []); // 空依赖数组，handler 引用始终稳定
}
