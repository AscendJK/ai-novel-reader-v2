/**
 * useAudioPlayer 自动翻章流程回归测试
 * 覆盖 U14 修复：异步加载章节时 addChapters 先替换当前章内容、
 * 后 setSelectedChapter 切索引，自动播放不得被中间渲染消费/取消。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAudioPlayer } from "../useAudioPlayer";
import { useTTSStore } from "@/stores/tts-store";

// ── Mock TTSManager：不依赖真实 Web Speech / ZipVoice ──
// 记录 speak 调用并暴露最近一次 callbacks，供测试触发 onEnd
const h = vi.hoisted(() => {
  const mockSpeak = vi.fn();
  class MockTTSManagerImpl {
    setEngine() {}
    setVoice() {}
    setSpeed() {}
    setPlaybackRate() {}
    setPitch() {}
    async speak(_chunks: unknown, callbacks: Record<string, unknown>) {
      mockSpeak(callbacks);
      callbacks.onPlay?.();
    }
    pause() {}
    async resume() {}
    stop() {}
    destroy() {}
    getCurrentGenerationId() { return 0; }
    getCurrentChunkIndex() { return 0; }
    seekToChunk() {}
    isPlaying() { return false; }
    isPaused() { return false; }
  }
  return { mockSpeak, MockTTSManager: MockTTSManagerImpl };
});

vi.mock("@/tts/tts-manager", () => ({
  TTSManager: h.MockTTSManager,
}));

function setup(options: { content: string; index: number }) {
  const onNext = vi.fn();
  const hook = renderHook(
    ({ content, index }: { content: string; index: number }) =>
      useAudioPlayer({
        chapterContent: content,
        chapterIndex: index,
        novelId: "novel-1",
        onNextChapter: onNext,
      }),
    { initialProps: options }
  );
  return { hook, onNext };
}

beforeEach(() => {
  h.mockSpeak.mockClear();
  useTTSStore.setState({
    playing: false, paused: false, generating: false,
    currentNovelId: null, currentChapterIndex: null,
    currentTime: 0, duration: 0, currentParagraph: 0, totalParagraphs: 0,
    autoNextChapter: true,
    engine: "webspeech",
  });
});

afterEach(() => {
  vi.useRealTimers();
  useTTSStore.getState().reset();
});

describe("useAudioPlayer 自动翻章", () => {
  it("章节播放完毕 → 500ms 翻章 → 新章节加载完成后自动播放", async () => {
    vi.useFakeTimers();
    const { hook, onNext } = setup({ content: "第一章内容足够长", index: 0 });

    // 开始播放第一章
    await act(async () => { hook.result.current.play(); });
    expect(h.mockSpeak).toHaveBeenCalledTimes(1);
    const callbacks = h.mockSpeak.mock.calls[0][0];

    // 第一章结束 → 自动翻章
    await act(async () => { callbacks.onEnd(); });
    expect(onNext).not.toHaveBeenCalled(); // 500ms 后才翻章
    expect(useTTSStore.getState().generating).toBe(true); // 翻章间隙播放栏保持可见

    await act(async () => { vi.advanceTimersByTime(500); });
    expect(onNext).toHaveBeenCalledTimes(1);

    // 新章节内容加载完成
    act(() => { hook.rerender({ content: "第二章内容足够长", index: 1 }); });

    // 350ms 后自动播放新章节
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(h.mockSpeak).toHaveBeenCalledTimes(2);
    expect(useTTSStore.getState().playing).toBe(true);
    expect(useTTSStore.getState().generating).toBe(false);
  });

  it("竞态修复：addChapters 先替换当前章内容（索引未变）时不消费自动播放标志", async () => {
    vi.useFakeTimers();
    const { hook, onNext } = setup({ content: "第一章内容足够长", index: 0 });

    await act(async () => { hook.result.current.play(); });
    expect(h.mockSpeak).toHaveBeenCalledTimes(1);
    const callbacks = h.mockSpeak.mock.calls[0][0];

    await act(async () => { callbacks.onEnd(); });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(onNext).toHaveBeenCalledTimes(1);

    // 竞态场景：异步加载章节时 addChapters 先替换当前章内容
    // （新字符串引用，但 chapterIndex 仍是旧章 0）
    act(() => { hook.rerender({ content: "第一章内容足够长-新引用", index: 0 }); });
    // 随后 setSelectedChapter 生效 → 目标章节就绪
    act(() => { hook.rerender({ content: "第二章内容足够长", index: 1 }); });

    // 自动播放必须仍然发生（旧代码：中间渲染消费标志 + cleanup 取消 → 朗读停止）
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(h.mockSpeak).toHaveBeenCalledTimes(2);
    expect(useTTSStore.getState().playing).toBe(true);
  });

  it("竞态修复：章节内容先更新、索引后更新，中间重渲染不调度错误章节", async () => {
    vi.useFakeTimers();
    const { hook, onNext } = setup({ content: "第一章内容足够长", index: 0 });

    await act(async () => { hook.result.current.play(); });
    const callbacks = h.mockSpeak.mock.calls[0][0];

    await act(async () => { callbacks.onEnd(); });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(onNext).toHaveBeenCalledTimes(1);

    // 中间状态：内容已更新为第二章、但索引还是旧章（模拟渲染顺序差异）
    act(() => { hook.rerender({ content: "第二章内容足够长", index: 0 }); });
    // 校验：此刻不应自动播放旧索引章节（未到达目标索引）
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(h.mockSpeak).toHaveBeenCalledTimes(1);

    // 索引到达目标章节 → 自动播放
    act(() => { hook.rerender({ content: "第二章内容足够长", index: 1 }); });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(h.mockSpeak).toHaveBeenCalledTimes(2);
    expect(useTTSStore.getState().playing).toBe(true);
  });

  it("自动翻章等待期间手动停止 → 不自动播放", async () => {
    vi.useFakeTimers();
    const { hook, onNext } = setup({ content: "第一章内容足够长", index: 0 });

    await act(async () => { hook.result.current.play(); });
    const callbacks = h.mockSpeak.mock.calls[0][0];

    await act(async () => { callbacks.onEnd(); });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(onNext).toHaveBeenCalledTimes(1);

    // 用户停止
    await act(async () => { hook.result.current.stop(); });

    // 新章节加载完成，也不应自动播放
    act(() => { hook.rerender({ content: "第二章内容足够长", index: 1 }); });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(h.mockSpeak).toHaveBeenCalledTimes(1);
    expect(useTTSStore.getState().playing).toBe(false);
  });

  it("自动翻章等待期间手动切到其他章节 → 取消自动播放", async () => {
    vi.useFakeTimers();
    const { hook, onNext } = setup({ content: "第一章内容足够长", index: 0 });

    await act(async () => { hook.result.current.play(); });
    const callbacks = h.mockSpeak.mock.calls[0][0];

    await act(async () => { callbacks.onEnd(); });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(onNext).toHaveBeenCalledTimes(1);

    // 用户手动切到第 3 章（不是目标第 2 章）
    act(() => { hook.rerender({ content: "第三章内容足够长", index: 2 }); });
    expect(useTTSStore.getState().generating).toBe(false); // 已复位

    // 不应自动播放
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(h.mockSpeak).toHaveBeenCalledTimes(1);
  });
});
