/**
 * 临时探针：复现用户 119 字超时场景（Node worker_threads + 浏览器同款引擎）
 * 对照：带 extra.min_char_in_sentence=10 vs 不带，各计时
 * 同时验证 callback progress 是否推进（定位卡死阶段）
 */
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");

const MODEL_DIR = path.join(__dirname, "..", "server", "data", "tts-cache", "model");
const WASM_DIR = path.join(__dirname, "..", "server", "data", "tts-cache", "wasm");

// 约 119 字的中文段落（新闻风格，含标点，接近用户场景）
const LONG_TEXT =
  "据气象部门最新消息，未来三天我国中东部地区将迎来一轮大范围的强降雨天气过程，" +
  "部分地区伴有短时强降水和雷暴大风等强对流天气，请广大市民朋友注意出行安全，" +
  "提前做好防范准备，尽量减少不必要的外出活动，相关部门已经启动应急预案，" +
  "全力保障人民群众生命财产安全，后续情况我们将持续关注并及时发布最新消息。";

if (isMainThread) {
  console.log("[main] 读取模型文件...");
  const files = {};
  const wasmFiles = [
    "sherpa-onnx-wasm-main-tts.js",
    "sherpa-onnx-wasm-main-tts.wasm",
    "sherpa-onnx-wasm-main-tts.data",
    "sherpa-onnx-tts.js",
  ];
  const modelFiles = [
    "decoder.int8.onnx",
    "encoder.int8.onnx",
    "tokens.txt",
    "lexicon.txt",
    "vocos_24khz.onnx",
    "test_wavs/news-female.wav",
    "test_wavs/news-female-2.wav",
    "test_wavs/leijun-1.wav",
  ];
  for (const f of wasmFiles) {
    const p = path.join(WASM_DIR, f);
    if (fs.existsSync(p)) files[f] = fs.readFileSync(p);
    else console.log(`[main] 警告: WASM 文件缺失 ${f}`);
  }
  for (const f of modelFiles) {
    const p = path.join(MODEL_DIR, f);
    if (fs.existsSync(p)) files[f] = fs.readFileSync(p);
    else console.log(`[main] 警告: 模型文件缺失 ${f}`);
  }
  console.log(`[main] 已加载 ${Object.keys(files).length} 个文件, 文本长度=${LONG_TEXT.length} 字`);

  const w = new Worker(__filename, { workerData: { files } });
  // 测试序列：名称 → 生成参数
  const TESTS = [
    { name: "B: 完整参考音频+完整转录+146字（用户现状，长超时观察）", ref: "full", refText: "full", text: LONG_TEXT },
  ];
  let testIdx = 0;
  const t0 = Date.now();
  w.on("message", (msg) => {
    if (msg.type === "log") console.log("[worker]", msg.data);
    else if (msg.type === "ready") {
      console.log("[main] 模型就绪，开始测试...");
      w.postMessage({ type: "generate", text: LONG_TEXT, sid: 0, speed: 1.0, id: 0, ...TESTS[0].opts });
    } else if (msg.type === "result") {
      const name = TESTS[testIdx].name;
      console.log(`[main] ✅ ${name}: 耗时 ${msg.ms.toFixed(1)}s, ${msg.samples} samples, ${msg.sampleRate} Hz`);
      nextTest(w);
    } else if (msg.type === "error") {
      console.log(`[main] ❌ ${TESTS[testIdx].name}: ${msg.message}`);
      nextTest(w);
    }
  });
  function nextTest(w) {
    testIdx++;
    if (testIdx < TESTS.length) {
      console.log(`\n[main] 开始测试 ${testIdx + 1}/${TESTS.length}: ${TESTS[testIdx].name}`);
      w.postMessage({ type: "generate", text: LONG_TEXT, sid: 0, speed: 1.0, id: testIdx, ...TESTS[testIdx].opts });
    } else {
      console.log(`\n[main] 全部完成，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      process.exit(0);
    }
  }
  // 全局超时保护：B 测试最长观察 550s（exec 上限 600s）
  setTimeout(() => { console.log("[main] ⏰ 测试超时（550s），疑似卡死或极慢"); process.exit(2); }, 550000);
} else {
  const { files } = workerData;
  const { parentPort } = require("worker_threads");
  const log = (d) => parentPort.postMessage({ type: "log", data: d });

  async function init(files) {
    try {
      const os = require("os");
      const fs = require("fs");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sherpa-probe-"));
      const wasmMainJsPath = path.join(tmpDir, "sherpa-onnx-wasm-main-tts.js");
      const ttsApiPath = path.join(tmpDir, "sherpa-onnx-tts.js");
      fs.writeFileSync(wasmMainJsPath, files["sherpa-onnx-wasm-main-tts.js"]);
      fs.writeFileSync(ttsApiPath, files["sherpa-onnx-tts.js"]);

      const mod1 = await import("file://" + wasmMainJsPath);
      const createModule = mod1.default || mod1;
      const mod2 = await import("file://" + ttsApiPath);
      const createOfflineTts = mod2.createOfflineTts || mod2.default?.createOfflineTts;

      let Module;
      const dataBuf = files["sherpa-onnx-wasm-main-tts.data"].buffer.slice(
        files["sherpa-onnx-wasm-main-tts.data"].byteOffset,
        files["sherpa-onnx-wasm-main-tts.data"].byteOffset + files["sherpa-onnx-wasm-main-tts.data"].byteLength
      );
      Module = await createModule({
        wasmBinary: files["sherpa-onnx-wasm-main-tts.wasm"],
        getPreloadedPackage: () => dataBuf,
        locateFile: (filePath) => {
          if (filePath.endsWith(".wasm")) return "file://" + path.join(tmpDir, "sherpa-onnx-wasm-main-tts.wasm");
          if (filePath.endsWith(".data")) return "file://" + path.join(tmpDir, "sherpa-onnx-wasm-main-tts.data");
          return "file://" + path.join(tmpDir, filePath);
        },
      });
      log("WASM 模块初始化成功");

      const modelDir = "/api/rag/tts/model";
      const mkdirp = (p) => {
        const parts = p.split("/").filter(Boolean);
        let cur = "";
        for (const part of parts) { cur += "/" + part; try { Module.FS_createPath("/", cur.slice(1), true, true); } catch {} }
      };
      mkdirp(modelDir);
      const modelFiles = ["tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx", "lexicon.txt", "vocos_24khz.onnx"];
      for (const name of modelFiles) {
        if (files[name]) Module.FS_createDataFile(modelDir, name, new Uint8Array(files[name]), true, true, true);
      }
      try { Module.FS_createPath(modelDir, "test_wavs", true, true); } catch {}
      for (const wav of ["test_wavs/news-female.wav", "test_wavs/news-female-2.wav", "test_wavs/leijun-1.wav"]) {
        if (files[wav]) {
          const name = wav.split("/").pop();
          Module.FS_createDataFile(modelDir + "/test_wavs", name, new Uint8Array(files[wav]), true, true, true);
        }
      }

      const config = {
        offlineTtsModelConfig: {
          debug: false,
          offlineTtsZipVoiceModelConfig: {
            tokens: "/api/rag/tts/model/tokens.txt",
            encoder: "/api/rag/tts/model/encoder.int8.onnx",
            decoder: "/api/rag/tts/model/decoder.int8.onnx",
            vocoder: "/api/rag/tts/model/vocos_24khz.onnx",
            dataDir: "/espeak-ng-data",
            lexicon: "/api/rag/tts/model/lexicon.txt",
          },
          numThreads: 1,
        },
        ruleFsts: "",
        ruleFars: "",
        maxNumSentences: 1,
      };
      const tts = createOfflineTts(Module, config);
      log("TTS 实例创建成功! numSpeakers=" + tts.numSpeakers);

      function decodeWav(arrayBuf) {
        const data = new Uint8Array(arrayBuf);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const numChannels = view.getUint16(22, true);
        const sampleRate = view.getUint32(24, true);
        let dataOffset = 12;
        while (view.getUint32(dataOffset, true) !== 0x61746164) dataOffset += 8 + view.getUint32(dataOffset + 4, true);
        const dataSize = view.getUint32(dataOffset + 4, true);
        const samples = new Float32Array(dataSize / 2);
        const rawData = new Int16Array(data.buffer, data.byteOffset + dataOffset + 8, dataSize / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = rawData[i] / 32768.0;
        if (numChannels === 2) {
          const mono = new Float32Array(samples.length / 2);
          for (let i = 0; i < mono.length; i++) mono[i] = (samples[i * 2] + samples[i * 2 + 1]) / 2;
          return { audio: mono, sampleRate };
        }
        return { audio: samples, sampleRate };
      }

      const REF_AUDIOS = [
        { file: "test_wavs/news-female.wav", text: "各位村民, 大家新年好! 近期, 湖北省武汉市等多个地区" },
      ];
      const refAudios = [];
      for (const ref of REF_AUDIOS) {
        if (files[ref.file]) {
          const d = decodeWav(files[ref.file]);
          refAudios.push({ audio: d.audio, sampleRate: d.sampleRate, text: ref.text });
          log(`参考音频解码: ${ref.file} → ${d.audio.length} samples, ${d.sampleRate} Hz`);
        }
      }

      parentPort.postMessage({ type: "ready" });

      parentPort.on("message", async (msg) => {
        if (msg.type === "generate") {
          try {
            const ref = refAudios[0];
            const t0 = process.hrtime.bigint();
            log(`调用 generateWithConfig (text=${msg.text.length}字, numSteps=${msg.numSteps ?? "默认"}, extra=${JSON.stringify(msg.extra ?? "无")})...`);
            const audio = tts.generateWithConfig(msg.text, {
              speed: msg.speed ?? 1.0,
              referenceAudio: ref.audio,
              referenceSampleRate: ref.sampleRate,
              referenceText: ref.text,
              ...(msg.numSteps !== undefined ? { numSteps: msg.numSteps } : {}),
              ...(msg.extra !== undefined ? { extra: msg.extra } : {}),
              callback: (samples, n, progress, arg) => {
                log(`  progress: ${(progress * 100).toFixed(0)}%`);
                return 0;
              },
            });
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            log(`生成返回: ${audio.samples.length} samples, ${audio.sampleRate} Hz`);
            parentPort.postMessage({ type: "result", ms: ms / 1000, samples: audio.samples.length, sampleRate: audio.sampleRate });
          } catch (err) {
            parentPort.postMessage({ type: "error", message: "generateWithConfig 失败: " + (err.message || String(err)) });
          }
        }
      });
    } catch (e) {
      parentPort.postMessage({ type: "error", message: "初始化失败: " + (e.message || String(e)) });
    }
  }
  init(files);
}
