// 调号估计：Krumhansl-Schmuckler 调性轮廓相关法
import type { DetectedNote } from './segment';

// Krumhansl-Kessler 调性轮廓（大调 / 小调）
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const KEY_NAMES = ['C', '#C', 'D', 'bE', 'E', 'F', '#F', 'G', 'bA', 'A', 'bB', 'B'];

export interface KeyResult {
  key: string;
  confidence: number;
  isMinor: boolean;
}

function correlate(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

/** 用音级时长分布 + 调性轮廓相关度判断调号 */
export function estimateKey(notes: DetectedNote[]): KeyResult {
  const chroma = new Array(12).fill(0) as number[];
  for (const note of notes) {
    const pc = ((Math.round(note.midi) % 12) + 12) % 12;
    const dur = Math.max(0.01, note.endTime - note.startTime);
    chroma[pc] += dur;
  }
  const total = chroma.reduce((a, b) => a + b, 0);
  if (total <= 0) return { key: '1=C', confidence: 0, isMinor: false };

  let bestKey = '1=C';
  let bestScore = -Infinity;
  let bestMinor = false;

  for (let root = 0; root < 12; root++) {
    const majorRot = MAJOR_PROFILE.map((_, i) => MAJOR_PROFILE[(i - root + 12) % 12]);
    const minorRot = MINOR_PROFILE.map((_, i) => MINOR_PROFILE[(i - root + 12) % 12]);
    const sm = correlate(chroma, majorRot);
    const sn = correlate(chroma, minorRot);
    if (sm > bestScore) {
      bestScore = sm;
      bestKey = `1=${KEY_NAMES[root]}`;
      bestMinor = false;
    }
    if (sn > bestScore) {
      bestScore = sn;
      bestKey = `1=${KEY_NAMES[root]}`;
      bestMinor = true;
    }
  }

  return { key: bestKey, confidence: Math.max(0, bestScore), isMinor: bestMinor };
}
