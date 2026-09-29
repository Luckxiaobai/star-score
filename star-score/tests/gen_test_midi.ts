/* 生成测试 MIDI：小星星片段 + 毛刺音符 + 被切碎的长音 */
import { midiToBytes } from '../src/core/midi/export';
import type { MidiDocument, MidiNote } from '../src/types/midiProject';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ppq = 480;
const bpm = 100;

// 音符助手
const q = (pitch: number, start: number): MidiNote => ({ id: '', pitch, startTick: start * ppq, durationTick: ppq, velocity: 90, enabled: true, track: 0 });
const h = (pitch: number, start: number): MidiNote => ({ id: '', pitch, startTick: start * ppq, durationTick: 2 * ppq, velocity: 90, enabled: true, track: 0 });

// 小星星主旋律（4/4，每拍一个音）
// 1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 -
const notes: MidiNote[] = [
  q(60, 0), q(60, 1), q(67, 2), q(67, 3),
  q(69, 4), q(69, 5), h(67, 6),
  q(65, 8), q(65, 9), q(63, 10), q(63, 11),
  q(62, 12), q(62, 13), h(60, 14),
];

// 加毛刺：极短音符（5 tick < 30）
notes.push({ id: '', pitch: 72, startTick: 100, durationTick: 5, velocity: 70, enabled: true, track: 0 });
notes.push({ id: '', pitch: 74, startTick: 2000, durationTick: 8, velocity: 70, enabled: true, track: 0 });

// 加被切碎的长音：G4 从 beat 18 开始本该 4 拍，被切成 3 段（间隙 5 tick）
const frag = (startTick: number): MidiNote => ({ id: '', pitch: 67, startTick, durationTick: 2 * ppq, velocity: 92, enabled: true, track: 0 });
notes.push(frag(18 * ppq));
notes.push(frag(20 * ppq + 5));
notes.push(frag(22 * ppq + 10));

notes.sort((a, b) => a.startTick - b.startTick);

const doc: MidiDocument = {
  time: { ppq, bpm, timeSignature: [4, 4] },
  notes,
  totalTicks: 24 * ppq,
  sourceFileName: 'test_twinkle.mid',
};

const outputPath = resolve(process.argv[2] ?? 'exports/test_twinkle.mid');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, Buffer.from(midiToBytes(doc)));
console.log(`written: ${outputPath}, ${notes.length} notes`);
