// Sherpa-onnx TTS Worker
// 接收主线程传来的文件数据，不从网络加载

const MODEL_BASE = "/api/rag/tts/model";
let pageOrigin = "";
let tts = null;
let refAudioData = null; // 缓存参考音频 Float32Array

function log(msg) { console.log("[Worker] " + msg); }

/** 从 ArrayBuffer 解码 WAV 为 Float32Array */
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

// 拦截 URL 构造函数：blob URL 不能作为 new URL() 的 base
// Emscripten 内部用 new URL(".", import.meta.url) 解析路径，import.meta.url 是 blob:... 会失败
// 必须在 import() 之前设置，因为 import 进来的模块会立即执行 URL 构造
const OrigURL = self.URL;
function WrappedURL(...args) {
  if (args.length >= 2 && typeof args[1] === "string" && args[1].startsWith("blob:")) {
    args[1] = (pageOrigin || "http://localhost:5173") + "/";
  }
  return new OrigURL(...args);
}
WrappedURL.prototype = OrigURL.prototype;
Object.assign(WrappedURL, OrigURL);
self.URL = WrappedURL;

async function init(files, origin) {
  pageOrigin = origin || "";
  try {
    const hasSAB = typeof SharedArrayBuffer !== "undefined";
    log("crossOriginIsolated=" + self.crossOriginIsolated + " SharedArrayBuffer=" + hasSAB);
    if (!hasSAB) throw new Error("SharedArrayBuffer 不可用");

    // 1. 为 JS 文件创建 Blob URL
    log("创建 Blob URL...");
    const wasmMainJsBlob = new Blob([files["sherpa-onnx-wasm-main-tts.js"]], { type: "application/javascript" });
    const wasmMainJsUrl = URL.createObjectURL(wasmMainJsBlob);
    const ttsApiBlob = new Blob([files["sherpa-onnx-tts.js"]], { type: "application/javascript" });
    const ttsApiUrl = URL.createObjectURL(ttsApiBlob);

    // 2. 加载 WASM 胶水代码（import 让 Emscripten 的 import.meta.url 变成 blob URL，但 WrappedURL 会处理）
    log("加载 WASM 胶水代码...");
    const mod1 = await import(wasmMainJsUrl);
    const createModule = mod1.default;
    if (!createModule) throw new Error("createModule 为空");
    log("WASM 胶水代码就绪");

    // 3. 加载 TTS API
    log("加载 TTS API...");
    const mod2 = await import(ttsApiUrl);
    const createOfflineTts = mod2.createOfflineTts;
    if (!createOfflineTts) throw new Error("createOfflineTts 为空");
    log("TTS API 就绪");

    // 4. 为 WASM 和 data 文件创建 Blob URL
    const wasmBlob = new Blob([files["sherpa-onnx-wasm-main-tts.wasm"]], { type: "application/wasm" });
    const wasmUrl = URL.createObjectURL(wasmBlob);
    const dataBlob = new Blob([files["sherpa-onnx-wasm-main-tts.data"]], { type: "application/octet-stream" });
    const dataUrl = URL.createObjectURL(dataBlob);

    // 5. 初始化 WASM 模块
    log("初始化 WASM 模块...");
    const heartbeat = setInterval(() => log("心跳: WASM 初始化中..."), 10000);
    let Module;
    try {
      Module = await createModule({
        // 直接传入 WASM 和数据文件，避免 fetch
        wasmBinary: files["sherpa-onnx-wasm-main-tts.wasm"],
        getPreloadedPackage: () => files["sherpa-onnx-wasm-main-tts.data"],
        // pthread Workers 用这个 blob URL 来加载，而不是 new URL(xxx, import.meta.url)
        mainScriptUrlOrBlob: wasmMainJsUrl,
        locateFile: (filePath) => {
          log("locateFile: " + filePath);
          if (filePath.endsWith(".wasm")) return wasmUrl;
          if (filePath.endsWith(".data")) return dataUrl;
          return pageOrigin + (filePath.startsWith("/") ? "" : "/") + filePath;
        },
        setStatus: (status) => {
          log("Emscripten: " + status);
        },
      });
      log("WASM 模块初始化成功");
      emModule = Module;
      // 检查 FS API 名称
      log("FS可用: FS_createDataFile=" + (typeof Module.FS_createDataFile) +
          " FS.createDataFile=" + (typeof Module.FS?.createDataFile) +
          " FS_readFile=" + (typeof Module.FS_readFile) +
          " FS.readFile=" + (typeof Module.FS?.readFile));
    } finally {
      clearInterval(heartbeat);
    }

    // 6. 将模型文件写入 Emscripten 虚拟文件系统
    // TTS 库通过文件路径读取 tokens.txt、encoder.onnx 等
    log("写入模型文件到虚拟文件系统...");
    const modelDir = "/api/rag/tts/model";
    const modelFiles = ["tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx", "lexicon.txt"];
    // 创建目录层级
    for (const dir of ["/api", "/api/rag", "/api/rag/tts", "/api/rag/tts/model"]) {
      try { Module.FS_createPath("/", dir.slice(1), true, true); } catch {}
    }
    // 写入 vocoder 模型
    const vocoderFile = "vocos-22khz-univ.onnx";
    if (files[vocoderFile]) {
      Module.FS_createDataFile(modelDir, vocoderFile, new Uint8Array(files[vocoderFile]), true, true, true);
      log("  " + vocoderFile + ": " + files[vocoderFile].byteLength + " 字节");
    }
    for (const name of modelFiles) {
      if (files[name]) {
        Module.FS_createDataFile(modelDir, name, new Uint8Array(files[name]), true, true, true);
        log("  " + name + ": " + files[name].byteLength + " 字节");
      }
    }
    // 写入参考音频到模型目录（模型在 ONNX 文件所在目录查找 test_wavs/）
    try { Module.FS_createPath(modelDir, "test_wavs", true, true); } catch {}
    const wavFiles = ["test_wavs/news-female.wav", "test_wavs/news-female-2.wav", "test_wavs/leijun-1.wav"];
    for (const wavPath of wavFiles) {
      if (files[wavPath]) {
        const name = wavPath.split("/").pop();
        const data = new Uint8Array(files[wavPath]);
        Module.FS_createDataFile(modelDir + "/test_wavs", name, data, true, true, true);
        log("  " + name + ": " + data.length + " B");
      }
    }
    // 缓存参考音频（news-female.wav）为 Float32Array，供生成时使用
    if (files["test_wavs/news-female.wav"]) {
      const decoded = decodeWav(files["test_wavs/news-female.wav"]);
      refAudioData = decoded.audio;
      log("参考音频已解码: " + refAudioData.length + " samples, " + decoded.sampleRate + " Hz");
    }

    // 7. 创建 TTS 实例
    log("创建 TTS 实例...");
    const config = {
      offlineTtsModelConfig: {
        debug: false,
        maxNumSentences: 1,
        offlineTtsZipVoiceModelConfig: {
          tokens: MODEL_BASE + "/tokens.txt",
          encoder: MODEL_BASE + "/encoder.int8.onnx",
          decoder: MODEL_BASE + "/decoder.int8.onnx",
          vocoder: MODEL_BASE + "/vocos-22khz-univ.onnx",
          dataDir: "/espeak-ng-data",
          lexicon: MODEL_BASE + "/lexicon.txt",
        },
        numThreads: 1,
      },
      ruleFsts: "",
      ruleFars: "",
      maxNumSentences: 1,
    };
    tts = createOfflineTts(Module, config);
    log("TTS 就绪! numSpeakers=" + tts.numSpeakers);

    self.postMessage({ type: "sherpa-onnx-tts-ready", modelType: "zipvoice", numSpeakers: tts.numSpeakers });
  } catch (e) {
    self.postMessage({ type: "error", message: "TTS 初始化失败: " + (e.message || String(e)) });
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    await init(msg.files, msg.pageOrigin);
  } else if (msg.type === "generate") {
    if (!tts) { self.postMessage({ type: "error", id: msg.id, message: "TTS 未初始化" }); return; }
    try {
      // generateWithConfig 才支持 referenceAudio/referenceSampleRate/referenceText
      log("开始生成, refAudio=" + refAudioData.length + " samples, text=" + msg.text.length + " chars");
      let audio;
      try {
        audio = tts.generateWithConfig(msg.text, {
          sid: 0,
          speed: msg.speed || 1.0,
          referenceAudio: refAudioData,
          referenceSampleRate: 24000,
          referenceText: "各位村民, 大家新年好! 近期, 湖北省武汉市等多个地区",
        });
      } catch (e) {
        log("generateWithConfig 抛出: " + e + " message=" + e.message);
        throw e;
      }
      log("生成成功! samples=" + audio.samples.length + " rate=" + audio.sampleRate);
      // 复制 samples 到独立 buffer（避免 Emscripten heap 已释放）
      const copy = new Float32Array(audio.samples);
      self.postMessage({ type: "sherpa-onnx-tts-result", id: msg.id, samples: copy, sampleRate: audio.sampleRate }, [copy.buffer]);
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, message: "生成失败: " + (err.message || String(err)) });
    }
  } else if (msg.type === "dispose") {
    if (tts && typeof tts.free === "function") tts.free();
    tts = null;
  }
};
