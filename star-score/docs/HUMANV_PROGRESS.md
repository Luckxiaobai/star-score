# HumanV Workbench Progress

Last updated: 2026-09-29

This file is the running implementation record. Update it after every
meaningful HumanV change.

## Status Legend

- `DONE`: implemented and verified.
- `IN PROGRESS`: current work.
- `NEXT`: agreed next task.
- `BLOCKED`: waiting for an external dependency or decision.

Never mark an item `DONE` without naming the verification command or browser
flow that passed.

## Current Milestone

`M3 - AI lyrics and alignment providers`

Status: `IN PROGRESS`

### M3a - OpenAI-compatible AI transcription

Status: `DONE`

Delivered:

- Added local backend AI proxy: `backend/ai_provider.py`.
- Added `POST /api/ai/transcribe`.
- Added frontend AI Provider contract and OpenAI-compatible provider.
- Added local AI settings storage for Base URL, API Key, model, and language.
- Added AI lyrics panel with segment/word timestamps.
- Added deterministic lyric-to-note alignment.
- Added command palette actions for AI lyrics.
- Added optional browser draft persistence for lyric results.

Verification:

- `python -m py_compile backend/ai_provider.py backend/server.py`
- `python backend/verify/test_ai_provider.py`
- `npm run build`
- Browser flow: opened HumanV, opened the AI lyrics panel, and verified layout.

### M3c - Prompt to MIDI generation

Status: `DONE`

Delivered:

- Added `POST /api/ai/generate-midi`.
- Added OpenAI-compatible chat-completion generation.
- Added strict note-plan normalization in the backend.
- Added frontend `MidiGenerationPlan` and `MidiDocument` conversion.
- Added AI MIDI panel with prompt, style, BPM, bars, and key.
- Added replace and append modes for the piano-roll document.
- Added command palette actions for AI MIDI generation.
- Generated notes stay editable through the existing piano roll.

Verification:

- `python -m py_compile backend/ai_provider.py backend/server.py`
- `python backend/verify/test_ai_provider.py`
- `npm run build`

### M3b - Forced alignment provider

Status: `NEXT`

Planned:

- Add a provider contract for known lyrics + audio + timestamps.
- Support local HubertFA or another forced-alignment engine.
- Merge word/phoneme boundaries with GAME note boundaries.
- Upgrade the first-pass nearest-note mapping to boundary-aware alignment.

### M3d - Upstream model discovery

Status: `DONE`

Delivered:

- Added `POST /api/ai/models`.
- Added OpenAI-compatible `/models` fetching in `backend/ai_provider.py`.
- Added `listModels` to the frontend AI Provider contract.
- Added a reusable `useAiModels` hook.
- Added “获取模型” to both AI lyrics and AI MIDI panels.
- Model IDs populate the existing model input suggestions.

Verification:

- `python backend/verify/test_ai_provider.py`
- `npm run build`

## Previous Milestone

`M2 - Cancellable backend jobs`

Status: `DONE`

Goal:

- Long-running synthesis and render work runs in backend jobs.
- The frontend receives `job_id`, progress, status, and a download URL.
- Cancel requests stop work between processing units.
- Existing synchronous endpoints remain for compatibility.

Delivered:

- Added `backend/job_manager.py`.
- Added `POST /api/jobs/synth/single-sample`.
- Added `POST /api/jobs/render`.
- Added `GET /api/jobs/<id>`.
- Added `GET /api/jobs/<id>/download`.
- Added `POST /api/jobs/<id>/cancel`.
- Added cancellation checkpoints to note-based synthesis and rendering.
- Frontend synthesis providers now use jobs instead of blocking HTTP calls.
- Frontend abort now calls the backend cancel endpoint.
- Workspace shows task status and progress percentage.

Verification:

- `python -m py_compile backend/job_manager.py backend/server.py backend/synth_adapter.py`
- `python backend/verify/test_job_manager.py`
- `npm run test:humanv`
- `npm run build`

## Completed Milestones

### U1 - Laboratory Console Visual Refresh

Status: `DONE`

References:

- RhineLabUI: layered terminal surfaces, status traces, scanning motion.
- onetake: continuity and restrained state-change animation.
- ThreeUI: structured navigation and component hierarchy.
- Bencho: immediate interactive feedback.

Delivered:

- Added `src/styles/lab-ui.css`.
- Reworked the Global shell with translucent surfaces and grid background.
- Reworked HumanV into console header + status rail + main workspace.
- Added status pulse, panel rise, scan-line, button, and dialog motion.
- Added responsive single-column fallback.
- Added reduced-motion support.
- Added `docs/UI_DESIGN.md` as the frontend design contract.

Verification:

- `npm run build`
- Browser flow: checked the new HumanV console layout and AI MIDI panel.

### M1 - Workbench Usability And Architecture

Status: `DONE`

Delivered:

- Backend online/offline polling.
- Drag-and-drop MIDI/audio import.
- Guided three-step workflow.
- Undo/redo for MIDI edits.
- Selection tools: transpose, quantize, velocity, enable, delete.
- Command palette (`Ctrl+K`).
- Save/open project dialogs.
- Synth playback: pause, stop, seek, volume, speed, loop, download.
- Piano-roll zoom, fit, and snap controls.
- Synth Provider registry.
- Architecture guardrails in `AGENTS.md`.

Verification:

- `npm run build`
- `npm run test:humanv`
- `npm run test:pianoroll`
- Browser flow: imported a real WAV and MIDI, selected notes, ran undo.

## Next Milestone

`M3b - Forced Alignment Provider`

Status: `NEXT`

Planned:

- Add a known-lyrics + audio alignment provider.
- Support HubertFA or a compatible local alignment model.
- Merge phoneme/word boundaries with GAME note boundaries.
- Allow multiple syllables to bind to one MIDI phrase.
- DONE (2026-10-02): greedy nearest-note mapping replaced by boundary-aware monotonic DP alignment (`src/core/ai/alignment.ts`); tested with 5 cases.

## Clean-room architecture backlog

These design directions come from reading public architecture discussions (ADR-style rationale), NOT from copying code. We reimplement each idea in our own React/TS + Python stack. Nothing below imports or ports external source.

### B1 - Unified command layer (EditBatch)

Status: `NEXT`

Planned:

- Converge all MIDI-project mutations (UI buttons, REST calls, future AI agent tools) into one validated transaction object.
- Every edit is versioned, diffable, and undoable through the same path; no side doors for agents.
- Reuse the existing undo/redo and command palette as the seam; do not fork parallel mutation paths.

### B2 - Staged transcription quick-lane

Status: `NEXT`

Planned:

- Break GAME transcription into visible stages: denoise -> loudness normalize -> GAME notes -> quantize -> scale/key snap.
- Each stage keeps its artifacts and offers a preview + "adopt" button, instead of one black-box result.
- Reuse the GAME `game_onnx.py` backend; stages are thin wrappers around it.

### B3 - Named version snapshots

Status: `NEXT`

Planned:

- Allow the user to snapshot the current `.vproj` with a name.
- AI-assisted edits can be rolled back to a named snapshot (complements the existing undo stack).
- Keep snapshots inside the project folder, not a global git repo.

## Later Milestones

1. `M4`: USTX / VSQX / MusicXML export.
2. `M5`: optional AI assistant provider (builds on B1 command layer).
3. `M6`: desktop packaging and plugin sandbox.

## Decision Log

| Date | Decision | Reason |
|---|---|---|
| 2026-09-29 | Use an in-process job manager | Local single-user application; no Redis/Celery dependency needed |
| 2026-09-29 | Keep synchronous endpoints | Allows gradual migration and rollback |
| 2026-09-29 | Cancel between note units | Safe and portable without interrupting native DSP uninterruptibly |
| 2026-09-29 | Put model choices behind providers | Prevent model-specific branches in UI |

## Change Log

| Date | Area | Summary |
|---|---|---|
| 2026-09-29 | Workbench | Added drag/drop, command palette, undo, selection tools, transport controls |
| 2026-09-29 | Architecture | Added `AGENTS.md` and `HUMANV_ARCHITECTURE.md` |
| 2026-09-29 | Synth | Added Provider registry and shared result contract |
| 2026-09-29 | Backend | Added cancellable job manager and `/api/jobs/*` endpoints |
| 2026-09-29 | Frontend | Switched synth calls to polling jobs with real cancel |
| 2026-09-29 | AI | Added configurable OpenAI-compatible lyric transcription and note alignment |
| 2026-09-29 | AI | Added prompt-to-MIDI generation and piano-roll integration |
| 2026-09-29 | AI | Added upstream `/models` discovery and automatic model suggestions |
| 2026-09-29 | UI | Added laboratory-console shell, HumanV rail layout, and motion system |
| 2026-09-30 | UI | Reskinned HumanV as dark instrument console: scoped dark tokens to `.humanv`, replaced hardcoded blue/amber/gray in `humanv.css` with `--lab-*` tokens, dark glass buttons and form controls, staggered entrance motion, hover glow; updated `UI_DESIGN.md` |
| 2026-09-30 | UI | Unified whole app to dark lab theme: flipped `--color-*` tokens in global.css from warm-paper to dark teal, kept the score sheet as a light paper card so notation stays readable, fixed view-switch active button (was white-on-transparent = invisible), renamed tab "人力V工作台" → "人声合成", kicker → "VOCAL / SYNTHESIS LAB" |
| 2026-10-02 | AI | Replaced greedy nearest-note lyric mapping with boundary-aware monotonic DP alignment (`src/core/ai/alignment.ts`); 5 test cases; fixes one M3b sub-item |
| 2026-10-05 | Architecture | Added clean-room backlog (B1 unified command layer / B2 staged transcription quick-lane / B3 named version snapshots) after reading public ADR-style rationale; no external code ported |
