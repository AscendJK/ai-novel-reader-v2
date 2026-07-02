import { useEffect, useRef, useState, useCallback } from "react";

export interface PageRange {
  startIndex: number;  // 起始段落索引
  endIndex: number;    // 结束段落索引（包含）
}

interface UsePaginationOptions {
  paragraphs: string[];
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  fontFamily: string;
  paragraphSpacing: number;
  contentWidth: number;
  contentHeight: number;
  enabled: boolean;
}

/**
 * 分页算法 Hook：通过隐藏测量容器计算段落高度，将内容分页。
 * 每页尽量多放段落，但确保最后一个段落底部不超出页面边界。
 */
export function usePagination(options: UsePaginationOptions) {
  const {
    paragraphs, fontSize, lineHeight, fontWeight, fontFamily,
    paragraphSpacing, contentWidth, contentHeight, enabled,
  } = options;

  const measureRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<PageRange[]>([]);

  // 实际的分页计算逻辑
  const doCalculate = useCallback(() => {
    if (!measureRef.current || !contentWidth || !contentHeight) {
      setPages([]);
      return;
    }

    const children = Array.from(measureRef.current.children) as HTMLElement[];
    if (children.length === 0) {
      setPages([]);
      return;
    }

    // 测量每个段落的顶部位置和高度
    const rects: { top: number; height: number }[] = [];
    for (const child of children) {
      const rect = child.getBoundingClientRect();
      rects.push({ top: rect.top, height: rect.height });
    }

    // 以第一个段落为基准，转换为相对于容器的坐标
    const baseTop = rects[0].top;
    const positions = rects.map(r => ({ top: r.top - baseTop, height: r.height }));

    // 按页面高度切分（使用 0.5px 容差避免浮点精度问题）
    const result: PageRange[] = [];
    let pageStartIdx = 0;
    let pageBottom = contentHeight; // 当前页面的底部边界
    const TOLERANCE = 0.5; // 浮点精度容差

    for (let i = 0; i < positions.length; i++) {
      const paraBottom = positions[i].top + positions[i].height;

      // 段落底部超出当前页面边界（带容差）
      if (paraBottom > pageBottom + TOLERANCE) {
        // 如果这个段落不是页面的第一个段落，则把它放到下一页
        if (i > pageStartIdx) {
          result.push({ startIndex: pageStartIdx, endIndex: i - 1 });
          pageStartIdx = i;
          pageBottom = positions[i].top + contentHeight;
        } else {
          // 单个段落就超过一页，强制放在一页上
          result.push({ startIndex: i, endIndex: i });
          pageStartIdx = i + 1;
          pageBottom = positions[i].top + contentHeight;
        }
      }
    }

    // 最后一页
    if (pageStartIdx < positions.length) {
      result.push({ startIndex: pageStartIdx, endIndex: positions.length - 1 });
    }

    setPages(result);
  }, [contentWidth, contentHeight]);

  // 延迟触发重新计算，避免频繁调整字体时每帧都测量所有段落
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!enabled || !contentWidth || !contentHeight) {
      setPages([]);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const raf = requestAnimationFrame(doCalculate);
      return () => cancelAnimationFrame(raf);
    }, 100);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [doCalculate, enabled, paragraphs, fontSize, lineHeight, fontWeight, fontFamily, paragraphSpacing]);

  return { pages, totalPages: pages.length, measureRef };
}
