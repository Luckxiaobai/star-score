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

/**
 * Assign timed lyric units to the nearest enabled notes.
 *
 * This is a deterministic first-pass alignment. A future forced-alignment
 * provider can replace this function without changing the UI.
 */
export function alignLyricsToDocument(
  doc: MidiDocument,
  units: LyricUnit[],
): MidiDocument {
  const notes = doc.notes.map((note) => ({ ...note, lyric: undefined as string | undefined }));
  const enabled = notes.filter((note) => note.enabled);
  if (enabled.length === 0 || units.length === 0) return { ...doc, notes };

  for (const unit of units) {
    const ideal = (unit.start + unit.end) / 2;
    let target: MidiNote | null = null;
    let bestScore = -Infinity;

    for (const note of enabled) {
      const noteStart = tickToSec(note.startTick, doc.time.ppq, doc.time.bpm);
      const noteEnd = tickToSec(
        note.startTick + note.durationTick,
        doc.time.ppq,
        doc.time.bpm,
      );
      const overlap = Math.max(0, Math.min(unit.end, noteEnd) - Math.max(unit.start, noteStart));
      const noteMid = (noteStart + noteEnd) / 2;
      const score = overlap * 10 - Math.abs(ideal - noteMid);
      if (score > bestScore) {
        bestScore = score;
        target = note;
      }
    }

    if (target) {
      target.lyric = appendLyric(target.lyric, unit.text);
    }
  }

  return { ...doc, notes };
}
