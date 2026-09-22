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

/**
 * 每一把锁的现状记录，按调用方（label）分开。
 *
 * 为什么要留这个：息屏后朗读断不断，是移动端最常见的疑点，而"锁到底有没有拿到"
 * 原先只活在闭包里，界面上看不见——不支持、被省电模式拒、被系统在熄屏那一瞬收走，
 * 三种情况看起来一模一样。真机自检要靠这几行字把它分开。
 * 分开按 label 记是必须的：朗读和自动阅读各持一把，共用一条记录的话谁释放都会把
 * 另一条写成"未持有"，等于报假消息。
 */
export interface WakeLockRecord {
  label: string;
  tried: boolean;
  held: boolean;
  lastGrantedAt: number | null;
  lastReleasedAt: number | null;
  /** 申请被拒的原因（`NotAllowedError` 之类）；拿到过之后再被释放不算错误 */
  lastError: string | null;
}

const records = new Map<string, WakeLockRecord>();
const listeners = new Set<(line: string) => void>();

function recordOf(label: string): WakeLockRecord {
  let r = records.get(label);
  if (!r) {
    r = { label, tried: false, held: false, lastGrantedAt: null, lastReleasedAt: null, lastError: null };
    records.set(label, r);
  }
  return r;
}

function emit(line: string): void {
  for (const fn of [...listeners]) fn(line);
}

/** 订阅唤醒锁事件（到手 / 被释放 / 被拒）。返回取消订阅。 */
export function onWakeLockEvent(fn: (line: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function wakeLockRecords(): WakeLockRecord[] {
  return [...records.values()].map((r) => ({ ...r }));
}

/**
 * @param label 这把锁属于哪个场景（"朗读" / "自动阅读"…）。必填：取证时按它分行，
 *              共用一个名字会让两个场景互相写脏（详见 `WakeLockRecord` 注释）。
 */
export function useScreenWakeLock(active: boolean, label: string): void {
  const activeRef = useRef(active);
  useLayoutEffect(() => { activeRef.current = active; });

  // 用 useLayoutEffect（DOM 变更后同步执行）：iOS Safari 的 Wake Lock 要求
  // request() 在用户手势（点击）上下文中调用，异步 effect 可能超出手势窗口被拒（NotAllowedError）
  useLayoutEffect(() => {
    let disposed = false;
    let lock: WakeLockSentinelLike | null = null;
    const rec = recordOf(label);

    const request = () => {
      const wl = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
      rec.tried = true;
      if (!wl?.request || disposed) return; // 不支持：静默降级（但"不支持"这件事被记下来了）
      wl.request("screen")
        .then((sentinel) => {
          if (disposed) {
            sentinel.release().catch(() => {});
            return;
          }
          lock = sentinel;
          rec.held = true;
          rec.lastGrantedAt = Date.now();
          rec.lastError = null;
          emit(`唤醒锁[${label}] 到手`);
          // 锁被系统释放（切后台/熄屏/切标签）后清引用；
          // 若仍处于激活且页面可见，回到前台时由 visibilitychange 重新请求
          sentinel.addEventListener("release", () => {
            lock = null;
            if (rec.held) {
              rec.held = false;
              rec.lastReleasedAt = Date.now();
              emit(`唤醒锁[${label}] 已放开（熄屏/切后台会被系统收走，也可能是我们自己放的）`);
            }
            if (activeRef.current && document.visibilityState === "visible") request();
          });
        })
        .catch((e: unknown) => {
          rec.held = false;
          rec.lastError = e instanceof Error ? `${e.name || "Error"}: ${e.message}` : String(e);
          emit(`唤醒锁[${label}] 申请被拒：${rec.lastError}`);
        });
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
  }, [active, label]);
}
