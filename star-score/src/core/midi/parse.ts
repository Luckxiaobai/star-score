/* ================================================================
 * 人力V工作台 · MIDI 文件解析（纯前端，无依赖）
 * ----------------------------------------------------------------
 * 解析 Standard MIDI File (SMF) 二进制：
 *   - Header chunk（format / ntrks / division）
 *   - Track chunk（delta-time VLQ + running status + 事件）
 *   - Note On/Off 配对成音符（多 track 合并）
 *   - 第一个 tempo 事件作为全局 BPM（契约：阶段1不支持变速 MIDI）
 *   - 第一个 time signature 事件作为拍号
 * ================================================================ */

import type { MidiDocument, MidiNote } from '../../types/midiProject';
import { noteId } from '../../types/midiProject';

/* [VLQ] 变长数量：offset 通过对象引用推进 */
function readVLQ(view: DataView, offset: { v: number }): number {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const b = view.getUint8(offset.v++);
    value = (value << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return value;
}

/* [TRACK 解析] --------------------------------------------------- */

interface TrackResult {
  notes: MidiNote[];
  endTick: number;
  tempo: number | null;
  timeSig: [number, number] | null;
}

function parseTrack(
  view: DataView,
  start: number,
  trackLength: number,
  trackIndex: number,
  ppq: number
): TrackResult {
  const end = start + trackLength;
  let offset = start;
  let tick = 0;
  let runningStatus = 0;
  let tempo: number | null = null;
  let timeSig: [number, number] | null = null;

  /** 开启中的音符: key = channel * 128 + note */
  const active = new Map<number, { startTick: number; velocity: number }>();
  const notes: MidiNote[] = [];

  while (offset < end) {
    const o = { v: offset };
    const delta = readVLQ(view, o);
    offset = o.v;
    tick += delta;

    let status = view.getUint8(offset);
    if (status < 0x80) {
      // running status：复用上一个 status 字节
      status = runningStatus;
    } else {
      offset++;
      runningStatus = status;
    }

    const kind = status & 0xf0;

    // ---- 通道消息 ----
    if (kind === 0x90 || kind === 0x80) {
      // Note On / Note Off
      const note = view.getUint8(offset);
      const velocity = view.getUint8(offset + 1);
      offset += 2;
      const key = (status & 0x0f) * 128 + note;

      if (kind === 0x80 || velocity === 0) {
        // Note Off（含 velocity=0 的 Note On）
        const act = active.get(key);
        if (act) {
          active.delete(key);
          const dur = Math.max(1, tick - act.startTick);
          notes.push({
            id: noteId(ppq, act.startTick, note, dur),
            pitch: note,
            startTick: act.startTick,
            durationTick: dur,
            velocity: act.velocity,
            enabled: true,
            track: trackIndex,
          });
        }
      } else {
        // Note On
        active.set(key, { startTick: tick, velocity });
      }
    } else if (kind === 0xa0) {
      offset += 2; // Poly Aftertouch
    } else if (kind === 0xb0) {
      offset += 2; // Control Change
    } else if (kind === 0xc0) {
      offset += 1; // Program Change
    } else if (kind === 0xd0) {
      offset += 1; // Channel Pressure
    } else if (kind === 0xe0) {
      offset += 2; // Pitch Bend
    } else if (status === 0xf0 || status === 0xf7) {
      // SysEx
      const o2 = { v: offset };
      const len = readVLQ(view, o2);
      offset = o2.v + len;
    } else if (status === 0xff) {
      // Meta 事件
      const metaType = view.getUint8(offset);
      offset++;
      const o2 = { v: offset };
      const len = readVLQ(view, o2);
      offset = o2.v;

      if (metaType === 0x51 && len >= 3) {
        // Tempo：微秒/四分音符
        const micros =
          (view.getUint8(offset) << 16) |
          (view.getUint8(offset + 1) << 8) |
          view.getUint8(offset + 2);
        if (tempo === null) tempo = 60000000 / micros;
      } else if (metaType === 0x58 && len >= 2) {
        // Time Signature
        const nn = view.getUint8(offset);
        const dd = 1 << view.getUint8(offset + 1);
        if (timeSig === null) timeSig = [nn, dd];
      } else if (metaType === 0x2f) {
        offset = end; // End of Track
        break;
      }
      offset += len;
    } else {
      // 未知状态字节，跳过 1 字节避免死循环
      offset++;
    }
  }

  // 悬挂的 Note On（没有对应 Note Off）：用 track 末尾兜底
  const endTick = tick;
  for (const [key, act] of active) {
    const note = key % 128;
    const dur = Math.max(1, endTick - act.startTick);
    notes.push({
      id: noteId(ppq, act.startTick, note, dur),
      pitch: note,
      startTick: act.startTick,
      durationTick: dur,
      velocity: act.velocity,
      enabled: true,
      track: trackIndex,
    });
  }

  return { notes, endTick, tempo, timeSig };
}

/* [主解析] -------------------------------------------------------- */

const DEFAULT_PPQ = 480;
const DEFAULT_BPM = 120;

/**
 * 解析 .mid 文件字节 → MidiDocument
 * @throws Error 格式不合法时抛出
 */
export function parseMidiFile(buffer: ArrayBuffer, sourceFileName = 'untitled.mid'): MidiDocument {
  const view = new DataView(buffer);

  // --- Header ---
  if (view.byteLength < 14) throw new Error('MIDI 文件过短');
  const hdrTag = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (hdrTag !== 'MThd') throw new Error('不是有效的 MIDI 文件（缺少 MThd）');

  const hdrLen = view.getUint32(4);
  const ntrks = view.getUint16(10);
  const divisionRaw = view.getUint16(12);

  let ppq = DEFAULT_PPQ;
  if (divisionRaw & 0x8000) {
    // SMPTE 格式：阶段1不支持，按 480 兜底（极罕见）
    ppq = DEFAULT_PPQ;
  } else {
    ppq = divisionRaw || DEFAULT_PPQ;
  }

  let offset = 8 + hdrLen;
  if (offset < 14) offset = 14; // 防御：header 长度异常

  let globalTempo: number | null = null;
  let globalTimeSig: [number, number] | null = null;
  const allNotes: MidiNote[] = [];
  let maxTick = 0;

  // --- Tracks ---
  const trackCount = ntrks > 0 ? ntrks : 16;
  for (let t = 0; t < trackCount && offset + 8 <= view.byteLength; t++) {
    const tag = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    if (tag !== 'MTrk') break;
    const trackLen = view.getUint32(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = Math.min(dataStart + trackLen, view.byteLength);

    const res = parseTrack(view, dataStart, dataEnd - dataStart, t, ppq);
    allNotes.push(...res.notes);
    maxTick = Math.max(maxTick, res.endTick);
    if (globalTempo === null && res.tempo !== null) globalTempo = res.tempo;
    if (globalTimeSig === null && res.timeSig !== null) globalTimeSig = res.timeSig;

    offset = dataEnd;
  }

  // --- 排序 ---
  allNotes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);

  return {
    time: {
      ppq,
      bpm: globalTempo ?? DEFAULT_BPM,
      timeSignature: globalTimeSig ?? [4, 4],
    },
    notes: allNotes,
    totalTicks: maxTick,
    sourceFileName,
  };
}

/** 便捷：从 File 对象解析 */
export async function parseMidiFileFromFile(file: File): Promise<MidiDocument> {
  const buffer = await file.arrayBuffer();
  return parseMidiFile(buffer, file.name);
}
