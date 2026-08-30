// Sherpa-onnx TTS Worker（Kokoro 引擎）
// 接收主线程传来的文件数据，不从网络加载
// 引擎：sherpa-onnx 1.13.6 classic 构建（importScripts 加载）
// 模型：Kokoro multi-lang v1.0 int8（53 音色，中文 sid 45-52）
// 无参考音频：sid 直接选音色，无 ZipVoice 的克隆/杂音问题

const MODEL_BASE = "/api/rag/tts/model";
let pageOrigin = "";
let tts = null;

function log(msg) { console.log("[Worker] " + msg); }

// ── 1.13.6 classic 加载：Emscripten 需要 self.Module 先定义，再 importScripts 胶水 ──
self.Module = {
  setStatus: function (status) { log("Emscripten: " + status); },
  print: (x) => log("EM: " + x),
  printErr: (x) => log("EM-ERR: " + x),
};

async function init(files, origin) {
  pageOrigin = origin || "";
  try {
    log("初始化 (Kokoro + 1.13.6 classic)...");

    // 诊断：确认浏览器拿到的引擎 JS 文件是 classic（var Module）还是 ESM（import.meta）
    try {
      const decoder = new TextDecoder();
      const mainJs = files["sherpa-onnx-wasm-main-tts.js"];
      const mainStr = decoder.decode(mainJs.slice(0, 512));
      const ttsJs = files["sherpa-onnx-tts.js"];
      const ttsStr = decoder.decode(ttsJs.slice(0, 256));
      log(`诊断 main-tts.js: ${mainJs.byteLength}B 开头="${mainStr.slice(0, 40).replace(/\n/g, " ")}" 含import.meta=${mainStr.includes("import.meta")}`);
      log(`诊断 tts.js: ${ttsJs.byteLength}B 开头="${ttsStr.slice(0, 40).replace(/\n/g, " ")}"`);
    } catch (de) { log("诊断日志失败: " + de.message); }

    // 1. 为 JS/WASM/data 文件创建 Blob URL
    const wasmMainJsUrl = URL.createObjectURL(new Blob([files["sherpa-onnx-wasm-main-tts.js"]], { type: "application/javascript" }));
    const ttsApiUrl = URL.createObjectURL(new Blob([files["sherpa-onnx-tts.js"]], { type: "application/javascript" }));
    const wasmUrl = URL.createObjectURL(new Blob([files["sherpa-onnx-wasm-main-tts.wasm"]], { type: "application/wasm" }));
    const dataUrl = URL.createObjectURL(new Blob([files["sherpa-onnx-wasm-main-tts.data"]], { type: "application/octet-stream" }));

    // 2. 补全 Module 配置后加载 classic 胶水
    // 在 importScripts 之前预设 onRuntimeInitialized（Emscripten 只在胶水执行
    // 期间读取该回调；data 文件通过 runDependency 异步加载，runtime 就绪后触发）
    let runtimeReadyResolve, runtimeReadyReject;
    const runtimeReady = new Promise((resolve, reject) => { runtimeReadyResolve = resolve; runtimeReadyReject = reject; });
    const runtimeTimer = setTimeout(() => runtimeReadyReject(new Error("Emscripten runtime 初始化超时 (60s)")), 60000);
    self.Module.onRuntimeInitialized = () => { clearTimeout(runtimeTimer); runtimeReadyResolve(); };

    self.Module.wasmBinary = files["sherpa-onnx-wasm-main-tts.wasm"];
    self.Module.getPreloadedPackage = () => files["sherpa-onnx-wasm-main-tts.data"];
    self.Module.locateFile = (filePath) => {
      if (filePath.endsWith(".wasm")) return wasmUrl;
      if (filePath.endsWith(".data")) return dataUrl;
      return wasmMainJsUrl;
    };

    importScripts(wasmMainJsUrl); // 执行 classic 胶水，self.Module 被实例化
    log("WASM 胶水代码就绪");
    importScripts(ttsApiUrl);     // 暴露 createOfflineTts
    log("TTS API 就绪");
    const Module = self.Module;

    // 3. 等待 Emscripten runtime 就绪（wasm 实例化完成）
    // 1.13.6 的 data 文件（espeak-ng-data）通过 runDependency 异步加载，
    // 在 runtime 就绪前 HEAP8 等内存视图未定义，提前 FS_createDataFile 会报
    // "Cannot read properties of undefined (reading 'buffer')"。
    if (!Module.calledRun && !Module.runtimeInitialized) {
      await runtimeReady;
    } else {
      clearTimeout(runtimeTimer);
    }
    log("Emscripten runtime 就绪");

    // 3. 将模型文件写入 Emscripten 虚拟文件系统（/api/rag/tts/model/）
    log("写入模型文件到虚拟文件系统...");
    const modelDir = "/api/rag/tts/model";
    for (const dir of ["/api", "/api/rag", "/api/rag/tts", modelDir]) {
      try { Module.FS_createPath("/", dir.slice(1), true, true); } catch {}
    }
    const kokoroFiles = [
      "model.onnx", "voices.bin", "tokens.txt",
      "lexicon-us-en.txt", "lexicon-zh.txt",
      "date-zh.fst", "number-zh.fst", "phone-zh.fst",
    ];
    for (const name of kokoroFiles) {
      if (files[name]) {
        Module.FS_createDataFile(modelDir, name, new Uint8Array(files[name]), true, true, true);
        log("  " + name + ": " + files[name].byteLength + " 字节");
      } else {
        log("  ⚠️ 缺失 " + name);
      }
    }
    // dict/（jieba 中文分词，Kokoro dictDir 需要）
    try { Module.FS_createPath(modelDir, "dict", true, true); } catch {}
    const dictFiles = Object.keys(files).filter((k) => k.startsWith("dict/"));
    for (const k of dictFiles) {
      const rel = k.slice("dict/".length);
      const name = rel.split("/").pop();
      if (rel.includes("/")) {
        try { Module.FS_createPath(modelDir + "/dict", "pos_dict", true, true); } catch {}
        Module.FS_createDataFile(modelDir + "/dict/pos_dict", name, new Uint8Array(files[k]), true, true, true);
      } else {
        Module.FS_createDataFile(modelDir + "/dict", name, new Uint8Array(files[k]), true, true, true);
      }
    }
    log("dict 写入 " + dictFiles.length + " 个文件");

    // 4. 创建 TTS 实例（Kokoro 配置）
    log("创建 TTS 实例...");
    const config = {
      offlineTtsModelConfig: {
        debug: false,
        offlineTtsKokoroModelConfig: {
          model: modelDir + "/model.onnx",
          voices: modelDir + "/voices.bin",
          tokens: modelDir + "/tokens.txt",
          dataDir: "/espeak-ng-data",
          lexicon: modelDir + "/lexicon-us-en.txt," + modelDir + "/lexicon-zh.txt",
          dictDir: modelDir + "/dict",
        },
        numThreads: 1,
      },
      ruleFsts: "",
      ruleFars: "",
      maxNumSentences: 1,
    };
    tts = createOfflineTts(Module, config);
    log("TTS 就绪! numSpeakers=" + tts.numSpeakers);

    self.postMessage({ type: "sherpa-onnx-tts-ready", modelType: "kokoro", numSpeakers: tts.numSpeakers });
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
      // Kokoro：sid 直接选音色（0-52），speed 控制语速，无需参考音频
      const sid = Math.min(Math.max(parseInt(msg.sid, 10) || 0, 0), (tts.numSpeakers || 53) - 1);
      const genStart = performance.now();
      log(`[generate] id=${msg.id} 开始: ${msg.text.length} 字, sid=${sid}, speed=${msg.speed ?? 1.0}`);
      const audio = tts.generate({
        text: msg.text,
        sid: sid,
        speed: msg.speed ?? 1.0,
      });
      const genMs = performance.now() - genStart;
      const audioSecs = audio.samples.length / audio.sampleRate;
      // RTF（real-time factor）= 生成耗时 / 音频时长：>1 表示生成比播放慢，越大越容易超时
      const rtf = (genMs / 1000) / audioSecs;
      log(`[generate] id=${msg.id} 完成: ${audio.samples.length} samples ≈ ${audioSecs.toFixed(1)}s 音频, 耗时 ${genMs.toFixed(0)}ms, RTF=${rtf.toFixed(2)}`);
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
