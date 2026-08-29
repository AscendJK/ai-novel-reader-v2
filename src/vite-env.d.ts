/// <reference types="vite/client" />

/** 构建时由 vite.config.ts 注入的版本号（来自 package.json） */
declare const __APP_VERSION__: string;

/** 构建时由 vite.config.ts 注入的 git commit hash（排查线上版本用） */
declare const __GIT_HASH__: string;

declare module "virtual:pwa-register" {
  export function registerSW(options?: {
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    immediate?: boolean;
  }): (reloadPage?: boolean) => Promise<void>;
}
