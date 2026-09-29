// YIN 音高检测（FFT 加速版）
// 参考: de Cheveigné & Kawahara (2002) "YIN, a fundamental frequency estimator"
//
// 原始 YIN 的差分函数是 O(N^2)，这里用 FFT 计算自相关，把单帧降到 O(N log N)。
// d(tau) = sum_{i=0}^{W-1} (x[i] - x[i+tau])^2
//        = P(0, W-tau) + P(tau, W) - 2 * r(tau)
// 其中 r(tau) 为线性自相关，可由 IFFT(|FFT(x)|^2) 得到。

import { fftInPlace, ifftInPlace, nextPow2 } from './fft';

export interface PitchResult {
  /** 基频 Hz；0 表示未检测到 */
  frequency: number;
  /** 置信度 0-1 */
  confidence: number;
}

// 复用的缓冲，减少 GC（按帧长缓存）
let cacheN = -1;
let bufRe: Float64Array = new Float64Array(0);
let bufIm: Float64Array = new Float64Array(0);
let bufCum: Float64Array = new Float64Array(0);

function ensureCache(n: number) {
  if (cacheN === n) return;
  cacheN = n;
  const m = nextPow2(2 * n);
  bufRe = new Float64Array(m);
  bufIm = new Float64Array(m);
  bufCum = new Float64Array(n + 1);
}

/**
 * 对单帧做 YIN 基频估计
 * @param frame 时域样本
 * @param sampleRate 采样率
 * @param threshold 绝对阈值（越小越严格）
 */
export function yinDetect(frame: Float32Array, sampleRate: number, threshold = 0.12): PitchResult {
  const n = frame.length;
  const half = n >> 1;
  if (half < 4) return { frequency: 0, confidence: 0 };

  ensureCache(n);
  const m = bufRe.length;
  const re = bufRe;
  const im = bufIm;

  // 清零 + 装入
  re.fill(0);
  im.fill(0);
  for (let i = 0; i < n; i++) re[i] = frame[i];

  // 自相关：IFFT(|FFT|^2)
  fftInPlace(re, im);
  for (let i = 0; i < m; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  ifftInPlace(re, im);

  // 累积平方和
  const cum = bufCum;
  cum[0] = 0;
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + frame[i] * frame[i];
  const totalPower = cum[n];
  if (totalPower < 1e-7) return { frequency: 0, confidence: 0 };

  // 差分函数 + 累积均值归一化（CMND）一步完成
  const dp = new Float64Array(half);
  dp[0] = 1;
  let running = 0;
  for (let tau = 1; tau < half; tau++) {
    const p0 = cum[n - tau];
    const p1 = totalPower - cum[tau];
    let d = p0 + p1 - 2 * re[tau];
    if (d < 0) d = 0;
    running += d;
    dp[tau] = running > 1e-12 ? (d * tau) / running : 1;
  }

  // 找第一个低于阈值的谷
  let tauEst = -1;
  for (let tau = 2; tau < half; tau++) {
    if (dp[tau] < threshold) {
      while (tau + 1 < half && dp[tau + 1] < dp[tau]) tau++;
      tauEst = tau;
      break;
    }
  }

  if (tauEst === -1) {
    // 退而求其次：全局最小，且不能太差
    let minV = Infinity;
    for (let tau = 2; tau < half; tau++) {
      if (dp[tau] < minV) {
        minV = dp[tau];
        tauEst = tau;
      }
    }
    if (tauEst === -1 || minV > 0.55) return { frequency: 0, confidence: 0 };
  }

  // 抛物线插值
  let betterTau = tauEst;
  const x0 = tauEst > 0 ? tauEst - 1 : tauEst;
  const x2 = tauEst + 1 < half ? tauEst + 1 : tauEst;
  if (x0 !== tauEst && x2 !== tauEst) {
    const s0 = dp[x0];
    const s1 = dp[tauEst];
    const s2 = dp[x2];
    const denom = 2 * (s0 - 2 * s1 + s2);
    if (Math.abs(denom) > 1e-12) betterTau = tauEst + (s0 - s2) / denom;
  }

  const frequency = sampleRate / betterTau;
  const confidence = Math.max(0, Math.min(1, 1 - dp[tauEst]));
  return { frequency, confidence };
}
