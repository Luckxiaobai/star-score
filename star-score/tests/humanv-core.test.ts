import assert from 'node:assert/strict';
import { buildHumanVCommands } from '../src/features/humanv/commands';
import { selectSynthProvider } from '../src/core/synth/registry';
import { planToMidiDocument } from '../src/core/ai/midiGeneration';
import { alignLyricsToDocument } from '../src/core/ai/alignment';
import type { LyricUnit } from '../src/core/ai/types';

const onlineContext = {
  hasMidi: true,
  hasFrontendSample: true,
  loadedFromBackend: false,
  backendOnline: true,
};

assert.equal(
  selectSynthProvider(onlineContext)?.id,
  'single-sample',
  'online frontend sample should use the single-sample provider',
);

assert.equal(
  selectSynthProvider({ ...onlineContext, loadedFromBackend: true })?.id,
  'backend-render',
  'restored backend project should take provider priority',
);

assert.equal(
  selectSynthProvider({ ...onlineContext, backendOnline: false }),
  null,
  'offline backend should not select a provider',
);

const noop = () => {};
const commands = buildHumanVCommands({
  hasMidi: true,
  hasSample: true,
  backendOnline: false,
  synthBusy: false,
  synthProviderName: '单样本循环',
  isPlaying: false,
  canUndo: false,
  canRedo: false,
  selectedCount: 1,
  snapDivision: '16',
  importMidi: noop,
  uploadSample: noop,
  openProject: noop,
  saveProject: noop,
  exportMidi: noop,
  generate: noop,
  togglePlayback: noop,
  undo: noop,
  redo: noop,
  selectAll: noop,
  deleteSelected: noop,
  transpose: noop,
  quantize: noop,
  adjustVelocity: noop,
  toggleEnabled: noop,
  toScore: noop,
  zoomIn: noop,
  zoomOut: noop,
  fitView: noop,
});

assert.equal(
  commands.find((command) => command.id === 'save-project')?.disabled,
  true,
  'save should be disabled while backend is offline',
);

assert.equal(
  commands.find((command) => command.id === 'generate-synth')?.disabled,
  true,
  'generate should be disabled while backend is offline',
);

assert.equal(
  commands.find((command) => command.id === 'delete-selected')?.disabled,
  false,
  'selection commands should be enabled when notes are selected',
);

const generatedDoc = planToMidiDocument({
  title: 'AI Test',
  bpm: 120,
  time_signature: [4, 4],
  bars: 1,
  notes: [
    { start_beat: 0, duration_beats: 1, pitch: 60, velocity: 100 },
    { start_beat: 1, duration_beats: 2, pitch: 64, velocity: 90 },
  ],
  provider: 'test',
  model: 'test',
});
assert.equal(generatedDoc.notes[0].startTick, 0);
assert.equal(generatedDoc.notes[1].startTick, 480);
assert.equal(generatedDoc.totalTicks, 1920);

// ---- alignLyricsToDocument: boundary-aware DP alignment ----

function makeDoc(notesSpec: Array<{ startTick: number; durationTick: number }>) {
  const ppq = 480;
  const bpm = 120;
  const notes = notesSpec.map((spec, idx) => ({
    id: `n${idx}`,
    pitch: 60 + idx,
    startTick: spec.startTick,
    durationTick: spec.durationTick,
    velocity: 96,
    enabled: true,
    track: 0,
    lyric: undefined as string | undefined,
  }));
  return {
    time: { ppq, bpm, timeSignature: [4, 4] as [number, number] },
    notes,
    totalTicks: Math.max(...notes.map((note) => note.startTick + note.durationTick)),
    sourceFileName: 'test.mid',
  };
}

const unit = (text: string, start: number, end: number): LyricUnit => ({ text, start, end });

// At 120 BPM / 480 PPQ, one beat = 0.5s, so tick 480 = 0.5s.
// Case 1: monotonicity — later units never map to earlier notes.
{
  const doc = makeDoc([
    { startTick: 0, durationTick: 480 },      // 0.0 – 0.5 s
    { startTick: 480, durationTick: 480 },    // 0.5 – 1.0 s
    { startTick: 960, durationTick: 480 },    // 1.0 – 1.5 s
  ]);
  const aligned = alignLyricsToDocument(doc, [unit('A', 0.0, 0.5), unit('B', 0.5, 1.0), unit('C', 1.0, 1.5)]);
  assert.deepEqual(aligned.notes.map((note) => note.lyric), ['A', 'B', 'C'], 'monotonic 1:1 mapping');
}

// Case 2: shuffled input order still produces chronological assignment.
{
  const doc = makeDoc([
    { startTick: 0, durationTick: 480 },
    { startTick: 480, durationTick: 480 },
    { startTick: 960, durationTick: 480 },
  ]);
  const aligned = alignLyricsToDocument(doc, [unit('C', 1.0, 1.5), unit('A', 0.0, 0.5), unit('B', 0.5, 1.0)]);
  assert.deepEqual(aligned.notes.map((note) => note.lyric), ['A', 'B', 'C'], 'shuffled inputs sorted by time');
}

// Case 3: melisma — two short units fold onto one long note.
{
  const doc = makeDoc([{ startTick: 0, durationTick: 1920 }]);   // 0.0 – 2.0 s
  const aligned = alignLyricsToDocument(doc, [unit('la', 0.1, 0.4), unit('li', 1.2, 1.6)]);
  assert.equal(aligned.notes[0].lyric, 'la li', 'two ascii syllables join with a separator on one note');
}

// Case 4: disabled notes are skipped entirely.
{
  const doc = makeDoc([
    { startTick: 0, durationTick: 480 },
    { startTick: 480, durationTick: 480 },
  ]);
  doc.notes[1].enabled = false;
  const aligned = alignLyricsToDocument(doc, [unit('X', 0.0, 0.5), unit('Y', 0.5, 1.0)]);
  assert.equal(aligned.notes[0].lyric, 'X Y', 'disabled note absorbs nothing; both units land on the enabled one, joined by the ascii separator');
  assert.equal(aligned.notes[1].lyric, undefined, 'disabled note keeps no lyric');
}

// Case 5: empty inputs are a no-op and do not throw.
{
  const doc = makeDoc([{ startTick: 0, durationTick: 480 }]);
  assert.equal(alignLyricsToDocument(doc, []).notes[0].lyric, undefined, 'empty units leaves lyrics unset');
}
console.log('humanv core checks passed');
