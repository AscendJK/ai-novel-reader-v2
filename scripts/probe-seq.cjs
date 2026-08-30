/**
 * Kokoro 探针：验证生成的音频样本值分布
 * 背景：用户日志显示生成→播放→结束链路完整（276000 samples ≈ 11.5s 音频
 * 正常播放了 11.5s），但听不到声音。本探针用与浏览器 worker 完全相同的
 * WASM + 模型 + 配置在 Node 里生成，检查样本是否全零/NaN/幅度异常。
 * 若样本正常 → 问题在浏览器播放端；若样本静音 → 问题在模型/配置。
 */
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");

const MODEL_DIR = process.env.PROBE_MODEL_DIR || path.join(__dirname, "..", ".fetch", "probe-v11int8");
const WASM_DIR = process.env.PROBE_WASM_DIR || path.join(__dirname, "..", "server", "data", "tts-cache", "wasm");

const TEST_TEXT = "各位村民，大家新年好。近期，湖北省武汉市等多个地区。";
const TEST_SID = 45; // 晓北（用户日志 voice=45）
const TEST_SPEED = 1.0;

// 多组对照：不同音色 + 中英文文本，定位 NaN 根因
// 支持环境变量 PROBE_CASES 覆盖（JSON 数组 [{sid,text},...]）
const TEST_CASES = process.env.PROBE_CASES
  ? JSON.parse(process.env.PROBE_CASES)
  : [
      { sid: 45, text: "大家好。" },
      { sid: 45, text: "各位村民，大家新年好。" },
      { sid: 45, text: "近期，湖北省武汉市等多个地区。" },
      { sid: 45, text: "今天天气真不错，我们一起出去走走吧。" },
      { sid: 50, text: "各位村民，大家新年好。" },
      { sid: 0, text: "Hello world, this is a test." },
    ];

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
    "model.int8.onnx", "voices.bin", "tokens.txt",
    "lexicon-us-en.txt", "lexicon-zh.txt",
    "date-zh.fst", "number-zh.fst", "phone-zh.fst",
    "dict/jieba.dict.utf8", "dict/hmm_model.utf8", "dict/idf.utf8",
    "dict/user.dict.utf8", "dict/stop_words.utf8",
    "dict/pos_dict/char_state_tab.utf8", "dict/pos_dict/prob_emit.utf8",
    "dict/pos_dict/prob_start.utf8", "dict/pos_dict/prob_trans.utf8",
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
  console.log(`[main] 已加载 ${Object.keys(files).length} 个文件, ${TEST_CASES.length} 组对照测试`);

  const w = new Worker(__filename, { workerData: { files } });
  let caseIdx = 0;
  const t0 = Date.now();
  w.on("message", (msg) => {
    if (msg.type === "log") console.log("[worker]", msg.data);
    else if (msg.type === "ready") {
      console.log("[main] 模型就绪，开始测试...");
      const c = TEST_CASES[0];
      console.log(`[main] 测试 ${1}/${TEST_CASES.length}: sid=${c.sid}, text=${c.text}`);
      w.postMessage({ type: "generate", text: c.text, sid: c.sid, speed: TEST_SPEED, id: 0 });
    } else if (msg.type === "result") {
      const c = TEST_CASES[caseIdx];
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[main] 用例 ${caseIdx + 1} (sid=${c.sid}) 完成, 总耗时 ${elapsed}s`);
      let maxAbs = 0, nanCount = 0, nonZero = 0, sum = 0;
      const STEP = 400;
      const checked = Math.ceil(msg.samples.length / STEP);
      for (let i = 0; i < msg.samples.length; i += STEP) {
        const v = msg.samples[i];
        if (Number.isNaN(v)) { nanCount++; continue; }
        const a = Math.abs(v);
        if (a > maxAbs) maxAbs = a;
        if (a > 0.0001) nonZero++;
        sum += a;
      }
      console.log(`  samples=${msg.samples.length} (${(msg.samples.length / msg.sampleRate).toFixed(1)}s): maxAbs=${maxAbs.toFixed(4)}, NaN=${nanCount}/${checked}, 非静音=${nonZero}/${checked}, avg=${(sum / checked).toFixed(5)}`);
      if (maxAbs < 0.001 && nanCount === 0) console.log("  → 全静音（0 幅度）");
      else if (nanCount > 0) console.log("  → 含 NaN");
      else console.log("  → 正常");
      caseIdx++;
      if (caseIdx < TEST_CASES.length) {
        const nc = TEST_CASES[caseIdx];
        console.log(`[main] 测试 ${caseIdx + 1}/${TEST_CASES.length}: sid=${nc.sid}, text=${nc.text}`);
        w.postMessage({ type: "generate", text: nc.text, sid: nc.sid, speed: TEST_SPEED, id: caseIdx });
      } else {
        console.log("\n[main] 全部完成");
        process.exit(0);
      }
    } else if (msg.type === "error") {
      console.log("[main] ❌ 失败:", msg.message);
      process.exit(1);
    }
  });
  setTimeout(() => { console.log("[main] ⏰ 超时（330s）"); process.exit(2); }, 330000);
} else {
  const { files } = workerData;
  const { parentPort } = require("worker_threads");
  const log = (d) => parentPort.postMessage({ type: "log", data: d });

  async function init(files) {
    const os = require("os");
    const fs2 = require("fs");
    const vm = require("vm");
    const tmpDir = fs2.mkdtempSync(path.join(os.tmpdir(), "sherpa-kokoro-"));
    const wasmMainJsPath = path.join(tmpDir, "sherpa-onnx-wasm-main-tts.js");
    const ttsApiPath = path.join(tmpDir, "sherpa-onnx-tts.js");
    fs2.writeFileSync(wasmMainJsPath, files["sherpa-onnx-wasm-main-tts.js"]);
    fs2.writeFileSync(ttsApiPath, files["sherpa-onnx-tts.js"]);

    // 非 MODULARIZE 的 Emscripten 构建：无 module.exports，
    // 用 vm 在沙箱全局作用域执行，预置的 Module 配置会被脚本沿用并挂载 FS/导出。
    const dataBuf = files["sherpa-onnx-wasm-main-tts.data"].buffer.slice(
      files["sherpa-onnx-wasm-main-tts.data"].byteOffset,
      files["sherpa-onnx-wasm-main-tts.data"].byteOffset + files["sherpa-onnx-wasm-main-tts.data"].byteLength
    );
    const sandbox = {
      require,
      module: { exports: {} },
      exports: {},
      __dirname: tmpDir,
      __filename: wasmMainJsPath,
      console, process, Buffer,
      setTimeout, clearTimeout, setInterval, clearInterval,
      URL, Blob, TextDecoder, TextEncoder, performance,
      Module: {
        wasmBinary: files["sherpa-onnx-wasm-main-tts.wasm"],
        getPreloadedPackage: () => dataBuf,
        locateFile: (f) => {
          if (f.endsWith(".wasm")) return "file://" + path.join(tmpDir, "sherpa-onnx-wasm-main-tts.wasm");
          if (f.endsWith(".data")) return "file://" + path.join(tmpDir, "sherpa-onnx-wasm-main-tts.data");
          return "file://" + path.join(tmpDir, f);
        },
        print: (t) => log(t),
        printErr: (t) => log("[err] " + t),
      },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs2.readFileSync(wasmMainJsPath, "utf8"), sandbox, { filename: "sherpa-onnx-wasm-main-tts.js" });
    const Module = sandbox.Module;
    await new Promise((res) => {
      if (Module.calledRun) res();
      else Module.onRuntimeInitialized = res;
    });
    log("WASM 模块初始化成功");

    const mod2 = await import("file://" + ttsApiPath);
    const createOfflineTts = mod2.createOfflineTts || mod2.default?.createOfflineTts;

    const modelDir = "/api/rag/tts/model";
    for (const dir of ["/api", "/api/rag", "/api/rag/tts", modelDir]) {
      try { Module.FS_createPath("/", dir.slice(1), true, true); } catch {}
    }
    const kokoroFiles = [
      "model.int8.onnx", "voices.bin", "tokens.txt",
      "lexicon-us-en.txt", "lexicon-zh.txt",
      "date-zh.fst", "number-zh.fst", "phone-zh.fst",
    ];
    for (const name of kokoroFiles) {
      if (files[name]) Module.FS_createDataFile(modelDir, name, new Uint8Array(files[name]), true, true, true);
    }
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

    const config = {
      offlineTtsModelConfig: {
        debug: false,
        offlineTtsKokoroModelConfig: {
          model: modelDir + "/model.int8.onnx",
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
    const tts = createOfflineTts(Module, config);
    log("TTS 就绪! numSpeakers=" + tts.numSpeakers);
    parentPort.postMessage({ type: "ready" });

    parentPort.on("message", (msg) => {
      if (msg.type === "generate") {
        const t0 = Date.now();
        log(`[generate] id=${msg.id} 开始: ${msg.text.length} 字, sid=${msg.sid}, speed=${msg.speed}`);
        const audio = tts.generate({ text: msg.text, sid: msg.sid, speed: msg.speed });
        const ms = Date.now() - t0;
        log(`[generate] id=${msg.id} 完成: 耗时 ${ms}ms, RTF=${((ms / 1000) / (audio.samples.length / audio.sampleRate)).toFixed(2)}`);
        parentPort.postMessage({ type: "result", samples: audio.samples, sampleRate: audio.sampleRate });
      }
    });
  }
  init(files).catch((e) => parentPort.postMessage({ type: "error", message: e.message || String(e) }));
}
