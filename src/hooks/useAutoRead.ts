/**
 * useAutoRead — 自动阅读（自动翻页 / 持续自动滚动）
 *
 * 两种模式：
 *  - 分页模式（paginated=true）：每 intervalSec 秒翻一页（章末自动进下一章）
 *  - 滚动模式：requestAnimationFrame 逐帧平滑滚动，速度 = speedLinesPerSec
 *    行/秒 × 行高（px），正文像字幕一样持续匀速向上流动，无停顿感
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
  /** 分页模式翻页间隔（秒） */
  intervalSec: number;
  /** 滚动模式速度（行/秒） */
  speedLinesPerSec: number;
  /** 滚动模式行高（px）= 字号 × 行高倍数，用于速度换算 */
  lineHeightPx: number;
  /** 缓启动时长（ms）：开启后速度从 0 线性渐增至目标（默认 800） */
  easeInMs?: number;
  /** true=分页模式（定时翻页）；false=滚动模式（持续滚动） */
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
/** 单帧间隔上限（秒）：超过视为后台恢复/主线程卡顿，跳过该帧位移防止跳屏 */
const MAX_FRAME_DT = 0.2;
/** 缓启动默认时长（ms）：点击开启后速度 0→目标渐变，给眼睛适应窗口 */
const EASE_IN_MS = 800;

export function useAutoRead({
  enabled,
  intervalSec,
  speedLinesPerSec,
  lineHeightPx,
  easeInMs = EASE_IN_MS,
  paginated,
  scrollRef,
  contentRef,
  onNextPage,
  isAtEnd,
  onStop,
}: UseAutoReadOptions) {
  // 回调/参数用 ref 保持最新（避免定时器/rAF 闭包过期；refs 在 effect 中更新）
  const onNextPageRef = useRef(onNextPage);
  const isAtEndRef = useRef(isAtEnd);
  const onStopRef = useRef(onStop);
  const intervalRef = useRef(intervalSec);
  const speedRef = useRef(speedLinesPerSec);
  const lineHeightRef = useRef(lineHeightPx);
  const easeInRef = useRef(easeInMs);
  useEffect(() => { onNextPageRef.current = onNextPage; });
  useEffect(() => { isAtEndRef.current = isAtEnd; });
  useEffect(() => { onStopRef.current = onStop; });
  useEffect(() => { intervalRef.current = intervalSec; });
  useEffect(() => { speedRef.current = speedLinesPerSec; });
  useEffect(() => { lineHeightRef.current = lineHeightPx; });
  useEffect(() => { easeInRef.current = easeInMs; });

  const stoppedRef = useRef(false);
  // enabled 重新开启时复位停止标记（stop 幂等，防 rAF 停止路径重复触发 onStop）
  useEffect(() => { if (enabled) stoppedRef.current = false; }, [enabled]);

  // 页面可见性：后台时浏览器节流定时器/rAF，恢复时防止跳屏/疯狂翻页
  const visibleRef = useRef(true);
  useEffect(() => {
    const onVisibility = () => { visibleRef.current = document.visibilityState === "visible"; };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const stop = useCallback((reason: "end" | "user") => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    onStopRef.current(reason);
  }, []);

  // 用户干扰 → 停止：点击正文 / 滚动正文 / 触摸 / 翻页类按键
  useEffect(() => {
    if (!enabled) return;
    const onInterrupt = () => stop("user");
    const el = contentRef.current;
    el?.addEventListener("pointerdown", onInterrupt, { passive: true });
    el?.addEventListener("wheel", onInterrupt, { passive: true });
    el?.addEventListener("touchstart", onInterrupt, { passive: true });
    const onKey = (e: KeyboardEvent) => { if (INTERRUPT_KEYS.has(e.key)) onInterrupt(); };
    window.addEventListener("keydown", onKey);
    return () => {
      el?.removeEventListener("pointerdown", onInterrupt);
      el?.removeEventListener("wheel", onInterrupt);
      el?.removeEventListener("touchstart", onInterrupt);
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled, contentRef, stop]);

  // 分页模式：定时翻页（递归 setTimeout：每次读取最新 intervalRef，运行中改间隔实时生效）
  useEffect(() => {
    if (!enabled || !paginated) return;
    // 开启瞬间先检查是否已在终点：在末页时立即停止并提示，不等待首个间隔
    if (isAtEndRef.current()) { stop("end"); return; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, intervalRef.current * 1000);
    }
    function tick() {
      // TTS 互斥：语音朗读中不自动前进（用户切到听书模式）
      if (useTTSStore.getState().playing) { stop("user"); return; }
      if (!visibleRef.current) { schedule(); return; } // 页面在后台：跳过本次，下个周期再试
      if (isAtEndRef.current()) { stop("end"); return; }   // 最后一章末页停止
      onNextPageRef.current();
      schedule();
    }
    schedule(); // 从当前页开始计时：首个完整间隔后才翻第一页（开启不跳页，进度条从 0 同步）
    return () => { if (timer) clearTimeout(timer); };
  }, [enabled, paginated, stop]);

  // 滚动模式：rAF 逐帧持续滚动（正文匀速流动，速度可调）
  useEffect(() => {
    if (!enabled || paginated) return;
    let rafId = 0;
    let lastTs: number | null = null; // null=首帧未初始化（首帧 ts 可能为 0，不能用 0 哨兵）
    let startTs: number | null = null; // 缓启动基准：开启时刻（首帧记录）

    // 滚动期间禁用 CSS scroll-behavior: smooth（scroll-smooth 类）：
    // 部分浏览器（Firefox）对 scrollTop 赋值也应用平滑动画，与 rAF 逐帧位移冲突导致滞后；
    // 停止/清理时恢复原值，不影响其他功能（键盘翻页等显式 behavior 滚动）。
    const scrollEl = scrollRef.current;
    const prevScrollBehavior = scrollEl ? scrollEl.style.scrollBehavior : "";
    if (scrollEl) scrollEl.style.scrollBehavior = "auto";

    const loop = (ts: number) => {
      // 停止条件（每帧都检查，含首帧：已在底部/朗读中时第一帧就该停）
      if (useTTSStore.getState().playing) { cancelAnimationFrame(rafId); stop("user"); return; }
      const el = scrollRef.current;
      if (el) {
        const max = el.scrollHeight - el.clientHeight;
        if (el.scrollTop >= max - SCROLL_END_TOLERANCE) { cancelAnimationFrame(rafId); stop("end"); return; } // 到底停止
      }
      if (lastTs !== null) {
        const dt = (ts - lastTs) / 1000; // 秒
        if (dt > MAX_FRAME_DT) {
          // 后台恢复/主线程卡顿：rAF 时间戳跳变，跳过该帧位移并重置基准，避免跳屏
          lastTs = ts;
          rafId = requestAnimationFrame(loop);
          return;
        }
        // 缓启动：开启后 easeInMs 内速度从 0 线性增至目标
        const elapsed = startTs !== null ? ts - startTs : 0;
        const factor = easeInRef.current > 0 ? Math.min(1, elapsed / easeInRef.current) : 1;
        if (el) el.scrollTop += speedRef.current * lineHeightRef.current * dt * factor; // 行/秒 × 行高 × 帧间隔 × 缓启动系数
      }
      if (startTs === null) startTs = ts;
      lastTs = ts;
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafId);
      if (scrollEl) scrollEl.style.scrollBehavior = prevScrollBehavior; // 恢复原滚动行为
    };
  }, [enabled, paginated, scrollRef, stop]);
}
