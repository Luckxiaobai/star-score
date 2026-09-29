/* ================================================================
 * 星谱识音 · Basic Pitch 引擎适配器
 * ----------------------------------------------------------------
 * 封装 Spotify Basic Pitch 神经网络，实现 AudioEngineAdapter 接口。
 *
 * 特点：
 *   - 浏览器端运行（TensorFlow.js），无需后端
 *   - 支持多音（polyphonic），通用乐器识别
 *   - 模型轻量（~900KB），加载快
 *   - 不专门针对歌声优化，但通用性好
 *
 * 上游更新：
 *   npm update @spotify/basic-pitch
 *   只需替换 public/models/basic-pitch/ 下的模型文件
 *   接口不变，此文件无需修改
 * ================================================================ */

import * as tf from '@tensorflow/tfjs';
import { BasicPitch, noteFramesToTime, addPitchBendsToNoteEvents, outputToNotesPoly } from '@spotify/basic-pitch';
import type { AudioEngineAdapter, EngineResult, EngineCapabilities } from './types';
import type { DetectedNote } from '../segment';
import type { ProgressCallback } from '../decode';
import { midiToFreq } from '../track';

/** 模型文件路径 */
const MODEL_PATH = `${import.meta.env.BASE_URL}models/basic-pitch/model.json`;

/** 单例模型缓存 */
let modelPromise: Promise<tf.GraphModel> | null = null;

/**
 * 用一个临时 AudioContext 把单声道 Float32 数据包装成 AudioBuffer。
 * 仅用于混合声道后交给 Basic Pitch，AudioBuffer 本身不依赖 ctx 生命周期。
 */
async function ctxMonoBuffer(mono: Float32Array, sampleRate: number): Promise<AudioBuffer> {
  const AudioCtx: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate });
  const buf = ctx.createBuffer(1, mono.length, sampleRate);
  const copy = new Float32Array(new ArrayBuffer(mono.length * 4));
  copy.set(mono);
  buf.copyToChannel(copy, 0);
  await ctx.close();
  return buf;
}

async function loadModel(): Promise<tf.GraphModel> {
  if (!modelPromise) {
    await tf.ready();
    modelPromise = tf.loadGraphModel(MODEL_PATH);
  }
  return modelPromise;
}

export class BasicPitchEngine implements AudioEngineAdapter {
  readonly id = 'basic-pitch';
  readonly name = 'Basic Pitch';
  readonly version = '1.0.1';
  readonly capabilities: EngineCapabilities = {
    singingVoice: false,
    polyphonic: true,
    pitchBend: true,
    requiresBackend: false,
    browserNative: true,
    inputType: 'audio',
  };

  async isAvailable(): Promise<boolean> {
    try {
      await loadModel();
      return true;
    } catch {
      return false;
    }
  }

  async preload(): Promise<void> {
    await loadModel();
  }

  async analyze(
    audio: Blob,
    onProgress?: ProgressCallback,
    _options?: Record<string, unknown>
  ): Promise<EngineResult> {
    onProgress?.(0.05, '加载 Basic Pitch 模型...');
    const model = await loadModel();

    onProgress?.(0.10, '解码音频...');
    // Basic Pitch 的 evaluateModel 要求传入 AudioBuffer，
    // 并读取 audioBuffer.sampleRate 校验必须为 22050Hz。
    // 直接用默认采样率的 AudioContext 解码会得到 48000Hz，
    // 从而报「Input audio buffer is not at correct sample rate! Is 48000. Should be 22050」。
    // 因此必须用 sampleRate: 22050 的 AudioContext 解码。
    const arrayBuffer = await audio.arrayBuffer();
    const AudioCtx: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx({ sampleRate: 22050 });
    let decodedBuffer: AudioBuffer;
    try {
      decodedBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch (err) {
      await ctx.close();
      throw new Error(`音频解码失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    await ctx.close();

    // Basic Pitch 要求单声道。立体声输入会报
    // 「Input audio buffer is not mono! Number of channels is 2. Should be 1」。
    // 这里显式混为单声道 AudioBuffer（22050Hz 单声道）。
    const channels = decodedBuffer.numberOfChannels;
    let audioBuffer = decodedBuffer;
    if (channels > 1) {
      onProgress?.(0.12, '混合为单声道...');
      const len = decodedBuffer.length;
      const mono = new Float32Array(len);
      for (let c = 0; c < channels; c++) {
        const data = decodedBuffer.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += data[i] / channels;
      }
      audioBuffer = await ctxMonoBuffer(mono, 22050);
    }

    const duration = audioBuffer.duration;

    onProgress?.(0.15, '模型就绪，开始推理...');

    const basicPitch = new BasicPitch(Promise.resolve(model));
    const allFrames: number[][] = [];
    const allOnsets: number[][] = [];
    const allContours: number[][] = [];

    await basicPitch.evaluateModel(
      audioBuffer,
      (frames: number[][], onsets: number[][], contours: number[][]) => {
        allFrames.push(...frames);
        allOnsets.push(...onsets);
        allContours.push(...contours);
      },
      (percent: number) => {
        onProgress?.(0.15 + percent * 0.7, `神经网络推理中... ${Math.round(percent * 100)}%`);
      }
    );

    onProgress?.(0.86, '后处理音符事件...');

    const notes = noteFramesToTime(
      addPitchBendsToNoteEvents(
        allContours,
        outputToNotesPoly(allFrames, allOnsets, 0.25, 0.25, 5)
      )
    );

    const detectedNotes: DetectedNote[] = notes.map((note) => ({
      startTime: note.startTimeSeconds,
      endTime: note.startTimeSeconds + note.durationSeconds,
      midi: note.pitchMidi,
      frequency: midiToFreq(note.pitchMidi),
      confidence: note.amplitude,
    }));

    detectedNotes.sort((a, b) => a.startTime - b.startTime);

    return {
      notes: detectedNotes,
      duration,
      frameCount: detectedNotes.length,
      engineName: this.name,
      engineVersion: this.version,
    };
  }
}

/** 将 Basic Pitch 音符转为兼容帧格式（供节拍/调号估计模块复用） */
export function basicPitchNotesToFrames(notes: DetectedNote[], sampleRate: number, hopSize = 512) {
  void sampleRate;
  void hopSize;
  return notes.map((note) => ({
    time: note.startTime,
    midi: note.midi,
    frequency: note.frequency,
    confidence: note.confidence,
    rms: 0.01,
    onset: 1,
  }));
}
