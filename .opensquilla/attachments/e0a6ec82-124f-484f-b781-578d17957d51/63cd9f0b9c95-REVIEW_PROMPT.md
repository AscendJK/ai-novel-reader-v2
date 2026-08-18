# 项目全面审查命令

将以下内容完整发送给 AI 审查工具，要求它对整个项目进行全面审查。

---

## 项目简介

**ai-novel-reader** v2.1.8 — 纯前端的 AI 辅助小说阅读器。

- 技术栈：React 18 + TypeScript + Vite 8 + Tailwind CSS
- 数据库：Dexie (IndexedDB) + better-sqlite3（可选后端）
- AI 提供商：OpenAI 兼容格式 + Anthropic（直接浏览器调用）
- 测试：Vitest + JSDOM，308 个测试用例
- 无后端服务：纯客户端 SPA，AI 请求从浏览器直发

## 审查范围

请对以下所有方面进行逐项审查，给出具体问题、风险等级（高/中/低）和修复建议。

---

### 1. 架构与项目结构

| 路径 | 主要职责 |
|------|---------|
| `src/agents/` | Agent 系统：章节总结、人物分析、时间线、图谱、地图 |
| `src/api/` | AI 提供商适配层（OpenAI、Anthropic）、token 预算管理 |
| `src/components/` | UI 组件：布局、阅读器、设置、总结面板、地图、TTS |
| `src/hooks/` | React Hooks：总结、分页、音频、键盘快捷键、解析 |
| `src/lib/` | 工具函数：错误处理、API 客户端、导出、文本处理 |
| `src/parsers/` | 小说文件解析（epub、txt） |
| `src/rag/` | 本地 RAG 检索（嵌入模型 + TF-IDF 混合） |
| `src/stores/` | Zustand 状态管理：API 配置、UI、摘要、TTS |
| `src/db/` | IndexedDB 数据库层（Dexie） |
| `src/sync/` | 多设备同步功能 |
| `src/tts/` | 文本转语音引擎 |

**审查要点**：
- 各层依赖关系是否清晰，有无循环依赖？
- 目录划分是否合理，有无职责模糊的模块？
- 公共工具函数是否集中在 `lib/` 还是散落在各处？
- 组件层级是否过深或过浅？

---

### 2. AI Provider 层（`src/api/`）

**关键文件**：`types.ts`、`registry.ts`、`providers/openai.ts`、`providers/anthropic.ts`、`token-manager.ts`、`error-handler.ts`

**审查要点**：
- `ChatCompletionResponse` 的 `tokensUsed` 字段是否为 API 真实用量？Agent 层用 `content.length` 替代后在接口层面是否存在语义不一致？
- 流式响应（SSE）解析 `readSSEData` 是否健壮？有无处理超长行、分块边界行、HTTP 204 等边界情况？
- `chatWithContextRetry` 自愈重试逻辑：捕获 `context_length` 后提取真实上下文长度 → 写缓存 → 重新裁剪 → 重试一次。这个流程是否在所有 agent 中正常工作？是否有死循环风险？
- `extractContextLength` 的三级匹配策略是否覆盖了所有国产 API 的错误格式？
- `handleFetchError` 的 `classifyError` 函数对 ModelScope、DeepSeek、Qwen 等国产 API 的 400 错误格式兼容性如何？
- 多个 agent 并发调用时，`discoveredContextWindows` 缓存是否存在竞态条件？
- 预算计算优先级链：用户配置 > 运行时发现 > MODEL_LIMITS > 默认。这个优先级是否在所有场景下合理？
- 非流式响应的 `parseResponse` 中，`data.usage` 为空时不做兜底，是否会导致调用方得到缺失的用量信息？

---

### 3. Agent 系统（`src/agents/`）

**关键文件**：`base-agent.ts`、`summarizer.ts`、`analyzers.ts`、`graph-agent.ts`、`map-agent.ts`、`utils.ts`、`types.ts`

**审查要点**：
- `BaseAgent.run()` → `prepareEnvironment()` → `execute()` 的抽象是否合理？子类 override 的 `prepareEnvironment` 是否一致？
- 每个 agent 的 `execute` 方法都接受 `chatWithContextRetry` 包装，重试时内部重新裁剪 prompt。这个模式是否在所有 agent 中统一实现？
- 章节总结的 `for` 循环中，每个章节独立调用 `chatWithContextRetry`，如果某章节重试后仍失败，错误处理是否合理（继续下一章 vs 中断）？
- 全书总结、人物、时间线、图谱的 fallback 逻辑：`estimatedInput >= computeAvailableInput(b, agentMaxTokens)` 触发精简模式。这个阈值是否合理？有无误触发或不触发的情况？
- `computeAvailableInput` 的 `safetyMargin = min(1000, contextWindow × 0.05)` 是否足够？对于极短上下文模型（如 4096）是否过度保守？
- 所有 agent 的输出都是 `system + user` 单轮对话，没有多轮历史。但 agent 的 `execute` 方法签名是否支持未来扩展多轮对话？`AgentResult` 类型是否足够？
- 图谱 agent 的 `parseGraphData` 使用 `extractJSON` 从 AI 回复中提取 JSON，对于回复包含额外文字的情况健壮性如何？
- 地图 agent 的 prompt 固定（不依赖预算截断），但它的 `execute` 没有接入 `chatWithContextRetry`。如果它遇到 400 错误，自愈是否会失效？

---

### 4. React 组件与 Hook（`src/components/` + `src/hooks/`）

**关键文件**：`AppLayout.tsx`、`SummaryPanel.tsx`、`useSummarizer.ts`、`ReadingPanel.tsx`、`ApiSettings.tsx`

**审查要点**：
- `useSummarizer.ts` 是最大的 hook（~650 行），职责是否过重？是否应该拆分为多个子 hook？
- `useSummarizer` 中状态管理混用 Zustand store + local state + ref，是否一致？
- 组件树的 `SummaryPanel` → `Tab(Chapter/Book/Notes/QA/Search)` → `Row/SubItem` → `MiniCard` 层级合理吗？Props drilling 是否过深？
- `MiniCard` 接收 `tokens: number` 作为 props，实际是 `content.length`（字数）。命名与语义不一致，是否应该改名？
- `SubItem` 组件接收 `summaries` 数组，但 `onGenerate` 和 `onRegenerate` 是外部回调，组件如何知道"当前正在生成哪一项"？
- 阅读器的 `ReadingPanel` 分页逻辑 `usePagination` 是否支持长章节的虚拟滚动？
- 章节切换时，是否清理了上一个章节的 AbortController？多个并发请求如何管理？
- 所有异步操作（AI 调用、DB 读写）是否都有 `AbortSignal` 支持？组件卸载时是否正确取消？

---

### 5. 状态管理（`src/stores/`）

**审查要点**：
- 6 个 Zustand store 的职责划分是否合理？`summary-store.ts` 和 `ui-store.ts` 是否有重叠？
- store 中持久化到 IndexedDB 的数据（summary、build）是否与 `useSummarizer` hook 中的本地缓存一致？
- 是否存在"数据同时在 store 和 DB 中，互相不同步"的问题？
- `api-store.ts` 中的 API 配置（含 API Key）是否安全存储？Zustand 默认是否持久化到 localStorage？

---

### 6. RAG 检索系统（`src/rag/`）

**审查要点**：
- 嵌入模型加载策略：`@xenova/transformers` 在浏览器中加载模型，首次加载耗时和内存占用是否可控？
- 混合检索（嵌入 + TF-IDF）的权重和排序策略是否合理？
- RAG 检索的 chunk 大小和 overlap 策略是否适合中文小说？
- QA 缓存（`qaRagCacheRef`）每 3 轮刷新，但缓存只在内存中，切换页面后丢失，是否应该改为持久化？
- 索引构建的进度反馈是否充分？用户是否能感知"正在构建"和"构建完成"？

---

### 7. 数据库层（`src/db/`）

**审查要点**：
- Dexie schema 设计是否合理？索引是否覆盖了所有查询模式？
- 章节内容存储是否做了分块？大章节（>10 万字）的读写性能如何？
- 数据迁移策略：schema 变更时如何处理旧数据？
- 同步功能（`src/sync/`）的冲突解决策略是什么？最后写入者胜出可能丢失数据？
- 数据库连接是否在组件卸载时正确关闭？

---

### 8. 错误处理与边界情况

**审查要点**：
- 全局错误边界（`ErrorBoundary`、`LocalErrorBoundary`）的覆盖范围是否完整？每个路由/关键区域是否有独立错误边界？
- 网络错误（离线、CORS、超时、DNS 失败）的处理是否一致？用户得到的错误信息是否可操作？
- AI API 返回的 400/401/429/500 错误是否有不同的用户提示？
- 鼠标/键盘快捷键（`useKeyboardShortcuts`）是否在模态框打开时被屏蔽？
- 文件解析（`src/parsers/`）对编码、格式错误的 epub/txt 的容错能力如何？
- 空状态、加载状态、错误状态的 UI 覆盖是否完整？

---

### 9. 测试覆盖（`src/**/__tests__/`）

**审查要点**：
- 308 个测试覆盖了哪些模块？哪些核心模块没有测试？
- 测试是否覆盖了 AI provider 的错误处理分支（400、401、429、流式解析失败）？
- Agent 的 fallback 逻辑、`computeAvailableInput` 边界值是否有测试？
- `chatWithContextRetry` 的 400 自愈重试逻辑是否有测试？
- 组件测试是否覆盖了关键的交互状态（加载、空、错误、成功）？
- 测试中 mock 的粒度是否合适？是否过度 mock 导致测试价值降低？

---

### 10. 性能与构建

**审查要点**：
- 构建产物大小分析：`vite build` 后的 bundle 中哪些依赖占体积最大？
- `@xenova/transformers` + `onnxruntime-web` 是否被正确拆分为异步 chunk？
- 图片、字体等静态资源是否被缓存策略覆盖？
- PWA service worker 的缓存策略（`vite-plugin-pwa`）是否合理？预缓存列表是否包含所有关键资源？
- 大型章节列表（>1000 章）的渲染性能是否有优化（虚拟化、懒加载）？
- RAG 检索的嵌入计算是否在 Web Worker 中执行？主线程是否被阻塞？

---

### 11. 代码质量与 TypeScript

**审查要点**：
- `any` 类型的使用是否可控？有无不安全类型断言（`as`）需要重构？
- ESLint 配置是否严格？有无被禁用的重要规则？
- 异步函数的错误处理：是否有未捕获的 Promise rejection？
- `useCallback`/`useMemo` 的依赖数组是否完整？有无缺少依赖导致的 stale closure？
- 是否有不可达代码或废弃的导出？
- 命名一致性：中文变量名/注释是否混用？API 字段命名是否统一？

---

### 12. 安全

**审查要点**：
- API Key 的存储位置：Zustand api-store 是否持久化到 localStorage？localStorage 的 XSS 风险是否有缓解措施？
- AI 回复中的 HTML/JS 注入风险：`react-markdown` + `dompurify` 的配置是否足够严格？
- 从文件系统加载的小说文件是否经过安全处理？
- CSP 策略是否设置？`cors` 中间件的配置是否合理？

---

### 13. 依赖项

**审查要点**：
- 依赖项中是否有重复功能的库（如多个状态管理库、多个 UI 库）？
- 主要依赖的版本是否过旧？有无已知的严重漏洞？
- `better-sqlite3` 和 `onnxruntime-node` 在浏览器 SPA 中是否真的需要？还是只在后端/构建时使用？
- 开发依赖中是否有应该移到生产依赖的包？

---

## 输出格式

请按以下格式逐项输出审查结果：

```
### [模块名]：[问题标题]

- **风险等级**：高/中/低
- **文件**：`src/xxx/xxx.ts`
- **问题描述**：具体说明了什么问题
- **影响**：可能导致什么后果
- **修复建议**：具体的修改方案
```

最后给出一个**总体评估**：代码质量评分（1-10）、最值得优先修复的 3 个问题、架构方面的改进建议。