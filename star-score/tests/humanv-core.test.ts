import assert from 'node:assert/strict';
import { buildHumanVCommands } from '../src/features/humanv/commands';
import { selectSynthProvider } from '../src/core/synth/registry';
import { planToMidiDocument } from '../src/core/ai/midiGeneration';

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

console.log('humanv core checks passed');
