/**
 * 跑完最后一段：把"这一跑有几条判据是被厂商预探杀掉的"打在收尾，紧挨着 Playwright 那句 `N skipped`。
 *
 * 为什么要单独一段（制作人 2026-09-28 拍 B）：预探跳过**不是失败**，Playwright 回 exit 0、
 * 尾部只有一句干巴巴的 `3 skipped`。2026-09-28 那一跑就是这么混过去的——#38（R-E4 错 key · 411）
 * 被一条 30 秒就 abort 的直连探针跳掉，我从 `list` 的尾部读数里根本看不出"这一跑少测了一条真判据"，
 * 是制作人追问"那个 38 号错 key 为啥没理由"才去翻日志翻出来的。
 *
 * 这一段只报小计，不改退出码：预探跳过的确不是产品坏了，但"没测到"也不许被读成"测过了"。
 */
import { readPreProbeTally } from "./fixtures";

export default function postflight(): void {
  const rows = readPreProbeTally();
  if (rows.length === 0) {
    console.log("\n[预探小计] 这一跑没有被厂商预探跳过的判据。");
    return;
  }
  const killed = new Set(rows.flatMap((r) => r.judges));
  console.log(
    `\n[预探小计] 这一跑有 ${killed.size} 条判据被厂商预探跳过（组 ${rows.length} 个）。` +
      `不是产品坏了，但也没测到——别把上面的 exit 0 读成"跑过了"：`,
  );
  for (const r of rows) {
    console.log(`  - ${r.group} ｜ ${r.vendor} ｜ ${r.judges.join("、")} ｜ ${r.why}`);
  }
}
