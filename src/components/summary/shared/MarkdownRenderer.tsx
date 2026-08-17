/**
 * 统一的 Markdown 渲染器组件
 * 组件配置见 ./markdown-config.ts
 */

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import {
  getMarkdownComponents,
  type MarkdownVariant,
} from "./markdown-config";

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

  if (className) {
    return (
      <div className={className}>
        <ReactMarkdown components={mergedComponents}>
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <ReactMarkdown components={mergedComponents}>
      {content}
    </ReactMarkdown>
  );
}
