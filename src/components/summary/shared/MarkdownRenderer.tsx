/**
 * 统一的 Markdown 渲染器组件
 * 组件配置见 ./markdown-config.ts
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import {
  getMarkdownComponents,
  type MarkdownVariant,
} from "./markdown-config";

/**
 * GFM 扩展：表格、删除线、任务清单、自动链接、脚注。
 * CommonMark 本身不含这些，少了这一支，markdown-config 里那五支 table/thead/tr/th/td
 * 与 `~~x~~`、`- [ ]` 全都走不到。
 */
const REMARK_PLUGINS = [remarkGfm];

/**
 * Markdown 渲染器属性
 */
interface MarkdownRendererProps {
  /** Markdown 内容 */
  content: string;
  /** 渲染变体 */
  variant?: MarkdownVariant;
  /** 自定义组件配置（覆盖默认配置） */
  components?: Components;
  /** 额外的 CSS 类名 */
  className?: string;
}

/**
 * 统一的 Markdown 渲染器组件
 *
 * @example
 * ```tsx
 * // 渲染分析结果
 * <MarkdownRenderer content={summary} variant="summary" />
 *
 * // 渲染对话消息
 * <MarkdownRenderer content={message} variant="chat" />
 * ```
 */
export function MarkdownRenderer({
  content,
  variant = "summary",
  components: customComponents,
  className,
}: MarkdownRendererProps) {
  const defaultComponents = getMarkdownComponents(variant);
  const mergedComponents = customComponents
    ? { ...defaultComponents, ...customComponents }
    : defaultComponents;

  // 两条 return 各写一份 props 是 M6 那记 0 红的根因（带 wrapper 那支漏传过 components），
  // 所以 props 只组一次，包不包 div 只决定外面那一层。
  const markdown = (
    <ReactMarkdown components={mergedComponents} remarkPlugins={REMARK_PLUGINS}>
      {content}
    </ReactMarkdown>
  );

  return className ? <div className={className}>{markdown}</div> : markdown;
}
