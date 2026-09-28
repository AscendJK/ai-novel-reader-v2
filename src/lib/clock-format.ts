/**
 * 时间线上的时刻——全项目唯一的一枚钟。
 *
 * 为什么单独一个文件：以前时刻是三处各自拼的，而且拼出来的不是一回事：
 * `logger.ts` 用 `toLocaleTimeString("zh-CN")`（24 小时制），
 * `debug-store.ts` 与 `DebugPanel.tsx` 用不带 locale 的 `toLocaleTimeString()`
 * （跟着浏览器语言走，en-US 下就是 `3:59:32 PM`）。两种小时制混在同一列里，
 * 拿"相邻两行的时间差"算停摆长度会得到 43200 秒（正好 12 小时）这种数——
 * 09-28 的一次性台架就是这么撞出来的。真机自检的整份报告就靠这两行相减，
 * 所以格式必须有唯一出处，且不许跟 locale 走。
 */

/** `[hh:mm:ss]`（24 小时制、零填充）。传入时刻，缺省为现在。 */
export function clockStamp(at: number | Date = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 行首是不是已经带过时刻（带过的不许多贴一层，读的人要先猜哪个才是事发时间）。
 * 认两种形态：`[13:04:05 ...]` 与 `[RAG 13:04:05]`——后一种是 `ragLog` 自己的老格式，
 * 它同时也往控制台打，改它会连带动到日志行的样子。
 */
export function startsWithClock(line: string): boolean {
  return /^\[(?:[A-Za-z]{1,4} )?\d{1,2}:\d{2}:\d{2}/.test(line);
}
