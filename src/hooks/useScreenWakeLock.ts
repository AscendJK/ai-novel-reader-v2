/**
 * useScreenWakeLock — 屏幕唤醒锁（Screen Wake Lock API）
 *
 * 自动阅读 / TTS 朗读等需要持续观看/收听的场景下保持屏幕常亮，
 * 防止移动端（手机/平板）无人操作时自动息屏。
 *
 * 行为：
 *  - active=true 时请求唤醒锁；active=false 时释放
 *  - 页面切后台/切标签后浏览器会强制释放锁，回到前台时自动重新请求
 *  - 浏览器不支持（无 HTTPS / 旧版本 / 权限拒绝）时静默降级，不影响主功能
 *
 * 兼容性：Android Chrome 84+、iOS Safari 16.4+、Firefox 126+。
 */

import { useLayoutEffect, useRef } from "react";

// 不依赖 lib.dom 的 WakeLockSentinel 类型（兼容旧 TS 环境）
interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
}

interface WakeLockLike {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

export function useScreenWakeLock(active: boolean): void {
  const activeRef = useRef(active);
  useLayoutEffect(() => { activeRef.current = active; });

  // 用 useLayoutEffect（DOM 变更后同步执行）：iOS Safari 的 Wake Lock 要求
  // request() 在用户手势（点击）上下文中调用，异步 effect 可能超出手势窗口被拒（NotAllowedError）
  useLayoutEffect(() => {
    let disposed = false;
    let lock: WakeLockSentinelLike | null = null;

    const request = () => {
      const wl = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
      if (!wl?.request || disposed) return; // 不支持：静默降级
      wl.request("screen")
        .then((sentinel) => {
          if (disposed) {
            sentinel.release().catch(() => {});
            return;
          }
          lock = sentinel;
          // 锁被系统释放（切后台/切标签）后清引用；
          // 若仍处于激活且页面可见，回到前台时由 visibilitychange 重新请求
          sentinel.addEventListener("release", () => {
            lock = null;
            if (activeRef.current && document.visibilityState === "visible") request();
          });
        })
        .catch(() => { /* 权限拒绝等：静默降级 */ });
    };

    const release = () => {
      if (lock) {
        lock.release().catch(() => {});
        lock = null;
      }
    };

    if (active) request();
    else release();

    // 页面回到前台时若仍需要常亮（后台期间锁已被浏览器强制释放），重新请求
    const onVisibility = () => {
      if (document.visibilityState === "visible" && activeRef.current && !lock) request();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [active]);
}
