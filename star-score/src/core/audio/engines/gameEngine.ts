/* ================================================================
 * 星谱识音 · GAME 引擎适配器
 * ----------------------------------------------------------------
 * 封装 OpenVPI GAME (Generative Adaptive MIDI Extractor) 后端推理。
 *
 * 特点：
 *   - 专为歌声设计，D3PM 离散扩散模型
 *   - 噪声/混响增强训练，抗干扰能力强
 *   - 输出浮点音高（连续 MIDI 值），精度高
 *   - 支持中文/日文/英文等语言条件
 *   - 需要后端服务（ONNX 推理）
 *
 * 后端 API：
 *   POST /api/game/extract
 *   - 上传音频文件
 *   - 返回 JSON: { notes: [{startTime, endTime, midi, frequency, confidence}], ... }
 *
 * 上游更新：
 *   - 替换后端 GAME ONNX 模型文件即可
 *   - 如 ONNX 接口结构变化，只需更新此文件的解析逻辑
 *   - 前端业务代码和接口不变
 * ================================================================ */

import type { AudioEngineAdapter, EngineResult, EngineCapabilities } from './types';
import type { DetectedNote } from '../segment';
import type { ProgressCallback } from '../decode';
import { midiToFreq } from '../track';

/** GAME 后端响应格式 */
interface GameResponse {
  notes: {
    startTime: number;
    endTime: number;
    midi: number;
    confidence?: number;
  }[];
  duration: number;
  frameCount?: number;
  language?: string;
}

export class GameEngine implements AudioEngineAdapter {
  readonly id = 'game';
  readonly name = 'GAME';
  readonly version = '1.0.0';
  readonly capabilities: EngineCapabilities = {
    singingVoice: true,
    polyphonic: false,
    pitchBend: true,
    requiresBackend: true,
    browserNative: false,
    inputType: 'audio',
  };

  /** 后端服务地址（运行时可配置） */
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:9874') {
    this.baseUrl = baseUrl;
  }

  /** 更新后端地址 */
  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/game/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      // 后端 /api/game/health 恒返回 HTTP 200，必须读 body 里的
      // ok / available 字段，否则模型缺失时会被误判为「可用」，
      // 进而在 /api/game/extract 报「GAME 模型未找到」。
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
    audio: Blob,
    onProgress?: ProgressCallback,
    options?: Record<string, unknown>
  ): Promise<EngineResult> {
    onProgress?.(0.05, '上传音频到 GAME 后端...');

    const formData = new FormData();
    formData.append('audio', audio);

    // 传递语言参数（默认中文，可提升中文歌曲识别精度）
    const language = (options?.language as string) ?? 'zh';
    formData.append('language', language);

    onProgress?.(0.15, 'GAME 神经网络推理中...');

    const resp = await fetch(`${this.baseUrl}/api/game/extract`, {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      throw new Error(`GAME 后端错误: ${errText}`);
    }

    onProgress?.(0.85, '解析 GAME 识别结果...');

    const data: GameResponse = await resp.json();

    // 转换为内部格式
    const notes: DetectedNote[] = data.notes.map((n) => ({
      startTime: n.startTime,
      endTime: n.endTime,
      midi: n.midi,
      frequency: midiToFreq(n.midi),
      confidence: n.confidence ?? 0.8,
    }));

    notes.sort((a, b) => a.startTime - b.startTime);

    return {
      notes,
      duration: data.duration,
      frameCount: data.frameCount ?? notes.length,
      engineName: this.name,
      engineVersion: this.version,
    };
  }
}
