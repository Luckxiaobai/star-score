/* ================================================================
 * 人力V工作台 · MIDI 解析 & 清洗 冒烟测试
 * 运行：npx tsx tests/midi.test.ts
 * ================================================================ */

import { parseMidiFile } from '../src/core/midi/parse';
import { cleanMidi } from '../src/core/midi/clean';
import { tickToSec, secToTick, noteId } from '../src/types/midiProject';
import type { MidiDocument, MidiNote } from '../src/types/midiProject';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/* [1] 构造最小 MIDI 文件字节（2 个音符，120BPM，4/4） */
function buildTestMidi(): Uint8Array {
  const bytes: number[] = [];
  // Header
  bytes.push(0x4d, 0x54, 0x68, 0x64); // MThd
  bytes.push(0, 0, 0, 6);             // length 6
  bytes.push(0, 0);                   // format 0
  bytes.push(0, 1);                   // 1 track
  bytes.push(0x01, 0xe0);             // division = 480

  // Track data
  const track: number[] = [];
  const ev = (...d: number[]) => track.push(...d);

  // delta 0, tempo = 500000 us/qn (120 BPM)
  ev(0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);
  // delta 0, time sig 4/4
  ev(0, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);
  // delta 0, Note On C4(60) vel 100
  ev(0, 0x90, 0x3c, 0x64);
  // delta 480, Note Off C4
  ev(0x83, 0x60, 0x80, 0x3c, 0x00);
  // delta 0, Note On E4(64) vel 90
  ev(0, 0x90, 0x40, 0x5a);
  // delta 480, Note Off E4
  ev(0x83, 0x60, 0x80, 0x40, 0x00);
  // delta 0, End of Track
  ev(0, 0xff, 0x2f, 0x00);

  bytes.push(0x4d, 0x54, 0x72, 0x6b); // MTrk
  const len = track.length;
  bytes.push((len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  bytes.push(...track);

  return new Uint8Array(bytes);
}

/* [2] 解析测试 */
console.log('\n[解析]');
const midiBytes = buildTestMidi();
const doc = parseMidiFile(midiBytes.buffer, 'test.mid');
assert('BPM = 120', Math.abs(doc.time.bpm - 120) < 0.01, String(doc.time.bpm));
assert('PPQ = 480', doc.time.ppq === 480, String(doc.time.ppq));
assert('拍号 = 4/4', doc.time.timeSignature[0] === 4 && doc.time.timeSignature[1] === 4);
assert('音符数 = 2', doc.notes.length === 2, String(doc.notes.length));
assert('音符1 = C4 起始0 时值480', doc.notes[0]?.pitch === 60 && doc.notes[0]?.startTick === 0 && doc.notes[0]?.durationTick === 480);
assert('音符2 = E4 起始480 时值480', doc.notes[1]?.pitch === 64 && doc.notes[1]?.startTick === 480 && doc.notes[1]?.durationTick === 480);
assert('ID 稳定（同参数两次生成一致）', noteId(480, 0, 60, 480) === noteId(480, 0, 60, 480));

/* [3] tick↔秒 换算 */
console.log('\n[tick↔秒]');
assert('480 tick @120BPM = 0.5s', Math.abs(tickToSec(480, 480, 120) - 0.5) < 1e-9);
assert('secToTick 往返', secToTick(0.5, 480, 120) === 480);

/* [4] 清洗测试 */
console.log('\n[清洗]');
// 构造：毛刺音符(10 tick) + 两个同音可合并 + 一个力度跳变不可合并
const messy: MidiNote[] = [
  { id: 'spike', pitch: 60, startTick: 0, durationTick: 10, velocity: 80, enabled: true, track: 0 },
  { id: 'a1', pitch: 62, startTick: 100, durationTick: 200, velocity: 80, enabled: true, track: 0 },
  { id: 'a2', pitch: 62, startTick: 305, durationTick: 200, velocity: 80, enabled: true, track: 0 }, // gap=5 < 15，可合并
  { id: 'b1', pitch: 64, startTick: 600, durationTick: 200, velocity: 80, enabled: true, track: 0 },
  { id: 'b2', pitch: 64, startTick: 805, durationTick: 200, velocity: 110, enabled: true, track: 0 }, // 力度差30，不合并
];
const messyDoc: MidiDocument = {
  time: { ppq: 480, bpm: 120, timeSignature: [4, 4] },
  notes: messy,
  totalTicks: 1005,
  sourceFileName: 'messy.mid',
};
const { doc: cleaned, report } = cleanMidi(messyDoc);
assert('毛刺被删除', report.deletedSpikes.length === 1 && report.deletedSpikes[0] === 'spike');
assert('同音合并 1 对', report.mergedPairs.length === 1, JSON.stringify(report.mergedPairs));
assert('合并后音符数 = 3', cleaned.notes.length === 3, String(cleaned.notes.length));
assert('合并后 a 音符时长 = 405', cleaned.notes.find(n => n.pitch === 62)?.durationTick === 405);
assert('力度跳变未合并（b1/b2 独立）', cleaned.notes.filter(n => n.pitch === 64).length === 2);

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
