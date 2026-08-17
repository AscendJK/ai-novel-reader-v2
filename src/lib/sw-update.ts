/**
 * Service Worker 更新回调（非组件 store 部分）
 * 组件见 @/components/common/UpdateBanner
 */

let _updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;

export function setUpdateSW(fn: (reloadPage?: boolean) => Promise<void>) {
  _updateSW = fn;
}

export function getUpdateSW(): ((reloadPage?: boolean) => Promise<void>) | null {
  return _updateSW;
}
