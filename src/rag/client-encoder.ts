/**
 * Client-side query encoder using Transformers.js (主线程封装).
 * Models are downloaded via backend proxy (bypasses CORS).
 * 真实逻辑位于 ./encode-core（可在主线程与 Worker 间复用）。
 */

import { encodeQueryCore } from "./encode-core";
import { getEffectiveServerUrl } from "@/lib/api-client";

/** 在主线程执行编码（使用生效的 serverUrl：显式配置优先，同源模式回退当前源） */
export async function encodeQuery(text: string, engine: string): Promise<Float32Array | null> {
  return encodeQueryCore(text, engine, getEffectiveServerUrl());
}