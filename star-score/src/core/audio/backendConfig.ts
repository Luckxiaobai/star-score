/* ================================================================
 * 星谱识音 · 后端地址单一配置源
 * ----------------------------------------------------------------
 * 全应用只有这里保存后端地址，并提供持久化。
 *
 * 设计目的：
 *   - 修复「后端地址改了不生效 / 关掉面板又变回去」的问题：
 *     此前 AudioImport、ModelManager 各自持有一份 backendUrl state，
 *     且都不持久化，GAME / HOMR 引擎用的是 engines/index.ts 里
 *     另一份地址，三者互不同步。
 *   - 现在统一为：读 getBackendUrl()、写 setBackendUrl()，
 *     两者都会同步 engines 里的 GAME / HOMR 引擎并写入 localStorage。
 *
 * 使用方式：
 *   import { getBackendUrl, setBackendUrl } from '../core/audio/backendConfig';
 *   const [url, setUrl] = useState(getBackendUrl);   // 初始化直接读全局
 *   setBackendUrl(next);                            // 修改即全局生效+持久化
 * ================================================================ */

import { getBackendUrl as getEngineBackendUrl, setBackendUrl as setEngineBackendUrl } from './engines';

/** localStorage 键名 */
const STORAGE_KEY = 'star-score:backend-url';

/** 默认后端地址（与 backend/server.py 默认端口一致） */
export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:9874';

/** 去掉末尾多余的斜杠，避免拼出 //health */
export function normalizeBackendUrl(url: string): string {
  const trimmed = (url || '').trim();
  return (trimmed || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
}

/** 读取当前后端地址（优先 localStorage，其次引擎管理器内存值） */
export function getBackendUrl(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeBackendUrl(saved);
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
  return normalizeBackendUrl(getEngineBackendUrl() || DEFAULT_BACKEND_URL);
}

/** 设置后端地址：规范化 → 持久化 → 同步到 GAME / HOMR 引擎 */
export function setBackendUrl(url: string): string {
  const next = normalizeBackendUrl(url);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 忽略写入失败 */
  }
  setEngineBackendUrl(next);
  return next;
}

/** 应用启动时把持久化地址同步到引擎（在 main.tsx 中调用一次） */
export function bootstrapBackend(): void {
  setEngineBackendUrl(getBackendUrl());
}
