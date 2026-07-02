import { useSyncExternalStore, useCallback } from "react";

/**
 * 响应式媒体查询 hook，通过 matchMedia 监听视口变化。
 * 在 SSR 或不支持 matchMedia 时返回默认值。
 */
export function useMediaQuery(query: string, defaultValue = false): boolean {
  return useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        if (typeof window === "undefined" || !window.matchMedia) {
          return () => {};
        }
        const mql = window.matchMedia(query);
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      },
      [query]
    ),
    useCallback(
      () => {
        if (typeof window === "undefined" || !window.matchMedia) return defaultValue;
        return window.matchMedia(query).matches;
      },
      [query, defaultValue]
    ),
    () => defaultValue
  );
}
