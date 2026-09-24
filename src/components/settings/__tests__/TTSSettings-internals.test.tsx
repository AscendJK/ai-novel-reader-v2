import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TTSSettings } from "@/components/settings/TTSSettings";
import { useTTSStore, __resetTTSSettingsCache, type TTSEngine } from "@/stores/tts-store";

/**
 * `TTSSettings` 内部那一层——浏览器档（`e2e/specs/f-rag-tts.spec.ts` 的 F10~F12）量不到的另一半。
 *
 * e2e 钉的是"点完最终界面变成什么"。三样东西它天生看不见：
 *  1) **SSE 的中间帧**——`route.fulfill` 不能分块，帧在浏览器侧一次到齐，"逐帧上屏"没人判；
 *  2) **顺序**——"先停掉正在朗读的那一档，再改设置"，只看终态永远看不出它反没反；
 *  3) **只在别的取值下才成立的分支**——browserReady 的三个来源、唤醒阶梯的第 3 拍、30s 轮询。
 * 这三样在这里判。桩只放在四道接缝上（引擎/服务器/预加载/apiFetch），语义照真后端给。
 */

const fake = vi.hoisted(() => ({
  modelLoaded: false,
  ios: false,
  preload: "idle",
  cacheReady: false,
  status: { supported: true, ready: false, reason: "" },
  statusCalls: 0,
  hasManager: false,
  log: [] as string[],
  spoken: [] as string[],
  getVoices: () => [] as unknown[],
  fetch: null as ((path: string) => Promise<unknown>) | null,
}));

vi.mock("@/tts/zipvoice-engine", () => ({
  ZH_VOICES: { "45": { name: "女声 晓北", gender: "female" }, "50": { name: "男声 云希", gender: "male" } },
  generateAudioFull: vi.fn(async () => ({ audio: new Float32Array(4), sampleRate: 24000 })),
  loadModel: vi.fn(async () => undefined),
  isModelLoaded: () => fake.modelLoaded,
  isIOSDevice: () => fake.ios,
}));

vi.mock("@/tts/server-engine", () => ({
  checkServerInference: async () => {
    fake.statusCalls++;
    return { ...fake.status };
  },
  synthesizeServer: async () => ({ samples: new Float32Array(4), sampleRate: 24000 }),
}));

// stop 与"改设置"都往同一条时间线打点：只看终态分不出先后，这里分得出
vi.mock("@/tts/tts-manager", () => ({
  getActiveTTSManager: () => (fake.hasManager ? { stop: () => fake.log.push("stop") } : null),
}));

vi.mock("@/tts/tts-preload", () => ({
  getTTSPreloadStatus: () => fake.preload,
  preloadZipVoice: vi.fn(async () => "ready"),
}));

vi.mock("@/tts/tts-cache", () => ({ isCacheReady: async () => fake.cacheReady }));

vi.mock("@/lib/api-client", () => ({
  apiFetch: (path: string) => {
    if (!fake.fetch) throw new Error(`未预置 apiFetch 桩：${path}`);
    return fake.fetch(path);
  },
}));

/** 能由测试一帧一帧喂的响应体（真 SSE 就是这个形状：读一次到一帧） */
function makeStream() {
  const enc = new TextEncoder();
  const queued: Uint8Array[] = [];
  let waiting: ((r: { done: boolean; value?: Uint8Array }) => void) | null = null;
  let closed = false;
  return {
    pushFrame(frame: object) {
      const chunk = enc.encode(`data: ${JSON.stringify(frame)}\n\n`);
      if (waiting) { const w = waiting; waiting = null; w({ done: false, value: chunk }); }
      else queued.push(chunk);
    },
    close() {
      closed = true;
      if (waiting) { const w = waiting; waiting = null; w({ done: true }); }
    },
    response: () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              if (queued.length) resolve({ done: false, value: queued.shift() });
              else if (closed) resolve({ done: true });
              else waiting = resolve;
            }),
        }),
      },
    }),
  };
}

class FakeAudioContext {
  state = "running";
  destination = {};
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createBuffer() { return { copyToChannel: () => undefined }; }
  createBufferSource() {
    return { buffer: null, connect: () => undefined, start: () => undefined, stop: () => undefined, onended: null };
  }
}

const engineCard = (name: string) => screen.getByRole("button", { name: `朗读引擎：${name}` });
const enableServer = () => screen.getByRole("button", { name: "启用服务端推理（下载模型）" });

/** 放掉时钟排下来的任务，并把 Promise 链跑到底（假时钟下 setTimeout 也得靠推进） */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(engine: TTSEngine, over: Record<string, unknown> = {}) {
  useTTSStore.setState({ engine, playing: false, generating: false, browserVoices: [], voiceId: "", ...over });
  render(<TTSSettings />);
  await settle();
}

const voice = (uri: string, lang: string) => ({
  voiceURI: uri, name: uri, lang, localService: true, default: false,
});

describe("TTSSettings 内部：切引擎、试听、逐帧解析与语音列表", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("BroadcastChannel", class {
      onmessage: ((e: MessageEvent) => void) | null = null;
      postMessage() {}
      close() {}
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => fake.getVoices() as SpeechSynthesisVoice[],
      speak: (u: { text: string }) => fake.spoken.push(u.text),
      cancel: () => undefined,
      pause: () => undefined,
    });
    vi.stubGlobal("SpeechSynthesisUtterance", class {
      text: string; lang = ""; voice: unknown = null;
      onstart: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor(text: string) { this.text = text; }
    });
    fake.modelLoaded = false;
    fake.ios = false;
    fake.preload = "idle";
    fake.cacheReady = false;
    fake.status = { supported: true, ready: false, reason: "" };
    fake.statusCalls = 0;
    fake.hasManager = false;
    fake.log = [];
    fake.spoken = [];
    fake.getVoices = () => [];
    fake.fetch = null;
    __resetTTSSettingsCache();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("切引擎：先停掉正在朗读的那一档，再改设置（反了会两边同时出声）", async () => {
    fake.hasManager = true;
    await mount("webspeech");

    const unsub = useTTSStore.subscribe((s, prev) => {
      if (s.engine !== prev.engine) fake.log.push(`engine:${s.engine}`);
    });
    fireEvent.click(engineCard("服务端推理"));
    unsub();

    expect(fake.log, "stop 必须排在改设置之前").toEqual(["stop", "engine:server"]);
  });

  it("点的就是当前那一档：不许把正在朗读的停掉", async () => {
    fake.hasManager = true;
    await mount("server");
    fake.log = [];

    fireEvent.click(engineCard("服务端推理"));

    expect(fake.log, "同档重选不该产生 stop").toEqual([]);
    expect(useTTSStore.getState().engine).toBe("server");
  });

  const zhVoice = () => [voice("zh-1", "zh-CN") as SpeechSynthesisVoice];

  it("试听前：正文处于「正在生成」的间隙也要停（只判 playing 会让两段音频叠在一起）", async () => {
    fake.hasManager = true;
    // 试听按钮只在语音列表非空时挂着（空列表时那一栏换成了「加载语音列表」）
    await mount("webspeech", { playing: false, generating: true, browserVoices: zhVoice() });
    fake.log = [];

    fireEvent.click(screen.getByRole("button", { name: "试听" }));

    expect(fake.log).toEqual(["stop"]);
  });

  it("试听前：没有活跃 manager 时直接清状态，不许留着 playing", async () => {
    fake.hasManager = false;
    await mount("webspeech", {
      playing: true, generating: true, currentNovelId: "n1", currentChapterIndex: 3, browserVoices: zhVoice(),
    });

    fireEvent.click(screen.getByRole("button", { name: "试听" }));

    const s = useTTSStore.getState();
    expect(s.playing).toBe(false);
    expect(s.currentNovelId).toBeNull();
  });

  it("浏览器推理的资源就绪有三个来源，任何一个单独成立都算就绪", async () => {
    // 少认一个来源，卡片就把"其实能用"说成"需下载模型"
    fake.modelLoaded = true;
    await mount("zipvoice");
    expect(engineCard("浏览器推理（离线）")).toHaveTextContent("可用");
    cleanup();

    fake.modelLoaded = false;
    fake.preload = "ready";
    await mount("zipvoice");
    expect(engineCard("浏览器推理（离线）")).toHaveTextContent("可用");
    cleanup();

    fake.preload = "idle";
    fake.cacheReady = true;
    await mount("zipvoice");
    expect(engineCard("浏览器推理（离线）")).toHaveTextContent("可用");
    cleanup();

    fake.cacheReady = false;
    await mount("zipvoice");
    expect(engineCard("浏览器推理（离线）")).toHaveTextContent("需下载模型");
  });

  it("iOS 上才有那句「内存占用高，改用服务端推理」的劝退", async () => {
    fake.ios = true;
    await mount("zipvoice");
    expect(screen.getByText(/检测到 iOS 设备/)).toBeInTheDocument();
    cleanup();

    fake.ios = false;
    await mount("zipvoice");
    expect(screen.queryByText(/检测到 iOS 设备/)).toBeNull();
  });

  it("每一帧 step 都当场落到界面：步骤与细节一起上屏，不许只在结尾一次性报完", async () => {
    const stream = makeStream();
    fake.fetch = async (path) => (path.includes("/prepare") ? stream.response() : { ok: true, status: 200 });
    await mount("server");

    fireEvent.click(enableServer());

    stream.pushFrame({ type: "step", step: "模型: 开始下载", detail: "尝试 GitHub（海外源）" });
    await settle();
    expect(screen.getByText("模型: 开始下载：尝试 GitHub（海外源）")).toBeInTheDocument();
    expect(screen.getByText("下载中...")).toBeInTheDocument();

    stream.pushFrame({ type: "step", step: "语音模型", detail: "就绪 ✓" });
    await settle();
    expect(screen.getByText("语音模型：就绪 ✓")).toBeInTheDocument();
    // 上一帧的话不许留在屏上盖着这一帧
    expect(screen.queryByText(/尝试 GitHub/)).toBeNull();
    stream.close();
  });

  it("流里的 error 帧当场为止：之后的 done 不许把它翻成成功", async () => {
    const stream = makeStream();
    fake.fetch = async (path) => (path.includes("/prepare") ? stream.response() : { ok: true, status: 200 });
    await mount("server");

    fireEvent.click(enableServer());
    stream.pushFrame({ type: "step", step: "下载模型" });
    stream.pushFrame({ type: "error", message: "磁盘空间不足" });
    stream.pushFrame({ type: "done" });
    stream.close();
    await settle();

    expect(screen.getByText("启用失败：磁盘空间不足")).toBeInTheDocument();
    expect(screen.queryByText(/服务端推理已就绪/)).toBeNull();
    expect(screen.queryByText("下载中...")).toBeNull();
  });

  it("HTTP 非 2xx：报状态码而不是「响应为空」，也不去读那具空尸体", async () => {
    let reads = 0;
    fake.fetch = async (path) =>
      path.includes("/prepare")
        ? {
            ok: false,
            status: 503,
            body: { getReader: () => ({ read: () => { reads++; return Promise.resolve({ done: true }); } }) },
          }
        : { ok: true, status: 200 };
    await mount("server");

    fireEvent.click(enableServer());
    await settle();

    expect(screen.getByText("启用失败：服务器返回 503")).toBeInTheDocument();
    expect(reads, "状态码已经判死，不该再去读流").toBe(0);
  });

  it("done 之后必须回服务器重查一次状态，「就绪」只能是服务器说的", async () => {
    const stream = makeStream();
    fake.fetch = async (path) => (path.includes("/prepare") ? stream.response() : { ok: true, status: 200 });
    await mount("server");
    const before = fake.statusCalls;

    fireEvent.click(enableServer());
    stream.pushFrame({ type: "done" });
    stream.close();
    await settle();

    expect(fake.statusCalls, "done 之后要重查服务器").toBeGreaterThan(before);
    expect(screen.getByText("模型下载完成，服务端推理已就绪")).toBeInTheDocument();
  });

  it("内容没变的轮询不许重新写 store（每 2 秒刷一次整页）", async () => {
    let polls = 0;
    fake.getVoices = () => { polls++; return [voice("zh-1", "zh-CN"), voice("en-1", "en-US")]; };
    await mount("webspeech");

    const first = useTTSStore.getState().browserVoices;
    expect(first.length).toBe(2);

    await settle(4000);
    expect(polls, "轮询确实跑了好几拍").toBeGreaterThan(2);
    expect(useTTSStore.getState().browserVoices, "同样的内容不该换新引用").toBe(first);

    fake.getVoices = () => [voice("zh-1", "zh-CN")];
    await settle(2000);
    expect(useTTSStore.getState().browserVoices, "内容真变了才该换").not.toBe(first);
  });

  it("选中的语音从列表里消失：先回中文第一个，没有中文才退到列表第一个", async () => {
    fake.getVoices = () => [voice("en-1", "en-US"), voice("zh-9", "zh-CN")];
    await mount("webspeech", { voiceId: "gone" });
    const select = screen.getByRole("combobox", { name: "语音选择" });
    expect(select).toHaveValue("zh-9");

    fake.getVoices = () => [voice("en-1", "en-US")];
    useTTSStore.setState({ browserVoices: [voice("en-1", "en-US")] as SpeechSynthesisVoice[] });
    await settle();
    expect(screen.getByRole("combobox", { name: "语音选择" })).toHaveValue("en-1");
  });

  it("语音列表一直空时的唤醒阶梯：零宽空格 → 第 3 拍升级成真实短文本 → 之后收手", async () => {
    let polls = 0;
    fake.getVoices = () => { polls++; return []; };
    await mount("webspeech");

    fireEvent.click(screen.getByRole("button", { name: "加载语音列表" }));
    expect(fake.spoken, "第一拍是无声的零宽空格").toEqual(["\u200b"]);

    await settle(1500);
    expect(fake.spoken, "第 3 拍还没出列表就该动真格").toEqual(["\u200b", "。"]);

    await settle(11_500);
    expect(screen.getByText(/当前浏览器未返回语音列表/)).toBeInTheDocument();
    expect(fake.spoken.length, "唤醒只用一次真短文本，不许每拍都念").toBe(2);

    // 阶梯那支轮询（500ms）到 24 拍就该收手，只剩挂载期那支 2s 的还在读列表。
    // 10s 窗口内：阶梯已停 ≈ 5 次，阶梯没停 ≈ 25 次——用频率判，数 speak 次数判不出来。
    const before = polls;
    await settle(10_000);
    expect(polls - before, "超过 24 拍就该停掉唤醒轮询，不许永远空转").toBeLessThanOrEqual(8);
  });

  it("服务器状态每 30 秒重查一次：不点按钮的页面也会自己翻成就绪", async () => {
    await mount("server");
    expect(screen.getByText(/但模型尚未下载到服务器/)).toBeInTheDocument();

    fake.status = { supported: true, ready: true, reason: "" };
    await settle(30_000);

    expect(screen.getByText("服务端推理已就绪（模型已下载到服务器，可直接朗读/试听）")).toBeInTheDocument();
  });
});
