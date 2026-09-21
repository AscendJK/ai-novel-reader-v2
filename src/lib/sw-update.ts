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

/**
 * 「等 SW 接管」那一次自刷的记账：`main.tsx` 写、真机自检面板读。
 * 两边必须同一个键名——手机上开不了 devtools，"还在刷"和"刷到上限放弃了"
 * 只能在面板那一行里分开看。
 */
export const COI_RELOAD_KEY = "coi-reload-count";
export const MAX_COI_RELOADS = 3;
