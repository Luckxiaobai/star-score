/* ================================================================
 * 人力V工作台 · 钢琴卷帘（三层 Canvas 架构）
 * ----------------------------------------------------------------
 * 契约第 3 节：
 *   L0 静态层：钢琴键 + 行背景 + 小节线 + 纵向滚动条
 *   L1 视口层：MIDI 音符矩形（时间轴 + 音高轴双重裁剪）
 *   L2 高频层：播放头 + 正在发声的音块高亮 + 选中框
 *
 * v2 修订（本次）—— 三个问题的修复：
 *   1. 纵向可滚动。音域 A0(21) ~ C8(108) 共 88 键 = 880px，远超容器高度，
 *      所以引入 view.scrollY（纵向视口）：
 *        - 滚轮（无修饰键）上下滚
 *        - 拖拽空白处可上下 + 左右平移
 *        - 拖拽左侧琴键列也可上下滚
 *        - 载入 MIDI / 容器尺寸变化时自动「适配到音符音域」（居中显示）
 *   2. 拖拽方向修正：向上拖 = 音高升高。原实现 pitch 用 my - startY 直接相加，
 *      与 pitchToY 的「音高越大越靠上」相反，导致上下拖拽反向。
 *   3. 播放对齐：点击音块或空白处设定播放起点（onSeek），播放时视口自动跟随
 *      播放头，并把「播放头正下方、正在发声的音块」高亮描边，让对齐可见。
 *
 * 高度：不传 height 时填满父容器（由 CSS 的 flex 决定），不再写死 320px。
 * ================================================================ */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { MidiDocument, MidiNote } from '../types/midiProject';

/* [配置] ---------------------------------------------------------- */

const KEY_WIDTH = 56;        // 左侧钢琴键宽度 px
const ROW_HEIGHT = 10;       // 每半音行高 px
const MIN_PITCH = 21;        // 显示音域下限 A0（88 键钢琴最低音）
const MAX_PITCH = 108;       // 显示音域上限 C8
const GRID_HEIGHT = (MAX_PITCH - MIN_PITCH + 1) * ROW_HEIGHT; // 880px
const DEFAULT_ZOOM = 2;      // 初始：每 px 多少 tick
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 20;
const GRID_SNAP_TICKS = 120; // 水平拖拽吸附：16 分音符（480/4）
const WHEEL_LINE_PX = 16;    // deltaMode=1（按行）时的换算像素
const CLICK_SLOP_PX = 3;     // 位移小于此值视为「点击」而非拖拽
const BLACK_PC = [1, 3, 6, 8, 10];

/* [工具] ---------------------------------------------------------- */

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function isBlackKey(pitch: number): boolean {
  return BLACK_PC.includes(((pitch % 12) + 12) % 12);
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const TRACK_COLORS = ['#4a90d9', '#e07b39', '#43a047', '#9c27b0', '#e53935', '#00acc1', '#fdd835', '#8d6e63'];

function trackColor(track: number): string {
  return TRACK_COLORS[track % TRACK_COLORS.length];
}

const SOUNDING_FILL = 'rgba(255,235,59,0.45)';
const SOUNDING_STROKE = '#f9a825';

/* [Props] --------------------------------------------------------- */

export interface PianoRollProps {
  doc: MidiDocument;
  selectedNoteIds: string[];
  playheadTick: number;
  isPlaying: boolean;
  onSelectNote?: (id: string, additive: boolean) => void;
  /** 首次真正拖动前记录一次历史快照 */
  onEditStart?: () => void;
  onNotesEdited?: (notes: MidiNote[]) => void;
  /** 设定播放起点（点击音块 = 该音块起点；点击空白 = 该处 tick） */
  onSeek?: (tick: number) => void;
  /** 点击左侧琴键试听该音高 */
  onPreviewPitch?: (midi: number) => void;
  /** 固定高度（px）；不传则填满父容器 */
  height?: number;
  /** 播放时视口自动跟随播放头（默认开） */
  followPlayhead?: boolean;
  /** 水平拖动吸附 tick；0 表示关闭吸附 */
  snapTicks?: number;
}

export interface PianoRollHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fitView: () => void;
}

interface DragState {
  mode: 'pan' | 'note';
  startX: number;
  startY: number;
  baseScrollTick: number;
  baseScrollY: number;
  noteIds: string[];
  notesBefore: MidiNote[];
  moved: boolean;
  checkpointed?: boolean;
  /** 点击命中音符的起点（mouseup 未移动时用于 seek） */
  hitStartTick?: number;
  /** 点击左侧琴键命中的音高（mouseup 未移动时用于试听） */
  pressedPitch?: number;
}

/* [组件] ---------------------------------------------------------- */

export const PianoRoll = forwardRef<PianoRollHandle, PianoRollProps>(function PianoRoll({
  doc,
  selectedNoteIds,
  playheadTick,
  isPlaying,
  onSelectNote,
  onEditStart,
  onNotesEdited,
  onSeek,
  onPreviewPitch,
  height,
  followPlayhead = true,
  snapTicks = GRID_SNAP_TICKS,
}, ref) {
  const l0Ref = useRef<HTMLCanvasElement>(null); // 键盘 + 网格 + 滚动条
  const l1Ref = useRef<HTMLCanvasElement>(null); // 音符
  const l2Ref = useRef<HTMLCanvasElement>(null); // 播放头 + 发声高亮
  const wrapRef = useRef<HTMLDivElement>(null);

  const viewRef = useRef({ scrollTick: 0, zoom: DEFAULT_ZOOM, scrollY: 0 });
  const dragRef = useRef<DragState | null>(null);
  const notesRef = useRef<MidiNote[]>(doc.notes);
  notesRef.current = doc.notes;

  const widthRef = useRef(0);
  const heightRef = useRef(0);
  const didFitRef = useRef(false);

  /* [坐标换算] ------------------------------------------------------ */

  /** tick → 画布 x */
  const tickToX = useCallback((tick: number) => {
    const v = viewRef.current;
    return KEY_WIDTH + (tick - v.scrollTick) / v.zoom;
  }, []);

  /** 画布 x → tick */
  const xToTick = useCallback((x: number) => {
    const v = viewRef.current;
    return Math.max(0, (x - KEY_WIDTH) * v.zoom + v.scrollTick);
  }, []);

  /** 音高 → 画布 y（音高越大越靠上；scrollY 越大内容越往上走） */
  const pitchToY = useCallback((pitch: number) => {
    return (MAX_PITCH - pitch) * ROW_HEIGHT - viewRef.current.scrollY;
  }, []);

  /** 画布 y → 音高 */
  const yToPitch = useCallback((y: number) => {
    const p = MAX_PITCH - Math.floor((y + viewRef.current.scrollY) / ROW_HEIGHT);
    return clamp(p, MIN_PITCH, MAX_PITCH);
  }, []);

  /** 纵向可滚动上限 */
  const maxScrollY = useCallback(() => {
    return Math.max(0, GRID_HEIGHT - heightRef.current);
  }, []);

  /** 当前纵向视口覆盖的音高范围（多留一行，避免边缘缺行） */
  const visiblePitchRange = useCallback(() => {
    const h = heightRef.current;
    const sy = viewRef.current.scrollY;
    const top = MAX_PITCH - Math.floor(sy / ROW_HEIGHT) + 1;
    const bottom = MAX_PITCH - Math.floor((sy + h) / ROW_HEIGHT);
    return {
      from: clamp(bottom - 1, MIN_PITCH, MAX_PITCH),
      to: clamp(top + 1, MIN_PITCH, MAX_PITCH),
    };
  }, []);

  /** 让某个音高出现在视野内（返回是否调整过） */
  const scrollPitchIntoView = useCallback((pitch: number) => {
    const h = heightRef.current;
    if (h <= 0) return false;
    const y = pitchToY(pitch);
    if (y >= 0 && y + ROW_HEIGHT <= h) return false;
    const targetTop = (MAX_PITCH - pitch) * ROW_HEIGHT - h * 0.35;
    const next = clamp(targetTop, 0, maxScrollY());
    if (next === viewRef.current.scrollY) return false;
    viewRef.current.scrollY = next;
    return true;
  }, [maxScrollY, pitchToY]);

  /**
   * 自动适配到音符音域：能装下就居中；装不下就居中到音高中位数
   * （比「对齐音域上限」更接近用户真正要看的那一片）。
   */
  const fitPitchRange = useCallback(() => {
    const h = heightRef.current;
    if (h <= 0) return;
    const pitches = notesRef.current.filter((n) => n.enabled).map((n) => n.pitch);
    const v = viewRef.current;
    if (pitches.length === 0) {
      v.scrollY = clamp((MAX_PITCH - 60) * ROW_HEIGHT - h / 2, 0, maxScrollY());
      return;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pitches) {
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    lo -= 2;
    hi += 2;
    const spanPx = (hi - lo + 1) * ROW_HEIGHT;
    let center: number;
    if (spanPx <= h) {
      center = (lo + hi) / 2;
    } else {
      const sorted = [...pitches].sort((a, b) => a - b);
      center = sorted[Math.floor(sorted.length / 2)];
    }
    v.scrollY = clamp(
      (MAX_PITCH - center) * ROW_HEIGHT - h / 2 + ROW_HEIGHT / 2,
      0,
      maxScrollY(),
    );
  }, [maxScrollY]);

  /** 水平适配：让整首曲子的音符范围进入当前视口 */
  const fitTimeRange = useCallback(() => {
    const w = widthRef.current;
    if (w <= KEY_WIDTH) return;
    const noteEnd = notesRef.current.reduce(
      (max, note) => Math.max(max, note.startTick + note.durationTick),
      0,
    );
    const total = Math.max(1, doc.totalTicks, noteEnd);
    const visiblePx = w - KEY_WIDTH;
    const v = viewRef.current;
    v.zoom = clamp(total / visiblePx, MIN_ZOOM, MAX_ZOOM);
    v.scrollTick = 0;
  }, [doc.totalTicks]);

  const fitView = useCallback(() => {
    fitPitchRange();
    fitTimeRange();
    redrawRef.current();
  }, [fitPitchRange, fitTimeRange]);

  const zoomBy = useCallback((factor: number) => {
    const w = widthRef.current;
    if (w <= KEY_WIDTH) return;
    const v = viewRef.current;
    const anchorX = KEY_WIDTH + (w - KEY_WIDTH) * 0.5;
    const anchorTick = xToTick(anchorX);
    v.zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    v.scrollTick = Math.max(0, anchorTick - (anchorX - KEY_WIDTH) * v.zoom);
    redrawRef.current();
  }, [xToTick]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => zoomBy(0.8),
    zoomOut: () => zoomBy(1.25),
    fitView,
  }), [fitView, zoomBy]);

  /* [绘制] ---------------------------------------------------------- */

  const drawL0 = useCallback(() => {
    const c = l0Ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = widthRef.current;
    const h = heightRef.current;
    if (w <= 0 || h <= 0) return;
    const v = viewRef.current;
    const { ppq, timeSignature } = doc.time;

    ctx.clearRect(0, 0, w, h);

    // 网格背景
    ctx.fillStyle = '#f7f7f5';
    ctx.fillRect(KEY_WIDTH, 0, w - KEY_WIDTH, h);

    // 行底色（只画可见音域）
    const { from, to } = visiblePitchRange();
    for (let p = from; p <= to; p++) {
      const y = pitchToY(p);
      if (y > h || y + ROW_HEIGHT < 0) continue;
      if (isBlackKey(p)) {
        ctx.fillStyle = '#ecece8';
        ctx.fillRect(KEY_WIDTH, y, w - KEY_WIDTH, ROW_HEIGHT);
      }
      if (p % 12 === 0) {
        ctx.fillStyle = 'rgba(74,144,217,0.07)';
        ctx.fillRect(KEY_WIDTH, y, w - KEY_WIDTH, ROW_HEIGHT);
      }
    }

    // 小节线
    const beatsPerMeasure = timeSignature[0] * (4 / timeSignature[1]);
    const measureTicks = Math.round(ppq * beatsPerMeasure);
    if (measureTicks > 0) {
      const startMeasure = Math.floor(v.scrollTick / measureTicks);
      const endMeasure = Math.ceil((v.scrollTick + (w - KEY_WIDTH) * v.zoom) / measureTicks);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      for (let m = startMeasure; m <= endMeasure; m++) {
        const x = Math.round(tickToX(m * measureTicks)) + 0.5;
        if (x < KEY_WIDTH - 1 || x > w + 1) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    // 左侧钢琴键（只画可见音域，88 键全覆盖）
    for (let p = to; p >= from; p--) {
      const y = pitchToY(p);
      if (y > h || y + ROW_HEIGHT < 0) continue;
      if (isBlackKey(p)) {
        ctx.fillStyle = '#333';
        ctx.fillRect(0, y, KEY_WIDTH * 0.6, ROW_HEIGHT);
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, y, KEY_WIDTH, ROW_HEIGHT);
        ctx.strokeStyle = '#bbb';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, y + 0.5, KEY_WIDTH - 1, ROW_HEIGHT - 1);
        if (p % 12 === 0) {
          ctx.fillStyle = '#666';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`C${Math.floor(p / 12) - 1}`, KEY_WIDTH / 2, y + ROW_HEIGHT / 2);
        }
      }
    }

    // 纵向滚动条（音域装不下时提示可滚动）
    if (GRID_HEIGHT > h) {
      const trackX = w - 7;
      ctx.fillStyle = 'rgba(0,0,0,0.06)';
      ctx.fillRect(trackX, 0, 6, h);
      const thumbH = Math.max(30, h * (h / GRID_HEIGHT));
      const denom = Math.max(1, GRID_HEIGHT - h);
      const thumbY = (v.scrollY / denom) * (h - thumbH);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(trackX, thumbY, 6, thumbH);
    }
  }, [doc, pitchToY, tickToX, visiblePitchRange]);

  const drawL1 = useCallback(() => {
    const c = l1Ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = widthRef.current;
    const h = heightRef.current;
    if (w <= 0 || h <= 0) return;
    const v = viewRef.current;

    ctx.clearRect(0, 0, w, h);

    const viewStartTick = v.scrollTick;
    const viewEndTick = v.scrollTick + (w - KEY_WIDTH) * v.zoom;

    for (const note of notesRef.current) {
      if (!note.enabled) continue;
      if (note.pitch < MIN_PITCH || note.pitch > MAX_PITCH) continue;
      const nStart = note.startTick;
      const nEnd = note.startTick + note.durationTick;
      if (nEnd < viewStartTick || nStart > viewEndTick) continue;

      const y = pitchToY(note.pitch);
      if (y > h || y + ROW_HEIGHT < 0) continue;

      const x = tickToX(nStart);
      const xEnd = tickToX(nEnd);
      const left = Math.max(KEY_WIDTH, x);
      const right = Math.min(w, xEnd);
      if (right <= left) continue;
      const ww = Math.max(3, right - left);
      const hh = ROW_HEIGHT - 1;

      const selected = selectedNoteIds.includes(note.id);
      ctx.fillStyle = selected ? '#ff9800' : trackColor(note.track);
      drawRoundedRect(ctx, left, y, ww, hh, 2);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = '#e65100';
        ctx.lineWidth = 1.5;
        drawRoundedRect(ctx, left - 1.5, y - 1.5, ww + 3, hh + 3, 3);
        ctx.stroke();
      }
    }
  }, [doc, selectedNoteIds, pitchToY, tickToX]);

  const drawL2 = useCallback(() => {
    const c = l2Ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = widthRef.current;
    const h = heightRef.current;
    if (w <= 0 || h <= 0) return;
    ctx.clearRect(0, 0, w, h);

    // ① 正在发声的音块（播放头正下方）—— 让「线有没有落在音块上」一眼可见
    for (const note of notesRef.current) {
      if (!note.enabled) continue;
      if (playheadTick < note.startTick || playheadTick >= note.startTick + note.durationTick) continue;
      const y = pitchToY(note.pitch);
      if (y > h || y + ROW_HEIGHT < 0) continue;
      const x = tickToX(note.startTick);
      const xEnd = tickToX(note.startTick + note.durationTick);
      const left = Math.max(KEY_WIDTH, x);
      const right = Math.min(w, xEnd);
      if (right <= left) continue;
      ctx.fillStyle = SOUNDING_FILL;
      drawRoundedRect(ctx, left, y, right - left, ROW_HEIGHT - 1, 2);
      ctx.fill();
      ctx.strokeStyle = SOUNDING_STROKE;
      ctx.lineWidth = 1.5;
      drawRoundedRect(ctx, left - 0.5, y - 0.5, right - left + 1, ROW_HEIGHT, 2);
      ctx.stroke();
    }

    // ② 播放头
    const x = Math.round(tickToX(playheadTick)) + 0.5;
    if (x >= KEY_WIDTH - 1 && x <= w + 1) {
      ctx.strokeStyle = '#d32f2f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = '#d32f2f';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - 5, 9);
      ctx.lineTo(x + 5, 9);
      ctx.closePath();
      ctx.fill();
    }
  }, [playheadTick, pitchToY, tickToX]);

  const redraw = useCallback(() => {
    drawL0();
    drawL1();
    drawL2();
  }, [drawL0, drawL1, drawL2]);

  /* [尺寸同步] ------------------------------------------------------ */
  /* 用 ref 持有绘制函数：避免播放时 playheadTick 每 25ms 变化就重建 ResizeObserver */

  const redrawRef = useRef<() => void>(() => {});
  const fitRef = useRef<() => void>(() => {});
  const maxScrollYRef = useRef<() => number>(() => 0);
  redrawRef.current = redraw;
  fitRef.current = fitView;
  maxScrollYRef.current = maxScrollY;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const resize = () => {
      const w = wrap.clientWidth;
      const h = height ?? wrap.clientHeight; // 不传 height 时填满父容器
      if (w <= 0 || h <= 0) return;
      widthRef.current = w;
      heightRef.current = h;
      for (const ref of [l0Ref, l1Ref, l2Ref]) {
        const c = ref.current;
        if (!c) continue;
        const dpr = window.devicePixelRatio || 1;
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
        const ctx = c.getContext('2d');
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      if (!didFitRef.current) {
        fitRef.current();
        didFitRef.current = true;
      } else {
        viewRef.current.scrollY = clamp(viewRef.current.scrollY, 0, maxScrollYRef.current());
      }
      redrawRef.current();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [height]);

  /* 载入新工程 / 换 MIDI：重置纵向视口并重新适配音域 */
  useEffect(() => {
    didFitRef.current = false;
    viewRef.current.scrollTick = 0;
    fitView();
    redraw();
  }, [doc.sourceFileName, doc.time.ppq, doc.time.bpm, fitView, redraw]);

  /* [播放头动画 + 视口跟随] ------------------------------------------ */

  useEffect(() => {
    if (!isPlaying) {
      drawL2();
      return;
    }
    let raf = 0;
    const loop = () => {
      if (followPlayhead) {
        const v = viewRef.current;
        const w = widthRef.current;
        let need = false;

        // 横向：播放头跑到视口 12%~75% 之外就把视图前推
        const x = tickToX(playheadTick);
        const leftEdge = KEY_WIDTH + (w - KEY_WIDTH) * 0.12;
        const rightEdge = KEY_WIDTH + (w - KEY_WIDTH) * 0.75;
        if (playheadTick > 0 && (x < leftEdge || x > rightEdge)) {
          const visibleTicks = (w - KEY_WIDTH) * v.zoom;
          const next = Math.max(0, playheadTick - visibleTicks * 0.2);
          if (next !== v.scrollTick) {
            v.scrollTick = next;
            need = true;
          }
        }

        // 纵向：让正在发声的音块留在视野内
        for (const n of notesRef.current) {
          if (!n.enabled) continue;
          if (playheadTick < n.startTick || playheadTick >= n.startTick + n.durationTick) continue;
          if (scrollPitchIntoView(n.pitch)) need = true;
          break;
        }

        if (need) {
          drawL0();
          drawL1();
        }
      }
      drawL2();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, playheadTick, doc, followPlayhead, tickToX, scrollPitchIntoView, drawL0, drawL1, drawL2]);

  /* [交互] ---------------------------------------------------------- */

  const hitTest = useCallback((x: number, y: number): MidiNote | null => {
    const v = viewRef.current;
    const w = widthRef.current;
    const viewEndTick = v.scrollTick + (w - KEY_WIDTH) * v.zoom;
    for (let i = notesRef.current.length - 1; i >= 0; i--) {
      const n = notesRef.current[i];
      if (!n.enabled) continue;
      if (n.startTick + n.durationTick < v.scrollTick || n.startTick > viewEndTick) continue;
      const nx = tickToX(n.startTick);
      const nxEnd = tickToX(n.startTick + n.durationTick);
      const ny = pitchToY(n.pitch);
      if (x >= nx && x <= nxEnd && y >= ny && y <= ny + ROW_HEIGHT) return n;
    }
    return null;
  }, [pitchToY, tickToX]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const v = viewRef.current;

    // 左侧琴键列：按下即准备试听；拖动则纵向滚动
    if (mx <= KEY_WIDTH) {
      dragRef.current = {
        mode: 'pan',
        startX: mx, startY: my,
        baseScrollTick: v.scrollTick, baseScrollY: v.scrollY,
        noteIds: [], notesBefore: [], moved: false,
        pressedPitch: yToPitch(my),
      };
      return;
    }

    const note = hitTest(mx, my);
    if (note) {
      const additive = e.ctrlKey || e.metaKey;
      onSelectNote?.(note.id, additive);
      dragRef.current = {
        mode: 'note',
        startX: mx, startY: my,
        baseScrollTick: v.scrollTick, baseScrollY: v.scrollY,
        noteIds: additive ? [...selectedNoteIds, note.id] : [note.id],
        notesBefore: notesRef.current.map((n) => ({ ...n })),
        moved: false,
        checkpointed: false,
        hitStartTick: note.startTick,
      };
      return;
    }

    // 空白：平移（横 + 纵）
    dragRef.current = {
      mode: 'pan',
      startX: mx, startY: my,
      baseScrollTick: v.scrollTick, baseScrollY: v.scrollY,
      noteIds: [], notesBefore: [], moved: false,
    };
  }, [hitTest, onSelectNote, selectedNoteIds, yToPitch]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const dxPx = mx - d.startX;
    const dyPx = my - d.startY;
    if (!d.moved && Math.abs(dxPx) < CLICK_SLOP_PX && Math.abs(dyPx) < CLICK_SLOP_PX) return;
    d.moved = true;

    if (d.mode === 'pan') {
      const v = viewRef.current;
      // 横向：向右拖 = 内容右移 = 时间轴向前
      v.scrollTick = Math.max(0, d.baseScrollTick - dxPx * v.zoom);
      // 纵向：向下拖 = 内容下移 = 看更低的音（scrollY 减小）
      v.scrollY = clamp(d.baseScrollY - dyPx, 0, maxScrollY());
      drawL0();
      drawL1();
      drawL2();
      return;
    }

    // mode === 'note'：向上拖 → 音高升高（此处取反，是本次修复的关键）
    if (!d.checkpointed) {
      d.checkpointed = true;
      onEditStart?.();
    }
    const snap = snapTicks > 0 ? snapTicks : 1;
    const dtick = Math.round((dxPx * viewRef.current.zoom) / snap) * snap;
    const dpitch = Math.round(-dyPx / ROW_HEIGHT);

    const edited = d.notesBefore.map((n) => {
      if (!d.noteIds.includes(n.id)) return n;
      return {
        ...n,
        startTick: Math.max(0, n.startTick + dtick),
        pitch: clamp(n.pitch + dpitch, MIN_PITCH, MAX_PITCH),
      };
    });
    onNotesEdited?.(edited);
  }, [onEditStart, onNotesEdited, drawL0, drawL1, drawL2, maxScrollY, snapTicks]);

  /** 松开鼠标：未发生位移 → 视为点击（seek / 试听） */
  const onMouseUp = useCallback((e?: React.MouseEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.moved) return;
    if (d.pressedPitch !== undefined) {
      onPreviewPitch?.(d.pressedPitch);
      return;
    }
    if (e) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const mx = e.clientX - rect.left;
      if (mx <= KEY_WIDTH) return;
    }
    if (d.mode === 'note' && d.hitStartTick !== undefined) {
      onSeek?.(d.hitStartTick);
      return;
    }
    if (d.mode === 'pan' && e) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const mx = e.clientX - rect.left;
      onSeek?.(Math.round(xToTick(mx)));
    }
  }, [onPreviewPitch, onSeek, xToTick]);

  /* 滚轮：纵向滚动（主）；Ctrl/⌘ = 水平缩放；Shift = 水平平移 */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const onWheelNative = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const v = viewRef.current;
      const step = ev.deltaMode === 1 ? ev.deltaY * WHEEL_LINE_PX : ev.deltaY;

      if (ev.ctrlKey || ev.metaKey) {
        const factor = step < 0 ? 1 / 0.9 : 0.9;
        const anchorTick = xToTick(mx);
        v.zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        v.scrollTick = Math.max(0, anchorTick - (mx - KEY_WIDTH) * v.zoom);
      } else if (ev.shiftKey) {
        v.scrollTick = Math.max(0, v.scrollTick + step * v.zoom);
      } else {
        v.scrollY = clamp(v.scrollY + step, 0, maxScrollY());
      }
      redrawRef.current();
    };

    wrap.addEventListener('wheel', onWheelNative, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheelNative);
  }, [maxScrollY, xToTick]);

  /* [渲染] ---------------------------------------------------------- */

  const style: React.CSSProperties = {
    position: 'relative',
    overflow: 'hidden',
    userSelect: 'none',
    cursor: 'crosshair',
    flex: '1 1 auto',
    minHeight: 240,
    ...(height !== undefined ? { height, flex: '0 0 auto' } : {}),
  };

  return (
    <div
      ref={wrapRef}
      className="piano-roll"
      style={style}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { dragRef.current = null; }}
    >
      <canvas ref={l0Ref} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={l1Ref} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={l2Ref} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
    </div>
  );
});
