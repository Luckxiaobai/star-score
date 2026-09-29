// 节拍估计：基于起始强度包络的自相关，并做倍频/半频校正
import type { PitchFrame } from './track';

export interface TempoResult {
  tempo: number;
  confidence: number;
}

/**
 * 用谱通量包络的自相关估计 BPM
 * 比"音符间隔直方图"稳，对漏检/多检更鲁棒。
 */
export function estimateTempo(frames: PitchFrame[], hopSeconds: number): TempoResult {
  const n = frames.length;
  if (n < 16 || hopSeconds <= 0) return { tempo: 90, confidence: 0 };

  // 起始强度包络
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) env[i] = frames[i].onset;

  // 去均值
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  for (let i = 0; i < n; i++) env[i] -= mean;

  const minBpm = 50;
  const maxBpm = 220;
  const minLag = Math.max(1, Math.floor(60 / maxBpm / hopSeconds));
  const maxLag = Math.min(n - 2, Math.ceil(60 / minBpm / hopSeconds));
  if (maxLag <= minLag) return { tempo: 90, confidence: 0 };

  const acf = new Float64Array(maxLag + 2);
  let bestLag = -1;
  let bestVal = -Infinity;
  let meanAbs = 0;
  let cnt = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    const len = n - lag;
    for (let i = 0; i < len; i++) s += env[i] * env[i + lag];
    s /= len;
    acf[lag] = s;
    meanAbs += Math.abs(s);
    cnt++;
    if (s > bestVal) {
      bestVal = s;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestVal <= 0) return { tempo: 90, confidence: 0 };

  // 抛物线插值（亚帧精度）
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = acf[bestLag - 1];
    const y1 = acf[bestLag];
    const y2 = acf[bestLag + 1];
    const denom = 2 * (y0 - 2 * y1 + y2);
    if (Math.abs(denom) > 1e-12) lag = bestLag + (y0 - y2) / denom;
  }
  if (lag <= 0) lag = bestLag;

  let tempo = 60 / (lag * hopSeconds);

  // 倍频校正：归一到 70-160 的常见区间
  while (tempo < 70) tempo *= 2;
  while (tempo > 160) tempo /= 2;

  const avg = cnt > 0 ? meanAbs / cnt : 0;
  const confidence = avg > 0 ? Math.max(0, Math.min(1, bestVal / avg / 3)) : 0;

  return { tempo: Math.round(tempo), confidence };
}
