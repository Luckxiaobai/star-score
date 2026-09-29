# HumanV Workbench Architecture

## Purpose

HumanV Workbench turns a MIDI score plus a short vocal sample into an edited,
auditioned, and rendered vocal track. The architecture favors replaceable
engines and small UI surfaces over feature-specific branches.

## Layer Map

```text
React views/components
  -> feature hooks
    -> pure domain logic
      -> provider/engine adapters
        -> local audio / Python backend / ONNX models
```

### UI

Location: `src/components/`

Responsibilities:

- Render state.
- Dispatch user intent.
- Show loading, error, and empty states.

Must not:

- Parse MIDI.
- Build synthesis payloads directly.
- Contain model-specific condition trees.
- Access backend response headers directly.

### Hooks

Location: `src/hooks/`

Current reusable hooks:

- `useAudioClipPlayer.ts`: one audio clip transport.
- `useBackendHealth.ts`: backend availability polling.
- `useUndoableState.ts`: snapshot undo/redo.

Add a hook when multiple components need the same stateful behavior.

### Domain

Location: `src/core/`

Current HumanV domains:

- `core/midi/`: parse, clean, export.
- `core/engines/`: playback scheduling.
- `core/synth/`: synthesis clients and provider registry.
- `core/audio/`: decoding, pitch, segmentation, recognition engines.
- `pipeline/analyze.ts`: score-analysis orchestration.

Domain code must remain independent of React.

### Styles

Location: `src/styles/`

Use class names and responsive layout rules. Avoid adding large inline style
objects to components.

## Synthesis Extension Point

Contract: `src/core/synth/types.ts`

Registry: `src/core/synth/registry.ts`

Providers: `src/core/synth/providers/`

To add a mode:

1. Implement `SynthProvider`.
2. Return the shared `SynthResult`.
3. Register it in priority order.
4. Add request construction only if the mode needs a new input type.
5. Reuse `SynthPlaybackBar` for playback.

The workbench should not branch on model names.

## Recognition Extension Point

Contract: `src/core/audio/engines/types.ts`

Registry: `src/core/audio/engines/index.ts`

Providers: `src/core/audio/engines/`

GAME is an existing provider. Future ASR, forced-alignment, RMVPE, or lyric
engines should be added as independent providers rather than inside
`HumanVWorkbench.tsx`.

## AI Extension Point

Contract: `src/core/ai/types.ts`

Registry: `src/core/ai/registry.ts`

Providers: `src/core/ai/providers/`

Backend proxy: `backend/ai_provider.py`

Current provider:

- `openai-compatible`: audio transcription through `/audio/transcriptions`.
- `openai-compatible`: prompt-to-MIDI through `/chat/completions`.
- `openai-compatible`: model discovery through `/models`.

Rules:

- API keys stay in browser local settings and are forwarded only to the local
  backend.
- Provider-specific request and response parsing stays in the provider module.
- UI receives normalized `AiTranscriptionResult`.
- Generated MIDI is normalized to `MidiGenerationPlan`, then converted into the
  normal `MidiDocument`; the model never writes binary MIDI directly.
- Forced alignment must be added as another provider, not as a branch in
  `AiLyricsPanel`.

## State Ownership

- MIDI document and edit history: HumanV workbench history state.
- Selected note IDs: HumanV UI state.
- MIDI playback: `AudioEngine`.
- Synth clip playback: `useAudioClipPlayer`.
- Backend online/offline: `useBackendHealth`.
- Project list/dialog state: project dialog component plus feature owner.
- Local draft persistence: workbench persistence effect.

## Planned Extension Areas

- Lyric capture and forced alignment.
- Multiple syllable binding.
- USTX / VSQX / MusicXML export.
- Job-based backend rendering with true cancel.
- Desktop packaging and plugin sandbox.

These are separate providers or services. They must not be implemented as
additional branches in the main workbench component.

## Upstream Feature Map

| Upstream project | Advantage to absorb | Current status |
|---|---|---|
| GAME | Singing-voice transcription and ONNX deployment | Integrated |
| GAME | Replaceable model sizes | Integrated through model manager |
| Vocal2Midi | Modular vocal-to-MIDI pipeline | Provider boundary prepared |
| Vocal2Midi | ASR, lyric matching, forced alignment | Planned provider |
| Vocal2Midi | USTX / VSQX / lyric-aligned exports | Planned services |
| AI_MIDI | Undo / redo for editing operations | Integrated |
| AI_MIDI | Project autosave and project archive workflow | Integrated as local draft plus project dialog |
| AI_MIDI | Command-driven workflow | Integrated as command palette |
| AI_MIDI | External AI assistant | Planned optional provider; requires user API key |
| FuFumidi | Transport controls and stop behavior | Integrated for synth clips |
| FuFumidi | Multi-engine adapter layout | Integrated for recognition and synthesis |
| FuFumidi | Piano-roll view controls and editing tools | Integrated baseline |
| FuFumidi | Plugin sandbox | Planned desktop-stage work |

## Completed Baseline

- Backend online/offline polling.
- Drag-and-drop import.
- Guided empty state.
- Undo/redo history for MIDI edits.
- Command palette.
- Save/open project dialogs.
- Selection tools for transpose, quantize, velocity, enable, and delete.
- Piano-roll zoom and fit controls.
- Synth playback with pause, stop, seek, volume, speed, loop, and download.
- Synthesis Provider registry.

## Next Provider Tasks

1. Add backend job creation, polling, and true cancellation.
2. Add a lyric/alignment provider with its own data model.
3. Add USTX / VSQX export services after the lyric model is stable.
4. Add an optional AI assistant provider behind an explicit user configuration.
5. Add desktop packaging and plugin isolation only after the web workflow is stable.

## Verification

Run from `star-score/`:

```powershell
npm run build
npm run lint
npm run test:humanv
npm run test:pianoroll
```

The current environment may not have all Python audio dependencies. State that
limitation when backend tests cannot run.

## Progress Tracking

Maintain `docs/HUMANV_PROGRESS.md` after every meaningful feature. It records
the current milestone, completed work, verification evidence, next step, and
architectural decisions.
