/* ================================================================
 * 人力V工作台 · MIDI 工程数据模型
 * ----------------------------------------------------------------
 * 对齐《核心契约 v0.3.1》核心字段（前端子集）：
 *   - tick ↔ 秒 强制换算公式（全模块统一调用，禁止自行实现）
 *   - note_id：内容派生稳定 ID（blake2b 风格，此处用 FNV-1a 32位
 *     兼顾浏览器性能，同一音符多次解析 ID 稳定）
 * ================================================================ */

/** 单个 MIDI 音符（契约 notes[] 的前端子集） */
export interface MidiNote {
  /** 内容派生稳定 ID：fnv1a(ppq|startTick|pitch|durationTick) 12位 hex */
  id: string;
  /** MIDI note number 0~127 */
  pitch: number;
  /** 起始 tick（相对曲首） */
  startTick: number;
  /** 时长 tick */
  durationTick: number;
  /** 力度 0~127 */
  velocity: number;
  /** 占位静音：保留时间位置，不生成音频 */
  enabled: boolean;
  /** 来源轨道 */
  track: number;
  /** 可选的歌词/音节标注；当前保存在浏览器草稿中 */
  lyric?: string;
}

/** 时间配置（契约 midi_config 前端子集） */
export interface MidiTimeConfig {
  /** pulses per quarter note */
  ppq: number;
  /** 全局 BPM（阶段1不支持变速 MIDI，取第一个 tempo 事件） */
  bpm: number;
  /** 拍号 [分子, 分母] */
  timeSignature: [number, number];
}

/** MIDI 工程文档 */
export interface MidiDocument {
  time: MidiTimeConfig;
  notes: MidiNote[];
  /** 工程总长度 tick */
  totalTicks: number;
  /** 原始文件名（提示用） */
  sourceFileName: string;
}

/** 清洗规则（契约 midi_config.clean_settings） */
export interface CleanSettings {
  /** 小于此 tick 的音符视为毛刺删除；默认 ppq/16 */
  minNoteTick: number;
  /** 相邻同音间隙 < 此 tick 才考虑合并；默认 ppq/32 */
  mergeGapTick: number;
  /** 前音尾部与后音头部力度差 < 此值才合并；默认 30 */
  velocityJumpThreshold: number;
}

/** 清洗报告 */
export interface CleanReport {
  deletedSpikes: string[];
  mergedPairs: [string, string][];
}

/* ================================================================
 * 强制换算公式（所有模块必须调用这里，禁止各自实现）
 * ================================================================ */

export function tickToSec(tick: number, ppq: number, bpm: number): number {
  return tick / ppq * (60.0 / bpm);
}

export function secToTick(sec: number, ppq: number, bpm: number): number {
  return Math.round(sec * ppq * bpm / 60.0);
}

/* ================================================================
 * 稳定 ID 生成（FNV-1a 32bit）
 * 同一音符（同 ppq/start/pitch/duration）在多次解析后 ID 稳定，
 * 工程保存 / 批量替换素材时可以用 ID 做引用。
 * ================================================================ */

export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function noteId(ppq: number, startTick: number, pitch: number, durationTick: number): string {
  return fnv1a(`${ppq}|${startTick}|${pitch}|${durationTick}`);
}

/** 默认清洗设置（契约默认值） */
export function defaultCleanSettings(ppq: number): CleanSettings {
  return {
    minNoteTick: Math.max(1, Math.round(ppq / 16)),
    mergeGapTick: Math.max(1, Math.round(ppq / 32)),
    velocityJumpThreshold: 30,
  };
}
