import type { Score } from '../types/score';
import { noteToMidi, noteDurationSeconds } from '../core/theory/musicTheory';

/** 导出JSON */
export function exportJSON(score: Score): void {
  const blob = new Blob([JSON.stringify(score, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${score.metadata.title || 'untitled'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 导出PNG (截图当前谱面) */
export async function exportPNG(score: Score, elementId: string): Promise<void> {
  const el = document.getElementById(elementId);
  if (!el) return;

  // 用SVG方式生成图片
  const data = new XMLSerializer().serializeToString(el);
  const blob = new Blob([data], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${score.metadata.title || 'untitled'}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 导出PDF (通过打印) */
export function exportPDF(): void {
  window.print();
}

/** 生成MIDI文件 */
export function exportMIDI(score: Score): void {
  const ticksPerQuarter = 480;
  const bpm = score.metadata.tempo;
  const microsPerQuarter = Math.round(60000000 / bpm);

  // 收集所有MIDI事件
  type TrackEvent = { tick: number; data: number[]; };
  const events: TrackEvent[] = [];
  let currentTick = 0;

  // 设置速度
  events.push({
    tick: 0,
    data: [0xFF, 0x51, 0x03,
      (microsPerQuarter >> 16) & 0xFF,
      (microsPerQuarter >> 8) & 0xFF,
      microsPerQuarter & 0xFF,
    ],
  });

  // 设置调号 (C major = 0 sharps)
  events.push({ tick: 0, data: [0xFF, 0x59, 0x02, 0x00, 0x00] });

  // 设置拍号
  const ts = score.metadata.timeNumerator;
  const td = score.metadata.timeDenominator;
  let denomExp = 0;
  let d = td;
  while (d > 1) { denomExp++; d >>= 1; }
  const clocksPerMetronome = Math.round(ticksPerQuarter / (ts > 3 ? 8 : ts));
  events.push({ tick: 0, data: [0xFF, 0x58, 0x04, ts, denomExp, clocksPerMetronome, 32] });

  // 添加音符
  for (const measure of score.measures) {
    for (const note of measure.notes) {
      if (note.pitch !== 0) {
        const midi = noteToMidi(note, score.metadata);
        const dur = noteDurationSeconds(note, bpm);
        const durTicks = Math.round((dur * bpm / 60) * ticksPerQuarter);

        // Note on
        events.push({ tick: currentTick, data: [0x90, midi, 80] });
        // Note off
        events.push({ tick: currentTick + durTicks, data: [0x80, midi, 0] });
      }
      const dur = noteDurationSeconds(note, bpm);
      currentTick += Math.round((dur * bpm / 60) * ticksPerQuarter);
    }
  }

  // 添加结束标记
  events.push({ tick: currentTick, data: [0xFF, 0x2F, 0x00] });

  // 按tick排序
  events.sort((a, b) => a.tick - b.tick);

  // 构建MIDI数据
  const bytes: number[] = [];

  // Header chunk
  bytes.push(0x4D, 0x54, 0x68, 0x64); // "MThd"
  writeUInt32(bytes, 6); // header length
  writeUInt16(bytes, 0); // format 0
  writeUInt16(bytes, 1); // 1 track
  writeUInt16(bytes, ticksPerQuarter); // ticks per quarter

  // Track chunk
  bytes.push(0x4D, 0x54, 0x72, 0x6B); // "MTrk"
  const trackData: number[] = [];
  let lastTick = 0;

  for (const ev of events) {
    const delta = ev.tick - lastTick;
    lastTick = ev.tick;
    writeVarLen(trackData, delta);
    for (const b of ev.data) {
      trackData.push(b);
    }
  }

  writeUInt32(bytes, trackData.length);
  bytes.push(...trackData);

  // 下载
  const arr = new Uint8Array(bytes);
  const blob = new Blob([arr], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${score.metadata.title || 'untitled'}.mid`;
  a.click();
  URL.revokeObjectURL(url);
}

function writeUInt16(arr: number[], val: number) {
  arr.push((val >> 8) & 0xFF, val & 0xFF);
}

function writeUInt32(arr: number[], val: number) {
  arr.push((val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF);
}

function writeVarLen(arr: number[], value: number) {
  const buffer: number[] = [];
  buffer.push(value & 0x7F);
  value >>= 7;
  while (value > 0) {
    buffer.push((value & 0x7F) | 0x80);
    value >>= 7;
  }
  for (let i = buffer.length - 1; i >= 0; i--) {
    arr.push(buffer[i]);
  }
}
