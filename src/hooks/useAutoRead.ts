/**
 * useAutoRead — 自动阅读（自动翻页/自动滚动）
 *
 * 两种模式：
 *  - 分页模式（paginated=true）：每 intervalSec 秒翻一页（章末自动进下一章）
 *  - 滚动模式：每 intervalSec 秒平滑滚动约 60% 视口高度
 *
 * 停止条件：
 *  - 读到终点（滚动到底 / 最后一章末页）→ onStop("end")
 *  - 用户干扰（点击/滑动正文、翻页类按键、TTS 朗读开始）→ onStop("user")
 *    —— 不与用户抢控制权，任何用户手势立即让位
 */

import { useCallback, useEffect, useRef } from "react";
import { useTTSStore } from "@/stores/tts-store";

export interface UseAutoReadOptions {
  enabled: boolean;
  /** 翻页/滚动间隔（秒） */
  intervalSec: number;
  /** true=分页模式（定时翻页）；false=滚动模式（定时滚动） */
  paginated: boolean;
  /** 滚动容器 ref（滚动模式的滚动目标） */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 正文容器 ref：用户点击/滑动/触摸正文 → 立即停止 */
  contentRef: React.RefObject<HTMLElement | null>;
  /** 分页模式翻页动作（章末自动进下一章；由调用方提供） */
  onNextPage: () => void;
  /** 分页模式是否已到最后一章末页 */
  isAtEnd: () => boolean;
  /** 停止回调：end=读到终点；user=被用户干扰 */
  onStop: (reason: "end" | "user") => void;
}

/** 翻页/滚动类按键（用户手动操作 → 停止自动阅读） */
const INTERRUPT_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", " ", "Home", "End",
]);

/** 滚动到底容差（px） */
const SCROLL_END_TOLERANCE = 4;
/** 单步滚动高度下限（px），小视口下不至于几乎不动 */
const MIN_SCROLL_STEP = 160;
/** 单步滚动 = 视口高度的比例 */
const SCROLL_STEP_RATIO = 0.6;

export function useAutoRead({
  enabled,
  intervalSec,
  paginated,
  scrollRef,
  contentRef,
  onNextPage,
  isAtEnd,
  onStop,
}: UseAutoReadOptions) {
  // 定时器回调用 ref 保持最新（避免 setInterval 闭包过期；refs 在 effect 中更新）
  const onNextPageRef = useRef(onNextPage);
  const isAtEndRef = useRef(isAtEnd);
  const onStopRef = useRef(onStop);
  const intervalRef = useRef(intervalSec);
  useEffect(() => { onNextPageRef.current = onNextPage; });
  useEffect(() => { isAtEndRef.current = isAtEnd; });
  useEffect(() => { onStopRef.current = onStop; });
  useEffect(() => { intervalRef.current = intervalSec; });

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback((reason: "end" | "user") => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    onStopRef.current(reason);
  }, []);

  // 用户干扰监听：点击/滑动/触摸正文、翻页类按键 → 立即停止
  useEffect(() => {
    if (!enabled) return;
    const onInterrupt = () => stop("user");
    const el = contentRef.current;
    el?.addEventListener("pointerdown", onInterrupt, { passive: true });
    el?.addEventListener("wheel", onInterrupt, { passive: true });
    el?.addEventListener("touchstart", onInterrupt, { passive: true });
    const onKey = (e: KeyboardEvent) => {
      if (INTERRUPT_KEYS.has(e.key)) onInterrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      el?.removeEventListener("pointerdown", onInterrupt);
      el?.removeEventListener("wheel", onInterrupt);
      el?.removeEventListener("touchstart", onInterrupt);
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled, contentRef, stop]);

  // 主定时器：间隔前进 + 终点检测 + TTS 互斥
  useEffect(() => {
    if (!enabled) return;

    const tick = () => {
      // TTS 互斥：语音朗读中不自动前进（听书模式与自动阅读二选一）
      if (useTTSStore.getState().playing) {
        stop("user");
        return;
      }
      if (!paginated) {
        const el = scrollRef.current;
        if (!el) return;
        const max = el.scrollHeight - el.clientHeight;
        if (el.scrollTop >= max - SCROLL_END_TOLERANCE) {
          stop("end"); // 滚动到底 → 停止
          return;
        }
        const step = Math.max(MIN_SCROLL_STEP, el.clientHeight * SCROLL_STEP_RATIO);
        el.scrollBy({ top: step, behavior: "smooth" });
        return;
      }
      if (isAtEndRef.current()) {
        stop("end"); // 最后一章末页 → 停止
        return;
      }
      onNextPageRef.current();
    };

    // 点击开启后立即前进一次（即时反馈），之后按间隔定时
    tick();
    timerRef.current = setInterval(tick, intervalRef.current * 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, paginated, scrollRef, stop]);
}
