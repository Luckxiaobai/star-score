// 逐帧音高轨迹：YIN 基频 + 谱通量（起始强度）+ 中值滤波
import { yinDetect } from './pitch';
import { magnitudeSpectrum } from './fft';

export interface PitchFrame {
  /** 秒 */
  time: number;
  /** 基频 Hz，0 = 无音高 */
  frequency: number;
  /** MIDI 编号，0 = 无音高 */
  midi: number;
  /** 置信度 0-1 */
  confidence: number;
  /** 帧能量 */
  rms: number;
  /** 谱通量（正半部分），用于节拍估计 */
  onset: number;
}

export interface TrackOptions {
  frameSize?: number;
  hopSize?: number;
  fMin?: number;
  fMax?: number;
  fluxSize?: number;
}

export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * 逐帧检测音高，并附带能量与谱通量
 */
export function trackPitches(
  data: Float32Array,
  sampleRate: number,
  onProgress?: (progress: number, message: string) => void,
  opts: TrackOptions = {}
): PitchFrame[] {
  const frameSize = opts.frameSize ?? 2048;
  const hopSize = opts.hopSize ?? 512;
  const fMin = opts.fMin ?? 70;
  const fMax = opts.fMax ?? 1500;
  const fluxSize = opts.fluxSize ?? 1024;

  const numFrames = Math.max(0, Math.floor((data.length - frameSize) / hopSize) + 1);
  const frames: PitchFrame[] = [];
  let prevMag: Float64Array | null = null;

  for (let i = 0; i < numFrames; i++) {
    const start = i * hopSize;
    const frame = data.subarray(start, start + frameSize);
    const time = start / sampleRate;

    // 能量
    let rms = 0;
    for (let j = 0; j < frameSize; j++) rms += frame[j] * frame[j];
    rms = Math.sqrt(rms / frameSize);

    // 基频
    let frequency = 0;
    let confidence = 0;
    if (rms > 0.004) {
      const r = yinDetect(frame, sampleRate);
      if (r.frequency >= fMin && r.frequency <= fMax && r.confidence > 0.45) {
        frequency = r.frequency;
        confidence = r.confidence;
      }
    }
    const midi = frequency > 0 ? freqToMidi(frequency) : 0;

    // 谱通量
    const mag = magnitudeSpectrum(frame, fluxSize);
    let onset = 0;
    if (prevMag) {
      const len = Math.min(mag.length, prevMag.length);
      for (let k = 0; k < len; k++) {
        const diff = mag[k] - prevMag[k];
        if (diff > 0) onset += diff;
      }
      onset /= len;
    }
    prevMag = mag;

    frames.push({ time, frequency, midi, confidence, rms, onset });

    if (onProgress && i % 250 === 0 && numFrames > 0) {
      const pct = 0.22 + 0.45 * (i / numFrames);
      onProgress(pct, `检测音高... ${Math.round((i / numFrames) * 100)}%`);
    }
  }

  return frames;
}

/**
 * 中值滤波平滑音高轨迹（减少抖动导致的碎音符）
 * 只平滑已有音高的帧，不桥接无声间隙。
 */
export function medianFilterPitch(frames: PitchFrame[], window = 5): void {
  if (window < 3 || frames.length === 0) return;
  const half = window >> 1;
  const mids = frames.map((f) => f.midi);
  const buf: number[] = [];

  for (let i = 0; i < frames.length; i++) {
    if (mids[i] <= 0) continue; // 只平滑有音高的帧
    buf.length = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= frames.length) continue;
      if (mids[j] > 0) buf.push(mids[j]);
    }
    if (buf.length === 0) continue;
    buf.sort((a, b) => a - b);
    const med = buf[buf.length >> 1];
    frames[i].midi = med;
    frames[i].frequency = midiToFreq(med);
  }
}
