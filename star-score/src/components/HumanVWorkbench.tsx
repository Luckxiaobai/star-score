/* ================================================================
 * 人力V工作台 · 主界面
 * ----------------------------------------------------------------
 * 流程：上传 .mid → 解析 → 自动清洗 → 钢琴卷帘
 *       └→ 上传素材音频（如 1s“喵”）→ 一键生成（后端单样本循环合成）
 *           └→ 播放 / 下载合成结果
 *
 * 音频播放统一走 core/engine/AudioEngine（不再内联私有播放器）：
 *   - 播放 MIDI 预览 = playTimedNotes(绝对时间音符列表)
 *   - 进度回调 onTime 驱动播放头
 * 合成请求走后端任务制，AbortController 会同时调用 cancel 端点。
 * ================================================================ */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Score } from '../types/score';
import type { MidiDocument, MidiNote, MidiTimeConfig } from '../types/midiProject';
import { tickToSec } from '../types/midiProject';
import { parseMidiFileFromFile } from '../core/midi/parse';
import { cleanMidi } from '../core/midi/clean';
import { downloadMidi, midiDurationSec } from '../core/midi/export';
import { encodeWav } from '../core/audio/wav';
import { AudioEngine } from '../core/engine/AudioEngine';
import type { TimedNote } from '../core/engine/AudioEngine';
import { DEFAULT_TIMBRE } from '../core/engine/timbres';
import { DEFAULT_SYNTH_BACKEND } from '../core/synth/backend';
import { midiToFreq } from '../core/theory/musicTheory';
import { PianoRoll } from './PianoRoll';
import type { PianoRollHandle } from './PianoRoll';
import { SynthPlaybackBar } from './SynthPlaybackBar';
import type { SynthPlaybackHandle } from './SynthPlaybackBar';
import { CommandPalette } from './humanv/CommandPalette';
import { ProjectDialog } from './humanv/ProjectDialog';
import type { ProjectSummary } from './humanv/ProjectDialog';
import { WorkbenchEmptyState } from './humanv/WorkbenchEmptyState';
import { WorkflowStrip } from './humanv/WorkflowStrip';
import { HumanVToolbar } from './humanv/HumanVToolbar';
import { AiLyricsPanel } from './humanv/AiLyricsPanel';
import { AiMidiPanel } from './humanv/AiMidiPanel';
import { convertToScore } from '../pipeline/analyze';
import type { DetectedNote } from '../core/audio/segment';
import { useBackendHealth } from '../hooks/useBackendHealth';
import { useUndoableState } from '../hooks/useUndoableState';
import { selectSynthProvider } from '../core/synth/registry';
import type { SynthRequest } from '../core/synth/types';
import { buildHumanVCommands } from '../features/humanv/commands';
import { useAiSettings } from '../hooks/useAiSettings';
import { useAiModels } from '../hooks/useAiModels';
import { openAICompatibleProvider } from '../core/ai/registry';
import type { AiTranscriptionResult, LyricUnit } from '../core/ai/types';
import { alignLyricsToDocument } from '../core/ai/alignment';
import { mergeGeneratedMidi } from '../core/ai/midiGeneration';
import type { MidiGenerationPlan, MidiGenerationRequest } from '../core/ai/types';

const BACKEND = DEFAULT_SYNTH_BACKEND;

/** MIDI 工作台本地缓存键：切视图 / 刷新后不丢工程；素材走内容寻址从后端缓存恢复 */
const HUMANV_STORAGE_KEY = 'star-score-humanv';

/* [映射] 卷帘文档 → 播放器可用的音符事件 ---------------------------- */

interface NoteEvent {
  id: string;
  startSec: number;
  durSec: number;
  midi: number;
  velocity: number;
}

function docToNoteEvents(doc: MidiDocument): NoteEvent[] {
  const { ppq, bpm } = doc.time;
  const out: NoteEvent[] = [];
  for (const n of doc.notes) {
    if (!n.enabled) continue;
    const durSec = tickToSec(n.durationTick, ppq, bpm);
    if (!(durSec > 0)) continue;
    out.push({
      id: n.id,
      startSec: tickToSec(n.startTick, ppq, bpm),
      durSec,
      midi: n.pitch,
      velocity: n.velocity,
    });
  }
  return out;
}

function toTimedNotes(events: NoteEvent[]): TimedNote[] {
  return events.map((e) => ({
    startSec: e.startSec,
    durSec: e.durSec,
    midi: e.midi,
    velocity: e.velocity,
  }));
}

/* [映射] 后端 project（下划线） → 前端 cleanedDoc（驼峰） ------------ */

function projectNotesToCleaned(proj: any, prevDoc: any) {
  return {
    ...prevDoc,
    time: {
      ppq: proj.midi_config.ppq,
      bpm: proj.midi_config.bpm,
      timeSignature: proj.midi_config.time_signature,
    },
    notes: proj.notes.map((n: any) => ({
      id: n.note_id,
      pitch: n.midi_pitch,
      startTick: n.start_tick,
      durationTick: n.duration_tick,
      velocity: n.velocity,
      enabled: n.enabled,
      track: 0,
    })),
    totalTicks: proj.notes.reduce(
      (m: number, n: any) => Math.max(m, n.start_tick + n.duration_tick), 0
    ),
  };
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException
    ? e.name === 'AbortError'
    : e instanceof Error && e.name === 'AbortError';
}

/* [组件] ------------------------------------------------------------ */

export interface HumanVWorkbenchProps {
  onScoreGenerated?: (score: Score) => void;
}

export function HumanVWorkbench({ onScoreGenerated }: HumanVWorkbenchProps) {
  const {
    present: cleanedDoc,
    set: setDocument,
    dispatch: dispatchDocument,
    reset: resetDocument,
    undo: undoDocument,
    redo: redoDocument,
    canUndo,
    canRedo,
    checkpoint: checkpointDocument,
  } = useUndoableState<MidiDocument | null>(null);
  const [cleanReport, setCleanReport] = useState<{ deleted: number; merged: number } | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [currentProjectName, setCurrentProjectName] = useState<string | null>(null);
  const [projectDialog, setProjectDialog] = useState<'open' | 'save' | null>(null);
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);
  const [projectDialogBusy, setProjectDialogBusy] = useState(false);
  const [projectDialogError, setProjectDialogError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [snapDivision, setSnapDivision] = useState<'off' | '4' | '8' | '16'>('16');
  // loadedFromBackend: true = 后端 AppState 已有素材，生成走 render；false = 走 synth
  const [loadedFromBackend, setLoadedFromBackend] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // 素材（单样本循环）
  const [sampleInfo, setSampleInfo] = useState<{ name: string; durationSec: number } | null>(null);
  const [synthBusy, setSynthBusy] = useState(false);
  const [synthUrl, setSynthUrl] = useState<string | null>(null);
  // 预览音色（timbres.ts 的 key）
  const [timbreId, setTimbreId] = useState<string>(DEFAULT_TIMBRE);
  // 素材内容寻址 hash：刷新后据此从后端 slice_cache 恢复素材
  const [sliceHash, setSliceHash] = useState<string | null>(null);
  // BPM 输入草稿：允许中途输入不完整值，失焦 / 回车才提交（否则输入 "1" 就被夹到 20）
  const [bpmDraft, setBpmDraft] = useState('');
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiResult, setAiResult] = useState<AiTranscriptionResult | null>(null);
  const [aiMidiPanelOpen, setAiMidiPanelOpen] = useState(false);
  const [aiMidiBusy, setAiMidiBusy] = useState(false);
  const [aiMidiError, setAiMidiError] = useState('');
  const [aiMidiPlan, setAiMidiPlan] = useState<MidiGenerationPlan | null>(null);
  const aiSettings = useAiSettings();
  const aiModels = useAiModels();

  const engineRef = useRef<AudioEngine | null>(null);
  const midiFileRef = useRef<HTMLInputElement>(null);
  const sampleFileRef = useRef<HTMLInputElement>(null);
  const sampleDataRef = useRef<{ audio: Blob; sampleRate: number; mono: Float32Array } | null>(null);
  const synthPlaybackRef = useRef<SynthPlaybackHandle | null>(null);
  const pianoRollRef = useRef<PianoRollHandle | null>(null);
  const synthUrlRef = useRef<string | null>(null);
  const synthAbortRef = useRef<AbortController | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  const aiMidiAbortRef = useRef<AbortController | null>(null);
  const backend = useBackendHealth(BACKEND);

  const getEngine = useCallback((): AudioEngine => {
    if (!engineRef.current) engineRef.current = new AudioEngine();
    return engineRef.current;
  }, []);

  const openMidiPicker = useCallback(() => midiFileRef.current?.click(), []);
  const openSamplePicker = useCallback(() => sampleFileRef.current?.click(), []);
  const zoomPianoRollIn = useCallback(() => pianoRollRef.current?.zoomIn(), []);
  const zoomPianoRollOut = useCallback(() => pianoRollRef.current?.zoomOut(), []);
  const fitPianoRollView = useCallback(() => pianoRollRef.current?.fitView(), []);

  /**
   * 从后端内容寻址缓存恢复素材：
   * 音频文件不进 localStorage（体积大），但 POST /api/slice/import 时后端已把它
   * 按 hash 落到 slice_cache/{hash}.wav，所以刷新/重启后按 hash 取回即可。
   */
  const restoreSampleFromCache = useCallback(async (hash: string): Promise<boolean> => {
    try {
      const r = await fetch(`${BACKEND}/api/slice/cache/${hash}`);
      if (!r.ok) return false;
      const buf = await r.arrayBuffer();
      const ctx = new AudioContext();
      // decodeAudioData 会 detach 传入的 ArrayBuffer，先拷一份
      const decoded = await ctx.decodeAudioData(buf.slice(0));
      const mono = decoded.getChannelData(0);
      const audio = encodeWav([mono], decoded.sampleRate);
      sampleDataRef.current = { audio, sampleRate: decoded.sampleRate, mono };
      setSampleInfo({ name: `缓存素材 ${hash.slice(0, 8)}`, durationSec: decoded.duration });
      void ctx.close().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }, []);

  // 卸载清理：停播放 + 释放合成 blob URL
  useEffect(() => {
    return () => {
      engineRef.current?.stop();
      if (synthUrlRef.current) URL.revokeObjectURL(synthUrlRef.current);
      synthAbortRef.current?.abort();
      aiAbortRef.current?.abort();
      aiMidiAbortRef.current?.abort();
    };
  }, []);

  /* --- 音色：切到引擎（立即生效） --- */
  useEffect(() => {
    getEngine().setTimbre(timbreId);
  }, [timbreId, getEngine]);

  /* --- MIDI 工程持久化：切视图 / 刷新都不必重新导入 --- */
  useEffect(() => {
    if (!cleanedDoc) return;
    try {
      localStorage.setItem(HUMANV_STORAGE_KEY, JSON.stringify({
        doc: cleanedDoc,
        cleanReport,
        timbreId,
        sliceHash,
        currentProjectName,
        loadedFromBackend,
        aiResult,
        aiMidiPlan,
      }));
    } catch (e) {
      console.warn('[humanv] 工程缓存写入失败（可能超出 localStorage 限额）:', e);
    }
  }, [cleanedDoc, cleanReport, timbreId, sliceHash, currentProjectName, loadedFromBackend, aiResult, aiMidiPlan]);

  /* --- 首次挂载：恢复上次的工程与素材 --- */
  useEffect(() => {
    const raw = localStorage.getItem(HUMANV_STORAGE_KEY);
    if (!raw) return;
    let saved: {
      doc?: MidiDocument;
      cleanReport?: { deleted: number; merged: number } | null;
      timbreId?: string;
      sliceHash?: string | null;
      currentProjectName?: string | null;
      loadedFromBackend?: boolean;
      aiResult?: AiTranscriptionResult | null;
      aiMidiPlan?: MidiGenerationPlan | null;
    };
    try {
      saved = JSON.parse(raw);
    } catch {
      return;
    }
    if (!saved?.doc) return;
    resetDocument(saved.doc);
    setDirty(false);
    setCleanReport(saved.cleanReport ?? null);
    if (saved.timbreId) setTimbreId(saved.timbreId);
    if (saved.currentProjectName) setCurrentProjectName(saved.currentProjectName);
    if (saved.loadedFromBackend) setLoadedFromBackend(true);
    if (saved.aiResult) setAiResult(saved.aiResult);
    if (saved.aiMidiPlan) setAiMidiPlan(saved.aiMidiPlan);
    if (saved.sliceHash) {
      setSliceHash(saved.sliceHash);
      void restoreSampleFromCache(saved.sliceHash).then((ok) => {
        setStatus(ok
          ? '已恢复上次的 MIDI 工程与素材（素材取自后端缓存）'
          : '已恢复上次的 MIDI 工程；素材缓存不可用，请重新上传素材');
      });
    } else {
      setStatus('已恢复上次的 MIDI 工程（无素材记录，请上传素材或「打开工程」）');
    }
  }, [resetDocument, restoreSampleFromCache]);

  /** 统一替换合成结果（先释放旧 URL，避免泄漏） */
  const applySynthBlob = useCallback((blob: Blob) => {
    if (synthUrlRef.current) URL.revokeObjectURL(synthUrlRef.current);
    const url = URL.createObjectURL(blob);
    synthUrlRef.current = url;
    setSynthUrl(url);
  }, []);

  /* --- 上传 MIDI --- */
  const handleMidiFile = useCallback(async (file: File | undefined) => {
    setError('');
    if (!file) return;
    try {
      const parsed = await parseMidiFileFromFile(file);
      const cleaned = cleanMidi(parsed);
      resetDocument(cleaned.doc);
      setDirty(false);
      setCleanReport({
        deleted: cleaned.report.deletedSpikes.length,
        merged: cleaned.report.mergedPairs.length,
      });
      setSelectedIds([]);
      setPlayheadSec(0);
      setIsPlaying(false);
      setCurrentProjectName(null);   // 新 MIDI = 新工程
      setLoadedFromBackend(false);   // 走前端素材路径
      setStatus('');
      getEngine().stop();
      // 同步 notes 到后端（懒建工程，不清空 slice_library）
      try {
        const saveName = currentProjectName || "__draft__";
        await fetch(`${BACKEND}/api/project/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: saveName,
            midi_meta: {
              ppq: cleaned.doc.time.ppq,
              bpm: cleaned.doc.time.bpm,
              time_signature: cleaned.doc.time.timeSignature,
            },
            notes: cleaned.doc.notes.map(n => ({
              startTick: n.startTick,
              durationTick: n.durationTick,
              pitch: n.pitch,
              velocity: n.velocity,
              enabled: n.enabled,
            })),
          }),
        });
      } catch (e) {
        console.warn('[midi] 后端同步失败（不阻断）:', e);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析失败');
    }
  }, [currentProjectName, resetDocument, getEngine]);

  /* --- 上传素材音频 --- */
  const handleSampleFile = useCallback(async (file: File | undefined) => {
    setError('');
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const ctx = new AudioContext();
      const decoded = await ctx.decodeAudioData(buf);
      const mono = decoded.getChannelData(0);
      const audio = encodeWav([mono], decoded.sampleRate);
      sampleDataRef.current = { audio, sampleRate: decoded.sampleRate, mono };
      setSampleInfo({ name: file.name, durationSec: decoded.duration });
      setStatus(
        decoded.duration > 2
          ? '素材上传成功；当前素材较长，建议使用 0.3 到 1.5 秒的单一音节以提升合成质量'
          : '素材上传成功，可以生成合成',
      );
      setSynthUrl(null);
      if (synthUrlRef.current) {
        URL.revokeObjectURL(synthUrlRef.current);
        synthUrlRef.current = null;
      }
      void ctx.close().catch(() => {});
      // 同步后端：素材进 slice 库 + 内容寻址缓存（返回 hash，供刷新后恢复素材）
      try {
        const form = new FormData();
        form.append('file', audio, file.name);
        const r = await fetch(`${BACKEND}/api/slice/import`, { method: 'POST', body: form });
        if (r.ok) {
          const j = await r.json() as { slice_hash?: string };
          if (j?.slice_hash) setSliceHash(j.slice_hash);
        }
      } catch { /* 后端未启动时静默 */ }
    } catch (e) {
      setError('素材解码失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, []);

  /* --- 时间参数编辑：MIDI 页面直接可调 BPM / 拍号（不必先转简谱） --- */
  const handleTimeChange = useCallback((patch: Partial<MidiTimeConfig>) => {
    setDocument((prev) => {
      if (!prev) return prev;
      const time: MidiTimeConfig = { ...prev.time, ...patch };
      const bpm = Number(time.bpm);
      time.bpm = Number.isFinite(bpm) && bpm > 0 ? Math.min(300, Math.max(20, bpm)) : prev.time.bpm;
      if (!Array.isArray(time.timeSignature) || time.timeSignature.length !== 2) {
        time.timeSignature = prev.time.timeSignature;
      }
      return { ...prev, time };
    });
    setDirty(true);
    // BPM 变了，时间基准随之改变：停掉正在跑的播放并复位播放头
    getEngine().stop();
    setIsPlaying(false);
    setPlayheadSec(0);
  }, [setDocument, getEngine]);

  const docBpm = cleanedDoc ? Math.round(cleanedDoc.time.bpm) : null;

  useEffect(() => {
    if (docBpm !== null) setBpmDraft(String(docBpm));
  }, [docBpm]);

  const commitBpm = useCallback((raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) {
      setBpmDraft(docBpm !== null ? String(docBpm) : '');
      return;
    }
    handleTimeChange({ bpm: v });
  }, [docBpm, handleTimeChange]);

  /* --- 播放 MIDI 预览（统一引擎；可从播放头位置起播） --- */
  const playFrom = useCallback((fromSec: number) => {
    if (!cleanedDoc) return;
    const events = docToNoteEvents(cleanedDoc);
    if (events.length === 0) {
      setError('当前工程没有可播放的音符（全部被禁用或时长为 0）');
      return;
    }
    setError('');
    const start = Math.max(0, Number.isFinite(fromSec) ? fromSec : 0);
    const engine = getEngine();
    engine.unlock();
    engine.playTimedNotes(toTimedNotes(events), {
      onTime: (sec) => setPlayheadSec(sec),
      onEnd: () => {
        setIsPlaying(false);
        setPlayheadSec(0);
      },
      onError: (msg) => {
        setIsPlaying(false);
        setError(msg);
      },
    }, start);
    setIsPlaying(true);
  }, [cleanedDoc, getEngine]);

  const startPlayback = useCallback(() => {
    synthPlaybackRef.current?.stop();
    // 从当前播放头位置起播；播放头在开头时等价于整曲播放
    playFrom(playheadSec);
  }, [playFrom, playheadSec]);

  const stopPlayback = useCallback(() => {
    getEngine().stop();
    setIsPlaying(false);
  }, [getEngine]);

  /** 点击音符 / 空白设定播放起点；正在播放时立即从新位置重新起播 */
  const handleSeek = useCallback((tick: number) => {
    if (!cleanedDoc) return;
    const { ppq, bpm } = cleanedDoc.time;
    const sec = Math.max(0, tick) / ppq * (60 / bpm);
    setPlayheadSec(sec);
    if (isPlaying) playFrom(sec);
  }, [cleanedDoc, isPlaying, playFrom]);

  /** 点击左侧琴键试听 */
  const previewPitch = useCallback((midi: number) => {
    const engine = getEngine();
    engine.unlock();
    engine.playNote(midiToFreq(midi), 0.45);
  }, [getEngine]);

  /* --- 编辑（卷帘拖拽后更新文档） --- */
  const handleNotesEdited = useCallback((notes: MidiNote[]) => {
    setDocument((prev) => {
      if (!prev) return prev;
      let totalTicks = prev.totalTicks;
      for (const n of notes) totalTicks = Math.max(totalTicks, n.startTick + n.durationTick);
      return { ...prev, notes, totalTicks };
    }, { record: false });
    setDirty(true);
  }, [setDocument]);

  const deleteSelectedNotes = useCallback(() => {
    if (!cleanedDoc || selectedIds.length === 0) return;
    const selected = new Set(selectedIds);
    dispatchDocument({
      label: `删除 ${selected.size} 个音符`,
      source: 'user',
      apply: (prev) => {
        if (!prev) return prev;
        return { ...prev, notes: prev.notes.filter((note) => !selected.has(note.id)) };
      },
    });
    setSelectedIds([]);
    setDirty(true);
  }, [cleanedDoc, dispatchDocument, selectedIds]);

  const transformSelectedNotes = useCallback((
    transform: (note: MidiNote) => MidiNote,
  ) => {
    if (selectedIds.length === 0) return;
    const selected = new Set(selectedIds);
    setDocument((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        notes: prev.notes.map((note) => selected.has(note.id) ? transform(note) : note),
      };
    });
    setDirty(true);
  }, [selectedIds, setDocument]);

  const transposeSelected = useCallback((semitones: number) => {
    transformSelectedNotes((note) => ({
      ...note,
      pitch: Math.max(21, Math.min(108, note.pitch + semitones)),
    }));
  }, [transformSelectedNotes]);

  const quantizeSelected = useCallback(() => {
    if (snapDivision === 'off' || !cleanedDoc) return;
    const grid = Math.max(1, Math.round(cleanedDoc.time.ppq / Number(snapDivision)));
    transformSelectedNotes((note) => ({
      ...note,
      startTick: Math.round(note.startTick / grid) * grid,
    }));
  }, [cleanedDoc, snapDivision, transformSelectedNotes]);

  const adjustSelectedVelocity = useCallback((delta: number) => {
    transformSelectedNotes((note) => ({
      ...note,
      velocity: Math.max(1, Math.min(127, note.velocity + delta)),
    }));
  }, [transformSelectedNotes]);

  const toggleSelectedEnabled = useCallback(() => {
    transformSelectedNotes((note) => ({ ...note, enabled: !note.enabled }));
  }, [transformSelectedNotes]);

  const selectAllNotes = useCallback(() => {
    if (!cleanedDoc) return;
    setSelectedIds(cleanedDoc.notes.map((note) => note.id));
  }, [cleanedDoc]);

  const handleUndo = useCallback(() => {
    undoDocument();
    setDirty(true);
  }, [undoDocument]);

  const handleRedo = useCallback(() => {
    redoDocument();
    setDirty(true);
  }, [redoDocument]);

  /* --- 保存工程 --- */
  const saveProjectNamed = useCallback(async (name: string) => {
    if (!cleanedDoc) {
      setProjectDialogError('无 MIDI 数据');
      return;
    }
    setProjectDialogBusy(true);
    setProjectDialogError('');
    const body = {
      name,
      midi_meta: {
        ppq: cleanedDoc.time.ppq,
        bpm: cleanedDoc.time.bpm,
        time_signature: cleanedDoc.time.timeSignature,
      },
      notes: cleanedDoc.notes.map(n => ({
        startTick: n.startTick,
        durationTick: n.durationTick,
        pitch: n.pitch,
        velocity: n.velocity,
        enabled: n.enabled,
      })),
    };
    const doSave = () => fetch(`${BACKEND}/api/project/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    try {
      const r = await doSave();
      if (!r.ok) throw new Error(`保存失败 HTTP ${r.status}`);
      const data = await r.json();
      setCurrentProjectName(name);
      let bound = data.bound_notes_count;
      // 自动绑定：后端有素材就绑（覆盖式，避免编辑过的音符永久未绑定）
      try {
        const cur = await fetch(`${BACKEND}/api/project/current`).then(r => r.json());
        const hasSamples = (cur?.slice_library?.global_samples?.length ?? 0) > 0;
        if (hasSamples) {
          const br = await fetch(`${BACKEND}/api/bind`, { method: 'POST' });
          if (br.ok) {
            const r2 = await doSave(); // 绑定后重存：slice_ref 继承落盘
            if (r2.ok) {
              const data2 = await r2.json();
              bound = data2.bound_notes_count;
            }
          }
        }
      } catch {
        // 工程主体已保存；绑定失败不覆盖成功状态。
      }

      setDirty(false);
      setProjectDialog(null);
      setStatus(`已保存：${name}（${data.notes_count} 音符，${bound} 已绑定）`);
    } catch (e) {
      setProjectDialogError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setProjectDialogBusy(false);
    }
  }, [cleanedDoc]);

  const handleSaveProject = useCallback(() => {
    if (!cleanedDoc) {
      setError('无 MIDI 数据');
      return;
    }
    if (!currentProjectName) {
      setProjectDialogError('');
      setProjectDialog('save');
      return;
    }
    void saveProjectNamed(currentProjectName);
  }, [cleanedDoc, currentProjectName, saveProjectNamed]);

  /* --- 打开工程（列表对话框） --- */
  const handleOpenDialog = useCallback(async () => {
    setProjectDialog('open');
    setProjectDialogBusy(true);
    setProjectDialogError('');
    try {
      const r = await fetch(`${BACKEND}/api/project/list`);
      if (!r.ok) throw new Error(`列表获取失败 HTTP ${r.status}`);
      const data = await r.json();
      setProjectList(data.projects || []);
    } catch (e) {
      setProjectDialogError(e instanceof Error ? e.message : '列表获取失败');
    } finally {
      setProjectDialogBusy(false);
    }
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }, []);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (name.endsWith('.mid') || name.endsWith('.midi')) {
      void handleMidiFile(file);
    } else if (file.type.startsWith('audio/')) {
      void handleSampleFile(file);
    } else {
      setError('只支持拖入 .mid / .midi 或音频文件');
    }
  }, [handleMidiFile, handleSampleFile]);

  const handleLoadProject = useCallback(async (name: string) => {
    setProjectDialogBusy(true);
    setProjectDialogError('');
    try {
      const r = await fetch(`${BACKEND}/api/project/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error(`加载失败 HTTP ${r.status}`);
      const data = await r.json();

      resetDocument(projectNotesToCleaned(data.project, cleanedDoc));
      setDirty(false);
      setCurrentProjectName(name);
      setIsPlaying(false);
      setPlayheadSec(0);
      getEngine().stop();
      setProjectDialog(null);

      const missing = (data.warnings || []).filter((w: any) => w.kind === 'cache_missing');
      if (missing.length > 0) {
        setLoadedFromBackend(false);
        setStatus(`已加载：${name}，但 ${missing.length} 个素材未找到，需重新上传`);
      } else if (data.restored_slices > 0) {
        setLoadedFromBackend(true);
        setStatus(`已加载：${name}，素材 ${data.restored_slices} 个（后端缓存）`);
      } else {
        setLoadedFromBackend(false);
        setStatus(`已加载：${name}（无素材，请上传）`);
      }
    } catch (e) {
      setProjectDialogError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setProjectDialogBusy(false);
    }
  }, [cleanedDoc, resetDocument, getEngine]);

  /* --- 中止合成（只中断前端等待） --- */
  const abortSynth = useCallback(() => {
    synthAbortRef.current?.abort();
    synthAbortRef.current = null;
    setSynthBusy(false);
    setStatus('已请求中止合成，正在通知后端取消任务...');
  }, []);

  /* --- 一键生成（后端单样本循环合成 / 渲染） --- */
  const handleGenerate = useCallback(async () => {
    if (synthBusy) return;
    if (backend.status !== 'online') {
      setError('后端离线，请先运行一键启动或点击状态栏重新检测');
      return;
    }

    const provider = selectSynthProvider({
      hasMidi: Boolean(cleanedDoc),
      hasFrontendSample: Boolean(sampleInfo),
      loadedFromBackend,
      backendOnline: backend.status === 'online',
    });
    if (!provider) {
      setError('当前工程缺少 MIDI，或没有可用的人声素材');
      return;
    }

    const ctrl = new AbortController();
    synthAbortRef.current = ctrl;
    setError('');
    setSynthBusy(true);
    const jobOptions = {
      signal: ctrl.signal,
      onProgress: (update: { progress: number; message: string }) => {
        const pct = Math.round(Math.max(0, Math.min(1, update.progress)) * 100);
        setStatus(`${update.message || '任务执行中'} ${pct}%`);
      },
    };

    try {
      let request: SynthRequest;
      if (provider.id === 'backend-render') {
        request = { mode: 'backend-render', ...jobOptions };
        setStatus('渲染中（后端工程）...');
      } else {
        if (!cleanedDoc || !sampleDataRef.current) {
          throw new Error('需要先导入 MIDI 并上传素材音频');
        }
        const notes = docToNoteEvents(cleanedDoc).map((e) => ({
          id: e.id,
          start: e.startSec,
          duration: e.durSec,
          pitch: e.midi,
          velocity: e.velocity,
          enabled: true,
        }));
        if (notes.length === 0) throw new Error('当前工程没有可合成的音符');
        request = {
          mode: 'single-sample',
          audio: sampleDataRef.current.audio,
          notes,
          ...jobOptions,
        };
        setStatus(`合成中（${provider.name}）...`);
      }

      const result = await provider.render(request);
      applySynthBlob(result.blob);
      const warningText = result.warnings > 0 ? `，告警 ${result.warnings}` : '';
      setStatus(`合成完成（${(result.blob.size / 1024).toFixed(1)} KB）${warningText}`);
    } catch (e) {
      if (ctrl.signal.aborted || isAbortError(e)) {
        setStatus('已中止合成（后端任务已取消）');
      } else {
        setError(e instanceof Error ? e.message : '合成失败');
        setStatus('');
      }
    } finally {
      if (synthAbortRef.current === ctrl) synthAbortRef.current = null;
      if (!ctrl.signal.aborted) setSynthBusy(false);
    }
  }, [
    applySynthBlob,
    backend.status,
    cleanedDoc,
    loadedFromBackend,
    sampleInfo,
    synthBusy,
  ]);

  /* --- 转简谱 --- */
  const handleToScore = useCallback(() => {
    if (!cleanedDoc) return;
    const detected: DetectedNote[] = cleanedDoc.notes
      .filter((n) => n.enabled)
      .map((n) => ({
        startTime: tickToSec(n.startTick, cleanedDoc.time.ppq, cleanedDoc.time.bpm),
        endTime: tickToSec(n.startTick + n.durationTick, cleanedDoc.time.ppq, cleanedDoc.time.bpm),
        midi: n.pitch,
        frequency: 440 * Math.pow(2, (n.pitch - 69) / 12),
        confidence: 1,
      }));
    const score = convertToScore(detected, cleanedDoc.time.bpm, '1=C',
      cleanedDoc.time.timeSignature[0], cleanedDoc.time.timeSignature[1]);
    onScoreGenerated?.(score);
  }, [cleanedDoc, onScoreGenerated]);

  const handleAiTranscribe = useCallback(async () => {
    if (!sampleDataRef.current) {
      setAiError('请先上传需要识别的人声素材');
      return;
    }
    aiAbortRef.current?.abort();
    const ctrl = new AbortController();
    aiAbortRef.current = ctrl;
    setAiBusy(true);
    setAiError('');
    setStatus('AI 正在识别歌词...');
    try {
      const result = await openAICompatibleProvider.transcribe(
        sampleDataRef.current.audio,
        aiSettings.config,
        { signal: ctrl.signal },
      );
      setAiResult(result);
      setStatus(`歌词识别完成：${result.segments.length} 个片段`);
    } catch (e) {
      if (!isAbortError(e)) {
        setAiError(e instanceof Error ? e.message : '歌词识别失败');
        setStatus('');
      }
    } finally {
      if (aiAbortRef.current === ctrl) aiAbortRef.current = null;
      setAiBusy(false);
    }
  }, [aiSettings.config]);

  const handleApplyLyrics = useCallback(() => {
    if (!cleanedDoc || !aiResult) return;
    const units: LyricUnit[] = aiResult.words.length > 0
      ? aiResult.words
      : aiResult.segments;
    if (units.length === 0) {
      setAiError('没有可对齐的歌词片段');
      return;
    }
    setDocument((prev) => {
      if (!prev) return prev;
      return alignLyricsToDocument(prev, units);
    });
    setDirty(true);
    setStatus(`已把 ${units.length} 个歌词片段对到音符`);
  }, [aiResult, cleanedDoc, setDocument]);

  const handleGenerateAiMidi = useCallback(async (request: MidiGenerationRequest) => {
    aiMidiAbortRef.current?.abort();
    const ctrl = new AbortController();
    aiMidiAbortRef.current = ctrl;
    setAiMidiBusy(true);
    setAiMidiError('');
    setStatus('AI 正在生成 MIDI...');
    try {
      const plan = await openAICompatibleProvider.generateMidi(
        aiSettings.config,
        request,
        { signal: ctrl.signal },
      );
      setAiMidiPlan(plan);
      setStatus(`AI MIDI 生成完成：${plan.notes.length} 个音符`);
    } catch (e) {
      if (!isAbortError(e)) {
        setAiMidiError(e instanceof Error ? e.message : 'AI MIDI 生成失败');
        setStatus('');
      }
    } finally {
      if (aiMidiAbortRef.current === ctrl) aiMidiAbortRef.current = null;
      setAiMidiBusy(false);
    }
  }, [aiSettings.config]);

  const handleApplyAiMidi = useCallback((mode: 'replace' | 'append') => {
    if (!aiMidiPlan) return;
    dispatchDocument({
      label: mode === 'append' ? 'AI 追加 MIDI' : 'AI 替换 MIDI',
      source: 'ai',
      apply: (prev) => mergeGeneratedMidi(prev, aiMidiPlan, mode),
    });
    setDirty(true);
    setSelectedIds([]);
    setPlayheadSec(0);
    setIsPlaying(false);
    setCurrentProjectName(null);
    setLoadedFromBackend(false);
    setCleanReport(null);
    getEngine().stop();
    setAiMidiPanelOpen(false);
    setStatus(
      mode === 'append'
        ? `已把 AI MIDI 追加到工作台：${aiMidiPlan.notes.length} 个音符`
        : `已用 AI MIDI 替换工作台：${aiMidiPlan.notes.length} 个音符`,
    );
  }, [aiMidiPlan, dispatchDocument, getEngine]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT'
        || target?.tagName === 'SELECT'
        || target?.tagName === 'TEXTAREA';

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        handleSaveProject();
        return;
      }
      if (typing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        handleRedo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAllNotes();
        return;
      }
      if (event.key === 'Escape') {
        if (commandPaletteOpen || projectDialog) {
          setCommandPaletteOpen(false);
          setProjectDialog(null);
        } else {
          setSelectedIds([]);
        }
        return;
      }
      if (event.key === ' ' && cleanedDoc) {
        event.preventDefault();
        if (isPlaying) stopPlayback();
        else startPlayback();
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length > 0) {
        event.preventDefault();
        deleteSelectedNotes();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    cleanedDoc,
    commandPaletteOpen,
    deleteSelectedNotes,
    handleRedo,
    handleSaveProject,
    handleUndo,
    isPlaying,
    projectDialog,
    selectAllNotes,
    selectedIds.length,
    startPlayback,
    stopPlayback,
  ]);

  const playheadTick = cleanedDoc
    ? Math.round(playheadSec * cleanedDoc.time.ppq * cleanedDoc.time.bpm / 60)
    : 0;

  const synthProvider = selectSynthProvider({
    hasMidi: Boolean(cleanedDoc),
    hasFrontendSample: Boolean(sampleInfo),
    loadedFromBackend,
    backendOnline: backend.status === 'online',
  });
  const canGenerate = Boolean(synthProvider) && !synthBusy;

  // oxlint-disable-next-line react/refs -- callbacks run after user input, not during render
  const commands = buildHumanVCommands({
    hasMidi: Boolean(cleanedDoc),
    hasSample: Boolean(sampleInfo || loadedFromBackend),
    backendOnline: backend.status === 'online',
    synthBusy,
    synthProviderName: synthProvider?.name,
    isPlaying,
    canUndo,
    canRedo,
    selectedCount: selectedIds.length,
    snapDivision,
    hasAiResult: Boolean(aiResult),
    aiBusy,
    hasAiMidiPlan: Boolean(aiMidiPlan),
    importMidi: openMidiPicker,
    uploadSample: openSamplePicker,
    openProject: handleOpenDialog,
    saveProject: handleSaveProject,
    exportMidi: () => {
      if (cleanedDoc) downloadMidi(cleanedDoc);
    },
    generate: handleGenerate,
    togglePlayback: () => isPlaying ? stopPlayback() : startPlayback(),
    undo: handleUndo,
    redo: handleRedo,
    selectAll: selectAllNotes,
    deleteSelected: deleteSelectedNotes,
    transpose: transposeSelected,
    quantize: quantizeSelected,
    adjustVelocity: adjustSelectedVelocity,
    toggleEnabled: toggleSelectedEnabled,
    toScore: handleToScore,
    zoomIn: zoomPianoRollIn,
    zoomOut: zoomPianoRollOut,
    fitView: fitPianoRollView,
    openAi: () => {
      setAiMidiPanelOpen(false);
      setAiPanelOpen(true);
    },
    transcribeAi: () => {
      setAiPanelOpen(true);
      void handleAiTranscribe();
    },
    applyAiLyrics: handleApplyLyrics,
    openAiMidi: () => {
      setAiPanelOpen(false);
      setAiMidiPanelOpen(true);
    },
    applyAiMidi: () => handleApplyAiMidi('replace'),
  });

  /* [RENDER] ---------------------------------------------------------- */

  return (
    <div
      className={`humanv ${dragActive ? 'is-drag-active' : ''}`}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragActive(false);
        }
      }}
      onDrop={handleDrop}
    >
      <input
        ref={midiFileRef}
        type="file"
        accept=".mid,.midi"
        style={{ display: 'none' }}
        onChange={(event) => handleMidiFile(event.target.files?.[0])}
      />
      <input
        ref={sampleFileRef}
        type="file"
        accept="audio/*"
        style={{ display: 'none' }}
        onChange={(event) => handleSampleFile(event.target.files?.[0])}
      />

      <header className="humanv-consolebar">
        <div className="humanv-console-identity">
          <span className="humanv-console-kicker">VOCAL / SYNTHESIS LAB</span>
          <strong>声学调音台</strong>
          <span className={`humanv-live-dot is-${backend.status}`}>
            {backend.status === 'online' ? 'LINK ONLINE' : backend.status === 'offline' ? 'LINK OFFLINE' : 'LINK CHECK'}
          </span>
        </div>
        <HumanVToolbar
        doc={cleanedDoc}
        sampleName={sampleInfo?.name}
        synthProviderName={synthProvider?.name}
        synthProviderDescription={synthProvider?.description}
        synthBusy={synthBusy}
        canGenerate={canGenerate}
        backendOnline={backend.status === 'online'}
        isPlaying={isPlaying}
        canUndo={canUndo}
        canRedo={canRedo}
        snapDivision={snapDivision}
        bpmDraft={bpmDraft}
        timbreId={timbreId}
        aiBusy={aiBusy}
        onImportMidi={openMidiPicker}
        onOpenCommand={() => setCommandPaletteOpen(true)}
        onTogglePlayback={() => isPlaying ? stopPlayback() : startPlayback()}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onExportMidi={() => {
          if (cleanedDoc) downloadMidi(cleanedDoc);
        }}
        onToScore={handleToScore}
        onSave={handleSaveProject}
        onZoomOut={zoomPianoRollOut}
        onFitView={fitPianoRollView}
        onZoomIn={zoomPianoRollIn}
        onSnapChange={setSnapDivision}
        onBpmDraftChange={setBpmDraft}
        onCommitBpm={commitBpm}
        onTimeSignatureChange={(value) => handleTimeChange({ timeSignature: value })}
        onTimbreChange={setTimbreId}
        onOpenProject={handleOpenDialog}
        onUploadSample={openSamplePicker}
        onGenerate={handleGenerate}
        onAbort={abortSynth}
        onOpenAi={() => {
          setAiMidiPanelOpen(false);
          setAiPanelOpen(true);
        }}
        onOpenAiMidi={() => {
          setAiPanelOpen(false);
          setAiMidiPanelOpen(true);
        }}
        />
      </header>

      <div className="humanv-console-grid">
        <aside className="humanv-status-rail">
          <div className="humanv-rail-heading">工作流</div>
          <WorkflowStrip
            hasMidi={Boolean(cleanedDoc)}
            hasSample={Boolean(sampleInfo || loadedFromBackend)}
            dirty={dirty}
            backendStatus={backend.status}
            providerName={synthProvider?.name}
            onRefreshBackend={backend.refresh}
          />

          {selectedIds.length > 0 && (
            <div className="humanv-selection-tools">
              <span>已选 {selectedIds.length} 个音符</span>
              <button className="btn btn-sm" onClick={() => transposeSelected(12)}>升八度</button>
              <button className="btn btn-sm" onClick={() => transposeSelected(-12)}>降八度</button>
              <button className="btn btn-sm" onClick={quantizeSelected} disabled={snapDivision === 'off'}>
                量化
              </button>
              <button className="btn btn-sm" onClick={() => adjustSelectedVelocity(-10)}>力度 -</button>
              <button className="btn btn-sm" onClick={() => adjustSelectedVelocity(10)}>力度 +</button>
              <button className="btn btn-sm" onClick={toggleSelectedEnabled}>启用 / 停用</button>
              <button className="btn btn-sm btn-danger" onClick={deleteSelectedNotes}>删除</button>
              <button className="btn btn-sm" onClick={() => setSelectedIds([])}>取消选择</button>
            </div>
          )}
        </aside>

        <main className="humanv-workspace">

      {aiPanelOpen && (
        <AiLyricsPanel
          config={aiSettings.config}
          result={aiResult}
          audioReady={Boolean(sampleInfo)}
          busy={aiBusy}
          error={aiError}
          canApply={Boolean(cleanedDoc && aiResult)}
          models={aiModels.models}
          modelsLoading={aiModels.loading}
          modelsError={aiModels.error}
          onConfigChange={aiSettings.setConfig}
          onTranscribe={() => void handleAiTranscribe()}
          onApply={handleApplyLyrics}
          onClose={() => setAiPanelOpen(false)}
          onRefreshModels={() => void aiModels.refresh(aiSettings.config)}
        />
      )}

      {aiMidiPanelOpen && (
        <AiMidiPanel
          config={aiSettings.config}
          plan={aiMidiPlan}
          busy={aiMidiBusy}
          error={aiMidiError}
          models={aiModels.models}
          modelsLoading={aiModels.loading}
          modelsError={aiModels.error}
          onConfigChange={aiSettings.setConfig}
          onGenerate={(request) => void handleGenerateAiMidi(request)}
          onApply={handleApplyAiMidi}
          onClose={() => setAiMidiPanelOpen(false)}
          onRefreshModels={() => void aiModels.refresh(aiSettings.config)}
        />
      )}

      {error && <div className="humanv-error">{error}</div>}
      {status && <div className="humanv-status">{status}</div>}
      {synthUrl && !synthBusy && (
        <SynthPlaybackBar
          key={synthUrl}
          ref={synthPlaybackRef}
          src={synthUrl}
          downloadUrl={synthUrl}
          onBeforePlay={() => {
            getEngine().stop();
            setIsPlaying(false);
          }}
        />
      )}

      {!cleanedDoc ? (
        <WorkbenchEmptyState
          hasSample={Boolean(sampleInfo)}
          sampleName={sampleInfo?.name}
          sampleDurationSec={sampleInfo?.durationSec}
          backendStatus={backend.status}
          onImportMidi={openMidiPicker}
          onUploadSample={openSamplePicker}
        />
      ) : (
        <>
          {/* 信息条 */}
          <div className="humanv-info">
            <span>文件：{cleanedDoc.sourceFileName}</span>
            <span>音符：{cleanedDoc.notes.length}</span>
            <span>BPM：{cleanedDoc.time.bpm.toFixed(1)}</span>
            <span>拍号：{cleanedDoc.time.timeSignature[0]}/{cleanedDoc.time.timeSignature[1]}</span>
            <span>时长：{midiDurationSec(cleanedDoc).toFixed(1)}s</span>
            {cleanReport && (
              <span className="humanv-clean-info">
                清洗：删毛刺 {cleanReport.deleted} · 合并长音 {cleanReport.merged}
              </span>
            )}
            {sampleInfo && (
              <span className="humanv-sample-info">
                素材：{sampleInfo.name}（{sampleInfo.durationSec.toFixed(2)}s）
              </span>
            )}
          </div>

          {/* 钢琴卷帘：填满剩余高度（纵向可滚动，全音域 A0~C8） */}
          <PianoRoll
            ref={pianoRollRef}
            doc={cleanedDoc}
            selectedNoteIds={selectedIds}
            playheadTick={playheadTick}
            isPlaying={isPlaying}
            followPlayhead
            snapTicks={snapDivision === 'off' ? 0 : Math.max(1, Math.round(cleanedDoc.time.ppq / Number(snapDivision)))}
            onSeek={handleSeek}
            onPreviewPitch={previewPitch}
            onEditStart={checkpointDocument}
            onSelectNote={(id, additive) =>
              setSelectedIds((prev) =>
                additive
                  ? prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
                  : [id]
              )
            }
            onNotesEdited={handleNotesEdited}
          />
        </>
      )}

        </main>
      </div>

      {projectDialog && (
        <ProjectDialog
          mode={projectDialog}
          projects={projectList}
          initialName={currentProjectName ?? cleanedDoc?.sourceFileName.replace(/\.midi?$/i, '') ?? 'untitled'}
          busy={projectDialogBusy}
          error={projectDialogError}
          onClose={() => setProjectDialog(null)}
          onOpen={handleLoadProject}
          onSave={saveProjectNamed}
        />
      )}

      {commandPaletteOpen && (
        <CommandPalette
          commands={commands}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}
    </div>
  );
}
