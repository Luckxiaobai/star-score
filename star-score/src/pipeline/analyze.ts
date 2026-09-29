/* ================================================================
 * 星谱识音 · 音频分析流水线
 * ----------------------------------------------------------------
 * 职责：引擎调度 → 节拍估计 → 调号估计 → 简谱生成
 *
 * 架构变更（v2）：
 *   旧版：直接调用 YIN / Basic Pitch
 *   新版：通过引擎管理器自动选择最佳引擎
 *   - 引擎选择逻辑封装在 engines/index.ts
 *   - 本文件只负责"拿到音符后怎么处理"
 *
 * 目录：
 *   [IMPORTS]     导入
 *   [TYPES]       类型定义
 *   [QUANTIZE]    时值量化
 *   [CONVERT]     检测结果 → 简谱
 *   [ANALYZE]     主分析函数
 * ================================================================ */

/* [IMPORTS] 导入 */
import type { Score, Note, Measure, Pitch, Duration } from '../types/score';
import { createNote, createMeasure, DURATION_BEATS, KEY_SEMITONES } from '../types/score';
import type { ProgressCallback } from '../core/audio/decode';
import { separateViaBackend, type SeparateMode, type SeparateMethod } from '../core/audio/separate';
import { estimateTempo } from '../core/audio/tempo';
import { estimateKey } from '../core/audio/key';
import { analyzeAudioWithBestEngine } from '../core/audio/engines';

export type { DetectedNote } from '../core/audio/segment';
export { freqToMidi } from '../core/audio/track';
export type { ProgressCallback } from '../core/audio/decode';
export { preloadEngines, checkEngineStatus, setBackendUrl } from '../core/audio/engines';

export interface AnalysisResult {
  notes: import('../core/audio/segment').DetectedNote[];
  estimatedTempo: number;
  estimatedKey: string;
  keyConfidence: number;
  tempoConfidence: number;
  isMinor: boolean;
  duration: number;
  frameCount: number;
  /** 使用的引擎 ID */
  engineId: string;
}

/* [QUANTIZE] 时值量化表 */
const QUANT: { beats: number; duration: Duration; dotted: boolean }[] = [
  { beats: 0.125, duration: 'thirtysecond', dotted: false },
  { beats: 0.25, duration: 'sixteenth', dotted: false },
  { beats: 0.375, duration: 'sixteenth', dotted: true },
  { beats: 0.5, duration: 'eighth', dotted: false },
  { beats: 0.75, duration: 'eighth', dotted: true },
  { beats: 1, duration: 'quarter', dotted: false },
  { beats: 1.5, duration: 'quarter', dotted: true },
  { beats: 2, duration: 'half', dotted: false },
  { beats: 3, duration: 'half', dotted: true },
  { beats: 4, duration: 'whole', dotted: false },
];

const DEFAULT_QUANT = QUANT[5];

function quantizeBeats(beats: number): { beats: number; duration: Duration; dotted: boolean } {
  const b = Math.max(0.06, beats);
  let best = DEFAULT_QUANT;
  let bestD = Infinity;
  const lb = Math.log2(b);
  for (const q of QUANT) {
    const d = Math.abs(lb - Math.log2(q.beats));
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

const SEMI_TO_PITCH: Record<number, Pitch> = { 0: 1, 2: 2, 4: 3, 5: 4, 7: 5, 9: 6, 11: 7 };

/* [CONVERT] 检测结果 → 简谱 */

export function convertToScore(
  notes: import('../core/audio/segment').DetectedNote[],
  tempo: number,
  key: string,
  timeNumerator = 4,
  timeDenominator = 4
): Score {
  const secondsPerBeat = 60 / tempo;
  const beatsPerMeasure = timeNumerator * (4 / timeDenominator);
  const keyOffset = KEY_SEMITONES[key] ?? 0;

  const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);
  const measures: Measure[] = [];
  let cur = createMeasure();
  let curBeats = 0;
  let prevEnd = 0;

  const makeRest = (beats: number): { note: Note; beats: number } => {
    const q = quantizeBeats(beats);
    const n = createNote(0, q.duration);
    n.dotted = q.dotted;
    return { note: n, beats: q.beats };
  };

  const closeMeasure = (final = false) => {
    const rem = beatsPerMeasure - curBeats;
    if (rem > 0.12) { const r = makeRest(rem); cur.notes.push(r.note); curBeats += r.beats; }
    if (final) cur.barline = 'final';
    measures.push(cur);
    cur = createMeasure();
    curBeats = 0;
  };

  const appendNote = (n: Note) => {
    const nb = DURATION_BEATS[n.duration] * (n.dotted ? 1.5 : 1);
    if (curBeats + nb > beatsPerMeasure + 1e-6 && cur.notes.length > 0) closeMeasure();
    cur.notes.push(n);
    curBeats += nb;
    if (curBeats >= beatsPerMeasure - 1e-6) closeMeasure();
  };

  for (const det of sorted) {
    const gap = det.startTime - prevEnd;
    if (gap > 0.5 * secondsPerBeat) {
      let restBeats = gap / secondsPerBeat;
      let guard = 0;
      while (restBeats > 0.12 && guard++ < 64) { const r = makeRest(restBeats); appendNote(r.note); restBeats -= r.beats; }
    }
    prevEnd = Math.max(prevEnd, det.endTime);

    const midi = Math.round(det.midi);
    const rel = midi - 60 - keyOffset;
    const pc = ((rel % 12) + 12) % 12;
    let pitch: Pitch;
    let accidental: Note['accidental'] = 'none';
    if (SEMI_TO_PITCH[pc] !== undefined) { pitch = SEMI_TO_PITCH[pc]; }
    else { pitch = SEMI_TO_PITCH[(pc - 1 + 12) % 12] ?? 1; accidental = 'sharp'; }
    const octave = Math.max(-2, Math.min(2, Math.floor(rel / 12)));

    const beats = (det.endTime - det.startTime) / secondsPerBeat;
    const q = quantizeBeats(beats);
    const note = createNote(pitch, q.duration);
    note.dotted = q.dotted;
    note.octave = octave;
    note.accidental = accidental;
    appendNote(note);
  }

  if (cur.notes.length > 0) closeMeasure(true);
  if (measures.length === 0) measures.push(createMeasure());

  return {
    metadata: { title: '音频识别结果', artist: '', key, timeNumerator, timeDenominator, tempo, style: '' },
    measures,
  };
}

/* [ANALYZE] 主分析函数 */

export interface AnalyzeOptions {
  separate?: { enabled: boolean; baseUrl?: string; mode?: SeparateMode; method?: SeparateMethod; };
  forceYIN?: boolean;
  language?: string;
}

/**
 * 完整音频分析流程
 * 引擎管理器自动选择最佳引擎，本函数负责后处理
 */
export async function analyzeAudio(
  file: Blob,
  onProgress?: ProgressCallback,
  options?: AnalyzeOptions
): Promise<{ score: Score; analysis: AnalysisResult }> {
  // 0. 分离协调：全链路引擎(transcribe)自带后端分离，直接透传；
  //    普通引擎才在这里做前端预分离。
  let source: Blob = file;
  const engineOptions: Record<string, unknown> = { language: options?.language };

  if (options?.separate?.enabled) {
    const method = options.separate.method ?? 'center';
    if (method === 'demucs') {
      // 交给全链路引擎的后端 Demucs（最准）
      engineOptions.separate = 'demucs';
      engineOptions.mode = options.separate.mode ?? 'vocal';
    } else {
      // center 中置提取仍在浏览器端做，然后引擎不再重复分离
      source = await separateViaBackend(file, {
        baseUrl: options.separate.baseUrl,
        mode: options.separate.mode,
        method: 'center',
      }, onProgress);
      engineOptions.separate = 'none';
    }
  } else {
    // 未显式开启分离：全链路引擎默认 demucs（准确度优先）
    engineOptions.separate = 'demucs';
    engineOptions.mode = options?.separate?.mode ?? 'vocal';
  }

  // 1. 引擎管理器自动选择引擎并分析
  const engineResult = await analyzeAudioWithBestEngine(source, onProgress, {
    language: options?.language,
    forceYIN: options?.forceYIN,
    engineOptions,
  });

  const { notes, duration, frameCount, engineId } = engineResult;

  // 2. 节拍估计
  onProgress?.(0.88, '估计节拍...');
  const hopSeconds = 512 / 22050;
  const frames = notes.map((n) => ({
    time: n.startTime, midi: n.midi, frequency: n.frequency,
    confidence: n.confidence, rms: 0.01, onset: 1,
  }));
  const { tempo, confidence: tempoConfidence } = estimateTempo(frames, hopSeconds);

  // 3. 调号估计
  onProgress?.(0.91, '估计调号...');
  const { key, confidence: keyConfidence, isMinor } = estimateKey(notes);

  // 4. 转简谱
  onProgress?.(0.92, '生成简谱...');
  const score = convertToScore(notes, tempo, key);
  onProgress?.(1, '分析完成!');

  return {
    score,
    analysis: {
      notes,
      estimatedTempo: tempo,
      estimatedKey: key,
      keyConfidence,
      tempoConfidence,
      isMinor,
      duration,
      frameCount,
      engineId,
    },
  };
}
