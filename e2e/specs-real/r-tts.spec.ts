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
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { importFiles, miniNovel, openBook, shelfCard, txtFile } from "../pages/shelf";
import { openSettings } from "../pages/settings";
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
    await openSettingsWithEngine(page, baseURL!, "朗读引擎：服务端推理");
    // 起点必须是"没下过"——包外那份数据目录是新开的，要是这里就显示就绪，
    // 说明上一轮没清干净或者路径漂了，后面的"真下载"判据全部作废。
    await expect(page.getByText("服务端推理可用，但模型尚未下载到服务器")).toBeVisible({ timeout: 30_000 });

    const steps = new Set<string>();
    const sampler = setInterval(async () => {
      const t = await page.getByText(/下载中|\d+%|模型|语音引擎|引擎:/).first().innerText().catch(() => "");
      if (t.trim()) steps.add(t.replace(/\s+/g, " ").trim());
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
    await signIn(page, baseURL!, USER);
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
    await expect
      .poll(async () => (await bar.locator("xpath=ancestor-or-self::*[1]").innerText()).replace(/\s+/g, " "), {
        timeout: 90_000,
        message: "播放栏一直是 0:00 —— 浏览器没有真的把这段音频放出来",
      })
      .toMatch(/0:[1-9][0-9]/);
    await expect(page.getByText(/朗读出错/)).toHaveCount(0);
    await page.getByTitle(/停止/).first().click();
  });

  test("R-D3 浏览器推理：380MB 资源真预载进 IndexedDB，界面进入可离线就绪", async ({ page, baseURL }) => {
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
  });

  test("R-D4 浏览器推理真出声：wasm 在隔离页里算出非零音频，播放栏计时在走", async ({ page, baseURL }) => {
    test.setTimeout(15 * 60_000);
    await signIn(page, baseURL!, USER);
    await openSettings(page);
    await page.getByLabel("朗读引擎：浏览器推理（离线）").click();
    await expect(page.getByText("语音资源已就绪，可离线使用")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "关闭设置", exact: true }).click().catch(() => page.keyboard.press("Escape"));

    await expect(shelfCard(page, BOOK)).toBeVisible({ timeout: 30_000 });
    await openBook(page, BOOK);
    await page.getByTitle("语音朗读").click();
    const bar = page.getByTitle("上一章", { exact: true });
    await expect(bar).toBeVisible({ timeout: 5 * 60_000 });
    // RTF≈12（`TTSSettings.tsx:510`）：一句中文要生成几十秒，所以预算给到分钟级
    await expect
      .poll(async () => (await bar.innerText()).replace(/\s+/g, " "), {
        timeout: 8 * 60_000,
        message: "浏览器 wasm 推理没把播放推进（一直是 0:00）",
      })
      .toMatch(/0:[1-9][0-9]/);
    await expect(page.getByText(/朗读出错/)).toHaveCount(0);
    await page.getByTitle(/停止/).first().click();
  });
});
