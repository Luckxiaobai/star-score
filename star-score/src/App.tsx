/* ================================================================
 * 星谱识音 · 主应用组件
 * ----------------------------------------------------------------
 * 职责：状态管理 + 事件编排 + 布局组合
 *
 * 目录（搜索关键词快速定位）：
 *   [IMPORTS]     导入
 *   [TYPES]       类型定义
 *   [STATE]       状态声明
 *   [EFFECTS]     副作用
 *   [ACTIONS]     用户操作处理（输入/播放/导出/光标）
 *   [KEYBOARD]    全局键盘事件
 *   [RENDER]      JSX 渲染
 * ================================================================ */

/* [IMPORTS] 导入 */
import { useState, useEffect, useRef, useCallback } from 'react';
import type { Duration, Pitch, Score } from './types/score';
import { shorterDuration, longerDuration, noteDurationSeconds } from './core/theory/musicTheory';
import { AudioEngine } from './core/engine/AudioEngine';
import { useScore } from './hooks/useScore';
import { Toolbar } from './components/Toolbar';
import { ScoreRenderer } from './components/ScoreRenderer';
import { Sidebar } from './components/Sidebar';
import { AudioImport } from './components/AudioImport';
import { ModelManager } from './components/ModelManager';
import { HumanVWorkbench } from './components/HumanVWorkbench';
import { exportJSON, exportMIDI, exportPDF } from './utils/exporters';

/* 样式：全局基础 + 谱面渲染 + 音频对话框 + 模型管理 */
import './styles/global.css';
import './styles/score.css';
import './styles/audioImport.css';
import './styles/modelManager.css';
import './styles/humanv.css';
import './styles/lab-ui.css';

/* [TYPES] 类型定义 */
type ModalType = 'none' | 'help' | 'audio' | 'models';

export default function App() {
  /* [STATE] 状态声明 */
  const scoreState = useScore();
  const { score } = scoreState;

  const [currentDuration, setCurrentDuration] = useState<Duration>('quarter');
  const [selectedMeasure, setSelectedMeasure] = useState(0);
  const [selectedNote, setSelectedNote] = useState(0);
  const [cursorMeasure, setCursorMeasure] = useState(0);
  const [cursorNote, setCursorNote] = useState(0);
  const [playingMeasure, setPlayingMeasure] = useState(-1);
  const [playingNote, setPlayingNote] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [modal, setModal] = useState<ModalType>('none');
  const [toast, setToast] = useState('');
  const [view, setView] = useState<'score' | 'humanv'>('score');

  const audioRef = useRef<AudioEngine | null>(null);

  /* [EFFECTS] 副作用 */
  // 初始化音频引擎
  useEffect(() => {
    audioRef.current = new AudioEngine();
    return () => { audioRef.current?.stop(); };
  }, []);

  // showToast 工具函数（被多个 action 依赖，需先声明）
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2000);
  }, []);

  /* [ACTIONS] 用户操作处理 ------------------------------------------ */
  /* 子目录：
   *   moveCursor      光标导航（左/右）
   *   insertPitch     插入音符（数字键 / 软键盘触发）
   *   startPlayback   开始播放
   *   stopPlayback    停止播放
   *   handleNoteClick 点击音符选中
   *   handleMeasureClick 点击小节定位
   *   handleExport    导出（PDF/MIDI/JSON/PNG）
   *   handleAudioResult 音频识别结果处理
   * ---------------------------------------------------------------- */

  /* --- 光标导航 --- */
  const moveCursor = useCallback((dir: 'left' | 'right') => {
    if (dir === 'left') {
      if (cursorNote > 0) {
        setCursorNote(cursorNote - 1);
      } else if (cursorMeasure > 0) {
        const prevM = cursorMeasure - 1;
        setCursorMeasure(prevM);
        setCursorNote(Math.max(0, score.measures[prevM]?.notes.length || 0));
      }
    } else {
      const m = score.measures[cursorMeasure];
      if (m && cursorNote < m.notes.length) {
        setCursorNote(cursorNote + 1);
      } else if (cursorMeasure < score.measures.length - 1) {
        setCursorMeasure(cursorMeasure + 1);
        setCursorNote(0);
      }
    }
  }, [cursorNote, cursorMeasure, score.measures]);

  /* --- 插入音符 --- */
  const insertPitch = useCallback((pitch: Pitch) => {
    // 确保 AudioContext 在用户交互中被激活
    audioRef.current?.unlock();
    scoreState.insertNote(pitch, currentDuration, cursorMeasure, cursorNote);
    setSelectedMeasure(cursorMeasure);
    setSelectedNote(cursorNote);
    setCursorNote(cursorNote + 1);

    // 试听
    const newNote = { pitch, octave: 0, duration: currentDuration, dotted: false, accidental: 'none' as const, tie: 'none' as const };
    audioRef.current?.previewNote(newNote as any, score);
  }, [scoreState, currentDuration, cursorMeasure, cursorNote, score]);

  /* --- 播放控制 --- */
  /** 「第 mi 小节第 ni 个音符」的起始秒数：用于从光标位置起播 */
  const noteStartSec = useCallback((measureIdx: number, noteIdx: number): number => {
    const bpm = score.metadata.tempo;
    let t = 0;
    for (let mi = 0; mi < score.measures.length; mi++) {
      const m = score.measures[mi];
      for (let ni = 0; ni < m.notes.length; ni++) {
        if (mi === measureIdx && ni === noteIdx) return t;
        t += noteDurationSeconds(m.notes[ni], bpm);
      }
    }
    return t;
  }, [score]);

  const startPlayback = useCallback(() => {
    const audibleNotes = score.measures.reduce(
      (sum, m) => sum + m.notes.filter((n) => n.pitch !== 0).length,
      0
    );
    if (audibleNotes === 0) {
      showToast('谱面还没有音符：先点「示例」，或识别一段音频');
      return;
    }
    // 从当前光标位置起播：点中某个音符后再按播放 = 从那里开始
    const fromSec = noteStartSec(cursorMeasure, cursorNote);
    // 确保 AudioContext 在用户点击的上下文中被激活
    audioRef.current?.unlock();
    audioRef.current?.playScore(score, {
      onNoteStart: (mi, ni) => {
        setPlayingMeasure(mi);
        setPlayingNote(ni);
      },
      onEnd: () => {
        setIsPlaying(false);
        setPlayingMeasure(-1);
        setPlayingNote(-1);
      },
      onError: (msg) => {
        setIsPlaying(false);
        setPlayingMeasure(-1);
        setPlayingNote(-1);
        showToast(msg);
      },
    }, fromSec);
    setIsPlaying(true);
  }, [score, showToast, noteStartSec, cursorMeasure, cursorNote]);

  const stopPlayback = useCallback(() => {
    audioRef.current?.stop();
    setIsPlaying(false);
    setPlayingMeasure(-1);
    setPlayingNote(-1);
  }, []);

  /* [KEYBOARD] 全局键盘事件 ------------------------------------------ */
  /* 快捷键映射：
   *   0-7      → 输入音符 / 休止
   *   ← →      → 光标移动
   *   ↑ ↓      → 升降八度
   *   Q / E    → 缩短 / 延长时值
   *   W        → 附点切换
   *   Space    → 播放 / 停止
   *   Delete   → 删除音符
   *   Ctrl+Z   → 撤销  Ctrl+Shift+Z → 重做
   * ---------------------------------------------------------------- */
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // 忽略输入框中的键盘事件
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
      // 只在简谱视图响应快捷键：两视图现在常挂载，避免在 MIDI 工作台里误改谱面
      if (view !== 'score') return;

      // Ctrl 组合键
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || e.key === 'Z') {
          e.preventDefault();
          if (e.shiftKey) scoreState.redo(); else scoreState.undo();
          return;
        }
        if (e.key === 'y' || e.key === 'Y') {
          e.preventDefault();
          scoreState.redo();
          return;
        }
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          showToast('已自动保存');
          return;
        }
        return;
      }

      // 数字键 0-7: 输入音符
      if (e.key >= '0' && e.key <= '7') {
        e.preventDefault();
        insertPitch(Number(e.key) as Pitch);
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          moveCursor('left');
          break;
        case 'ArrowRight':
          e.preventDefault();
          moveCursor('right');
          break;
        case 'ArrowUp':
          e.preventDefault();
          scoreState.shiftOctave(selectedMeasure, selectedNote, 1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          scoreState.shiftOctave(selectedMeasure, selectedNote, -1);
          break;
        case 'q': case 'Q':
          e.preventDefault();
          setCurrentDuration(d => shorterDuration(d));
          break;
        case 'e': case 'E':
          e.preventDefault();
          setCurrentDuration(d => longerDuration(d));
          break;
        case 'w': case 'W':
          e.preventDefault();
          scoreState.toggleDot(selectedMeasure, selectedNote);
          break;
        case ' ':
          e.preventDefault();
          if (isPlaying) { stopPlayback(); } else { startPlayback(); }
          break;
        case 'Delete': case 'Backspace':
          e.preventDefault();
          scoreState.deleteNote(selectedMeasure, selectedNote);
          if (selectedNote > 0) {
            setSelectedNote(selectedNote - 1);
            setCursorNote(cursorNote > 0 ? cursorNote - 1 : 0);
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [insertPitch, moveCursor, scoreState, selectedMeasure, selectedNote, cursorNote, isPlaying, currentDuration, startPlayback, stopPlayback, view]);

  /* [ACTIONS 继续] ------------------------------------------ */

  /* --- 点击音符选中 --- */
  const handleNoteClick = useCallback((mi: number, ni: number) => {
    setSelectedMeasure(mi);
    setSelectedNote(ni);
    setCursorMeasure(mi);
    setCursorNote(ni + 1);
  }, []);

  const handleMeasureClick = useCallback((mi: number) => {
    setSelectedMeasure(mi);
    setCursorMeasure(mi);
    setCursorNote(score.measures[mi]?.notes.length || 0);
  }, [score.measures]);

  /* --- 导出 --- */
  const handleExport = useCallback((format: 'pdf' | 'png' | 'midi' | 'json') => {
    switch (format) {
      case 'pdf':
        exportPDF();
        showToast('正在准备打印...');
        break;
      case 'midi':
        exportMIDI(score);
        showToast('MIDI 已导出');
        break;
      case 'json':
        exportJSON(score);
        showToast('JSON 已导出');
        break;
      case 'png':
        showToast('SVG 导出...');
        break;
    }
  }, [score, showToast]);

  /* --- 软键盘配置 --- */
  const softKeys: { label: string; sub?: string; action: () => void; wide?: boolean }[] = [
    { label: '1', sub: 'do', action: () => insertPitch(1) },
    { label: '2', sub: 're', action: () => insertPitch(2) },
    { label: '3', sub: 'mi', action: () => insertPitch(3) },
    { label: '4', sub: 'fa', action: () => insertPitch(4) },
    { label: '5', sub: 'sol', action: () => insertPitch(5) },
    { label: '6', sub: 'la', action: () => insertPitch(6) },
    { label: '7', sub: 'si', action: () => insertPitch(7) },
    { label: '0', sub: '休止', action: () => insertPitch(0) },
    { label: '↑', action: () => scoreState.shiftOctave(selectedMeasure, selectedNote, 1) },
    { label: '↓', action: () => scoreState.shiftOctave(selectedMeasure, selectedNote, -1) },
    { label: '←', action: () => moveCursor('left') },
    { label: '→', action: () => moveCursor('right') },
    { label: '?', action: () => isPlaying ? stopPlayback() : startPlayback(), wide: true },
    { label: '×', action: () => scoreState.deleteNote(selectedMeasure, selectedNote), wide: true },
  ];

  const selectedNoteData = score.measures[selectedMeasure]?.notes[selectedNote];

  /* --- 音频识别结果处理 --- */
  const handleAudioResult = useCallback((newScore: Score, analysis: any) => {
    scoreState.updateScore(() => newScore);
    setModal('none');
    setSelectedMeasure(0);
    setSelectedNote(0);
    setCursorMeasure(0);
    setCursorNote(0);
    showToast(`识别完成: ${analysis.estimatedKey} ${analysis.estimatedTempo}BPM, ${analysis.notes.length}个音符`);
  }, [scoreState, showToast]);

  /* --- 人力V工作台：MIDI 转简谱回调 --- */
  const handleScoreFromHumanV = useCallback((newScore: Score) => {
    scoreState.updateScore(() => newScore);
    setView('score');
    setSelectedMeasure(0);
    setSelectedNote(0);
    setCursorMeasure(0);
    setCursorNote(0);
    showToast('已从 MIDI 生成简谱，可继续编辑');
  }, [scoreState, showToast]);

  /* [RENDER] JSX 渲染 ----------------------------------------------- */
  /* 布局层次：
   *   <div .app>
   *     ├─ <header .app-header>         品牌 + 全局操作
   *     ├─ <Toolbar>                    编辑工具栏
   *     ├─ <div .app-body>
   *     │   ├─ <div .editor-main>       编辑器
   *     │   │   ├─ .editor-toolbar     曲目信息条
   *     │   │   ├─ .editor-canvas      谱面画布（ScoreRenderer）
   *     │   │   └─ .soft-keyboard      底部软键盘
   *     │   └─ <Sidebar>               右侧属性/歌词/和弦
   *     ├─ <footer .statusbar>          底部状态栏
   *     ├─ <AudioImport> (modal)        音频识别弹窗
   *     ├─ help modal                   快捷键弹窗
   *     └─ .toast                       浮动提示
   * ---------------------------------------------------------------- */
  return (
    <div className="app">
      {/* 顶部标题栏 */}
      <header className="app-header">
        <div className="app-logo">
          <div className="app-logo-icon">谱</div>
          <span>星谱识音</span>
        </div>
        <div className="app-view-switch">
          <button
            className={`btn btn-sm ${view === 'score' ? 'btn-primary' : ''}`}
            onClick={() => setView('score')}
          >
            简谱编辑器
          </button>
          <button
            className={`btn btn-sm ${view === 'humanv' ? 'btn-primary' : ''}`}
            onClick={() => setView('humanv')}
          >
            人声合成
          </button>
        </div>
        <div className="app-actions">
          <button className="btn btn-sm btn-primary" onClick={() => setModal('audio')}>
            ? 音频识别
          </button>
          <button className="btn btn-sm" onClick={() => setModal('help')}>快捷键</button>
        </div>
      </header>

      {/* ===== 视图一：简谱编辑器（常挂载，切视图只隐藏，避免状态丢失） ===== */}
      <div
        className="view-pane"
        style={{ display: view === 'score' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}
      >
      {/* 工具栏 */}
      <Toolbar
        score={score}
        currentDuration={currentDuration}
        onDurationChange={setCurrentDuration}
        onMetadataChange={scoreState.updateMetadata}
        onTranspose={scoreState.transpose}
        onAddMeasure={() => scoreState.addMeasure(cursorMeasure)}
        onDeleteMeasure={scoreState.deleteMeasure}
        selectedMeasure={selectedMeasure}
        onPlay={startPlayback}
        onStop={stopPlayback}
        isPlaying={isPlaying}
        onUndo={scoreState.undo}
        onRedo={scoreState.redo}
        canUndo={scoreState.canUndo}
        canRedo={scoreState.canRedo}
        onExport={handleExport}
        onClear={scoreState.clearScore}
        onLoadDemo={scoreState.loadDemo}
        onShowHelp={() => setModal('help')}
        onShowModels={() => setModal('models')}
      />

      {/* 编辑器 */}
      <div className="app-body">
        <div className="editor-main">
          <div className="editor-toolbar">
            <span className="editor-track-info">
              {score.metadata.title}{score.metadata.artist ? ` - ${score.metadata.artist}` : ''}
            </span>
            <div className="editor-duration-info">
              <span>时值: {currentDuration}</span>
            </div>
          </div>

          <div className="editor-canvas">
            <ScoreRenderer
              score={score}
              selectedMeasure={selectedMeasure}
              selectedNote={selectedNote}
              cursorMeasure={cursorMeasure}
              cursorNote={cursorNote}
              playingMeasure={playingMeasure}
              playingNote={playingNote}
              onNoteClick={handleNoteClick}
              onMeasureClick={handleMeasureClick}
            />
          </div>

          {/* 软键盘 */}
          <div className="soft-keyboard">
            <div className="soft-key-row">
              {softKeys.slice(0, 8).map((k, i) => (
                <button key={i} className="soft-key" onClick={k.action} title={k.sub}>
                  {k.label}
                </button>
              ))}
            </div>
            <div className="soft-key-row">
              {softKeys.slice(8).map((k, i) => (
                <button
                  key={i}
                  className={`soft-key ${k.wide ? 'soft-key-wide' : ''}`}
                  onClick={k.action}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 侧边栏 */}
        <Sidebar
          score={score}
          selectedMeasure={selectedMeasure}
          selectedNote={selectedNote}
          onMetadataChange={scoreState.updateMetadata}
          onSetLyric={scoreState.setLyric}
          onSetChord={scoreState.setChord}
        />
      </div>

      {/* 状态栏 */}
      <footer className="statusbar">
        <div className="statusbar-left">
          <span>第 {cursorMeasure + 1} 小节</span>
          <span>光标位置: {cursorNote + 1}</span>
        </div>
        <div className="statusbar-right">
          {selectedNoteData && (
            <span>
              选中: {selectedNoteData.pitch === 0 ? '休止' : selectedNoteData.pitch}
              {selectedNoteData.octave > 0 && ' 高'}{selectedNoteData.octave < 0 && ' 低'}
              {' '}{selectedNoteData.duration}
              {selectedNoteData.dotted && '·'}
            </span>
          )}
          <span>{score.measures.length} 小节</span>
          <span>{scoreState.canUndo ? '可撤销' : '─'}</span>
        </div>
      </footer>
      </div>

      {/* ===== 视图二：人力V工作台（常挂载：切到简谱时仅隐藏，MIDI 工程不会丢） ===== */}
      <div className="view-pane" style={{ display: view === 'humanv' ? 'block' : 'none' }}>
        <HumanVWorkbench onScoreGenerated={handleScoreFromHumanV} />
      </div>

      {/* 音频导入模态框 */}
      {modal === 'audio' && (
        <AudioImport onResult={handleAudioResult} onClose={() => setModal('none')} />
      )}

      {/* 模型管理弹窗 */}
      {modal === 'models' && (
        <ModelManager onClose={() => setModal('none')} />
      )}

      {/* 帮助模态框 */}
      {modal === 'help' && (
        <div className="modal-overlay" onClick={() => setModal('none')}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">快捷键 & 使用说明</div>
            <div className="modal-body help-content">
              <h4>音符输入</h4>
              <table>
                <tr><td>1 - 7</td><td>输入 do re mi fa sol la si</td></tr>
                <tr><td>0</td><td>输入休止符</td></tr>
                <tr><td>↑ / ↓</td><td>升高 / 降低八度</td></tr>
                <tr><td>Q / E</td><td>缩短 / 延长时值</td></tr>
                <tr><td>W</td><td>切换附点</td></tr>
              </table>
              <h4>导航</h4>
              <table>
                <tr><td>← / →</td><td>移动光标</td></tr>
                <tr><td>点击音符</td><td>选中该音符</td></tr>
                <tr><td>点击小节</td><td>定位到该小节末尾</td></tr>
              </table>
              <h4>播放 & 编辑</h4>
              <table>
                <tr><td>Space</td><td>播放 / 停止</td></tr>
                <tr><td>Delete</td><td>删除选中音符</td></tr>
                <tr><td>Ctrl+Z</td><td>撤销</td></tr>
                <tr><td>Ctrl+Shift+Z</td><td>重做</td></tr>
                <tr><td>Ctrl+S</td><td>手动保存</td></tr>
              </table>
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => setModal('none')}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
