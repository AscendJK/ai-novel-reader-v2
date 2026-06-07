export function estimateReadingTime(chars: number): string {
  const minutes = Math.ceil(chars / 500); // ~500 chars/min for Chinese
  if (minutes < 1) return "< 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

export function formatCharCount(chars: number): string {
  if (chars < 1000) return `${chars} 字`;
  if (chars < 10000) return `${(chars / 1000).toFixed(1)} 千字`;
  return `${(chars / 10000).toFixed(1)} 万字`;
}

export function sliceTextByTokens(text: string, maxTokens: number): string {
  // Rough: 1 token ≈ 1.5 Chinese chars
  const maxChars = maxTokens * 1.5;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[文本因Token限制被截断...]";
}
