/* ================================================================
 * 星谱识音 · YIN 引擎适配器
 * ----------------------------------------------------------------
 * 封装传统 YIN 信号处理音高检测，实现 AudioEngineAdapter 接口。
 *
 * 特点：
 *   - 纯信号处理，无外部依赖，无模型文件
 *   - 永远可用（最后兜底引擎）
 *   - 单音检测（不支持多音）
 *   - 对噪声/伴奏敏感，准确率有限
 *
 * 适用场景：
 *   - Basic Pitch 模型加载失败时自动降级
 *   - 纯旋律/单音音频的快速识别
 * ================================================================ */

import type { AudioEngineAdapter, EngineResult, EngineCapabilities } from './types';
import type { DetectedNote } from '../segment';
import type { ProgressCallback } from '../decode';
import { decodeAudioFile } from '../decode';
import { trackPitches, medianFilterPitch } from '../track';
import { segmentNotes } from '../segment';

export class YinEngine implements AudioEngineAdapter {
  readonly id = 'yin';
  readonly name = 'YIN';
  readonly version = '1.0.0';
  readonly capabilities: EngineCapabilities = {
    singingVoice: false,
    polyphonic: false,
    pitchBend: false,
    requiresBackend: false,
    browserNative: true,
    inputType: 'audio',
  };

  async isAvailable(): Promise<boolean> {
    // YIN 纯信号处理，永远可用
    return true;
  }

  async analyze(
    audio: Blob,
    onProgress?: ProgressCallback,
    _options?: Record<string, unknown>
  ): Promise<EngineResult> {
    // 解码 + 降采样
    const { sampleRate, channelData, duration } = await decodeAudioFile(audio, onProgress);

    // 逐帧音高轨迹
    onProgress?.(0.22, '开始音高检测 (YIN)...');
    const hopSize = 512;
    const frames = trackPitches(channelData, sampleRate, onProgress, { hopSize });

    // 中值滤波平滑
    onProgress?.(0.68, '平滑音高轨迹...');
    medianFilterPitch(frames, 5);

    // 音符分割
    onProgress?.(0.72, '分割音符...');
    const hopSeconds = hopSize / sampleRate;
    const notes: DetectedNote[] = segmentNotes(frames, hopSeconds);

    return {
      notes,
      duration,
      frameCount: frames.length,
      engineName: this.name,
      engineVersion: this.version,
    };
  }
}
