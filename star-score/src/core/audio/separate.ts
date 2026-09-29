// 人声 / 伴奏分离：调用本地后端服务
//
// 设计要点：前端先用 Web Audio 解码成 WAV 再发给后端，
// 这样后端不需要 ffmpeg / 任何第三方库，纯标准库即可运行。
// 后端地址统一由 core/audio/backendConfig.ts 提供（单一配置源 + 持久化）。

import { decodeChannels } from './decode';
import { encodeWav } from './wav';
import { DEFAULT_BACKEND_URL, normalizeBackendUrl as normalize } from './backendConfig';

export type SeparateMode = 'vocal' | 'accompaniment';
export type SeparateMethod = 'center' | 'demucs';

export interface SeparateOptions {
  baseUrl?: string;
  mode?: SeparateMode;
  method?: SeparateMethod;
}

/** 健康检查：后端是否在线、支持哪些方法 */
export async function checkBackend(
  baseUrl: string = DEFAULT_BACKEND_URL
): Promise<{ ok: boolean; info?: Record<string, unknown> }> {
  try {
    const res = await fetch(normalize(baseUrl) + '/health', { method: 'GET' });
    if (!res.ok) return { ok: false };
    return { ok: true, info: (await res.json()) as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/**
 * 调用后端做分离，返回分离后的音频 Blob（WAV）。
 * 失败时抛出带中文说明的错误，便于界面直接展示。
 */
export async function separateViaBackend(
  file: Blob,
  opts: SeparateOptions = {},
  onProgress?: (progress: number, message: string) => void
): Promise<Blob> {
  const base = normalize(opts.baseUrl || DEFAULT_BACKEND_URL);
  const mode: SeparateMode = opts.mode || 'vocal';
  const method: SeparateMethod = opts.method || 'center';

  onProgress?.(0.02, '解码音频（保留立体声）...');
  const { channels, sampleRate } = await decodeChannels(file);

  onProgress?.(0.08, '打包 WAV...');
  const wav = encodeWav(channels, sampleRate);

  onProgress?.(0.12, `请求后端分离（${mode === 'vocal' ? '人声' : '伴奏'}）...`);
  let res: Response;
  try {
    res = await fetch(`${base}/separate?mode=${mode}&method=${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
    });
  } catch (err) {
    throw new Error(
      `无法连接分离后端（${base}）。请先双击 backend/启动后端.bat 启动服务。` +
        (err instanceof Error ? ` ${err.message}` : '')
    );
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j && j.error) msg = j.error;
    } catch {
      /* 忽略非 JSON 响应 */
    }
    throw new Error(`分离失败: ${msg}`);
  }

  const out = await res.blob();
  onProgress?.(0.2, '分离完成');
  return out;
}
