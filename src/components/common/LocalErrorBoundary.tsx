/**
 * 局部 ErrorBoundary 组件
 * 用于捕获子组件的错误，避免整个应用崩溃
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface LocalErrorBoundaryProps {
  /** 子组件 */
  children: ReactNode;
  /** 自定义错误回退 UI */
  fallback?: ReactNode;
  /** 错误回调（用于日志记录） */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** 错误边界的名称（用于日志） */
  name?: string;
}

interface LocalErrorBoundaryState {
  /** 是否有错误 */
  hasError: boolean;
  /** 错误对象 */
  error: Error | null;
}

/**
 * 局部 ErrorBoundary 组件
 *
 * @example
 * ```tsx
 * // 基本用法
 * <LocalErrorBoundary name="SummaryPanel">
 *   <SummaryPanel />
 * </LocalErrorBoundary>
 *
 * // 自定义回退 UI
 * <LocalErrorBoundary
 *   name="ReadingPanel"
 *   fallback={<div>阅读面板加载失败</div>}
 *   onError={(err) => console.error(err)}
 * >
 *   <ReadingPanel />
 * </LocalErrorBoundary>
 * ```
 */
export class LocalErrorBoundary extends Component<LocalErrorBoundaryProps, LocalErrorBoundaryState> {
  constructor(props: LocalErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): LocalErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const { name, onError } = this.props;
    console.error(`[LocalErrorBoundary${name ? `:${name}` : ""}]`, error, errorInfo);
    onError?.(error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    const { hasError, error } = this.state;
    const { children, fallback, name } = this.props;

    if (hasError) {
      // 使用自定义回退 UI
      if (fallback) {
        return fallback;
      }

      // 默认错误 UI
      return (
        <div className="flex flex-col items-center justify-center p-4 min-h-[100px] text-center">
          <p className="text-sm text-muted-foreground mb-2">
            {name ? `${name} 加载失败` : "组件加载失败"}
          </p>
          {error && (
            <p className="text-xs text-destructive mb-3 max-w-md truncate">
              {error.message}
            </p>
          )}
          <Button variant="outline" size="sm" onClick={this.handleReset}>
            重试
          </Button>
        </div>
      );
    }

    return children;
  }
}
