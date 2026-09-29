// 音符分割：把逐帧音高轨迹切成离散音符
import type { PitchFrame } from './track';

export interface DetectedNote {
  startTime: number;
  endTime: number;
  midi: number;
  frequency: number;
  confidence: number;
}

export interface SegmentOptions {
  /** 允许的最大静音间隙（帧），超过则断开音符 */
  maxGapFrames?: number;
  /** 音高变化容差（半音），超过则视为新音符 */
  pitchTolerance?: number;
  /** 最短音符时长（秒），更短的丢弃 */
  minDuration?: number;
}

export function segmentNotes(
  frames: PitchFrame[],
  hopSeconds: number,
  opts: SegmentOptions = {}
): DetectedNote[] {
  const maxGapFrames = opts.maxGapFrames ?? 4;
  const pitchTolerance = opts.pitchTolerance ?? 0.65;
  const minDuration = opts.minDuration ?? 0.08;

  const notes: DetectedNote[] = [];

  let startIdx = -1;
  let endIdx = -1;
  let midSum = 0;
  let midCount = 0;
  let freqSum = 0;
  let confSum = 0;
  let gap = 0;

  const flush = () => {
    if (startIdx < 0 || midCount === 0) {
      startIdx = -1;
      return;
    }
    const startTime = frames[startIdx].time;
    const endTime = frames[endIdx].time;
    if (endTime - startTime >= minDuration) {
      notes.push({
        startTime,
        endTime,
        midi: midSum / midCount,
        frequency: freqSum / midCount,
        confidence: confSum / midCount,
      });
    }
    startIdx = -1;
    endIdx = -1;
    midSum = 0;
    midCount = 0;
    freqSum = 0;
    confSum = 0;
  };

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];

    if (f.midi <= 0) {
      if (startIdx >= 0) {
        gap++;
        if (gap > maxGapFrames) {
          flush();
          gap = 0;
        }
      }
      continue;
    }

    if (startIdx < 0) {
      // 开始新音符
      startIdx = i;
      endIdx = i;
      midSum = f.midi;
      midCount = 1;
      freqSum = f.frequency;
      confSum = f.confidence;
      gap = 0;
      continue;
    }

    const ref = midSum / midCount;
    if (Math.abs(f.midi - ref) < pitchTolerance) {
      // 延续
      endIdx = i;
      midSum += f.midi;
      midCount++;
      freqSum += f.frequency;
      confSum += f.confidence;
      gap = 0;
    } else {
      // 音高跳变
      flush();
      startIdx = i;
      endIdx = i;
      midSum = f.midi;
      midCount = 1;
      freqSum = f.frequency;
      confSum = f.confidence;
      gap = 0;
    }
  }

  flush();
  // hopSeconds 用于将来扩展（如最小间隙的秒数换算），此处保留参数以保持接口稳定
  void hopSeconds;
  return notes;
}
