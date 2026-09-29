/* ================================================================
 * 音色预设（AudioEngine 统一使用）
 * ----------------------------------------------------------------
 * 一个音色 = 若干叠加振荡器 + 包络 + 可选低通 / 颤音。
 *
 * 为什么需要这一层：
 *   原来 playNote 里写死单个 triangle 振荡器、8ms 起音、80ms 释音，
 *   且音符只发声 92% 时值 —— 连续音符之间必然留一条静音缝，
 *   听感就是"一个音一个音地断断续续"。现在：
 *     1) 包络统一为 attack → decay → sustain → release；
 *     2) 发音用完整时值，release 允许越过音符结束点与下一个音重叠
 *        （连奏 legato），缝隙消失；
 *     3) 音色可切换，便于按用途挑（钢琴 / 弦乐 / 人声感 / 8-bit ...）。
 * ================================================================ */

export interface TimbreSpec {
  /** 显示名 */
  name: string;
  /** 叠加的振荡器成分 */
  oscs: { type: OscillatorType; gain: number; detune?: number; octave?: number }[];
  /** 起音秒 */
  attack: number;
  /** 衰减到 sustain 电平所需秒数（0 = 不衰减） */
  decay: number;
  /** 持续段电平（相对峰值，0~1；仅 decay>0 时生效） */
  sustain: number;
  /** 释音秒（允许越过音符结束点，形成连奏） */
  release: number;
  /** 可选低通截止（Hz） */
  lowpass?: number;
  /** 可选颤音 */
  vibrato?: { rate: number; depthCents: number };
  /** 峰值（避免削波，多振荡器音色取小值） */
  level: number;
}

export const TIMBRES: Record<string, TimbreSpec> = {
  /* 默认：与改造前行为最接近，保证简谱视图听感不突变 */
  triangle: {
    name: '三角波（默认）',
    oscs: [{ type: 'triangle', gain: 1 }],
    attack: 0.008, decay: 0, sustain: 1, release: 0.09, level: 0.5,
  },

  /* 钢琴感：高次谐波快速衰减 */
  piano: {
    name: '钢琴',
    oscs: [
      { type: 'triangle', gain: 1 },
      { type: 'sine', gain: 0.55, octave: 1 },
      { type: 'sine', gain: 0.22, octave: 2 },
    ],
    attack: 0.004, decay: 0.9, sustain: 0.18, release: 0.22, level: 0.5,
  },

  /* 电钢：带轻微颤音，柔和 */
  epiano: {
    name: '电钢',
    oscs: [
      { type: 'sine', gain: 1 },
      { type: 'sine', gain: 0.35, octave: 1 },
    ],
    attack: 0.006, decay: 0.6, sustain: 0.3, release: 0.24,
    vibrato: { rate: 5.2, depthCents: 10 }, level: 0.55,
  },

  /* 弦乐：慢起音 + 失谐叠加 + 低通，最适合听"连贯" */
  strings: {
    name: '弦乐（连奏）',
    oscs: [
      { type: 'sawtooth', gain: 0.6 },
      { type: 'sawtooth', gain: 0.45, detune: 9 },
      { type: 'sawtooth', gain: 0.45, detune: -9 },
    ],
    attack: 0.09, decay: 0, sustain: 1, release: 0.28,
    lowpass: 2600, vibrato: { rate: 5, depthCents: 7 }, level: 0.26,
  },

  /* 人声感（"啊"）：正弦 + 谐波 + 低通 + 颤音，预览人力V最接近成品 */
  vocal: {
    name: '人声感（啊）',
    oscs: [
      { type: 'sine', gain: 1 },
      { type: 'sine', gain: 0.32, octave: 1 },
      { type: 'triangle', gain: 0.18 },
    ],
    attack: 0.05, decay: 0, sustain: 1, release: 0.14,
    lowpass: 1900, vibrato: { rate: 5.6, depthCents: 16 }, level: 0.42,
  },

  /* 纯净正弦：对音高最直观 */
  sine: {
    name: '正弦（纯净）',
    oscs: [{ type: 'sine', gain: 1 }],
    attack: 0.01, decay: 0, sustain: 1, release: 0.1, level: 0.55,
  },

  /* 管风琴：持续平稳 */
  organ: {
    name: '管风琴',
    oscs: [
      { type: 'sine', gain: 1 },
      { type: 'sine', gain: 0.55, octave: 1 },
      { type: 'sine', gain: 0.3, octave: 2 },
    ],
    attack: 0.012, decay: 0, sustain: 1, release: 0.1, level: 0.4,
  },

  /* 8-bit 方波：鬼畜区常用 */
  square8: {
    name: '8-bit 方波',
    oscs: [{ type: 'square', gain: 0.5 }],
    attack: 0.002, decay: 0, sustain: 1, release: 0.05, level: 0.3,
  },
};

export const DEFAULT_TIMBRE = 'triangle';

/** 音色下拉列表（顺序即界面顺序） */
export const TIMBRE_LIST = Object.entries(TIMBRES).map(([id, spec]) => ({
  id,
  name: spec.name,
}));

/** 取音色；未知 id 回退默认，避免旧存档里的 id 让播放变哑 */
export function getTimbre(id: string | undefined): TimbreSpec {
  if (id && TIMBRES[id]) return TIMBRES[id];
  return TIMBRES[DEFAULT_TIMBRE];
}
