/**
 * 统一的 Markdown 渲染器
 * 提取 SummaryPanel.tsx 中的 summaryMd 和 chatMd 配置
 */

import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";

/**
 * 用于渲染 AI 分析结果的 Markdown 组件配置
 * 适用于章节总结、全书总览、人物分析等长文本
 */
export const summaryComponents: Components = {
  h1: ({ children }: { children: ReactNode }) => (
    <h2 className="text-sm font-bold border-b pb-0.5 mb-1.5 mt-3 first:mt-0">{children}</h2>
  ),
  h2: ({ children }: { children: ReactNode }) => (
    <h3 className="text-xs font-semibold mt-2 mb-1 flex items-center gap-1">
      <span className="w-1 h-1 rounded-full bg-primary shrink-0" />
      {children}
    </h3>
  ),
  h3: ({ children }: { children: ReactNode }) => (
    <h4 className="text-xs font-medium mt-1.5 mb-0.5">{children}</h4>
  ),
  p: ({ children }: { children: ReactNode }) => (
    <p className="text-foreground/80 leading-relaxed">{children}</p>
  ),
  ul: ({ children }: { children: ReactNode }) => (
    <ul className="list-disc pl-3 space-y-0.5 text-foreground/75">{children}</ul>
  ),
  ol: ({ children }: { children: ReactNode }) => (
    <ol className="list-decimal pl-3 space-y-0.5 text-foreground/75">{children}</ol>
  ),
  li: ({ children }: { children: ReactNode }) => (
    <li className="pl-0.5">{children}</li>
  ),
  strong: ({ children }: { children: ReactNode }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }: { children: ReactNode }) => (
    <em className="italic text-primary">{children}</em>
  ),
  hr: () => <hr className="my-2 border-border" />,
  blockquote: ({ children }: { children: ReactNode }) => (
    <blockquote className="border-l-2 border-primary/30 pl-2 italic">{children}</blockquote>
  ),
  code: ({ children }: { children: ReactNode }) => (
    <code className="bg-muted px-1 py-0.5 rounded text-xs">{children}</code>
  ),
  table: ({ children }: { children: ReactNode }) => (
    <div className="overflow-x-auto my-1">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: { children: ReactNode }) => (
    <thead className="bg-muted/50">{children}</thead>
  ),
  tr: ({ children }: { children: ReactNode }) => (
    <tr className="border-b border-border last:border-0">{children}</tr>
  ),
  th: ({ children }: { children: ReactNode }) => (
    <th className="text-left px-1.5 py-0.5 font-semibold">{children}</th>
  ),
  td: ({ children }: { children: ReactNode }) => (
    <td className="px-1.5 py-0.5">{children}</td>
  ),
};

/**
 * 用于渲染对话消息的 Markdown 组件配置
 * 适用于 Q&A 对话等短文本
 */
export const chatComponents: Components = {
  p: ({ children }: { children: ReactNode }) => (
    <p className="mb-0.5 last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children: ReactNode }) => (
    <ul className="list-disc pl-3">{children}</ul>
  ),
  ol: ({ children }: { children: ReactNode }) => (
    <ol className="list-decimal pl-3">{children}</ol>
  ),
  strong: ({ children }: { children: ReactNode }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  code: ({ children }: { children: ReactNode }) => (
    <code className="bg-black/10 dark:bg-white/10 px-1 py-0.5 rounded">{children}</code>
  ),
};

/**
 * Markdown 渲染器变体
 */
export type MarkdownVariant = "summary" | "chat";

/**
 * 获取指定变体的组件配置
 */
export function getMarkdownComponents(variant: MarkdownVariant): Components {
  return variant === "summary" ? summaryComponents : chatComponents;
}

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
