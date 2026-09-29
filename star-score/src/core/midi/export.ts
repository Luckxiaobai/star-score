/* ================================================================
 * 人力V工作台 · MIDI 导出（MidiDocument → .mid 二进制）
 * ----------------------------------------------------------------
 * 输出 format 0 单轨 MIDI：tempo + time signature + note on/off
 * ================================================================ */

import type { MidiDocument } from '../../types/midiProject';
import { tickToSec } from '../../types/midiProject';

function writeVarLen(arr: number[], value: number) {
  const buf: number[] = [];
  buf.push(value & 0x7f);
  value >>= 7;
  while (value > 0) {
    buf.push((value & 0x7f) | 0x80);
    value >>= 7;
  }
  for (let i = buf.length - 1; i >= 0; i--) arr.push(buf[i]);
}

function push32(arr: number[], v: number) {
  arr.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
}

function push16(arr: number[], v: number) {
  arr.push((v >> 8) & 0xff, v & 0xff);
}

/** 将 MidiDocument 导出为 .mid 字节 */
export function midiToBytes(doc: MidiDocument): Uint8Array {
  const { ppq, bpm, timeSignature } = doc.time;
  const microsPerQuarter = Math.round(60000000 / bpm);

  type Ev = { tick: number; data: number[] };
  const events: Ev[] = [];

  events.push({ tick: 0, data: [0xff, 0x51, 0x03, (microsPerQuarter >> 16) & 0xff, (microsPerQuarter >> 8) & 0xff, microsPerQuarter & 0xff] });

  let denomExp = 0;
  let d = timeSignature[1];
  while (d > 1) { denomExp++; d >>= 1; }
  const clocksPerMetronome = Math.round(ppq / (timeSignature[0] > 3 ? 8 : timeSignature[0]));
  events.push({ tick: 0, data: [0xff, 0x58, 0x04, timeSignature[0], denomExp, clocksPerMetronome, 32] });

  for (const note of doc.notes) {
    if (!note.enabled) continue;
    events.push({ tick: note.startTick, data: [0x90, note.pitch, Math.max(1, Math.min(127, note.velocity))] });
    events.push({ tick: note.startTick + note.durationTick, data: [0x80, note.pitch, 0] });
  }

  events.sort((a, b) => a.tick - b.tick || a.data[0] - b.data[0]);
  events.push({ tick: doc.totalTicks, data: [0xff, 0x2f, 0x00] });

  const bytes: number[] = [];
  bytes.push(0x4d, 0x54, 0x68, 0x64);
  push32(bytes, 6);
  push16(bytes, 0); // format 0
  push16(bytes, 1); // 1 track
  push16(bytes, ppq);

  bytes.push(0x4d, 0x54, 0x72, 0x6b);
  const trackData: number[] = [];
  let lastTick = 0;
  for (const ev of events) {
    const delta = ev.tick - lastTick;
    lastTick = ev.tick;
    writeVarLen(trackData, Math.max(0, delta));
    for (const b of ev.data) trackData.push(b);
  }
  push32(bytes, trackData.length);
  bytes.push(...trackData);

  return new Uint8Array(bytes);
}

/** 触发浏览器下载 */
export function downloadMidi(doc: MidiDocument): void {
  const bytes = midiToBytes(doc);
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const base = (doc.sourceFileName || 'untitled').replace(/\.mid$/i, '');
  a.href = url;
  a.download = `${base}.cleaned.mid`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 时长辅助（供 UI 显示） */
export function midiDurationSec(doc: MidiDocument): number {
  return tickToSec(doc.totalTicks, doc.time.ppq, doc.time.bpm);
}
