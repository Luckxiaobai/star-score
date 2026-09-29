import type { Note, Score } from '../../types/score';
import { noteToFreq, noteDurationSeconds, midiToFreq } from '../theory/musicTheory';
import { DEFAULT_TIMBRE, getTimbre } from './timbres';
import type { TimbreSpec } from './timbres';

/**
 * 播放回调。
 * onTime 是「相对曲首秒数」的进度回调（约 25ms 一次），供播放头使用，
 * 简谱视图与人力V工作台共用。
 */
type PlaybackCallback = {
  onNoteStart?: (measureIdx: number, noteIdx: number) => void;
  onNoteEnd?: (measureIdx: number, noteIdx: number) => void;
  onEnd?: () => void;
  /** 音频上下文反复无法出声时给出的可见提示 */
  onError?: (message: string) => void;
  /** 播放进度（相对曲首秒数） */
  onTime?: (sec: number) => void;
};

interface ScheduledEvent {
  /** 相对全曲起点的秒数 */
  time: number;
  dur: number;
  freq: number;
  /** 线性增益 0~1（由 velocity 换算，缺省 1） */
  gain: number;
  measureIdx: number;
  noteIdx: number;
}

/** 外部喂入的「绝对时间音符」（MIDI 预览 / 人力V工作台用） */
export interface TimedNote {
  /** 相对曲首秒数 */
  startSec: number;
  /** 持续秒数 */
  durSec: number;
  /** MIDI note number 0~127 */
  midi: number;
  /** 力度 0~127，缺省 100 */
  velocity?: number;
}

/** velocity(0~127) → 线性增益。与契约 velocity_to_db 等价（20log10(v/127) 反算即 v/127）。 */
export function velocityToGain(velocity: number): number {
  if (!Number.isFinite(velocity) || velocity <= 0) return 0;
  return Math.min(1, velocity / 127);
}

const SCHEDULE_INTERVAL_MS = 25;
/** 提前排入音频线程的时间窗：足够抗主线程卡顿，又不会一次创建大量节点 */
const SCHEDULE_AHEAD_SEC = 0.6;
/** 首个音符相对当前音频时钟的提前量，给 resume / 设备启动留余量 */
const START_DELAY_SEC = 0.25;
/** 音频时钟连续多少个采样周期不前进，判定为"挂死"并自愈（约 1.5s） */
const STALL_TICKS = 60;
/** 启动后多久内不做停滞判定，给音频设备启动留宽限 */
const STALL_GRACE_MS = 2000;
/** resume 未完成时的重试间隔与次数（总计约 1.2s，之后交给停滞自愈） */
const RESUME_RETRY_MS = 200;
const RESUME_MAX_RETRY = 6;

/**
 * 播放引擎（滚动调度版）。
 *
 * 旧实现把整首谱（识别谱可能有数千个音符）的振荡器在点击瞬间一次性
 * 全部创建并 start 到未来十几分钟，会：
 *   1. 同步阻塞主线程数千毫秒（低端机上页面假死，点击像没反应）；
 *   2. 在同一个 AudioContext 里同时挂数千个未发声的源节点，部分设备 /
 *      浏览器内核下音频图异常，表现为"点了播放没声音"；
 *   3. 注册上万个 setTimeout 做高亮。
 *
 * 现在采用 lookahead 调度：每 25ms 只把未来 0.6s 内要响的音符交给
 * Web Audio（任意时刻在途节点通常不超过十几个），既精确又稳。
 *
 * v2（本次）：合并原 HumanVWorkbench 内联的 MidiPlayer——
 *   - 新增 playTimedNotes()，让 MIDI 文档也能走同一套调度；
 *   - 启动前显式等待 AudioContext 进入 running，消除「排到不存在的未来时间点」；
 *   - 新增 onTime 进度回调，人力V 的播放头不再需要私有定时器。
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  /** 正在发声的音符（一个音符可含多个振荡器），stop 时统一收尾 */
  private activeVoices: { oscs: OscillatorNode[]; nodes: AudioNode[] }[] = [];
  private playing = false;
  private unlockBound = false;
  private volume = 0.6;
  /** 当前音色（timbres.ts 的 key） */
  private timbreId: string = DEFAULT_TIMBRE;

  // —— 滚动调度状态 ——
  private events: ScheduledEvent[] = [];
  /** 自愈重播用：最近一次播放的事件表（与视图无关） */
  private pendingEvents: ScheduledEvent[] | null = null;
  private pendingCallback: PlaybackCallback | undefined;
  private nextIndex = 0;
  private startCtxTime = 0;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private uiTimers: ReturnType<typeof setTimeout>[] = [];
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private finishScheduled = false;
  private lastClock = 0;
  private stallCount = 0;
  private schedulerStartedAt = 0;
  private selfHealed = false;
  /** 播放代次：stop / 重新播放会自增，用于作废尚未执行的 begin 闭包 */
  private playToken = 0;
  /** 本次播放的起点秒数（对齐播放头用） */
  private startFromSec = 0;

  private ensureContext(): AudioContext {
    // 上下文被关闭（设备切换、浏览器回收）后必须重建，否则一切操作静默失败
    if (this.ctx && this.ctx.state === 'closed') {
      this.ctx = null;
      this.masterGain = null;
      this.unlockBound = false;
      this.activeVoices = [];
    }
    if (!this.ctx) {
      const AudioCtx: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;
      // 总线软限幅：音色含多振荡器 / 瞬态叠加时避免削波（听感上是"糊/炸"）
      const lim = this.ctx.createDynamicsCompressor();
      lim.threshold.value = -10;
      lim.knee.value = 8;
      lim.ratio.value = 4;
      lim.attack.value = 0.003;
      lim.release.value = 0.25;
      this.masterGain.connect(lim);
      lim.connect(this.ctx.destination);
      this.bindGlobalUnlock();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /** 双保险：任意首次交互都尝试恢复音频上下文 */
  private bindGlobalUnlock(): void {
    if (this.unlockBound) return;
    this.unlockBound = true;
    const resume = () => {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    };
    document.addEventListener('pointerdown', resume);
    document.addEventListener('keydown', resume);
    document.addEventListener('touchstart', resume);
  }

  /** 用户交互时调用，确保 AudioContext 已激活 */
  unlock(): void {
    this.ensureContext();
  }

  /** 供界面诊断：'running' | 'suspended' | 'closed' | 'none' */
  getState(): string {
    return this.ctx ? this.ctx.state : 'none';
  }

  /** 主音量 0-1 */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain) this.masterGain.gain.value = this.volume;
  }

  /** 切换音色（timbres.ts 的 key）；未知 id 回退默认 */
  setTimbre(id: string): void {
    this.timbreId = id;
  }

  getTimbreId(): string {
    return this.timbreId;
  }

  /**
   * 在指定音频时间播放单个音符（startTime 省略则立即响）。
   *
   * 音色由 timbres.ts 描述：可含多个叠加振荡器 + 低通 + 颤音。
   * 包络 attack → decay → sustain → release，其中 release 允许越过音符
   * 结束点与下一个音重叠 —— 连续音符之间不会出现静音缝（连奏）。
   */
  playNote(freq: number, duration: number, startTime?: number, gain = 1): void {
    if (!Number.isFinite(freq) || freq <= 0) return;
    if (!(gain > 0)) return;
    const spec: TimbreSpec = getTimbre(this.timbreId);
    const ctx = this.ensureContext();
    const t = Math.max(startTime ?? ctx.currentTime, ctx.currentTime);
    const d = Math.max(0.05, duration);

    const attack = Math.max(0.002, Math.min(spec.attack, d * 0.6));
    const release = Math.max(0.03, Math.min(spec.release, Math.max(0.06, d * 0.8)));
    const peak = Math.max(0.0005, spec.level * Math.min(1, gain));
    const sustainLevel = Math.max(0.0002, peak * (spec.decay > 0 ? spec.sustain : 1));

    // ---- 主包络 ----
    const nodeGain = ctx.createGain();
    const g = nodeGain.gain;
    const decayEnd = Math.min(t + attack + spec.decay, t + d);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    if (spec.decay > 0 && decayEnd > t + attack) {
      g.exponentialRampToValueAtTime(sustainLevel, decayEnd);
    }
    g.setValueAtTime(sustainLevel, Math.max(t + d, decayEnd));
    g.exponentialRampToValueAtTime(0.0001, t + d + release);

    // ---- 可选低通 ----
    const nodes: AudioNode[] = [nodeGain];
    let tail: AudioNode = nodeGain;
    if (spec.lowpass) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = spec.lowpass;
      lp.Q.value = 0.6;
      nodeGain.connect(lp);
      tail = lp;
      nodes.push(lp);
    }
    tail.connect(this.masterGain ?? ctx.destination);

    // ---- 叠加振荡器 ----
    const oscs: OscillatorNode[] = [];
    const stopAt = t + d + release + 0.06;
    for (const part of spec.oscs) {
      const osc = ctx.createOscillator();
      osc.type = part.type;
      osc.frequency.setValueAtTime(freq * Math.pow(2, part.octave ?? 0), t);
      if (part.detune) osc.detune.setValueAtTime(part.detune, t);
      const partGain = ctx.createGain();
      partGain.gain.value = part.gain;
      osc.connect(partGain);
      partGain.connect(nodeGain);
      osc.start(t);
      osc.stop(stopAt);
      oscs.push(osc);
      nodes.push(partGain);
    }

    // ---- 颤音（LFO 打到各载波的 detune）----
    if (spec.vibrato && oscs.length > 0) {
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = spec.vibrato.rate;
      lfoGain.gain.value = spec.vibrato.depthCents;
      lfo.connect(lfoGain);
      for (const o of oscs) lfoGain.connect(o.detune);
      lfo.start(t);
      lfo.stop(stopAt);
      oscs.push(lfo);
      nodes.push(lfoGain);
    }

    const voice = { oscs, nodes };
    this.activeVoices.push(voice);
    const cleanup = () => {
      this.activeVoices = this.activeVoices.filter((v) => v !== voice);
      for (const n of nodes) {
        try { n.disconnect(); } catch { /* noop */ }
      }
    };
    oscs[0].onended = cleanup;
  }

  /** 把 Score 展平成带绝对时间的发声事件（休止符只占位，不建振荡器） */
  private buildEvents(score: Score): ScheduledEvent[] {
    const bpm = score.metadata.tempo;
    const out: ScheduledEvent[] = [];
    let time = 0;
    for (let mi = 0; mi < score.measures.length; mi++) {
      const measure = score.measures[mi];
      for (let ni = 0; ni < measure.notes.length; ni++) {
        const note = measure.notes[ni];
        const dur = noteDurationSeconds(note, bpm);
        if (note.pitch !== 0) {
          const freq = noteToFreq(note, score.metadata);
          if (Number.isFinite(freq) && freq > 0 && Number.isFinite(dur) && dur > 0) {
            out.push({ time, dur, freq, gain: 1, measureIdx: mi, noteIdx: ni });
          }
        }
        time += Number.isFinite(dur) && dur > 0 ? dur : 0;
      }
    }
    return out;
  }

  /** 把「绝对时间音符」展平成调度事件（人力V / MIDI 预览用） */
  private buildTimedEvents(notes: TimedNote[]): ScheduledEvent[] {
    const out: ScheduledEvent[] = [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const freq = midiToFreq(n.midi);
      const dur = n.durSec;
      if (!Number.isFinite(freq) || freq <= 0) continue;
      if (!Number.isFinite(dur) || dur <= 0) continue;
      const gain = velocityToGain(n.velocity ?? 100);
      if (!(gain > 0)) continue;
      const time = Number.isFinite(n.startSec) ? Math.max(0, n.startSec) : 0;
      out.push({ time, dur, freq, gain, measureIdx: 0, noteIdx: i });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  /** 播放整个谱面；fromSec > 0 时从该秒数起播（对齐光标 / 播放头） */
  playScore(score: Score, callback?: PlaybackCallback, fromSec = 0): void {
    this.playEvents(this.buildEvents(score), callback, fromSec);
  }

  /**
   * 播放绝对时间音符列表（MIDI 预览 / 人力V工作台）。
   * @param fromSec 从第几秒开始（对齐播放头）；之前已结束的音符不补发
   */
  playTimedNotes(notes: TimedNote[], callback?: PlaybackCallback, fromSec = 0): void {
    this.playEvents(this.buildTimedEvents(notes), callback, fromSec);
  }

  private playEvents(events: ScheduledEvent[], callback?: PlaybackCallback, fromSec = 0): void {
    this.stop();
    this.pendingEvents = events;
    this.pendingCallback = callback;
    this.selfHealed = false;
    this.startFromSec = Math.max(0, Number.isFinite(fromSec) ? fromSec : 0);
    if (events.length === 0) {
      // 没有可发声事件：明确回调结束，不静默
      callback?.onEnd?.();
      return;
    }
    this.startScheduler(events, callback);
  }

  private startScheduler(events: ScheduledEvent[], callback?: PlaybackCallback): void {
    const ctx = this.ensureContext();
    this.events = events;
    this.nextIndex = 0;
    this.stallCount = 0;
    this.finishScheduled = false;
    this.lastClock = ctx.currentTime;
    this.playing = true;

    const token = ++this.playToken;
    let begun = false;
    let retries = 0;

    /** 只有等上下文真正 running 才算起点，否则会排到"永远不来的未来时间点" */
    const begin = () => {
      if (begun) return;
      if (token !== this.playToken || !this.playing) { begun = true; return; }
      if (ctx.state !== 'running' && retries < RESUME_MAX_RETRY) {
        retries += 1;
        ctx.resume().catch(() => {});
        setTimeout(begin, RESUME_RETRY_MS);
        return;
      }
      begun = true;
      this.startCtxTime = ctx.currentTime + START_DELAY_SEC - this.startFromSec;
      this.schedulerStartedAt = Date.now();
      this.runScheduler(ctx, callback);
    };

    if (ctx.state === 'running') {
      begin();
    } else {
      ctx.resume().then(begin, begin);
      setTimeout(begin, RESUME_RETRY_MS);
    }
  }

  private runScheduler(ctx: AudioContext, callback?: PlaybackCallback): void {
    if (this.schedulerTimer !== null) clearInterval(this.schedulerTimer);

    this.schedulerTimer = setInterval(() => {
      if (!this.playing) return;

      // 上下文被关闭：停止本拍，交给 stop / 下一次播放
      if (ctx.state === 'closed') {
        this.finishPlayback(callback, false);
        return;
      }

      // 时钟停滞自愈：state 显示 running 但音频时钟长期不走
      // （多见于蓝牙设备切换、UC 内核音频服务挂起）。启动宽限期内不判。
      const now = ctx.currentTime;
      const inGrace = Date.now() - this.schedulerStartedAt < STALL_GRACE_MS;
      if (!inGrace && now === this.lastClock) {
        this.stallCount++;
        if (this.stallCount >= STALL_TICKS) {
          this.stallCount = 0;
          this.healContext(ctx, callback);
          return;
        }
      } else {
        this.stallCount = 0;
        this.lastClock = now;
      }

      // 进度回调（播放头）：即使所有音符已排完也继续走，直到真正播完
      callback?.onTime?.(Math.max(0, now - this.startCtxTime));

      const horizon = now + SCHEDULE_AHEAD_SEC;
      while (
        this.nextIndex < this.events.length &&
        this.startCtxTime + this.events[this.nextIndex].time < horizon
      ) {
        const ev = this.events[this.nextIndex++];
        const at = this.startCtxTime + ev.time;
        // 起播点之前的音符直接跳过（不补发）：从播放头位置起播时，
        // 若照常排入，这些音符的 at 已是过去时间，会被 playNote 钳到
        // "立刻播放"，导致几十上百个音同时炸响
        if (at + ev.dur <= ctx.currentTime) continue;
        try {
          // 完整时值 + 溢出释音 → 连续音符自然重叠（连奏），不再"断断续续"
          this.playNote(ev.freq, ev.dur, at, ev.gain);
        } catch (err) {
          callback?.onError?.(`音频调度失败：${err instanceof Error ? err.message : String(err)}`);
          this.finishPlayback(callback, false);
          return;
        }

        // 高亮定时器只比声音提前一点点注册，数量始终受控
        if (callback?.onNoteStart || callback?.onNoteEnd) {
          const startMs = Math.max(0, (at - ctx.currentTime) * 1000);
          const cb = callback;
          this.uiTimers.push(setTimeout(() => cb.onNoteStart?.(ev.measureIdx, ev.noteIdx), startMs));
          this.uiTimers.push(
            setTimeout(() => cb.onNoteEnd?.(ev.measureIdx, ev.noteIdx), startMs + ev.dur * 1000)
          );
        }
      }

      if (this.nextIndex >= this.events.length && !this.finishScheduled) {
        const last = this.events[this.events.length - 1];
        const remainingMs = last
          ? Math.max(0, (this.startCtxTime + last.time + last.dur - ctx.currentTime) * 1000) + 250
          : 250;
        this.finishScheduled = true;
        this.finishTimer = setTimeout(() => {
          this.finishTimer = null;
          callback?.onTime?.(last ? last.time + last.dur : 0);
          this.finishPlayback(callback, true);
        }, remainingMs);
      }
    }, SCHEDULE_INTERVAL_MS);
  }

  /** 音频时钟挂死时：尝试 resume；无效则销毁并重建上下文，从头重播一次 */
  private healContext(oldCtx: AudioContext, callback?: PlaybackCallback): void {
    if (this.selfHealed || !this.pendingEvents) {
      callback?.onError?.('音频设备无响应，请检查系统音量、浏览器标签页静音或输出设备后重试');
      this.finishPlayback(callback, false);
      return;
    }
    this.selfHealed = true;
    this.teardownScheduler();
    try { oldCtx.close().catch(() => {}); } catch { /* noop */ }
    if (this.ctx === oldCtx) {
      this.ctx = null;
      this.masterGain = null;
      this.unlockBound = false;
    }
    this.activeVoices = [];
    const events = this.pendingEvents;
    const cb = callback ?? this.pendingCallback;
    this.startScheduler(events, cb);
  }

  private finishPlayback(callback: PlaybackCallback | undefined, completed: boolean): void {
    this.teardownScheduler();
    this.playing = false;
    if (completed) callback?.onEnd?.();
  }

  private teardownScheduler(): void {
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    this.finishScheduled = false;
    this.uiTimers.forEach((t) => clearTimeout(t));
    this.uiTimers = [];
  }

  /** 停止播放 */
  stop(): void {
    this.playing = false;
    this.playToken += 1; // 作废尚未执行的 begin
    this.pendingEvents = null;
    this.pendingCallback = undefined;
    this.teardownScheduler();

    const now = this.ctx?.currentTime ?? 0;
    for (const voice of this.activeVoices) {
      for (const n of voice.nodes) {
        try { n.disconnect(); } catch { /* noop */ }
      }
      for (const o of voice.oscs) {
        try { o.stop(now + 0.01); } catch { /* 已停止或未启动 */ }
      }
    }
    this.activeVoices = [];
  }

  /** 试听单个音符 */
  previewNote(note: Note, score: Score): void {
    if (note.pitch === 0) return;
    const freq = noteToFreq(note, score.metadata);
    const dur = noteDurationSeconds(note, score.metadata.tempo);
    this.playNote(freq, Math.max(0.2, dur * 0.8));
  }

  /** 试听某个频率 */
  previewFreq(freq: number, duration = 0.3): void {
    this.playNote(freq, duration);
  }

  isPlaying(): boolean {
    return this.playing;
  }
}
