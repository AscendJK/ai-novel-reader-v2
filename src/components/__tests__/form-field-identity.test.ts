import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

/**
 * Chrome DevTools 会报「A form field element should have an id or name attribute」。
 * 这条判据把「原生表单控件必须自报身份」落成代码：新增一只裸 input 当场红。
 *
 * 为什么用解析器而不是 grep：JSX 属性会换行，正则扫源码漏过了一半的格子。
 * 为什么不看 ui/select 的 Select：那只导出的是 Radix Root，渲染出来不是原生控件。
 */

// 原生标签 + 两只把 props 整包透传给原生标签的壳（ui/input、ui/textarea）
const WATCHED = new Set(["input", "textarea", "select", "Input", "Textarea"]);

function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "src")) && existsSync(join(dir, "package.json"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  throw new Error("找不到仓库根（需要同时含 src/ 与 package.json），这条判据的分母就不可信");
}

function listTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...listTsx(p));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

interface Finding {
  where: string;
  tag: string;
}

function scan(): { findings: Finding[]; files: number; watchedElements: number } {
  const root = repoRoot();
  const files = listTsx(join(root, "src"));
  const findings: Finding[] = [];
  let watchedElements = 0;

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rel = file.slice(root.length + 1).replace(/\\/g, "/");

    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        if (WATCHED.has(tag)) {
          watchedElements++;
          const attrs = node.attributes.properties;
          // 带展开属性的（如 ui/input 那两只壳本体）由调用方递身份，这里判不了也不该判
          const hasSpread = attrs.some((a) => ts.isJsxSpreadAttribute(a));
          const hasIdentity = attrs.some(
            (a) => ts.isJsxAttribute(a) && (a.name.getText(sf) === "id" || a.name.getText(sf) === "name"),
          );
          if (!hasSpread && !hasIdentity) {
            findings.push({ where: `${rel}:${text.slice(0, node.getStart(sf)).split("\n").length}`, tag });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { findings, files: files.length, watchedElements };
}

describe("表单控件身份（id 或 name）地板", () => {
  const { findings, files, watchedElements } = scan();

  // 分母自己说话：扫不到文件／扫不到受管元素＝这条判据是空的，不许当绿。
  // 09-29 实测：src 下非测试 .tsx 共 55 只，其中受管表单元素 45 只。
  it("扫描本身是活的：文件数与受管元素数都要够", () => {
    expect(files, `只扫到 ${files} 只 .tsx，仓库根找错了`).toBeGreaterThanOrEqual(50);
    expect(watchedElements, `只扫到 ${watchedElements} 只表单元素，判据没有牙`).toBeGreaterThanOrEqual(40);
  });

  it("每一只原生表单控件都声明了 id 或 name", () => {
    expect(
      findings.map((f) => `${f.where} <${f.tag}>`),
      `这些表单控件既没有 id 也没有 name：\n${findings.map((f) => `  ${f.where} <${f.tag}>`).join("\n")}`,
    ).toEqual([]);
  });
});
