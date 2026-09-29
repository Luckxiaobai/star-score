// 简谱核心数据模型

/** 音高: 0=休止, 1-7=do re mi fa sol la si */
export type Pitch = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** 音符时值 */
export type Duration = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth' | 'thirtysecond';

/** 变音记号 */
export type Accidental = 'none' | 'sharp' | 'flat' | 'natural';

/** 连音线 */
export type TieType = 'none' | 'start' | 'continue' | 'end';

/** 单个音符 */
export interface Note {
  id: string;
  pitch: Pitch;
  octave: number;       // -2 ~ 2, 0 = 中音区
  duration: Duration;
  dotted: boolean;       // 附点
  accidental: Accidental;
  tie: TieType;
  lyric?: string;        // 歌词
  chord?: string;        // 和弦名
  fingering?: string;    // 指法
}

/** 小节 */
export interface Measure {
  id: string;
  notes: Note[];
  barline: BarlineType;
}

export type BarlineType = 'single' | 'double' | 'final' | 'repeat-start' | 'repeat-end' | 'repeat-both';

/** 谱面元数据 */
export interface ScoreMetadata {
  title: string;
  artist: string;
  key: string;           // "1=C"
  timeNumerator: number;  // 拍号分子
  timeDenominator: number; // 拍号分母
  tempo: number;          // BPM
  style: string;          // 风格
}

/** 完整谱面 */
export interface Score {
  metadata: ScoreMetadata;
  measures: Measure[];
}

/** 时值对应的拍数 (以四分音符为1拍) */
export const DURATION_BEATS: Record<Duration, number> = {
  'whole': 4,
  'half': 2,
  'quarter': 1,
  'eighth': 0.5,
  'sixteenth': 0.25,
  'thirtysecond': 0.125,
};

/** 时值对应的下划线数 */
export const DURATION_UNDERLINES: Record<Duration, number> = {
  'whole': 0,
  'half': 0,
  'quarter': 0,
  'eighth': 1,
  'sixteenth': 2,
  'thirtysecond': 3,
};

/** 音名映射 */
export const PITCH_NAMES: Record<number, string> = {
  0: '0',
  1: '1',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
};

/** do re mi fa sol la si 对应的半音数 (C大调) */
export const PITCH_SEMITONES: Record<number, number> = {
  1: 0,   // C
  2: 2,   // D
  3: 4,   // E
  4: 5,   // F
  5: 7,   // G
  6: 9,   // A
  7: 11,  // B
};

/** 调号列表 */
export const KEYS = [
  '1=C', '1=#C', '1=D', '1=bE', '1=E', '1=F', '1=#F', '1=G', '1=bA', '1=A', '1=bB', '1=B',
];

/** 调号对应的半音偏移 (相对于C) */
export const KEY_SEMITONES: Record<string, number> = {
  '1=C': 0, '1=#C': 1, '1=D': 2, '1=bE': 3, '1=E': 4, '1=F': 5,
  '1=#F': 6, '1=G': 7, '1=bA': 8, '1=A': 9, '1=bB': 10, '1=B': 11,
  '1=bD': 1, '1=#D': 3, '1=bG': 6, '1=#G': 8,
};

/** 生成唯一ID */
export function genId(): string {
  return Math.random().toString(36).slice(2, 11);
}

/** 创建默认音符 */
export function createNote(pitch: Pitch = 0, duration: Duration = 'quarter'): Note {
  return {
    id: genId(),
    pitch,
    octave: 0,
    duration,
    dotted: false,
    accidental: 'none',
    tie: 'none',
  };
}

/** 创建默认小节 */
export function createMeasure(): Measure {
  return {
    id: genId(),
    notes: [],
    barline: 'single',
  };
}

/** 创建空谱面 */
export function createEmptyScore(): Score {
  return {
    metadata: {
      title: '未命名曲谱',
      artist: '',
      key: '1=C',
      timeNumerator: 4,
      timeDenominator: 4,
      tempo: 90,
      style: '',
    },
    measures: [createMeasure()],
  };
}
