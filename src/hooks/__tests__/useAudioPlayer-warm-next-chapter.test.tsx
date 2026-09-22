/**
 * 章界预热：本章播到最后一句时就得把下一章推进缓冲（T-章界）
 *
 * 现象：服务器推理播到一章末尾会静一段。原因不在翻章本身，而在新一章的第一句是
 * 冷启动现推的——`tts-manager.ts:816-817` 的预生成窗口只覆盖**当前这一批 chunks**，
 * 而 `useAudioPlayer.ts:275-303` 的 `onEnd` 之后要走过 500ms 定时器 + 章节加载 +
 * 350ms 定时器才重新 `speak()`，于是章界 = 翻章底噪 + 一整轮首段推理。
 *
 * 这一档管的是**触发方**（谁在什么时刻要求预热、预热什么）；缓冲本身是否真被
 * 下一章消费、换音色之后是否还认，见 `src/tts/__tests__/tts-manager-warm-next.test.ts`。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAudioPlayer } from "../useAudioPlayer";
import { useTTSStore } from "@/stores/tts-store";
import { useNovelStore } from "@/stores/novel-store";

const CH1 = "洛阳城下的雪落了三天，街面上没有一个卖炭的人，守城的兵卒围着火盆打盹。";
const CH2 = "虎牢关的鼓声一夜未停，守将把盔缨系了两遍又松开，探马第三次回报敌军尚在三十里外。";
const CH3 = "黑木崖上有人吹笛，笛声里带着饕餮二字的古意，山下渡口那条船等了半月。";

// 记录 warmAhead 收到的内容：预热"发了什么"就是这一档的判据对象
const h = vi.hoisted(() => {
  const warmAhead = vi.fn();
  const speak = vi.fn();
  class MockTTSManager {
    setEngine() {}
    setVoice() {}
    setSpeed() {}
    setPlaybackRate() {}
    setPitch() {}
    setPrefetchCount() {}
    prewarmZipVoiceAudio() {}
    warmAhead = warmAhead;
    async speak(_chunks: unknown, callbacks: Record<string, unknown>) {
      speak(callbacks);
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
  return { warmAhead, speak, MockTTSManager };
});

vi.mock("@/tts/tts-manager", () => ({ TTSManager: h.MockTTSManager }));

// 懒加载那条路：下一章正文不在内存里时要能从库里读回来
const loadChapters = vi.fn((...args: unknown[]) => {
  const [novelId, start] = args as [string, number];
  const table: Record<number, string> = { 0: CH1, 1: CH2, 2: CH3 };
  return Promise.resolve([
    { id: `ch-${start}`, novelId, index: start, title: `第${start + 1}章`, content: table[start] ?? "", startOffset: 0, endOffset: 0 },
  ]);
});
vi.mock("@/db/repositories", () => ({ loadChapters: (...a: unknown[]) => loadChapters(...a) }));

/** 三章全书；`loaded=false` 时后两章正文留空（模拟翻页模式还没滚到那儿） */
function seedBook(loaded: boolean) {
  useNovelStore.setState({
    currentNovel: {
      id: "novel-1", title: "预热书", author: "", fileName: "t.txt", fileFormat: "txt",
      totalChars: 200, chapterCount: 3, createdAt: 1, updatedAt: 1,
      chapters: [
        { id: "ch-0", novelId: "novel-1", index: 0, title: "第一章", content: CH1, startOffset: 0, endOffset: CH1.length },
        { id: "ch-1", novelId: "novel-1", index: 1, title: "第二章", content: loaded ? CH2 : "", startOffset: 0, endOffset: CH2.length },
        { id: "ch-2", novelId: "novel-1", index: 2, title: "第三章", content: loaded ? CH3 : "", startOffset: 0, endOffset: CH3.length },
      ],
    } as never,
  });
}

function mount(opts: { index: number; content: string | null; hasNext: boolean }) {
  return renderHook(() =>
    useAudioPlayer({
      chapterContent: opts.content,
      chapterIndex: opts.index,
      novelId: "novel-1",
      onNextChapter: opts.hasNext ? vi.fn() : undefined,
    })
  );
}

/** 起播并把朗读推进到第 i 段（total 段）开头 */
async function playTo(hook: ReturnType<typeof mount>, i: number, total: number) {
  await act(async () => { hook.result.current.play(); });
  const callbacks = h.speak.mock.calls[h.speak.mock.calls.length - 1][0] as { onChunkStart: (i: number, t: number, p: number) => void };
  await act(async () => { callbacks.onChunkStart(i, total, i); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  h.warmAhead.mockClear();
  h.speak.mockClear();
  loadChapters.mockClear();
  useTTSStore.setState({ autoNextChapter: true, engine: "server", prefetchCount: 2 });
});

afterEach(() => {
  useTTSStore.getState().reset();
  useNovelStore.setState({ currentNovel: null } as never);
});

describe("章界预热的触发时机", () => {
  it("本章播到最后一句：必须已经把下一章正文交给预热", async () => {
    seedBook(true);
    const hook = mount({ index: 0, content: CH1, hasNext: true });
    // 本章只有一句 → 开播即章末
    await playTo(hook, 0, 1);

    expect(h.warmAhead, "章末没预热下一章：翻章之后第一句只能冷启动现推").toHaveBeenCalled();
    const warmed = h.warmAhead.mock.calls[0][0] as { text: string }[];
    expect(warmed[0].text).toContain("虎牢关");
    hook.unmount();
  });

  it("本章还有后续句子时不许提前预热", async () => {
    seedBook(true);
    const hook = mount({ index: 0, content: CH1, hasNext: true });
    await playTo(hook, 0, 3);
    expect(h.warmAhead, "开头就预热等于拿整本书的钱赌用户会听完").not.toHaveBeenCalled();
    hook.unmount();
  });

  it("下一章正文还没加载：预热要自己去库里读那一句", async () => {
    seedBook(false);
    const hook = mount({ index: 0, content: CH1, hasNext: true });
    await playTo(hook, 0, 1);
    expect(loadChapters, "正文不在内存里就放弃预热，等于翻页模式下这条改进永远不生效").toHaveBeenCalled();
    const warmed = h.warmAhead.mock.calls[0][0] as { text: string }[];
    expect(warmed[0].text).toContain("虎牢关");
    hook.unmount();
  });

  it("最后一章没有下一章：不许预热", async () => {
    seedBook(true);
    const hook = mount({ index: 2, content: CH3, hasNext: false });
    await playTo(hook, 0, 1);
    expect(h.warmAhead).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("用户关了自动翻章：不许预热（他不会在该章末尾继续听）", async () => {
    seedBook(true);
    useTTSStore.setState({ autoNextChapter: false });
    const hook = mount({ index: 0, content: CH1, hasNext: true });
    await playTo(hook, 0, 1);
    expect(h.warmAhead).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("同一章只预热一次（段落进度会反复回调）", async () => {
    seedBook(true);
    const hook = mount({ index: 0, content: CH1, hasNext: true });
    await playTo(hook, 0, 1);
    await playTo(hook, 0, 1);
    expect(h.warmAhead).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("Web 语音这一档没有可预热的东西：不许发任何预热", async () => {
    seedBook(true);
    useTTSStore.setState({ engine: "webspeech" });
    const hook = mount({ index: 0, content: CH1, hasNext: true });
    await playTo(hook, 0, 1);
    expect(h.warmAhead, "浏览器原生朗读不产 AudioBuffer，预热它是白排队").not.toHaveBeenCalled();
    hook.unmount();
  });
});
