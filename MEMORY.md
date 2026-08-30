# MEMORY.md

## TTS 引擎（Kokoro）修复记录 — 2026-08-30

### 根因：int8 模型在 wasm 上生成全 NaN（无声）
- Kokoro v1.0 **int8**（`model.int8.onnx`，114MB）在 sherpa-onnx 1.13.6 wasm 上
  生成全 NaN 音频：播放链路完整（276000 samples ≈ 11.5s）但听不到声音。
  Node 探针（`scripts/probe-kokoro.cjs` / `probe-seq.cjs`，与浏览器 worker 相同引擎+配置）复现：6/6 全 NaN。
- **修复**：改用 **fp32 v1.0**（`model.onnx`，310MB），探针 6/6 正常（0 NaN，含中英文 + 多音色）。
- v1.1 包：官方 `kokoro-int8-multi-lang-v1_1.tar.bz2`（147MB）实际也是 fp32 模型（325MB），
  且音色是编号制（zf_001…zf_099），无晓北/云健等命名音色，故未采用。

### 音色 sid 修正（v1.0 fp32 官方映射）
- 45-48 女声：晓北/晓妮/晓晓/晓伊
- 49-52 男声：云健/云希/云夏/云扬（之前代码 50-53 是偏移 bug，53 超出范围）

### 性能参考（fp32，Node 单线程）
- RTF≈4.4-10（11 字约 14-21s，18 字约 19s）
- 默认单次生成 60 字（原 150），超时每字 6s（原 4s）

### 部署要点
- 服务器模型源：Gitee 分卷是 int8（废弃）→ GitHub 官方 tts-models fp32 v1.0 + 镜像 fallback
  （gh-proxy.com / gh.llkk.cc，国内可用）
- 浏览器缓存前缀 kokoro-v3/ 强制重下
- 服务器本地已手动放置 `server/data/tts-cache/model/model.onnx`（325MB），
  旧 int8 备份为 `model.int8.onnx.bak`
- 排查中间产物在 `.fetch/`：probe-fp32v10/（fp32 完整包）、probe-v10b/（int8+dict）、
  probe-v11b/（fp32 v1.1）等

### 相关提交
- `2ee5238` fix(tts): Kokoro 生成全 NaN 无声，模型 int8 切回 fp32 + 修正音色 sid
- `eaea82f` fix(tts): 服务器模型下载接 GitHub 官方源 + 镜像 fallback；探针支持 fp32
- `a3e910c` feat(tts): 新增服务端推理引擎（Python 原生多线程）+ 模型按需下载 + 设置页三引擎 UI

## 服务端推理（Python）— 2026-08-30 新增

### 为什么做
浏览器 wasm 单线程 fp32 推理 RTF≈12-13（29 字 69s），无法边听边推理；
int8 在 1.13.6 wasm 上全 NaN（死路）；官方 wasm 无 pthread/WebGPU 构建。

### 方案：服务器 Python sherpa-onnx 原生多线程
- `server/tts-worker.py`：常驻进程（stdin/stdout JSON 行协议），
  sherpa-onnx 1.13.6，8 线程，加载 fp32 v1.0，输出 WAV base64
- `POST /api/rag/tts/synthesize`（rag.js）：懒启动 Python 进程（队列/超时/崩溃重启），
  返回 audio/wav
- `GET /tts/status`：新增 `serverInference` 字段（supported/ready/reason）
- 性能实测（本机）：模型加载 2.3s；18 字 RTF≈0.6（8 线程 2.5s，4 线程 3.3s，1 线程 10s）
- 首次 synthesize 4.9s（含进程启动+模型加载），常驻后 2.0s

### 部署要求
- 服务器 `pip install sherpa-onnx`（本机已验证 1.13.6 可用，Python 3.11）
- 服务器需有 espeak-ng-data（已复制到 model 目录，来自 v1.1 包 17MB）

### 模型按需下载（不再一打开后端就下载）
- server/index.js 移除启动 5s 自动 ensureTTSResources
- AppLayout 移除登录后自动 preloadZipVoice
- 设置页「启用」按钮触发：服务端推理→/tts/prepare（下载到服务器）；
  浏览器推理→preloadZipVoice（下载到浏览器 IndexedDB）

### 前端引擎结构
- TTSEngine = "server" | "zipvoice" | "webspeech"
- server 与 zipvoice 共用 Kokoro 参数（voiceId/speed/chunkSize），webspeech 独立
- 引擎选择在设置页：服务端推理（推荐·快）/ 浏览器推理（离线·慢）/ Web Speech（免下载）
- 关键文件：src/tts/server-engine.ts（新）、src/tts/tts-manager.ts（ServerKokoroEngine）、
  src/stores/tts-store.ts、src/components/settings/TTSSettings.tsx
