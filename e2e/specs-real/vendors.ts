/**
 * 真厂商清单（`ANR_VENDOR_MANIFEST` 指过来的那只 JSON，**放在仓库外**）。
 *
 * 为什么不再用 `ANR_VENDOR1_* / ANR_VENDOR2_*` 那两只写死的槽位：槽位只有两只，加第三家就得改
 * 代码；更要紧的是地址、模型名会跟着进提交、进日志、进判据文案。清单把这些搬到盘外，
 * **连 key 值都不进清单**——清单里只有 `keyFile` 指向的那只文件的路径，key 由制作人自己填进去。
 *
 * 清单坏一行必须当场炸，不能悄悄少测一家：要是"11 passed"其实是 4 家里只跑了 2 家，
 * 报出去的绿就是假绿。所以这里的校验是"抛"，不是"跳过"。
 */
import { existsSync, readFileSync } from "node:fs";

export interface VendorSpec {
  /** ASCII 的短名：用户名、provider 名、日志前缀都派生自它，别把中文塞进 URL 与 localStorage 键 */
  id: string;
  /** 只出现在用例标题与判据文案里，不含 key */
  label: string;
  /** 决定请求形状：openai 拼 `${base}/chat/completions`，anthropic 拼 `${base}/messages` */
  format: "openai" | "anthropic";
  /** 填到 `/v1` 为止（两家都是这个形状），端点由产品侧的 normalizeBaseUrl 拼 */
  base: string;
  model: string;
  /** 只放路径，不放值。文件里就一行 key，允许多余换行 */
  keyFile: string;
  /** 这家已知的形状备注，会拼进用例标题（如"不响应 OPTIONS 预检"） */
  note?: string;
}

/** 清单里的 id 只允许这套字符：它会进 URL query、localStorage 值、provider 名、日志 */
const ID = /^[a-z0-9][a-z0-9._-]{0,23}$/;
const FORMATS = ["openai", "anthropic"] as const;

/**
 * 读清单。没设 `ANR_VENDOR_MANIFEST` 时回空数组（真厂商那一组整组按"没清单"跳过）；
 * 设了但文件不在 / 形状不对 / id 重名，一律抛——这些都属于"这一轮没资格报绿"。
 */
export function loadVendors(): VendorSpec[] {
  const p = process.env.ANR_VENDOR_MANIFEST;
  if (!p) return [];
  if (!existsSync(p)) throw new Error(`ANR_VENDOR_MANIFEST 指向的文件不存在：${p}`);
  const rows = parse(JSON.parse(readFileSync(p, "utf8")), p);
  const seen = new Set<string>();
  for (const v of rows) {
    if (seen.has(v.id)) throw new Error(`清单里 id 重复：${v.id}（${p}）`);
    seen.add(v.id);
  }
  return rows;
}

function requireString(o: Record<string, unknown>, k: string, where: string): string {
  const val = o[k];
  if (typeof val !== "string" || val.trim() === "") throw new Error(`${where} 的 "${k}" 必须是非空字符串`);
  return val.trim();
}

function parse(raw: unknown, file: string): VendorSpec[] {
  if (!Array.isArray(raw)) throw new Error(`清单顶层必须是数组（${file}）`);
  return raw.map((entry, i) => {
    const where = `清单第 ${i + 1} 条`;
    if (typeof entry !== "object" || entry === null) throw new Error(`${where} 不是对象（${file}）`);
    const o = entry as Record<string, unknown>;
    const id = requireString(o, "id", where);
    if (!ID.test(id)) throw new Error(`${where} 的 id "${id}" 不合规矩：只允许小写字母/数字/._-，且 ≤24 字符`);
    const format = requireString(o, "format", where);
    if (!(FORMATS as readonly string[]).includes(format)) {
      throw new Error(`${where} 的 format "${format}" 不认识，只能是 ${FORMATS.join(" / ")}`);
    }
    const v: VendorSpec = {
      id,
      label: requireString(o, "label", where),
      format: format as VendorSpec["format"],
      base: requireString(o, "base", where).replace(/\/+$/, ""),
      model: requireString(o, "model", where),
      keyFile: requireString(o, "keyFile", where),
    };
    if (typeof o.note === "string" && o.note.trim() !== "") v.note = o.note.trim();
    return v;
  });
}

/**
 * 读出这一家的 key。**没 key 就抛**，不返回空串：
 *
 * 一家没 key 的厂商安静地跳过，跟"这一轮压根忘了给它配 key"长得一模一样，而报出来的仍是一句
 * "11 passed"。真要用某家跑判据时，缺文件/空文件都该在**开跑那一刻**把话说清楚。
 *
 * key 值本身在这条链上只活一次：读进内存 → 塞进请求头 → 丢掉。不打印、不写进清单、不进日志
 * （跑带 key 的那一档还要 `ANR_REAL_ARTIFACTS=off`，trace 会原样记请求头）。
 */
export function vendorKey(v: VendorSpec): string {
  if (!existsSync(v.keyFile)) throw new Error(`${v.label}：keyFile 不存在 ${v.keyFile}——先把 key 写进这只文件再跑`);
  // 只取第一行并去掉 BOM/换行：制作人用记事本贴 key 会留一个 \r\n，那会让厂商回"格式错"而不是"密钥错"
  const line = readFileSync(v.keyFile, "utf8").replace(/^/, "").split(/\r?\n/)[0].trim();
  if (line === "") throw new Error(`${v.label}：keyFile 是空的 ${v.keyFile}——把 key 贴进去再跑（一行就够）`);
  return line;
}

/**
 * 收集阶段（`describe` 还没跑起来）用的安全版：拿不到 key 时把原因带回去，让 `test.skip` 说清楚。
 * 直接抛会连**别家配好了 key 的**一起跑不了——文件级异常是整个 spec 作废。
 */
export function tryVendorKey(v: VendorSpec): { key: string; missing: string | null } {
  try {
    return { key: vendorKey(v), missing: null };
  } catch (e) {
    return { key: "", missing: e instanceof Error ? e.message : String(e) };
  }
}

/** 厂商端点（探针与"这一发到底该打到哪儿"的唯一出处） */
export function chatEndpoint(v: VendorSpec): string {
  return `${v.base}${v.format === "anthropic" ? "/messages" : "/chat/completions"}`;
}

/**
 * 一发聊天请求的 body（两种格式只差 `stream` 那一格：anthropic 不带它即非流式）。
 * 抽出来当唯一出处，因为 R-E1 与预探要的是**同一种**请求，只有问题与预算不同。
 */
export function chatBody(v: VendorSpec, prompt: string, maxTokens: number): unknown {
  const body: Record<string, unknown> = { model: v.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  if (v.format !== "anthropic") body.stream = false;
  return body;
}

/**
 * 预探用的那一发请求（**两条腿都从这一处取形状**：node 直连厂商那一发，与 node 交给后端代理
 * 转发的那一发；见 `fixtures.ts` 的 `vendorReach`/`proxyProbe`）。看的是状态码，不是内容。
 *
 * 头这一格是整个预探的风险所在：anthropic 用 `x-api-key` + `anthropic-version`，拿 Bearer 打过去
 * 厂商回 401，而 401 在判据里属于"真问题、不许跳过"那一档——形状写错就会红成"key 坏了"。
 * 预算给 64：够到正文就行，预探不判内容（推理模型那种"预算吃光、200 但没正文"的形状由
 * R-E1 那条真探针管，它自己给 512）。
 */
export function probeRequest(v: VendorSpec, key: string): { url: string; headers: Record<string, string>; body: unknown } {
  return { url: chatEndpoint(v), headers: authHeaders(v, key), body: chatBody(v, "ping", 64) };
}

/** 两种格式的头（这里写错，厂商回的是 401，而 401 在判据里是"真问题、不许跳过"那一档） */
export function authHeaders(v: VendorSpec, key: string): Record<string, string> {
  return v.format === "anthropic"
    ? { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { "content-type": "application/json", authorization: `Bearer ${key}` };
}

/** 探针回包摊平后的样子（R-E1 判的就是这三件） */
export interface ProbeReply {
  content: string;
  finish?: string;
  usage: Record<string, unknown>;
}

/** 非流式 JSON 回包（两种形状都认，读不出结构时如实回空正文，让判据去说"没正文"） */
export function probeReply(v: VendorSpec, raw: string): ProbeReply {
  const empty: ProbeReply = { content: "", usage: {} };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return empty;
  }
  const usage = (typeof j.usage === "object" && j.usage !== null ? j.usage : {}) as Record<string, unknown>;
  if (v.format === "anthropic") {
    const blocks = Array.isArray(j.content) ? j.content : [];
    const content = blocks
      .map((b) => {
        const o = b as { type?: unknown; text?: unknown };
        return o?.type === "text" && typeof o.text === "string" ? o.text : "";
      })
      .join("");
    return { content, finish: typeof j.stop_reason === "string" ? j.stop_reason : undefined, usage };
  }
  const choice = (Array.isArray(j.choices) ? j.choices[0] : undefined) as
    | { message?: { content?: unknown }; finish_reason?: unknown }
    | undefined;
  return {
    content: typeof choice?.message?.content === "string" ? choice.message.content : "",
    finish: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    usage,
  };
}

/**
 * 线路上那一发的正文（SSE 与 JSON 两种都要摊平）。
 *
 * 为什么必须 SSE 感知：`config.stream` 没显式关掉时产品就带 `stream:true` 出去，厂商回的是
 * `text/event-stream`；照 JSON 解会一份都解不出来，于是"模型回了多少条关系"读成 0 ——
 * 那是判据读错了，不是产品错了。两种格式的帧形状不同：openai 是 `choices[0].delta.content`，
 * anthropic 是 `content_block_delta` 里的 `delta.text`（`thinking_delta` 那份**不算正文**）。
 */
export function wireText(v: VendorSpec, body: string, contentType: string): string {
  if (!contentType.includes("event-stream")) return probeReply(v, body).content;
  let out = "";
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue; // 半帧/心跳帧解不开不是这一档要管的事
    }
    if (v.format === "anthropic") {
      if (frame.type !== "content_block_delta") continue;
      const d = frame.delta as { type?: unknown; text?: unknown } | undefined;
      if (d?.type === "text_delta" && typeof d.text === "string") out += d.text;
      continue;
    }
    const choice = (Array.isArray(frame.choices) ? frame.choices[0] : undefined) as
      | { delta?: { content?: unknown } }
      | undefined;
    if (typeof choice?.delta?.content === "string") out += choice.delta.content;
  }
  return out;
}

/** 用例标题与日志前缀用的一行名：label + 型号 + 备注（永不含 key） */
export function vendorTag(v: VendorSpec): string {
  return `${v.label}（${v.format} · ${v.model}${v.note ? ` · ${v.note}` : ""}）`;
}
