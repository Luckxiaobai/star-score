import type { MidiDocument, MidiNote } from '../../types/midiProject';
import { noteId } from '../../types/midiProject';
import type { MidiGenerationPlan } from './types';

const AI_PPQ = 480;

export function planToMidiDocument(plan: MidiGenerationPlan): MidiDocument {
  const notes: MidiNote[] = plan.notes.map((note) => {
    const startTick = Math.max(0, Math.round(note.start_beat * AI_PPQ));
    const durationTick = Math.max(1, Math.round(note.duration_beats * AI_PPQ));
    return {
      id: noteId(AI_PPQ, startTick, note.pitch, durationTick),
      pitch: Math.max(0, Math.min(127, note.pitch)),
      startTick,
      durationTick,
      velocity: Math.max(1, Math.min(127, note.velocity)),
      enabled: true,
      track: 0,
      lyric: note.lyric,
    };
  });
  const [numerator, denominator] = plan.time_signature;
  const beatsPerBar = numerator * (4 / denominator);
  const barTicks = AI_PPQ * beatsPerBar;
  const noteEnd = notes.reduce(
    (max, note) => Math.max(max, note.startTick + note.durationTick),
    0,
  );
  return {
    time: {
      ppq: AI_PPQ,
      bpm: plan.bpm,
      timeSignature: [numerator, denominator],
    },
    notes,
    totalTicks: Math.max(noteEnd, Math.round(plan.bars * barTicks)),
    sourceFileName: `${plan.title || 'AI MIDI'}.ai.mid`,
  };
}

export function mergeGeneratedMidi(
  current: MidiDocument | null,
  plan: MidiGenerationPlan,
  mode: 'replace' | 'append',
): MidiDocument {
  const generated = planToMidiDocument(plan);
  if (!current || mode === 'replace') return generated;

  const offset = current.totalTicks;
  const notes = generated.notes.map((note) => {
    const startTick = note.startTick + offset;
    const durationTick = note.durationTick;
    return {
      ...note,
      id: noteId(current.time.ppq, startTick, note.pitch, durationTick),
      startTick,
    };
  });
  return {
    ...current,
    notes: [...current.notes, ...notes],
    totalTicks: Math.max(current.totalTicks, generated.totalTicks + offset),
  };
}
