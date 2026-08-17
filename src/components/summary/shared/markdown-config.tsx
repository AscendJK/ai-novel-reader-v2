/**
 * Markdown 渲染组件配置（非组件部分）
 * 组件见 ./MarkdownRenderer.tsx
 */

import type { ReactNode } from "react";
import type { Components } from "react-markdown";

type CProps = { children?: ReactNode };

/**
 * 用于渲染 AI 分析结果的 Markdown 组件配置
 * 适用于章节总结、全书总览、人物分析等长文本
 */
export const summaryComponents: Components = {
  h1: ({ children }: CProps) => (
    <h2 className="text-sm font-bold border-b pb-0.5 mb-1.5 mt-3 first:mt-0">{children}</h2>
  ),
  h2: ({ children }: CProps) => (
    <h3 className="text-xs font-semibold mt-2 mb-1 flex items-center gap-1">
      <span className="w-1 h-1 rounded-full bg-primary shrink-0" />
      {children}
    </h3>
  ),
  h3: ({ children }: CProps) => (
    <h4 className="text-xs font-medium mt-1.5 mb-0.5">{children}</h4>
  ),
  p: ({ children }: CProps) => (
    <p className="text-foreground/80 leading-relaxed break-words">{children}</p>
  ),
  ul: ({ children }: CProps) => (
    <ul className="list-disc pl-3 space-y-0.5 text-foreground/75">{children}</ul>
  ),
  ol: ({ children }: CProps) => (
    <ol className="list-decimal pl-3 space-y-0.5 text-foreground/75">{children}</ol>
  ),
  li: ({ children }: CProps) => (
    <li className="pl-0.5">{children}</li>
  ),
  strong: ({ children }: CProps) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }: CProps) => (
    <em className="italic text-primary">{children}</em>
  ),
  hr: () => <hr className="my-2 border-border" />,
  blockquote: ({ children }: CProps) => (
    <blockquote className="border-l-2 border-primary/30 pl-2 italic break-words">{children}</blockquote>
  ),
  code: ({ children }: CProps) => (
    <code className="bg-muted px-1 py-0.5 rounded text-xs break-all">{children}</code>
  ),
  table: ({ children }: CProps) => (
    <div className="overflow-x-auto my-1 max-w-full">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: CProps) => (
    <thead className="bg-muted/50">{children}</thead>
  ),
  tr: ({ children }: CProps) => (
    <tr className="border-b border-border last:border-0">{children}</tr>
  ),
  th: ({ children }: CProps) => (
    <th className="text-left px-1.5 py-0.5 font-semibold">{children}</th>
  ),
  td: ({ children }: CProps) => (
    <td className="px-1.5 py-0.5">{children}</td>
  ),
};

/**
 * 用于渲染对话消息的 Markdown 组件配置
 * 适用于 Q&A 对话等短文本
 */
export const chatComponents: Components = {
  p: ({ children }: CProps) => (
    <p className="mb-0.5 last:mb-0">{children}</p>
  ),
  ul: ({ children }: CProps) => (
    <ul className="list-disc pl-3">{children}</ul>
  ),
  ol: ({ children }: CProps) => (
    <ol className="list-decimal pl-3">{children}</ol>
  ),
  strong: ({ children }: CProps) => (
    <strong className="font-semibold">{children}</strong>
  ),
  code: ({ children }: CProps) => (
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
