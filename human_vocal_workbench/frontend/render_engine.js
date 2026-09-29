/**
 * render_engine.js — 三层 Canvas 钢琴卷帘渲染引擎
 * 契约第 4.3 节 / 第 5 节
 *
 * 三层：
 *   L0 静态层：钢琴键 + 行背景 + 小节线 + 时间刻度
 *   L1 视口层：MIDI 音符矩形（视口裁剪，颜色按 semitone_shift 分级）
 *   L2 高频层：播放头 + 选中框
 *
 * 坐标约定：
 *   - X 轴：tick → 像素，plotX0 起（左侧 keyboardWidth 为钢琴键区）
 *   - Y 轴：MIDI pitch 越大越靠上（反向）
 */
class RenderEngine {
  constructor(wrapEl) {
    this.wrap = wrapEl;
    this.canvas = {
      l0: wrapEl.querySelector('#layer0'),
      l1: wrapEl.querySelector('#layer1'),
      l2: wrapEl.querySelector('#layer2'),
    };
    if (!this.canvas.l0 || !this.canvas.l1 || !this.canvas.l2) {
      throw new Error('缺少 canvas：需要 #layer0 / #layer1 / #layer2');
    }
    this.ctx = {
      l0: this.canvas.l0.getContext('2d'),
      l1: this.canvas.l1.getContext('2d'),
      l2: this.canvas.l2.getContext('2d'),
    };
    this.dpr = window.devicePixelRatio || 1;
    this.notes = [];
    this.selectedIds = new Set();
    this.playheadTick = 0;
    this.view = {
      startTick: 0,
      widthTick: 1920,
      pitchMin: 36,
      pitchMax: 84,
    };
    this.keyboardWidth = 60;
    this.marginTop = 20;
    this.ppq = 480;
    this.timeSig = [4, 4];
    this.onNoteChange = null;
    this.onSelectionChange = null;
    this._bindEvents();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }
  // ---- 数据 ----
  setNotes(notes) {
    this.notes = Array.isArray(notes) ? notes : [];
    this.autoFitPitch();
    this.render();
  }
  setMidiContext(ppq, timeSignature) {
    if (ppq) this.ppq = ppq;
    if (timeSignature) this.timeSig = timeSignature;
    this.renderL0();
  }
  setPlayhead(tick) {
    this.playheadTick = tick;
    this.renderL2();
  }
  autoFitPitch() {
    if (!this.notes.length) return;
    let pmin = 127, pmax = 0;
    for (const n of this.notes) {
      if (n.midi_pitch < pmin) pmin = n.midi_pitch;
      if (n.midi_pitch > pmax) pmax = n.midi_pitch;
    }
    this.view.pitchMin = Math.max(0, pmin - 3);
    this.view.pitchMax = Math.min(127, pmax + 3);
  }
  // ---- 尺寸 ----
  _resize() {
    const rect = this.wrap.getBoundingClientRect();
    const w = Math.max(200, Math.floor(rect.width));
    const h = Math.max(150, Math.floor(rect.height));
    for (const k of ['l0', 'l1', 'l2']) {
      const c = this.canvas[k];
      c.width = w * this.dpr;
      c.height = h * this.dpr;
      c.style.width = w + 'px';
      c.style.height = h + 'px';
      this.ctx[k].setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    this.W = w;
    this.H = h;
    this.render();
  }
  // ---- 坐标换算 ----
  get plotX0() { return this.keyboardWidth; }
  get plotY0() { return this.marginTop; }
  get plotW() { return Math.max(1, this.W - this.keyboardWidth); }
  get plotH() { return Math.max(1, this.H - this.marginTop); }
  get rowH() {
    const n = this.view.pitchMax - this.view.pitchMin + 1;
    return this.plotH / Math.max(1, n);
  }
  get pxPerTick() {
    return this.plotW / Math.max(1, this.view.widthTick);
  }
  tickToX(tick) { return this.plotX0 + (tick - this.view.startTick) * this.pxPerTick; }
  xToTick(x)   { return this.view.startTick + (x - this.plotX0) / this.pxPerTick; }
  pitchToY(p)  { return this.plotY0 + (this.view.pitchMax - p) * this.rowH; }
  yToPitch(y)  { return this.view.pitchMax - Math.floor((y - this.plotY0) / this.rowH); }
  // ---- 渲染 ----
  render() {
    this.renderL0();
    this.renderL1();
    this.renderL2();
  }
  renderL0() {
    const ctx = this.ctx.l0;
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, this.W, this.H);
    const blackKeys = new Set([1, 3, 6, 8, 10]);
    // 行背景（plot 区）
    for (let p = this.view.pitchMin; p <= this.view.pitchMax; p++) {
      const y = this.pitchToY(p);
      ctx.fillStyle = blackKeys.has(p % 12) ? '#151515' : '#1d1d1d';
      ctx.fillRect(this.plotX0, y, this.plotW, this.rowH);
    }
    // 钢琴键
    for (let p = this.view.pitchMin; p <= this.view.pitchMax; p++) {
      const y = this.pitchToY(p);
      const isBlack = blackKeys.has(p % 12);
      ctx.fillStyle = isBlack ? '#0a0a0a' : '#e5e5e5';
      ctx.fillRect(0, y, this.keyboardWidth, this.rowH);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(0.25, y + 0.25, this.keyboardWidth - 0.5, this.rowH - 0.5);
      if (!isBlack && this.rowH >= 8) {
        ctx.fillStyle = '#666';
        ctx.font = '9px monospace';
        ctx.fillText(pitchName(p), 4, y + this.rowH - 2);
      }
    }
    // 小节线 + 刻度
    const ticksPerBeat = this.ppq;
    const ticksPerBar = ticksPerBeat * this.timeSig[0] * 4 / this.timeSig[1];
    const startBar = Math.floor(this.view.startTick / ticksPerBar);
    const endTick = this.view.startTick + this.view.widthTick;
    const endBar = Math.ceil(endTick / ticksPerBar);
    ctx.strokeStyle = '#333';
    ctx.fillStyle = '#777';
    ctx.font = '10px monospace';
    for (let b = startBar; b <= endBar; b++) {
      const x = this.tickToX(b * ticksPerBar);
      if (x < this.plotX0 - 1 || x > this.W) continue;
      ctx.beginPath();
      ctx.moveTo(x, this.plotY0);
      ctx.lineTo(x, this.H);
      ctx.stroke();
      if (this.plotY0 >= 12) ctx.fillText('#' + (b + 1), x + 3, this.plotY0 - 6);
    }
    // 键盘右边界线
    ctx.strokeStyle = '#444';
    ctx.beginPath();
    ctx.moveTo(this.plotX0, 0);
    ctx.lineTo(this.plotX0, this.H);
    ctx.stroke();
    // 顶部时间轴分界
    ctx.strokeStyle = '#333';
    ctx.beginPath();
    ctx.moveTo(0, this.plotY0);
    ctx.lineTo(this.W, this.plotY0);
    ctx.stroke();
  }
  renderL1() {
    const ctx = this.ctx.l1;
    ctx.clearRect(0, 0, this.W, this.H);
    const startTick = this.view.startTick;
    const endTick = startTick + this.view.widthTick;
    for (const n of this.notes) {
      const nEnd = n.start_tick + n.duration_tick;
      if (nEnd < startTick || n.start_tick > endTick) continue;
      const x = this.tickToX(n.start_tick);
      const y = this.pitchToY(n.midi_pitch);
      const w = Math.max(2, this.pxPerTick * n.duration_tick);
      const h = Math.max(3, this.rowH - 1);
      const shift = (n.slice_ref && typeof n.slice_ref.semitone_shift === 'number')
        ? n.slice_ref.semitone_shift : 0;
      const a = Math.abs(shift);
      let fill = '#4ade80';
      if (a >= 8) fill = '#ef4444';
      else if (a >= 5) fill = '#facc15';
      ctx.globalAlpha = n.enabled === false ? 0.25 : 1.0;
      ctx.fillStyle = fill;
      ctx.fillRect(x, y + 0.5, w, h);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 1, w - 1, h - 1);
      ctx.globalAlpha = 1.0;
      if (this.selectedIds.has(n.note_id)) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1.5, w - 2, h - 2);
        ctx.lineWidth = 1;
      }
    }
  }
  renderL2() {
    const ctx = this.ctx.l2;
    ctx.clearRect(0, 0, this.W, this.H);
    const x = this.tickToX(this.playheadTick);
    if (x >= this.plotX0 && x <= this.W) {
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, this.plotY0);
      ctx.lineTo(x, this.H);
      ctx.stroke();
      ctx.lineWidth = 1;
      // 顶部三角指示
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.moveTo(x - 4, this.plotY0);
      ctx.lineTo(x + 4, this.plotY0);
      ctx.lineTo(x, this.plotY0 + 6);
      ctx.closePath();
      ctx.fill();
    }
  }
  // ---- 交互 ----
  _bindEvents() {
    const l2 = this.canvas.l2;
    let drag = null;
    l2.addEventListener('mousedown', (e) => {
      const rect = l2.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (mx < this.plotX0 || my < this.plotY0) return;
      const hit = this._hitTest(mx, my);
      if (hit) {
        this.selectedIds.clear();
        this.selectedIds.add(hit.note_id);
        drag = {
          kind: 'note',
          note: hit,
          startMouseX: mx,
          startMouseY: my,
          startTick: hit.start_tick,
          startPitch: hit.midi_pitch,
          moved: false,
        };
      } else {
        this.selectedIds.clear();
        drag = {
          kind: 'pan',
          startMouseX: mx,
          startTick: this.view.startTick,
        };
      }
      if (this.onSelectionChange) {
        this.onSelectionChange(Array.from(this.selectedIds));
      }
      this.renderL1();
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const rect = l2.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (drag.kind === 'pan') {
        const dx = mx - drag.startMouseX;
        if (Math.abs(dx) < 2 && !drag.moved) return;
        drag.moved = true;
        const dt = -dx / this.pxPerTick;
        this.view.startTick = Math.max(0, drag.startTick + dt);
        this.render();
        return;
      }
      if (drag.kind === 'note') {
        const dx = mx - drag.startMouseX;
        const dy = drag.startMouseY - my; // 反向：鼠标向上 → 音高增加
        const dt = Math.round(dx / this.pxPerTick);
        const dp = Math.round(dy / this.rowH);
        const n = drag.note;
        n.start_tick = Math.max(0, drag.startTick + dt);
        n.midi_pitch = Math.max(0, Math.min(127, drag.startPitch + dp));
        if (dt !== 0 || dp !== 0) drag.moved = true;
        this.renderL1();
      }
    });
    window.addEventListener('mouseup', () => {
      if (drag && drag.kind === 'note' && drag.moved && this.onNoteChange) {
        this.onNoteChange(drag.note);
      }
      drag = null;
    });
    l2.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = l2.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      if (e.ctrlKey || e.metaKey) {
        const tickAtMouse = this.xToTick(mx);
        const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
        this.view.widthTick = Math.max(120, Math.min(96000, this.view.widthTick * factor));
        this.view.startTick = Math.max(
          0,
          tickAtMouse - (mx - this.plotX0) / this.pxPerTick
        );
      } else {
        this.view.startTick = Math.max(0, this.view.startTick + e.deltaY * 2);
      }
      this.render();
    }, { passive: false });
  }
  _hitTest(mx, my) {
    const tick = this.xToTick(mx);
    const pitch = this.yToPitch(my);
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (n.midi_pitch !== pitch) continue;
      if (tick >= n.start_tick && tick <= n.start_tick + n.duration_tick) {
        return n;
      }
    }
    return null;
  }
}
function pitchName(p) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const oct = Math.floor(p / 12) - 1;
  return names[((p % 12) + 12) % 12] + oct;
}
