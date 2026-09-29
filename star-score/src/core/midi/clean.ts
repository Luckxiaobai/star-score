/* ================================================================
 * 人力V工作台 · MIDI 清洗（契约 v0.3.1 第 3.5 节）
 * ----------------------------------------------------------------
 * 规则（量化，缺一不可）：
 *   1. 毛刺过滤：durationTick < minNoteTick 的音符直接删除
 *   2. 同音合并：必须同时满足
 *      a. 两个音符 MIDI 音高完全相同
 *      b. 音符间隙 tick < mergeGapTick
 *      c. 前音符结束力度与后音符起始力度差值 < velocityJumpThreshold
 *      不满足任意一条，禁止合并（保护装饰音）
 * ================================================================ */

import type { CleanReport, CleanSettings, MidiDocument, MidiNote } from '../../types/midiProject';
import { noteId } from '../../types/midiProject';

/**
 * 执行 MIDI 清洗（原地返回新数组，不改动输入文档）
 * 排序前提：notes 按 startTick 升序（parseMidiFile 已保证）
 */
export function cleanMidi(doc: MidiDocument, settings?: Partial<CleanSettings>): { doc: MidiDocument; report: CleanReport } {
  const cfg: CleanSettings = {
    minNoteTick: Math.max(1, Math.round(doc.time.ppq / 16)),
    mergeGapTick: Math.max(1, Math.round(doc.time.ppq / 32)),
    velocityJumpThreshold: 30,
    ...(settings ?? {}),
  };

  const report: CleanReport = { deletedSpikes: [], mergedPairs: [] };

  // --- 1. 毛刺过滤 ---
  let notes = doc.notes.filter((n) => {
    if (n.durationTick < cfg.minNoteTick) {
      report.deletedSpikes.push(n.id);
      return false;
    }
    return true;
  });

  // --- 2. 同音合并（单向扫描：前音 + 后音） ---
  const merged: MidiNote[] = [];
  for (let i = 0; i < notes.length; i++) {
    const cur = notes[i];
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;

    if (prev && canMerge(prev, cur, cfg)) {
      // 合并：保留前音起始，时长延伸至后音结束
      const newDur = cur.startTick + cur.durationTick - prev.startTick;
      merged[merged.length - 1] = {
        ...prev,
        durationTick: newDur,
        id: noteId(doc.time.ppq, prev.startTick, prev.pitch, newDur),
      };
      report.mergedPairs.push([prev.id, cur.id]);
    } else {
      merged.push(cur);
    }
  }

  // 合并可能再次产生 < minNoteTick 的音符？不会：合并只会变长。
  // 合并后的总时长不应超过 doc.totalTicks（保持一致性）
  let totalTicks = doc.totalTicks;
  for (const n of merged) {
    totalTicks = Math.max(totalTicks, n.startTick + n.durationTick);
  }

  return {
    doc: { ...doc, notes: merged, totalTicks },
    report,
  };
}

/** 判定两个相邻音符是否可合并（契约 3.5 三条件） */
function canMerge(a: MidiNote, b: MidiNote, cfg: CleanSettings): boolean {
  // 条件 a：音高完全相同
  if (a.pitch !== b.pitch) return false;
  // 条件 b：间隙 tick < mergeGapTick（b.start - a.end < gap）
  const gap = b.startTick - (a.startTick + a.durationTick);
  if (gap >= cfg.mergeGapTick) return false;
  // 条件 c：力度差 < velocityJumpThreshold
  if (Math.abs(a.velocity - b.velocity) >= cfg.velocityJumpThreshold) return false;
  return true;
}
