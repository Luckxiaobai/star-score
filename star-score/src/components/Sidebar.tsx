/* ================================================================
 * 星谱识音 · 侧边栏组件
 * ----------------------------------------------------------------
 * 职责：谱面信息编辑 + 选中音符属性 + 歌词和弦 + 统计 + 快捷键
 *
 * 目录（搜索关键词快速定位）：
 *   [IMPORTS]    导入
 *   [TYPES]      Props 类型定义
 *   [STATE]      局部状态
 *   [EFFECTS]    副作用（同步选中音符到输入框）
 *   [RENDER]     JSX 渲染（4 个区块）
 * ================================================================ */

/* [IMPORTS] 导入 */
import React, { useState } from 'react';
import type { Score } from '../types/score';

/* [TYPES] Props 类型定义 */
interface SidebarProps {
  score: Score;
  selectedMeasure: number;
  selectedNote: number;
  onMetadataChange: (updates: Partial<Score['metadata']>) => void;
  onSetLyric: (m: number, n: number, lyric: string) => void;
  onSetChord: (m: number, n: number, chord: string) => void;
}

/* [RENDER] 组件主体 */
export const Sidebar: React.FC<SidebarProps> = ({
  score, selectedMeasure, selectedNote,
  onMetadataChange, onSetLyric, onSetChord,
}) => {
  /* [STATE] 局部状态 */
  const selectedNoteData = score.measures[selectedMeasure]?.notes[selectedNote];
  const [lyricInput, setLyricInput] = useState('');
  const [chordInput, setChordInput] = useState('');

  /* [EFFECTS] 副作用：选中音符变化时同步输入框 */
  React.useEffect(() => {
    setLyricInput(selectedNoteData?.lyric ?? '');
    setChordInput(selectedNoteData?.chord ?? '');
  }, [selectedMeasure, selectedNote, selectedNoteData?.lyric, selectedNoteData?.chord]);

  /* [RENDER] JSX 渲染 */
  /* 渲染区块：
   *   1. 谱面信息（曲名 / 作者）
   *   2. 选中音符属性（大号显示 + 歌词 + 和弦 + 快捷和弦）
   *   3. 统计（小节 / 音符 / 调 / 拍 / 速度）
   *   4. 快捷键提示
   */
  return (
    <div className="sidebar">
      {/* 1. 谱面信息 */}
      <div className="sidebar-section">
        <div className="sidebar-title">谱面信息</div>
        <div className="sidebar-stack">
          <div className="sidebar-field">
            <input
              type="text"
              className="sidebar-input"
              placeholder="曲名"
              value={score.metadata.title}
              onChange={e => onMetadataChange({ title: e.target.value })}
            />
          </div>
          <div className="sidebar-field">
            <input
              type="text"
              className="sidebar-input"
              placeholder="作者/演唱者"
              value={score.metadata.artist}
              onChange={e => onMetadataChange({ artist: e.target.value })}
            />
          </div>
        </div>
      </div>

      {/* 2. 选中音符属性 */}
      <div className="sidebar-section">
        <div className="sidebar-title">选中音符</div>
        {selectedNoteData ? (
          <div className="sidebar-stack">
            {/* 大号显示 */}
            <div className="sidebar-note-display">
              {selectedNoteData.pitch === 0 ? '0' : selectedNoteData.pitch}
              {selectedNoteData.octave > 0 && ' ↑'.repeat(selectedNoteData.octave)}
              {selectedNoteData.octave < 0 && ' ↓'.repeat(-selectedNoteData.octave)}
            </div>

            {/* 歌词 */}
            <div className="sidebar-field">
              <label className="input-label">歌词</label>
              <input
                type="text"
                className="sidebar-input"
                placeholder="输入歌词"
                value={lyricInput}
                onChange={e => setLyricInput(e.target.value)}
                onBlur={() => onSetLyric(selectedMeasure, selectedNote, lyricInput)}
                onKeyDown={e => { if (e.key === 'Enter') onSetLyric(selectedMeasure, selectedNote, lyricInput); }}
              />
            </div>

            {/* 和弦 */}
            <div className="sidebar-field">
              <label className="input-label">和弦</label>
              <input
                type="text"
                className="sidebar-input"
                placeholder="如 C, Am, G7"
                value={chordInput}
                onChange={e => setChordInput(e.target.value)}
                onBlur={() => onSetChord(selectedMeasure, selectedNote, chordInput)}
                onKeyDown={e => { if (e.key === 'Enter') onSetChord(selectedMeasure, selectedNote, chordInput); }}
              />
            </div>

            {/* 快捷和弦 */}
            <div className="sidebar-chord-quick">
              {['C', 'Dm', 'Em', 'F', 'G', 'Am', 'G7', 'Cmaj7'].map(c => (
                <button key={c} className="btn btn-sm" onClick={() => { setChordInput(c); onSetChord(selectedMeasure, selectedNote, c); }}>
                  {c}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="sidebar-empty">点击音符以编辑属性</div>
        )}
      </div>

      {/* 3. 统计 */}
      <div className="sidebar-section">
        <div className="sidebar-title">统计</div>
        <div className="sidebar-stats">
          <div>小节数: {score.measures.length}</div>
          <div>音符数: {score.measures.reduce((s, m) => s + m.notes.length, 0)}</div>
          <div>调: {score.metadata.key}</div>
          <div>拍: {score.metadata.timeNumerator}/{score.metadata.timeDenominator}</div>
          <div>速度: ♩={score.metadata.tempo}</div>
        </div>
      </div>

      {/* 4. 快捷键提示 */}
      <div className="sidebar-section" style={{ flex: 1, overflow: 'auto' }}>
        <div className="sidebar-title">快捷键</div>
        <div className="sidebar-shortcuts">
          <div><code>1-7</code>输入音符</div>
          <div><code>0</code>休止符</div>
          <div><code>←→</code>移动光标</div>
          <div><code>↑↓</code>升降八度</div>
          <div><code>Q/E</code>缩短/延长时值</div>
          <div><code>W</code>附点</div>
          <div><code>Space</code>播放/停止</div>
          <div><code>Del</code>删除音符</div>
          <div><code>Ctrl+Z</code>撤销</div>
          <div><code>Ctrl+Y</code>重做</div>
        </div>
      </div>
    </div>
  );
};
