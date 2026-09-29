/* ================================================================
 * 星谱识音 · 全链路转录引擎（准确度优先）
 * ----------------------------------------------------------------
 * 封装后端 /api/transcribe —— 一条请求完成：
 *   分离(Demucs/center) → GAME 歌声转录 → music21 专业后处理
 *
 * 这是「怕不准」场景下的首选引擎：短音符过滤、音域过滤、
 * 八度纠错、节拍/调号/和弦识别都在后端用 music21 完成，
 * 比纯浏览器端 YIN / Basic Pitch 输出干净一个量级。
 *
 * 优先级：transcribe > game > basic-pitch > yin
 * 需要：后端在线 + GAME 模型已下载（否则自动降级）
 * ================================================================ */

import type { AudioEngineAdapter, EngineResult, EngineCapabilities } from './types';
import type { DetectedNote } from '../segment';
import type { ProgressCallback } from '../decode';
import { midiToFreq } from '../track';

/** 后端 /api/transcribe 响应格式 */
interface TranscribeResponse {
  notes: {
    startTime: number;
    endTime: number;
    midi: number;
    confidence?: number;
  }[];
  duration: number;
  tempo?: number;
  key?: string;
  chords?: { time: number; chord: string }[];
  engine?: string;
  separate?: string;
  noteCount?: number;
  filtered?: number;
}

export class TranscribeEngine implements AudioEngineAdapter {
  readonly id = 'transcribe';
  readonly name = '全链路(GAME+music21)';
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

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  async isAvailable(): Promise<boolean> {
    // 与 GAME 健康检查一致：后端在线且 GAME 模型已下载才可用
    try {
      const resp = await fetch(`${this.baseUrl}/api/game/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
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
    onProgress?.(0.05, '上传音频到全链路后端...');

    const formData = new FormData();
    formData.append('audio', audio);
    // separate: demucs(最准) / center / none —— 由前端分析选项决定
    formData.append('separate', String(options?.separate ?? 'demucs'));
    formData.append('mode', String(options?.mode ?? 'vocal'));
    formData.append('language', String(options?.language ?? 'zh'));
    formData.append('range', String(options?.range ?? 'auto'));
    formData.append('minDuration', String(options?.minDuration ?? 0.08));
    formData.append('confidence', String(options?.confidence ?? 0));
    formData.append('musicXml', String(options?.musicXml ? '1' : '0'));

    onProgress?.(0.15, '全链路推理中(分离→GAME→music21)...');

    const resp = await fetch(`${this.baseUrl}/api/transcribe`, {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const err = (await resp.json().catch(() => null)) as { error?: string } | null;
      throw new Error(
        `全链路转录失败: ${err?.error ?? resp.statusText}（请检查后端与 GAME 模型）`
      );
    }

    onProgress?.(0.9, '解析识别结果...');

    const data: TranscribeResponse = await resp.json();

    const notes: DetectedNote[] = (data.notes ?? []).map((n) => ({
      startTime: n.startTime,
      endTime: n.endTime,
      midi: n.midi,
      frequency: midiToFreq(n.midi),
      confidence: n.confidence ?? 0.9,
    }));

    notes.sort((a, b) => a.startTime - b.startTime);

    onProgress?.(1, '分析完成!');

    return {
      notes,
      duration: data.duration,
      frameCount: notes.length,
      engineName: this.name,
      engineVersion: this.version,
    };
  }
}
