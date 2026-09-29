// 音频解码：文件 -> 单声道 PCM -> 降采样
// 目标采样率统一为 22050Hz，兼顾音高检测精度与运算量。

export interface DecodedAudio {
  /** 实际使用的采样率（降采样后） */
  sampleRate: number;
  /** 单声道 PCM */
  channelData: Float32Array;
  /** 秒 */
  duration: number;
  /** 原始采样率 */
  originalSampleRate: number;
  /** 声道数 */
  channels: number;
}

export type ProgressCallback = (progress: number, message: string) => void;

export const TARGET_SAMPLE_RATE = 22050;

/** 解码音频文件为单声道 PCM 并降采样 */
export async function decodeAudioFile(
  file: Blob,
  onProgress?: ProgressCallback,
  targetSampleRate: number = TARGET_SAMPLE_RATE
): Promise<DecodedAudio> {
  onProgress?.(0.03, '读取文件中...');
  const arrayBuffer = await file.arrayBuffer();
  onProgress?.(0.08, '解码音频中...');

  const AudioCtx: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  } catch (err) {
    await ctx.close();
    throw new Error(`音频解码失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  await ctx.close();
  onProgress?.(0.16, '混合声道...');

  // === 混合为单声道 ===
  const n = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;
  const mono = new Float32Array(n);
  if (channels === 1) {
    mono.set(audioBuffer.getChannelData(0));
  } else {
    for (let c = 0; c < channels; c++) {
      const d = audioBuffer.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / channels;
    }
  }

  // === 降采样（块平均，兼具低通抗混叠效果）===
  const originalSampleRate = audioBuffer.sampleRate;
  let sampleRate = originalSampleRate;
  let channelData: Float32Array = mono;

  if (originalSampleRate > targetSampleRate) {
    onProgress?.(0.19, '降采样...');
    const ratio = originalSampleRate / targetSampleRate;
    const outLen = Math.floor(n / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(n, Math.floor((i + 1) * ratio));
      let s = 0;
      let cnt = 0;
      for (let j = start; j < end; j++) {
        s += mono[j];
        cnt++;
      }
      out[i] = cnt > 0 ? s / cnt : 0;
    }
    channelData = out;
    sampleRate = targetSampleRate;
  }

  onProgress?.(0.22, '准备分析...');
  return {
    sampleRate,
    channelData,
    duration: audioBuffer.duration,
    originalSampleRate,
    channels,
  };
}

/** 解码为多声道 Float32（分离前处理用，保留原始声道与采样率） */
export async function decodeChannels(
  file: Blob
): Promise<{ channels: Float32Array[]; sampleRate: number; duration: number }> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  } catch (err) {
    await ctx.close();
    throw new Error(`音频解码失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  await ctx.close();

  const channels: Float32Array[] = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(new Float32Array(audioBuffer.getChannelData(c)));
  }
  return { channels, sampleRate: audioBuffer.sampleRate, duration: audioBuffer.duration };
}
