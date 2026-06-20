/**
 * 多标签页通信模块
 * 使用 BroadcastChannel API 实现标签页间的数据同步
 */

type MessageHandler = (data: BroadcastMessage) => void;

export interface BroadcastMessage {
  type: 'sync-complete' | 'data-changed' | 'user-switched' | 'logout' | 'tab-closed' | 'model-download-complete';
  payload?: unknown;
  source: string; // 标签页 ID
  timestamp: number;
}

class BroadcastManager {
  private channel: BroadcastChannel | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private tabId: string;

  constructor() {
    this.tabId = this.generateTabId();
    this.init();
  }

  private generateTabId(): string {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private init() {
    try {
      this.channel = new BroadcastChannel('ai-novel-reader');
      this.channel.onmessage = (event) => {
        const message = event.data as BroadcastMessage;
        // 忽略自己发送的消息
        if (message.source === this.tabId) return;
        this.dispatch(message);
      };
    } catch {
      // BroadcastChannel 不支持的环境（如旧浏览器）
      console.warn('[broadcast] BroadcastChannel not supported');
    }
  }

  private dispatch(message: BroadcastMessage) {
    const handlers = this.handlers.get(message.type);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(message);
        } catch (err) {
          console.error('[broadcast] handler error:', err);
        }
      });
    }

    // 通配符处理器
    const wildcardHandlers = this.handlers.get('*');
    if (wildcardHandlers) {
      wildcardHandlers.forEach(handler => {
        try {
          handler(message);
        } catch (err) {
          console.error('[broadcast] wildcard handler error:', err);
        }
      });
    }
  }

  /**
   * 发送消息到其他标签页
   */
  send(type: BroadcastMessage['type'], payload?: unknown) {
    if (!this.channel) return;

    const message: BroadcastMessage = {
      type,
      payload,
      source: this.tabId,
      timestamp: Date.now(),
    };

    try {
      this.channel.postMessage(message);
    } catch (err) {
      console.error('[broadcast] send error:', err);
    }
  }

  /**
   * 监听特定类型的消息
   * @returns 取消监听的函数
   */
  on(type: string | '*', handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /**
   * 监听消息（自动清理）
   */
  onSyncComplete(handler: () => void): () => void {
    return this.on('sync-complete', () => handler());
  }

  onDataChanged(handler: (payload: unknown) => void): () => void {
    return this.on('data-changed', (msg) => handler(msg.payload));
  }

  onUserSwitched(handler: (username: string) => void): () => void {
    return this.on('user-switched', (msg) => handler(msg.payload as string));
  }

  onLogout(handler: () => void): () => void {
    return this.on('logout', () => handler());
  }

  /**
   * 获取当前标签页 ID
   */
  getTabId(): string {
    return this.tabId;
  }

  /**
   * 关闭通道
   */
  close() {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.handlers.clear();
  }
}

// 单例导出
export const broadcast = new BroadcastManager();
