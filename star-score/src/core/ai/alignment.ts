import type { MidiDocument, MidiNote } from '../../types/midiProject';
import { tickToSec } from '../../types/midiProject';
import type { LyricUnit } from './types';

function appendLyric(existing: string | undefined, text: string): string {
  if (!existing) return text;
  const left = existing[existing.length - 1] ?? '';
  const right = text[0] ?? '';
  if (/[a-z0-9]/i.test(left) && /[a-z0-9]/i.test(right)) {
    return `${existing} ${text}`;
  }
  return existing + text;
}

interface NoteSpan {
  note: MidiNote;
  start: number;
  end: number;
}

/**
 * Boundary affinity between a lyric unit and a note span in seconds.
 * Combines temporal IoU with a soft center-distance penalty so short
 * notes are not penalized purely by length.
 */
function unitNoteAffinity(unit: LyricUnit, span: NoteSpan): number {
  const overlap = Math.max(0, Math.min(unit.end, span.end) - Math.max(unit.start, span.start));
  if (overlap <= 0) {
    const gap = unit.start >= span.end
      ? unit.start - span.end
      : span.start - unit.end;
    return -gap;
  }
  const union = (unit.end - unit.start) + (span.end - span.start) - overlap;
  const iou = union > 0 ? overlap / union : 0;
  const unitMid = (unit.start + unit.end) / 2;
  const spanMid = (span.start + span.end) / 2;
  const scale = Math.max(0.05, (span.end - span.start) / 2);
  const centerPenalty = Math.abs(unitMid - spanMid) / scale;
  return iou * 2 - centerPenalty * 0.25;
}

/**
 * Assign timed lyric units to enabled notes using a monotonic,
 * boundary-aware dynamic-programming alignment.
 *
 * Guarantees:
 * - Units are processed in chronological order regardless of input order.
 * - Later units never map to earlier notes (monotonicity).
 * - Multiple units may share one note (syllabic melisma), but the score
 *   discourages stacking when a better-fitting neighbor exists.
 *
 * This is a deterministic first-pass alignment. A future forced-alignment
 * provider can replace this function without changing the UI.
 */
export function alignLyricsToDocument(
  doc: MidiDocument,
  units: LyricUnit[],
): MidiDocument {
  const notes = doc.notes.map((note) => ({ ...note, lyric: undefined as string | undefined }));
  const spans: NoteSpan[] = notes
    .filter((note) => note.enabled)
    .map((note) => ({
      note,
      start: tickToSec(note.startTick, doc.time.ppq, doc.time.bpm),
      end: tickToSec(note.startTick + note.durationTick, doc.time.ppq, doc.time.bpm),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (spans.length === 0 || units.length === 0) return { ...doc, notes };

  const sortedUnits = [...units].sort((a, b) => a.start - b.start || a.end - b.end);
  const unitCount = sortedUnits.length;
  const spanCount = spans.length;

  // affinity[i][j]: score of assigning unit i to span j (precomputed).
  const affinity: number[][] = sortedUnits.map((unit) =>
    spans.map((span) => unitNoteAffinity(unit, span)));

  // dp[i][j]: best total score for assigning the first i units using only
  // spans up to index j, where unit (i-1) is assigned to span j.
  const NEG = -Infinity;
  const dp: number[][] = Array.from({ length: unitCount }, () => new Array<number>(spanCount).fill(NEG));
  const back: number[][] = Array.from({ length: unitCount }, () => new Array<number>(spanCount).fill(-1));

  for (let j = 0; j < spanCount; j += 1) {
    dp[0][j] = affinity[0][j];
  }

  for (let i = 1; i < unitCount; i += 1) {
    // runningBest = max over previous row indices k <= j of dp[i-1][k]
    let runningBest = NEG;
    let runningArg = -1;
    for (let j = 0; j < spanCount; j += 1) {
      if (dp[i - 1][j] > runningBest) {
        runningBest = dp[i - 1][j];
        runningArg = j;
      }
      const candidate = runningBest === NEG ? NEG : runningBest + affinity[i][j];
      dp[i][j] = candidate;
      back[i][j] = runningArg;
    }
  }

  let bestScore = NEG;
  let bestCol = -1;
  for (let j = 0; j < spanCount; j += 1) {
    if (dp[unitCount - 1][j] > bestScore) {
      bestScore = dp[unitCount - 1][j];
      bestCol = j;
    }
  }
  if (bestCol < 0) return { ...doc, notes };

  const assignment = new Array<number>(unitCount).fill(-1);
  assignment[unitCount - 1] = bestCol;
  for (let i = unitCount - 1; i >= 1; i -= 1) {
    assignment[i - 1] = back[i][assignment[i]];
  }

  for (let i = 0; i < unitCount; i += 1) {
    const col = assignment[i];
    if (col < 0) continue;
    const target = spans[col].note;
    target.lyric = appendLyric(target.lyric, sortedUnits[i].text);
  }

  return { ...doc, notes };
}
