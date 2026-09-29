/* ================================================================
 * 星谱识音 · HOMR 引擎适配器
 * ----------------------------------------------------------------
 * 封装 HOMR (Homer's Optical Music Recognition) 后端推理。
 *
 * 特点：
 *   - 输入为乐谱**图片**（非音频），是独立的输入维度
 *   - Vision Transformer + UNet 分割
 *   - 输出 MusicXML，需解析为简谱格式
 *   - 需要后端服务（ONNX 推理）
 *
 * 后端 API：
 *   POST /api/homr/recognize
 *   - 上传图片文件
 *   - 返回 JSON: { measures: [{ notes: [...] }], key, timeSignature, tempo }
 *
 * 上游更新：
 *   - 替换后端 HOMR ONNX 模型文件即可
 *   - 上游 homr 版本更新通过 pip install --upgrade homr
 *   - 前端解析逻辑如 MusicXML 格式不变则无需改动
 * ================================================================ */

import type { AudioEngineAdapter, EngineResult, EngineCapabilities } from './types';
import type { DetectedNote } from '../segment';
import type { ProgressCallback } from '../decode';
import { midiToFreq } from '../track';

/** HOMR 后端响应格式（已解析为音符列表） */
interface HomrResponse {
  notes: {
    startTime: number;
    endTime: number;
    midi: number;
    confidence?: number;
  }[];
  duration: number;
  key?: string;
  timeSignature?: { numerator: number; denominator: number };
  tempo?: number;
}

export class HomrEngine implements AudioEngineAdapter {
  readonly id = 'homr';
  readonly name = 'HOMR';
  readonly version = '1.0.0';
  readonly capabilities: EngineCapabilities = {
    singingVoice: false,
    polyphonic: true,
    pitchBend: false,
    requiresBackend: true,
    browserNative: false,
    inputType: 'image',
  };

  /** 后端服务地址 */
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:9874') {
    this.baseUrl = baseUrl;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/homr/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      // 同 GAME：后端健康检查恒返回 200，需按 body 的 ok/available 判定
      if (!resp.ok) return false;
      const data = (await resp.json().catch(() => null)) as
        | { ok?: boolean; available?: boolean }
        | null;
      if (!data) return false;
      return Boolean(data.ok ?? data.available ?? false);
    } catch {
      return false;
    }
  }

  async analyze(
    image: Blob,
    onProgress?: ProgressCallback,
    _options?: Record<string, unknown>
  ): Promise<EngineResult> {
    onProgress?.(0.05, '上传乐谱图片到 HOMR 后端...');

    const formData = new FormData();
    formData.append('image', image);

    onProgress?.(0.15, 'HOMR 视觉 Transformer 识别中...');

    const resp = await fetch(`${this.baseUrl}/api/homr/recognize`, {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      throw new Error(`HOMR 后端错误: ${errText}`);
    }

    onProgress?.(0.85, '解析乐谱识别结果...');

    const data: HomrResponse = await resp.json();

    const notes: DetectedNote[] = data.notes.map((n) => ({
      startTime: n.startTime,
      endTime: n.endTime,
      midi: n.midi,
      frequency: midiToFreq(n.midi),
      confidence: n.confidence ?? 0.9,
    }));

    notes.sort((a, b) => a.startTime - b.startTime);

    return {
      notes,
      duration: data.duration,
      frameCount: notes.length,
      engineName: this.name,
      engineVersion: this.version,
    };
  }
}
