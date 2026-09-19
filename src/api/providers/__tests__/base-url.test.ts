/**
 * baseUrl 归一测试（round 2 批次 3 / R-39）
 */

import { describe, it, expect } from "vitest";
import { normalizeBaseUrl } from "../base-url";

describe("normalizeBaseUrl", () => {
  it("剥掉尾斜杠", () => {
    expect(normalizeBaseUrl("https://api.deepseek.com/v1/", "/chat/completions"))
      .toBe("https://api.deepseek.com/v1");
    expect(normalizeBaseUrl("https://x.dev/v1///", "/chat/completions"))
      .toBe("https://x.dev/v1");
  });

  it("用户粘贴完整端点时剥掉端点后缀，不产出双重路径", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1/chat/completions", "/chat/completions"))
      .toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("https://gw.example.com/v1/messages/", "/messages"))
      .toBe("https://gw.example.com/v1");
  });

  it("大小写不敏感", () => {
    expect(normalizeBaseUrl("https://x.dev/v1/Chat/Completions", "/chat/completions"))
      .toBe("https://x.dev/v1");
  });

  it("空值与纯空白返回空串（调用方回落默认地址）", () => {
    expect(normalizeBaseUrl(undefined, "/chat/completions")).toBe("");
    expect(normalizeBaseUrl("   ", "/chat/completions")).toBe("");
  });

  it("路径里出现同名片段但不在结尾时不误剥", () => {
    expect(normalizeBaseUrl("https://x.dev/v1/chat/completions/probe", "/chat/completions"))
      .toBe("https://x.dev/v1/chat/completions/probe");
  });

  it("归一后拼接两次端点仍得到唯一路径", () => {
    const base = normalizeBaseUrl("https://x.dev/v1/chat/completions//", "/chat/completions");
    expect(`${base}/chat/completions`).toBe("https://x.dev/v1/chat/completions");
  });
});
