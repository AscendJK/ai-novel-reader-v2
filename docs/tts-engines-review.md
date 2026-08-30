# 语音朗读（TTS）模块审查说明

> 覆盖三个朗读引擎：**服务端推理（server）**、**浏览器推理（zipvoice）**、**浏览器内置（webspeech）**。
> 本文档梳理模块清单、引擎机制、本次「预生成缓冲池（A）+ 多 Worker 并行（C）」改造点、UI 提示与测试覆盖，供审查。

---

## 1. 总体架构

```
朗读入口（顶栏按钮 / 朗读栏 AudioPlayer）
        │
        ▼
useAudioPlayer（Hook：状态桥接、自动翻章、设置同步）
        │
        ▼
TTSManager（核心调度器：分块 → 预生成缓冲池 → 播放队列）
        │            │              │
        ▼            ▼              ▼
WebSpeechTTSEngine  BrowserKokoro   ServerKokoro
(浏览器内置, 类内)  (zipvoice-engine  (server-engine
                     worker 池, wasm)  HTTP → Python)
```

- **入口**：`AudioPlayer.tsx`（朗读栏）+ 顶栏朗读按钮（经 store 的 `startRequested` 触发）
- **调度**：`TTSManager.speak()` 统一入口，按 `engine` 分发；Kokoro 类引擎（server/zipvoice）共用一条「分块 → 缓冲池 → 播放」流水线，Web Speech 走独立直读路径
- **状态**：`tts-store`（zustand）承载三引擎独立设置 + 播放/生成/缓冲状态，UI 全量订阅

---

## 2. 模块文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/tts/tts-manager.ts` | 1130 | 核心：TTSChunk 定义、TTSPlaybackCallbacks、三引擎类（WebSpeech 内嵌 L79 / Kokoro 基类 L330 / Browser 子类 L604 / Server 子类 L617）、TTSManager 调度器（预生成缓冲池、流水线、作废机制、自动翻章配合） |
| `src/tts/zipvoice-engine.ts` | 688 | 浏览器推理引擎：sherpa-onnx wasm 的 **Worker 池**（本次 C 改造）、模型加载、任务调度、崩溃自动重建、超时/错误处理 |
| `src/tts/server-engine.ts` | 113 | 服务端推理 HTTP 客户端：`synthesizeServer`（SSE/轮询取音频）、`cancelServerInference`（取消排队请求）、WAV 头校验 |
| `src/tts/tts-cache.ts` | 275 | IndexedDB 模型资源缓存（412MB：model.onnx 310MB + voices + espeak + jieba dict）+ 旧前缀自动清理 |
| `src/tts/tts-preload.ts` | 111 | 预下载模型资源（后台提前拉取，避免首读等待） |
| `src/tts/text-preprocess.ts` | 202 | 文本清洗、按句子边界分块、段落索引映射（chunk ↔ 原段落） |
| `src/tts/voice-classify.ts` | 130 | Web Speech 语音列表分类（语言/本地在线） |
| `src/stores/tts-store.ts` | 453 | 三引擎独立设置（PersistedSettings）+ 播放/生成/预生成/缓冲状态 + 持久化 |
| `src/hooks/useAudioPlayer.ts` | 476 | 播放 Hook：manager 生命周期、回调→store 桥接（含 `onGenerating`→`setGenerating`）、自动翻章、seek、位置记忆 |
| `src/components/tts/AudioPlayer.tsx` | 378 | 朗读栏 UI：播放控制、进度、**预生成提示/缓冲水位/立即播放**（本次 A 改造） |
| `src/components/settings/TTSSettings.tsx` | 804 | 设置页：引擎选择（切换前停止朗读）、音色试听、**预生成段数/Worker 数**（本次新增） |

测试文件（9 个）：`tts-manager-pipeline`（9 例，缓冲池核心）、`tts-manager-engine-switch`（5 例，跨引擎切换回归，本次新增）、`tts-manager`、`tts-store`（含新增持久化例）、`useAudioPlayer-autonext`（5 例）、`useAudioPlayer-position`、`normalize-text`、`paragraph-tracking`、`text-preprocess`、`tts-preload`、`voice-classify`。

---

## 3. 三引擎对比

| 维度 | server（服务端推理） | zipvoice（浏览器推理） | webspeech（浏览器内置） |
|---|---|---|---|
| 实现位置 | `ServerKokoroEngine` L617 + `server-engine.ts` | `BrowserKokoroEngine` L604 + `zipvoice-engine.ts` | `WebSpeechTTSEngine` L79（tts-manager 内） |
| 推理位置 | 服务器 Python（8 线程） | 浏览器 wasm（1-3 Worker 池） | 系统 TTS（浏览器/OS） |
| 速度 | RTF≈0.6（快） | RTF≈5-8/worker（慢，本次 C 改造并行化） | 实时（系统级） |
| 模型资源 | 服务器侧 | 前端 IndexedDB 412MB | 无（系统内置） |
| 离线 | ❌ 需服务器 | ✅ 全离线 | ✅ 系统内置 |
| 主要限制 | 断网不可用 | 生成远慢于播放 → 依赖缓冲池；每 worker 约 400-500MB 内存 | 音色依赖系统；段落追踪靠时间估算；无预生成概念 |
| 音色 | Kokoro 中文 8 音色（sid 45-52） | 同左（同模型） | 系统语音列表 |

**共用的 Kokoro 流水线**（server/zipvoice）：`TTSManager` 对两者走同一套「分块 → 预生成缓冲池 → AudioBuffer 播放」，仅生成来源不同（HTTP vs wasm）。

---

## 4. 三引擎独立设置机制（tts-store）

- **PersistedSettings**：按引擎前缀独立存储 `server*/zipvoice*/webspeech*`（voiceId/speed/volume/pitch/chunkSize），本次新增：
  - `serverPrefetchCount`（默认 2）/ `zipvoicePrefetchCount`（默认 3）：开播前预生成段数
  - `zipvoiceWorkerCount`（默认 1）：浏览器推理并行 Worker 数
- **切换引擎 `setEngine`**：先把当前引擎的生效值 `writeCurrentParams` 写回旧引擎 → 再 `getParamsForEngine` 载入新引擎参数 → 持久化
- **clamp 规则**：chunkSize 30-500；prefetchCount 1-10；workerCount 1-3
- **旧数据兼容**：loadSettings 对缺失字段用 `?? 默认值` 兜底（旧 localStorage 无新字段时自动取默认）
- **生效值**：`prefetchCount` 跟随当前引擎；`workerCount` 是 zipvoice 全局设置（不随引擎切换）

---

## 5. 本次 A+C 核心机制

### 5.1 预生成缓冲池（A）— tts-manager

**开播前（prepareBuffers）**：
1. `speak()` 在 Kokoro 引擎就绪后，先并行提交前 K 段（`prefetchCount`）的生成（K 段同时进入 worker 池/服务端）
2. 期间通过 `onPrepareProgress(ready, total)` 上报进度（UI 显示"正在预生成 X/K 段"）
3. 全部就绪才开始播放第一条；用户可点**立即播放**（`skipPrepare()`）跳过剩余预生成

**播放中（水位推进 pumpPrefetch）**：
- 每次 `speakNextChunk` 播放当前段时，把 `generateWatermark` 推进到 `currentIndex + K`，缺失段并行提交生成
- 生成完成按 index 有序入 `buffered[]`，`onBufferChange(buffered.length)` 上报水位（UI 显示"⏩ 缓冲 N 段"）
- `speakNextChunk` 优先从 `buffered` 按 index 取段（命中即播，不重复生成），未命中才现场生成

**作废机制（generationId）**：停止 / seek / 语速变更 / 新 speak 都会 `generationId++`，所有在飞生成与已缓存段在回调处校验，作废即丢弃，防止旧结果污染新播放。

### 5.2 多 Worker 并行推理（C）— zipvoice-engine

- 单 worker → **Worker 池（1-3 个）**，每个 worker 独立加载模型（独立 wasm 实例，物理并行）
- **调度**：`dispatchTask` 找空闲 worker 立即派发，无空闲入 `taskQueue`（FIFO）；worker 完成经 `onWorkerIdle` 回填并派发下一个 → N 个任务同时并行
- **加载**：`loadModel` 串行初始化池（逐个 worker init，避免内存峰值叠加）；每个 worker 用 `files.slice(0)` 拷贝 + transfer（零拷贝传输）；`activePoolSize` 记录实际池大小，用户改 `workerCount` 后下次朗读检测差异并自动按新池大小重建
- **释放**：`resetWorker` 终止整个池、清空队列、reject 全部 pending、**revoke 全部 blob URL**
- **配置**：`setWorkerPoolSize(n)`（1-3），朗读前应用；模型已加载时 `speak()` 仍调用 `loadModel`（幂等：池大小一致立即返回，不一致重建），保证 workerCount 修改总是生效
- **为什么不用 pthread**：前端部署在 GitHub Pages，无法自定义 COOP/COEP 响应头 → `crossOriginIsolated=false` → SharedArrayBuffer 不可用；多 Web Worker 是唯一可行的并行路线（不依赖 SAB/COEP，全浏览器可用）

#### 崩溃恢复与资源泄漏防护（本次修复）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 单 worker 崩溃 | onerror 清空 taskQueue、reject **全部** pending、槽位置 undefined | `taskWorkerMap`（requestId→index）**精确 reject 该 worker 的任务**，其他 worker 任务正常完成；该槽位失效并记入诊断日志 |
| 全池崩溃 | pending 无限排队 → 卡 120s 超时 | `dispatchTask` 无存活 worker 时**立即快速失败**（"所有 Worker 已崩溃，请重试"）+ `scheduleRebuild` 自动重建（节流 30s，`loadingPromise`/`disposed` 防并发） |
| 部分 worker 崩溃 | 不恢复，剩余任务堆积 | `scheduleRebuild` 检测任务堆积自动**补建缺失槽位**；全崩则重建整个池 |
| blob URL | 永不 revoke（泄漏） | `workerBlobUrls` 追踪，terminate/失败/`resetWorker` 全路径 `revokeObjectURL` |
| 部分初始化失败 | 已创建 worker 不 terminate（400-500MB 孤儿） | `loadModel` 失败路径统一 terminate + revoke；**部分成功降级运行**（≥1 worker 就绪即可用，不再整体降级 Web Speech） |
| 超时任务 | 超时后结果仍回填（白生成） | 超时清理 `taskWorkerMap`，过期结果到达被识别丢弃 |
| 引擎切换 | `getKokoroEngine` 返回旧类型实例 → 走错引擎 | 每次获取校验 `lastKokoroKind`，类型不匹配销毁重建 |

### 5.3 量化预期（论证结论）

| 场景 | 1 Worker（现状） | 2 Worker | 3 Worker |
|---|---|---|---|
| 预生成 3 段等待 | 3-5 分钟 | 1.5-2.5 分钟 | 1-1.5 分钟 |
| 播放中等待粒度 | 等 60-90s 播 12s | 等 30-45s 播 12s | 等 20-30s 播 12s |

物理上限：即使 3 Worker，生成速率（约 0.4-0.6s/s）仍低于播放消耗（1s/s），**无法彻底消除卡顿**，优化目标是「开局流畅 + 等待粒度细化 + 可预期」。

---

## 6. UI 提示点（避免用户懵）

### 朗读栏（AudioPlayer）
| 阶段 | 提示 |
|---|---|
| 预生成阶段 | 进度条 + "正在预生成 X/K 段（浏览器推理较慢，可先等缓冲或立即播放）..." + **立即播放**按钮（≥1 段就绪可点） |
| 播放中 | 绿色缓冲水位 "⏩ 缓冲 N 段"（N=0 时不显示） |
| 生成中 | 进度条（generateProgress）+ 加载图标；**缓冲耗尽现场生成时同样显示"生成中"**（`onGenerating` 回调 → store `generating`，本次修复） |

### 设置页（TTSSettings）
| 设置 | 说明文案要点 |
|---|---|
| 开播前预生成段数（1-10） | 预生成越多开局越流畅，但等待越久；server 默认 2 / zipvoice 默认 3 |
| 并行推理 Worker 数（1-3） | 每增加 1 个约多占 400-500MB 内存；8GB 以下建议 1 个；高配可调 2-3 显著缩短等待；修改后下次朗读生效 |

---

## 7. 状态流转（store 关键字段）

| 字段 | 含义 | 写入方 |
|---|---|---|
| `generating` / `generateProgress` | 生成中 + 进度 | `setGenerating`（useAudioPlayer） |
| `prepareReady` / `prepareTotal` | 预生成阶段进度（total=0 未启用） | `onPrepareProgress` → `setPrepareProgress` |
| `bufferedChunks` | 播放中缓冲水位 | `onBufferChange` → `setBufferedChunks` |
| `playing` / `paused` | 播放状态 | manager 回调 |
| `currentParagraph` / `totalParagraphs` | 段落进度（朗读栏 + 正文高亮） | `onParagraphChange` / `onChunkStart` |
| `prefetchCount` / `workerCount` | 当前引擎预生成段数 / Worker 数 | 设置页 actions |

---

## 8. 测试覆盖

| 测试文件 | 覆盖点 |
|---|---|
| `tts-manager-pipeline.test.ts`（8 例） | 预生成完成才播放（onPrepareProgress 3/3）；立即播放跳过；缓冲水位升降（≥2 → 归 0）；停止丢弃预生成；seek 后重新生成；server/zipvoice 都走流水线；取消排队请求 |
| `tts-manager-engine-switch.test.ts`（5 例，本次新增） | **跨引擎切换回归**：server→zipvoice 重建为浏览器引擎（不再走服务端）；zipvoice→server 重建为服务端引擎；webspeech→server 正确走服务端；切换后音色参数应用到新实例；切换时正在朗读 → stop 中断旧引擎并通知取消排队 |
| `tts-manager.test.ts` | 播放/暂停/停止/错误回调基础行为 |
| `tts-store.test.ts` | 三引擎参数独立；**新增**：prefetchCount 按引擎独立 + workerCount 持久化 + 越界 clamp |
| `useAudioPlayer-autonext.test.tsx`（5 例） | 自动翻章时序、竞态修复 |
| 其他 5 个 | 文本清洗/分块/段落映射/预下载/语音分类 |

当前全量：**530 测试通过**（43 个测试文件），`tsc -b` 全绿，`eslint` 通过，`vite build` 成功。

---

## 9. 已知限制与风险（审查关注点）

1. **物理上限**：3 Worker 无法让浏览器推理实时，长章最终仍会"播一段等一段"（等待粒度 20-30s）——这是算力约束，非实现缺陷
2. **内存**：N Worker ≈ N×400-500MB 浏览器常驻；workerCount=3 时低配设备（<8GB）可能吃紧，故默认 1 且 UI 有说明
3. ~~**workerCount 生效时机**~~ ✅ 已修复：`speak()` 无条件调用 `loadModel`（幂等），模型已加载时池大小变更同样生效（`activePoolSize` 对比触发重建）
4. **Web Speech 引擎**：无缓冲池概念（直接顺序 speak），不受 A+C 影响
5. **server 引擎**：预生成段数同样生效（生成快、几乎无感），但排队取消依赖 `cancelServerInference` 的后端配合
6. **作废竞态**：预生成完成回调在 `generationId` 校验后才入缓冲，已由测试覆盖（停止丢弃、seek 重新生成）
7. ~~**worker 崩溃**~~ ✅ 已修复：崩溃自动重建 + 精确 reject（详见 §5.2），不再整体降级 Web Speech

### 本次审查修复清单（2026-08-30）

| 级别 | 问题 | 修复 |
|---|---|---|
| P0 | 跨引擎切换走错引擎：server→zipvoice 仍走 HTTP 推理、zipvoice→server 现场生成报"模型未加载" | `getKokoroEngine` 类型校验 + 销毁重建；`lastKokoroKind` 追踪；+5 个回归测试 |
| P1 | 部分 worker 初始化失败：已创建 worker 泄漏（400-500MB 孤儿） | 失败路径统一 terminate + revoke blob URL；部分成功降级运行 |
| P1 | 运行期全崩死锁：pending 任务排队等 120s 超时 | 无存活 worker 快速失败 + `scheduleRebuild` 自动重建（30s 节流） |
| P2 | 任何引擎 stop() 都卸载浏览器模型（反复卸载） | 仅 zipvoice 时 `resetWorker`（`lastKokoroKind` 判断） |
| P2 | Android 首次朗读白等 10s（voiceschanged 不触发） | `waitForVoices` Android 直接返回 |
| P2 | 设置页"浏览器推理可用"恒真 | `browserReady` 真实检测（已加载/预加载完成/缓存齐全） |
| P2 | IndexedDB 旧前缀（kokoro-v1/v2）残留，多次升级逼近配额 | `cleanupLegacyCache` 页面会话内清理一次 |
| P2 | 缓冲耗尽现场生成时无"生成中"UI | `onGenerating` 回调 → store `generating` |
| P3 | 超时任务结果仍回填（白生成） | 超时清理 `taskWorkerMap`，过期结果丢弃 |
| P3 | `decodeWav` 无格式校验（服务器返回异常数据时静默解析） | RIFF/WAVE 头 + PCM/单声道/采样率校验 |
| P3 | `queue()` 死代码 | 删除 |
| P3 | 试听打断朗读后状态错乱 | 试听前经 `manager.stop()` 走完整状态清理 |
| P3 | 进度显示边界（seek 到段尾可能显示 0/N） | 回退到最近前一段 |

### 已知保留项（设计取舍）

- **预生成失败静默**：缓冲池预生成失败只影响缓冲水位（现场生成兜底），已通过 `onGenerating` 改善可感知性；未做自动重试（避免失败风暴）
- **切到 webspeech 后 Kokoro 实例常驻**：保留实例便于切回时复用（省重建成本），`getKokoroEngine` 的类型校验保证不会误用错误引擎
