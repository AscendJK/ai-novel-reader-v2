/**
 * R-D：真后端上的 TTS 全链路（计划里最重的一组）。
 *
 * 为什么只有这一档能给结论：**今天没有任何一层真下过那只 334MB 的语音模型、
 * 也没有任何一层听过一个真音节的音频。**
 *  - 主套 F4/F4b/F5/F6 的 `prepare` 是 `route.fulfill` 出来的整段 body（连分块都做不到，
 *    见 `f-rag-tts.spec.ts:256-264` 那段注释），WAV 是 44 字节头的假文件（`:216`）；
 *  - `probe:rag` 打的是服务端契约，管不到"浏览器能不能真的把声音放出来"；
 *  - 20 条拼卷单测（批次 U 的 `tts-assemble`）用假 `exec`/假下载器，验的是**顺序与清理**，
 *    不是"这台机器上的 7-Zip 真能把这 4 卷拼回来"。
 *
 * 所以这里的判据全部落在**字节**上：模型落盘的尺寸、SSE 逐帧推进的采样序列、
 * 服务端回的那段 WAV 的 PCM 峰值（静音是 0，真语音不可能全 0）。
 *
 * 红线不变：数据目录在包外（`<ANR_REAL_DATA_DIR>/tts-cache`），开发目录的
 * `server/data/` 由 `r-account` 的 R-B5 收尾比对指纹；`mkcert` 已从 PATH 剥掉，
 * 这一档不会去动系统信任根。
 */
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { importFiles, miniNovel, openBook, shelfCard, txtFile } from "../pages/shelf";
import { leaveSettings, openSettings } from "../pages/settings";
import { DATA_DIR, ORIGIN, RUN, signIn } from "./fixtures";

const USER = `r组真听书-${RUN}`;
const BOOK = `TTS真书-${RUN}`;
const MODEL_DIR = path.join(DATA_DIR, "tts-cache", "model");
const WASM_DIR = path.join(DATA_DIR, "tts-cache", "wasm");
const TEMP_DIR = path.join(DATA_DIR, "tts-temp");

function sizeOf(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}

/** 中转目录里剩下的东西（半截卷 / 解压出来的临时目录）——判据要的是"跑完是空的" */
function tempLeftovers(): string[] {
  if (!existsSync(TEMP_DIR)) return [];
  return readdirSync(TEMP_DIR, { withFileTypes: true }).map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`);
}

async function token(page: Page): Promise<string> {
  return (await page.evaluate(() => localStorage.getItem("sync-token"))) ?? "";
}

/**
 * 解析 WAV：返回采样峰值。
 *
 * 只认 `fmt `=1（PCM）单声道这一种形状（`server/lib/tts-py-worker` 与
 * `src/tts/server-engine.ts:47` 就按这个约定走）。找不到 data 块直接判红，
 * 不返回 0 —— 那会把"服务器给了个别的格式"错报成"给了静音"。
 */
function pcmPeak(buf: Buffer): { peak: number; samples: number; bytes: number } {
  expect(buf.slice(0, 4).toString("ascii"), "回的不是 RIFF").toBe("RIFF");
  expect(buf.slice(8, 12).toString("ascii"), "RIFF 里面不是 WAVE").toBe("WAVE");
  let off = 12;
  let dataAt = -1;
  let dataLen = 0;
  let fmt = "";
  while (off + 8 <= buf.length) {
    const id = buf.slice(off, off + 4).toString("ascii");
    const len = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = buf.slice(off + 8, off + 10).toString("hex");
    if (id === "data") {
      dataAt = off + 8;
      dataLen = len;
      break;
    }
    off += 8 + len + (len % 2);
  }
  expect(dataAt, `WAV 里没有 data 块（fmt=${fmt}）`).toBeGreaterThan(0);
  const n = Math.floor(dataLen / 2);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(dataAt + i * 2);
    if (Math.abs(s) > peak) peak = Math.abs(s);
  }
  return { peak, samples: n, bytes: dataLen };
}

/** 选朗读引擎并打开设置页（引擎三选一在设置页里，`TTSSettings.tsx:461/481`） */
async function openSettingsWithEngine(page: Page, baseURL: string, label: string): Promise<void> {
  await signIn(page, baseURL, USER);
  await openSettings(page);
  await page.getByLabel(label).click();
}

test.describe.serial("真后端：模型真下载、SSE 真逐帧、音频真出声", () => {
  test("R-D1 点「启用服务端推理」：真 SSE 逐帧推进，模型真落盘，中转目录不留半截卷", async ({ page, baseURL }) => {
    test.setTimeout(15 * 60_000);
    // 先清掉包外一次性目录里的语音缓存：TTS 的模型与 WASM 是**全服务器共用一份**
    // （不像书/索引那样按用户分），上一轮跑过之后它一直在盘上，那条"还没下载"的起点
    // 与整条"真下载"判据都会静默降级成"缓存命中"。删的仍是包外目录，不是开发项目的 server/data。
    rmSync(path.join(DATA_DIR, "tts-cache"), { recursive: true, force: true });
    await openSettingsWithEngine(page, baseURL!, "朗读引擎：服务端推理");
    // 起点必须是"没下过"——包外那份数据目录是新开的，要是这里就显示就绪，
    // 说明上一轮没清干净或者路径漂了，后面的"真下载"判据全部作废。
    await expect(page.getByText("服务端推理可用，但模型尚未下载到服务器")).toBeVisible({ timeout: 30_000 });

    // 逐帧采样：读的是那一行进度文案所在的段落（`TTSSettings.tsx:545-547` 的
    // `serverPrepareStep + serverPrepareDetail`，琥珀色那一截）。
    // 不读 `.first()` 的泛匹配——那会把同一枚常驻标签反复计成"新文案"。
    const steps = new Set<string>();
    const sampler = setInterval(async () => {
      for (const t of await page.locator("p.text-amber-500").allInnerTexts()) {
        const s = t.replace(/\s+/g, " ").trim();
        // 那句"可用但没下模型"是常驻提示（`:537`），不算推进
        if (s && !s.startsWith("服务端推理可用")) steps.add(s);
      }
    }, 1_000);
    try {
      await page.getByRole("button", { name: "启用服务端推理（下载模型）" }).click();
      await expect(page.getByText("服务端推理已就绪（模型已下载到服务器")).toBeVisible({ timeout: 14 * 60_000 });
    } finally {
      clearInterval(sampler);
    }

    // 逐帧推进：主套 F 组演不出这一条，因为 `route.fulfill` 的 body 是一次到齐的
    expect(steps.size, `SSE 的进度只看到一种文案（看到 ${steps.size} 种：${[...steps].join(" | ")}）`).toBeGreaterThanOrEqual(3);

    // 落盘：齐套校验看几枚关键文件，不重复 `MODEL_REQUIRED_FILES` 那张表（那边有 20 条单测）
    expect(sizeOf(path.join(MODEL_DIR, "model.onnx")), "服务端模型目录里没有 model.onnx").toBeGreaterThan(100 * 1048576);
    expect(sizeOf(path.join(MODEL_DIR, "voices.bin")), "voices.bin 没落盘（分卷可能只拼了一半）").toBeGreaterThan(1024 * 1024);
    expect(sizeOf(path.join(MODEL_DIR, "dict", "jieba.dict.utf8")), "中文分词词典没落盘").toBeGreaterThan(1024 * 1024);
    expect(sizeOf(path.join(MODEL_DIR, "phone-zh.fst")), "中文音素 FST 没落盘").toBeGreaterThan(1024);
    expect(sizeOf(path.join(WASM_DIR, "sherpa-onnx-wasm-main-tts.wasm")), "WASM 引擎没落盘（7z 那趟没跑成）").toBeGreaterThan(1024 * 1024);

    // 拼卷/解压的中转区要空：批次 U 那 20 条单测钉的是"清理清单算的是全部分卷名"，
    // 这一条是它在真 7-Zip、真分卷上的翻版
    expect(tempLeftovers(), `跑完之后 tts-temp 里还留着东西：${tempLeftovers().join("、")}`).toEqual([]);
  });

  test("R-D2 服务端真合成一句中文：回来的 WAV 有非零采样，界面上播放栏真的在走", async ({ page, baseURL }) => {
    test.setTimeout(6 * 60_000);
    // 引擎必须显式选"服务端推理"：默认是 webspeech，headless 里没有语音合成引擎，
    // 那样这条判据红的会是引擎选错，而不是服务端没出声。
    await openSettingsWithEngine(page, baseURL!, "朗读引擎：服务端推理");
    await leaveSettings(page);
    await importFiles(page, [txtFile(`${BOOK}.txt`, miniNovel())]);
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 30_000 });

    // 先按接口量字节：这一句钉的是"服务器真的用模型算出了声音"，不是"接口回了 200"
    const r = await page.request.post(`${ORIGIN}/api/rag/tts/synthesize`, {
      headers: { authorization: `Bearer ${await token(page)}` },
      data: { text: "洛阳城下的雪落了三天，街面上没有一个卖炭的人。", sid: 45, speed: 1.0 },
    });
    expect(r.status(), `合成接口回了 ${r.status()}：${await r.text()}`).toBe(200);
    const body = await r.body();
    const { peak, samples } = pcmPeak(body);
    expect(samples, `data 块只有 ${samples} 个采样（不到半秒）`).toBeGreaterThan(4000);
    expect(peak, "PCM 峰值是 0 = 服务器回的是静音，不是语音").toBeGreaterThan(500);

    // 再按界面量一次：同样的文本走用户那条路，播放栏要出现并且计时真的在走
    await openBook(page, BOOK);
    await page.getByTitle("语音朗读").click();
    const bar = page.getByTitle("上一章", { exact: true });
    await expect(bar).toBeVisible({ timeout: 60_000 });
    // 读"第几段"而不是"0:0X"，而且必须读那枚计数 `<span>` 本身：
    //  - `title="上一章"` 那枚是**图标按钮**，`innerText()` 恒为空（F6 只拿它判"栏子在不在"），
    //    我第一版拿它读时间，采到的永远是空串；
    //  - 服务端一次合成一句只有 1~3 秒（实测 `36150 samples → 1.5s 音频`），而 `elapsed`
    //    是**本段**已播秒数，还没到 1 秒就换段了，用时间判"有没有真放声"会稳定误判。
    // 段号前进（`AudioPlayer.tsx:205-209`）才等价于"上一段真放完了、下一段开始了"。
    // 顺带把台架能力钉住：headless Chromium 的 AudioContext 是真在跑的（一次性探针量到
    // `state:"running"`、1.2 秒墙钟里 currentTime 走 1.131、buffer 的 onended 触发），
    // 所以这一条不是"环境演不出来"。
    const counter = page.getByText(/\d+\s*\/\s*\d+\s*段/).first();
    let sawSegment = 0;
    await expect
      .poll(
        async () => {
          const m = (await counter.innerText().catch(() => "")).match(/(\d+)\s*\/\s*(\d+)/);
          if (m) sawSegment = Math.max(sawSegment, Number(m[1]));
          return sawSegment;
        },
        { timeout: 120_000, intervals: [300], message: "播放栏的段号没前进 —— 浏览器没有真的把音频放出来" },
      )
      .toBeGreaterThanOrEqual(2);
    await expect(page.getByText(/朗读出错/)).toHaveCount(0);
    await page.getByTitle(/停止/).first().click().catch(() => {});
  });

  /**
   * R-D3：浏览器推理这条腿一次跑完——380MB 资源真预载 → wasm 真合成 → 播放真的推进。
   *
   * 原计划把"预载"和"出声"分成两条（R-D3/R-D4）。合体的理由是台架事实：
   * IndexedDB 与 Cache Storage 都跟着 **context** 走，而 Playwright 每条用例一个新 context，
   * 拆成两条就要在两台机器上各下 380MB。判据一条没少：就绪文案、本地库里有货、
   * 段号前进（= 上一段真放完了）、没出现"朗读出错"。
   */
  test("R-D3 浏览器推理：380MB 真预载进本地库，wasm 真合成并放出声", async ({ page, baseURL }) => {
    test.setTimeout(15 * 60_000);
    await openSettingsWithEngine(page, baseURL!, "朗读引擎：浏览器推理（离线）");
    await expect(page.getByText("需先下载语音模型到浏览器")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "启用浏览器推理（下载模型）" }).click();
    await expect(page.getByText("语音资源已就绪，可离线使用")).toBeVisible({ timeout: 14 * 60_000 });

    const cached = await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      const hit = dbs.find((d) => /tts/i.test(d.name ?? ""));
      if (!hit) return { dbs: dbs.map((d) => d.name), store: 0 };
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const q = indexedDB.open(hit.name!);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const store = db.objectStoreNames[0];
      const count = await new Promise<number>((res, rej) => {
        const q = db.transaction(store).objectStore(store).count();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      db.close();
      return { dbs: dbs.map((d) => d.name), store: count };
    });
    expect(cached.store, `浏览器本地库里没有语音资源（库名：${JSON.stringify(cached.dbs)}）`).toBeGreaterThan(3);

    // 出声：这一腿不需要服务器参与（离线推理），所以先把 R-D2 那句"服务端回的真音频"隔开——
    // 这里能推进只可能是 wasm 算出来的
    await leaveSettings(page);
    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 30_000 });
    await openBook(page, BOOK);
    // 反向记账：这一腿必须是**浏览器算的**。段号前进这件事本身不区分引擎——
    // 若产品悄悄回落到 `/tts/synthesize`（服务端），界面照样会一格格往前走，
    // 那我就把"浏览器 wasm 真出声"判成了"服务器真出声"。
    let serverSynths = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/rag/tts/synthesize")) serverSynths++;
    });
    await page.getByTitle("语音朗读").click();
    const counter = page.getByText(/\d+\s*\/\s*\d+\s*段/).first();
    let sawSegment = 0;
    await expect
      .poll(
        async () => {
          const m = (await counter.innerText().catch(() => "")).match(/(\d+)\s*\/\s*(\d+)/);
          if (m) sawSegment = Math.max(sawSegment, Number(m[1]));
          return sawSegment;
        },
        { timeout: 8 * 60_000, intervals: [500], message: "浏览器 wasm 推理没把播放推进（段号一直不动）" },
      )
      .toBeGreaterThanOrEqual(2);
    await expect(page.getByText(/朗读出错/)).toHaveCount(0);
    expect(serverSynths, "浏览器推理这一腿偷偷回落到服务端合成了（判据判的就不是 wasm）").toBe(0);
    await page.getByTitle(/停止/).first().click().catch(() => {});
  });
});
