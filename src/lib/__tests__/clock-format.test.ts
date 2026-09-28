/**
 * 行首那一枚时刻的唯一出处。
 *
 * `logger.ts` 与 `debug-store.ts` 两边各自拼过各自的时刻（一边写死 zh-CN，一边跟着浏览器
 * locale 走），同一份导出里于是同时出现 `[15:59:32 WARN]` 与 `[3:59:32 PM] 引擎切换`——
 * 拿相邻两行算停摆长度会凭空多出 12 小时。这一档钉的是"只有一把钟"，搬家那半边
 * （两处调用点真的用它）在 logger.test.ts 与 debug-store.test.ts 里各判一次。
 *
 * 刀账（每刀都是当场改产品、跑完立刻反向还原并 `sha256sum` 对基线）：
 * - Z1 摘掉 store 的统一贴戳（`logLines.push(msg)`）→ jsdom 红 4；浏览器层 P2 红 1
 * - Z2 一律贴戳（不认已有的）→ 红 1（logger 转写那行被贴成双戳）
 * - Z3 `clockStamp` 退回 `toLocaleTimeString()` → **jsdom 红 0**（这台机器 Node locale 本就是
 *   24 小时制，属等价变异）；同一刀打进浏览器层 P2 红 1，读数是 `[5:43:05 PM] …`
 */
import { describe, it, expect } from "vitest";
import { clockStamp, startsWithClock } from "../clock-format";

describe("clockStamp", () => {
  it("24 小时制且零填充：下午一点与午夜各给一个样", () => {
    expect(clockStamp(new Date(2026, 8, 28, 13, 4, 5))).toBe("13:04:05");
    expect(clockStamp(new Date(2026, 8, 28, 0, 0, 7))).toBe("00:00:07");
    expect(clockStamp(new Date(2026, 8, 28, 23, 59, 59))).toBe("23:59:59");
  });

  it("不接受 locale 参数——同一个时刻在任何语言下都得是同一串", () => {
    const at = new Date(2026, 8, 28, 13, 4, 5);
    expect(clockStamp(at)).toBe(clockStamp(at.getTime()));
    expect(clockStamp(at)).not.toMatch(/AM|PM|上午|下午/);
  });

  it("缺省取当下（探针每一拍都靠这一句）", () => {
    const before = Date.now();
    const line = clockStamp();
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(Number(line.slice(0, 2)) * 3600).toBeLessThanOrEqual(23 * 3600);
    expect(before).toBeGreaterThan(0);
  });
});

describe("startsWithClock", () => {
  it("认自己拼的那种，也认 logger 与 ragLog 那两种带标签的", () => {
    expect(startsWithClock("[13:04:05] 朗读现场")).toBe(true);
    expect(startsWithClock("[13:04:05 LOG] [TTS] ▶ chunk")).toBe(true);
    expect(startsWithClock("[RAG 13:04:05] 检索中")).toBe(true);
  });

  it("不带时刻的行必须判 false——否则 store 就不给它贴时刻，那一行永远算不出时长", () => {
    expect(startsWithClock("朗读现场 engine=server chunk=3/9")).toBe(false);
    expect(startsWithClock("[探针] 自检探针已挂载")).toBe(false);
  });
});
