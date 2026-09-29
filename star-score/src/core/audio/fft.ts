// 基础 FFT 工具：为 YIN 自相关与谱通量提供 O(n log n) 支持
// 只依赖 TypedArray，无第三方库。

/** 下一个 2 的幂 */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** 原地基-2 FFT（长度必须是 2 的幂） */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = i + k + half;
        const vRe = re[b] * curRe - im[b] * curIm;
        const vIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - vRe;
        im[b] = im[a] - vIm;
        re[a] += vRe;
        im[a] += vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/** 原地逆 FFT（含 1/n 缩放） */
export function ifftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fftInPlace(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= inv;
    im[i] = -im[i] * inv;
  }
}

/** Hann 窗 */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  const d = n > 1 ? n - 1 : 1;
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d);
  return w;
}

/** 计算幅度谱（Hann 加窗，返回前半谱） */
export function magnitudeSpectrum(frame: Float32Array, size: number): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const n = Math.min(frame.length, size);
  const d = n > 1 ? n - 1 : 1;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d);
    re[i] = frame[i] * w;
  }
  fftInPlace(re, im);
  const half = size >> 1;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  return mag;
}
