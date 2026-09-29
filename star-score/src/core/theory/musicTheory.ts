import type { Note, ScoreMetadata, Duration, Pitch, Accidental } from '../../types/score';
import { DURATION_BEATS, PITCH_SEMITONES, KEY_SEMITONES } from '../../types/score';

/** 变音记号半音偏移 */
const ACCIDENTAL_SEMITONES: Record<string, number> = {
  'none': 0,
  'sharp': 1,
  'flat': -1,
  'natural': 0,
};

/** 计算音符的MIDI编号 */
export function noteToMidi(note: Note, metadata: ScoreMetadata): number {
  if (note.pitch === 0) return 0; // 休止符不发音

  const keyOffset = KEY_SEMITONES[metadata.key] ?? 0;
  const baseMidi = 60 + keyOffset; // C4 = 60
  const pitchSemitones = PITCH_SEMITONES[note.pitch] ?? 0;
  const accidentalSemitones = ACCIDENTAL_SEMITONES[note.accidental] ?? 0;
  const octaveSemitones = note.octave * 12;

  return baseMidi + pitchSemitones + accidentalSemitones + octaveSemitones;
}

/** MIDI编号转频率 */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 获取音符频率 */
export function noteToFreq(note: Note, metadata: ScoreMetadata): number {
  return midiToFreq(noteToMidi(note, metadata));
}

/** 获取音符持续秒数 */
export function noteDurationSeconds(note: Note, bpm: number): number {
  const beats = DURATION_BEATS[note.duration] ?? 1;
  const dottedMultiplier = note.dotted ? 1.5 : 1;
  const secondsPerBeat = 60 / bpm;
  return beats * dottedMultiplier * secondsPerBeat;
}

/** 计算小节总拍数 */
export function measureBeats(numerator: number, denominator: number): number {
  return numerator * (4 / denominator);
}

/** 获取小节中音符占用的拍数 */
export function notesBeats(notes: Note[]): number {
  return notes.reduce((sum, n) => {
    const beats = DURATION_BEATS[n.duration] ?? 1;
    return sum + beats * (n.dotted ? 1.5 : 1);
  }, 0);
}

/** 判断小节是否满拍 */
export function isMeasureFull(notes: Note[], numerator: number, denominator: number): boolean {
  return Math.abs(notesBeats(notes) - measureBeats(numerator, denominator)) < 0.01;
}

/** 移调: 将所有音符移调n个半音 */
export function transposeNote(note: Note, semitones: number): Note {
  if (note.pitch === 0) return note;

  // 计算当前音在C大调音阶中的位置
  // 移调后的半音偏移
  const newSemitones = PITCH_SEMITONES[note.pitch] + semitones;
  // 归一化到0-11
  let normalized = ((newSemitones % 12) + 12) % 12;

  // 映射回1-7 (最接近的自然音)
  const semitoneToPitch: Record<number, number> = {
    0: 1, 2: 2, 4: 3, 5: 4, 7: 5, 9: 6, 11: 7,
  };

  let newPitch: Pitch = note.pitch;
  let newOctave = note.octave;
  let newAccidental: Accidental = note.accidental;

  if (semitoneToPitch[normalized] !== undefined) {
    newPitch = semitoneToPitch[normalized] as Pitch;
    newAccidental = 'none';
  } else {
    // 偏音: 用升号表示
    newPitch = (semitoneToPitch[(normalized - 1 + 12) % 12] ?? 1) as Pitch;
    newAccidental = 'sharp';
  }

  // 计算八度变化
  const newSemitonesTotal = PITCH_SEMITONES[note.pitch] + (note.accidental === 'sharp' ? 1 : note.accidental === 'flat' ? -1 : 0) + note.octave * 12;
  const newMidiOffset = PITCH_SEMITONES[newPitch] + (newAccidental === 'sharp' ? 1 : 0);
  const octaveDiff = Math.floor((newSemitonesTotal - newMidiOffset) / 12);
  newOctave = note.octave + octaveDiff;

  return {
    ...note,
    pitch: newPitch,
    octave: newOctave,
    accidental: newAccidental,
  };
}

/** 时值列表 (用于选择器) */
export const DURATION_LIST: Duration[] = ['whole', 'half', 'quarter', 'eighth', 'sixteenth', 'thirtysecond'];

/** 时值显示名称 */
export const DURATION_LABELS: Record<Duration, string> = {
  'whole': '全音符',
  'half': '二分音符',
  'quarter': '四分音符',
  'eighth': '八分音符',
  'sixteenth': '十六分音符',
  'thirtysecond': '三十二分音符',
};

/** 时值切换: 更短 */
export function shorterDuration(d: Duration): Duration {
  const order: Duration[] = ['whole', 'half', 'quarter', 'eighth', 'sixteenth', 'thirtysecond'];
  const idx = order.indexOf(d);
  return order[Math.min(idx + 1, order.length - 1)];
}

/** 时值切换: 更长 */
export function longerDuration(d: Duration): Duration {
  const order: Duration[] = ['whole', 'half', 'quarter', 'eighth', 'sixteenth', 'thirtysecond'];
  const idx = order.indexOf(d);
  return order[Math.max(idx - 1, 0)];
}
