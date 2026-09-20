import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // playwright-report / test-results 是 E2E 跑出来的产物：里面是打包后的压缩 JS，
  // 每跑一次用例就重生成一次。不忽略的话 `eslint .` 会把它们当源码扫出几百条 no-undef，
  // 把整道 verify 闸门砸掉
  globalIgnores(['dist', 'release', 'server/data', 'public/models', 'public/sherpa-tts', '.fetch', 'playwright-report', 'test-results']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // 服务端与脚本是纯 JS（无 tsc 覆盖），且历史上反复出现"作用域/不存在的 API"类
    // P0——node --check 只查语法不查作用域，因此这一层的崩溃类错误必须由 no-undef 兜住。
    // 风格类规则降为 warn：存量近百条，闸门只拦真会炸的
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'warn',
      'no-unsafe-optional-chaining': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-cond-assign': ['error', 'except-parens'],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    // coi-sw.js 是要拼进 sw.js 的 Service Worker 源码，跑在 SW 全局而非 Node
    files: ['scripts/coi-sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },
])
