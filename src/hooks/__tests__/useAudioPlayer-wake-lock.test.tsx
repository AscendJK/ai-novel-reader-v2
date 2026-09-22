/**
 * 朗读必须真的去挂屏幕唤醒锁，并且以「朗读」这个名字挂（息屏保活接线）
 *
 * 为什么单独立一档：真机上"熄屏了还在不在读"全靠这一行 `useScreenWakeLock(..., "朗读")`。
 * 钩子本身的行为在 useScreenWakeLock.test.ts 里验过，但**谁在什么时候、以什么名字**调它
 * 没人管——名字写错或漏写，自检面板上两条锁就会互相顶名；判断条件写坏（比如恒真），
 * 代价是不朗读也把屏幕点着。jsdom 里没有 wakeLock，`tried` 恰好就是"应用真开口要过锁"
 * 这个事实，不需要额外造假。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAudioPlayer } from "../useAudioPlayer";
import { useTTSStore } from "@/stores/tts-store";
import { wakeLockRecords } from "../useScreenWakeLock";

const CH = "洛阳城下的雪落了三天，街面上没有一个卖炭的人，守城的兵卒围着火盆打盹。";

const h = vi.hoisted(() => {
  const speak = vi.fn();
  class MockTTSManager {
    setEngine() {}
    setVoice() {}
    setSpeed() {}
    setPlaybackRate() {}
    setPitch() {}
    setPrefetchCount() {}
    prewarmZipVoiceAudio() {}
    warmAhead() {}
    async speak(chunks: unknown, callbacks: Record<string, unknown>) {
      speak(chunks, callbacks);
      (callbacks.onPlay as (() => void) | undefined)?.();
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
  return { speak, MockTTSManager };
});

vi.mock("@/tts/tts-manager", () => ({ TTSManager: h.MockTTSManager }));
vi.mock("@/db/repositories", () => ({ loadChapters: () => Promise.resolve([]) }));

const lockOf = (label: string) => wakeLockRecords().find((r) => r.label === label);

function mount() {
  return renderHook(() => useAudioPlayer({
    chapterContent: CH,
    chapterIndex: 0,
    novelId: "novel-1",
    onNextChapter: vi.fn(),
  }));
}

beforeEach(() => {
  h.speak.mockClear();
  useTTSStore.setState({ engine: "server", prefetchCount: 2, autoNextChapter: true });
});

afterEach(() => {
  useTTSStore.getState().reset();
});

describe("朗读与屏幕唤醒锁的接线", () => {
  // 合成一条按阶段走的两段判据：记录表是模块级的，拆成两个 it 时后一个会读到前一个留下的
  // `tried=true`，那条"不许提前要锁"就成了永远绿的空判。
  it("开面时不许要锁，开始朗读之后才要——而且要在「朗读」名下", async () => {
    const hook = mount();
    await act(async () => {});
    expect(lockOf("朗读")?.tried ?? false, "一进朗读界面就常亮：不听的时候也把屏幕点着").toBe(false);

    await act(async () => { hook.result.current.play(); });
    await act(async () => {});
    expect(lockOf("朗读")?.tried, "朗读时没申请过屏幕唤醒锁：熄屏即断，而自检上看不出差别").toBe(true);
    hook.unmount();
  });
});
