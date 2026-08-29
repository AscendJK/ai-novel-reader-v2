/**
 * ZipVoice generateWithConfig 崩溃复现脚本（Node worker_threads）
 * 模拟浏览器 worker：加载 sherpa-onnx WASM + 模型文件 → 生成音频
 * 目的：复现 C++ 11903128 崩溃，定位根因
 */
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");

const MODEL_DIR = path.join(__dirname, "..", "server", "data", "tts-temp", "model", "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia");
const WASM_DIR = path.join(__dirname, "..", "server", "data", "tts-temp", "wasm", "sherpa-onnx-wasm-simd-1.13.3-sherpa-onnx-zipvoice-distill-int8-zh-en-emilia");
const TTS_TEMP = path.join(__dirname, "..", "server", "data", "tts-temp");

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
  // vocoder：24kHz（与浏览器 worker 一致；22kHz 会导致 C++ 11903128 崩溃）
  const vocoder24 = path.join(MODEL_DIR, "vocos_24khz.onnx");
  const vocoder22 = path.join(TTS_TEMP, "vocos-22khz-univ.onnx");
  const vocoderPath = fs.existsSync(vocoder24) ? vocoder24 : vocoder22;
  if (fs.existsSync(vocoderPath)) {
    files["vocos_24khz.onnx"] = fs.readFileSync(vocoderPath);
    console.log("[main] 使用 vocoder: " + path.basename(vocoderPath));
  } else console.log("[main] 警告: vocoder 缺失");
  console.log(`[main] 已加载 ${Object.keys(files).length} 个文件`);
  console.log(`[main] decoder.int8.onnx: ${(files["decoder.int8.onnx"]?.length / 1048576).toFixed(1)}MB`);

  const w = new Worker(__filename, { workerData: { files } });
  // 与浏览器 worker 一致的 3 个音色（sid → 参考音频）循环验证
  const TEST_TEXTS = [
    "各位村民，大家新年好。",  // 与参考文本重叠，验证杂音修复
    "今天天气真不错，我们一起出去走走吧。",
    "人工智能正在改变我们的生活方式。",
  ];
  let sid = 0;
  w.on("message", (msg) => {
    if (msg.type === "log") console.log("[worker]", msg.data);
    else if (msg.type === "ready") {
      console.log("[main] 模型就绪，开始生成（3 音色循环）...");
      w.postMessage({ type: "generate", text: TEST_TEXTS[0], sid: 0, speed: 1.0, id: 0 });
    } else if (msg.type === "result") {
      console.log(`[main] 音色 ${sid} 生成成功! samples=${msg.samples.length}, sampleRate=${msg.sampleRate}`);
      sid++;
      if (sid < 3) {
        w.postMessage({ type: "generate", text: TEST_TEXTS[sid], sid, speed: 1.0, id: sid });
      } else {
        console.log("[main] 全部 3 个音色验证通过");
        process.exit(0);
      }
    } else if (msg.type === "error") {
      console.log(`[main] 生成失败（音色 ${sid}）: ${msg.message}`);
      process.exit(1);
    }
  });
  w.on("error", (e) => { console.log("[main] worker 错误:", e.message); process.exit(1); });
} else {
  // worker 线程
  const { files } = workerData;
  const { parentPort } = require("worker_threads");
  const log = (d) => parentPort.postMessage({ type: "log", data: d });

  // 拦截 URL（blob URL 在 Node 里不可用，直接用 file:// 或 data URL）
  const path = require("path");

  async function init(files) {
    try {
      // 1. 从内存加载 JS 文件（Node 用 vm 或直接 require？这里用 eval 方式加载）
      // 实际上需要把 wasm 胶水代码转成可执行模块 —— 用临时文件方案
      const os = require("os");
      const fs = require("fs");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sherpa-"));
      const wasmMainJsPath = path.join(tmpDir, "sherpa-onnx-wasm-main-tts.js");
      const ttsApiPath = path.join(tmpDir, "sherpa-onnx-tts.js");
      fs.writeFileSync(wasmMainJsPath, files["sherpa-onnx-wasm-main-tts.js"]);
      fs.writeFileSync(ttsApiPath, files["sherpa-onnx-tts.js"]);
      log("临时文件已写入");

      const mod1 = await import("file://" + wasmMainJsPath);
      const createModule = mod1.default || mod1;
      log("WASM 胶水代码已加载");

      const mod2 = await import("file://" + ttsApiPath);
      const createOfflineTts = mod2.createOfflineTts || mod2.default?.createOfflineTts;
      log("TTS API 已加载: " + typeof createOfflineTts);

      // 2. 初始化 WASM 模块
      let Module;
      // data 包是 Emscripten 预打包格式（metadata + 文件偏移），直接传 ArrayBuffer
      // 注意：必须是真正的 ArrayBuffer（Node Buffer 不行，processPackageData 有类型断言）
      const dataBuf = files["sherpa-onnx-wasm-main-tts.data"].buffer.slice(
        files["sherpa-onnx-wasm-main-tts.data"].byteOffset,
        files["sherpa-onnx-wasm-main-tts.data"].byteOffset + files["sherpa-onnx-wasm-main-tts.data"].byteLength
      );
      log("data 包: " + (dataBuf.byteLength / 1048576).toFixed(1) + "MB");
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

      // 写模型文件到虚拟 FS
      const modelDir = "/api/rag/tts/model";
      const mkdirp = (p) => {
        const parts = p.split("/").filter(Boolean);
        let cur = "";
        for (const part of parts) { cur += "/" + part; try { Module.FS_createPath("/", cur.slice(1), true, true); } catch {} }
      };
      mkdirp(modelDir);
      const modelFiles = ["tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx", "lexicon.txt", "vocos_24khz.onnx"];
      for (const name of modelFiles) {
        if (files[name]) {
          Module.FS_createDataFile(modelDir, name, new Uint8Array(files[name]), true, true, true);
          log(`FS 写入 ${name}: ${files[name].byteLength} 字节`);
        }
      }
      try { Module.FS_createPath(modelDir, "test_wavs", true, true); } catch {}
      for (const wav of ["test_wavs/news-female.wav", "test_wavs/news-female-2.wav", "test_wavs/leijun-1.wav"]) {
        if (files[wav]) {
          const name = wav.split("/").pop();
          Module.FS_createDataFile(modelDir + "/test_wavs", name, new Uint8Array(files[wav]), true, true, true);
          log(`FS 写入 ${name}`);
        }
      }

      // 3. 创建 TTS 实例
      const config = {
        offlineTtsModelConfig: {
          debug: true,
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

      // 4. 解码参考音频
      function decodeWav(arrayBuf) {
        const data = new Uint8Array(arrayBuf);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (view.getUint16(20, true) !== 1) throw new Error("非 PCM WAV");
        const numChannels = view.getUint16(22, true);
        const sampleRate = view.getUint32(24, true);
        const bitsPerSample = view.getUint16(34, true);
        if (bitsPerSample !== 16) throw new Error("非 16-bit WAV");
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

      // 与浏览器 worker 一致：3 个音色 → 3 个参考音频 + 匹配转录（官方 prompt.txt）
      const REF_AUDIOS = [
        { file: "test_wavs/news-female.wav", text: "各位村民, 大家新年好! 近期, 湖北省武汉市等多个地区" },
        { file: "test_wavs/news-female-2.wav", text: "本台消息, 中共中央国务院, 近日印发关于构建数据基础制度, 更好发挥数据要素作用的意见." },
        { file: "test_wavs/leijun-1.wav", text: "那还是36年前, 1987年. 我呢考上了武汉大学的计算机系." },
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

      // 等待 generate 消息
      const { parentPort: pp } = require("worker_threads");
      require("worker_threads").parentPort.on("message", async (msg) => {
        if (msg.type === "generate") {
          try {
            // 按音色选择参考音频（与浏览器 worker 一致，越界回退到 0）
            const refIdx = Math.min(Math.max(parseInt(msg.sid, 10) || 0, 0), refAudios.length - 1);
            const ref = refAudios[refIdx] || refAudios[0];
            log("调用 generateWithConfig (sid=" + refIdx + ")...");
            const audio = tts.generateWithConfig(msg.text, {
              speed: msg.speed ?? 1.0,
              referenceAudio: ref.audio,
              referenceSampleRate: ref.sampleRate,
              referenceText: ref.text,
              // 不传 silenceScale（默认 0.2，保留句间停顿）；
              // 官方 zipvoice 参数：numSteps=4 + min_char_in_sentence=10
              numSteps: 4,
              extra: { min_char_in_sentence: 10 },
            });
            log("生成返回: " + audio.samples.length + " samples, " + audio.sampleRate + " Hz");
            pp.postMessage({ type: "result", samples: Array.from(audio.samples).slice(0, 10), sampleRate: audio.sampleRate });
          } catch (err) {
            pp.postMessage({ type: "error", message: "generateWithConfig 失败: " + (err.message || String(err)) });
          }
        }
      });
    } catch (e) {
      parentPort.postMessage({ type: "error", message: "初始化失败: " + (e.message || String(e)) });
    }
  }

  init(files);
}
