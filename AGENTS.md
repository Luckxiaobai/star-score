# Repository Agent Rules

This workspace contains two related products:

- `star-score/`: the main React + TypeScript application and Python backend.
- `human_vocal_workbench/`: the contract/reference implementation for `.vproj`, MIDI, slicing, binding, and rendering.

Read `star-score/docs/HUMANV_ARCHITECTURE.md` before changing the HumanV workbench.
Keep `star-score/docs/HUMANV_PROGRESS.md` updated after every meaningful change.
Read `star-score/docs/UI_DESIGN.md` before changing frontend layout or effects.

## Required Commands

Run these from `star-score/` after relevant changes:

```powershell
npm run build
npm run lint
npm run test:humanv
npm run test:pianoroll
python backend\verify\test_job_manager.py
python backend\verify\test_ai_provider.py
```

Run Python self-tests only with the runtime that has the required packages. Do not claim a Python test passed if dependencies are missing.

## Architecture Boundaries

1. UI components render state and dispatch user intent. Do not put backend fetch logic, MIDI parsing, or synthesis scheduling inside visual components.
2. Feature hooks orchestrate state and side effects. Keep reusable behavior in `src/hooks/`.
3. Pure domain logic belongs in `src/core/` and must not import React or DOM UI components.
4. Backend and model adapters belong in `src/core/audio/engines/` or `src/core/synth/providers/`.
5. Styles belong in `src/styles/`. Avoid adding large inline style objects.
6. Do not edit `node_modules/`, `dist/`, `__pycache__/`, generated model files, or `star-score-source.tar.gz`.

## Non-Negotiable Data Rules

- Use `tickToSec` / `secToTick` from `src/types/midiProject.ts`; do not duplicate the formulas.
- Use stable `noteId` generation; do not create ad-hoc IDs for notes.
- Preserve `.vproj` field compatibility unless the contract is explicitly updated.
- New synthesis modes must return the shared `SynthResult` shape.
- New recognition engines must implement `AudioEngineAdapter`.
- New synthesis engines must implement `SynthProvider` and be registered in `src/core/synth/registry.ts`.

## Adding A Feature

1. Identify the ownership layer before editing.
2. Add or update types in the domain layer.
3. Implement reusable logic outside UI components.
4. Wire UI through hooks or small components.
5. Add focused tests or verification scripts when behavior is non-trivial.
6. Update `docs/HUMANV_ARCHITECTURE.md` when a new extension point or layer is introduced.
7. Run build and lint. Report remaining warnings honestly.

## Definition Of Done

- The main workflow still builds.
- Existing piano-roll verification still passes.
- New behavior has a clear owner and extension point.
- No unrelated refactor or file churn is included.
- The final report states what was verified and what could not be verified.
