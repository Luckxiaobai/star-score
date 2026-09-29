/* ================================================================
 * 星谱识音 · 工具栏组件
 * ----------------------------------------------------------------
 * 职责：编辑操作 + 调号拍号选择 + 播放控制 + 导出
 *
 * 目录（搜索关键词快速定位）：
 *   [IMPORTS]    导入
 *   [TYPES]      Props 类型定义
 *   [RENDER]     JSX 渲染（按 toolbar-group 分组）
 *
 * 工具栏分组（从左到右）：
 *   1. 文件操作（示例 / 清空）
 *   2. 编辑（撤销 / 重做）
 *   3. 调号
 *   4. 拍号
 *   5. 速度
 *   6. 时值
 *   7. 移调（半音 / 八度）
 *   8. 小节（添加 / 删除）
 *   9. 播放 / 停止
 *  10. 导出（PDF / 图片 / MIDI / JSON）
 *  11. 帮助
 * ================================================================ */

/* [IMPORTS] 导入 */
import React from 'react';
import type { Score, Duration } from '../types/score';
import { KEYS } from '../types/score';
import { DURATION_LIST, DURATION_LABELS } from '../core/theory/musicTheory';

/* [TYPES] Props 类型定义 */
interface ToolbarProps {
  score: Score;
  currentDuration: Duration;
  onDurationChange: (d: Duration) => void;
  onMetadataChange: (updates: Partial<Score['metadata']>) => void;
  onTranspose: (semitones: number) => void;
  onAddMeasure: () => void;
  onDeleteMeasure: (idx: number) => void;
  selectedMeasure: number;
  onPlay: () => void;
  onStop: () => void;
  isPlaying: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onExport: (format: 'pdf' | 'png' | 'midi' | 'json') => void;
  onClear: () => void;
  onLoadDemo: () => void;
  onShowHelp: () => void;
  onShowModels: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  score, currentDuration, onDurationChange, onMetadataChange, onTranspose,
  onAddMeasure, onDeleteMeasure, selectedMeasure, onPlay, onStop, isPlaying,
  onUndo, onRedo, canUndo, canRedo, onExport, onClear, onLoadDemo, onShowHelp, onShowModels,
}) => {
  /* [RENDER] JSX 渲染 */
  return (
    <div className="toolbar">
      {/* 文件操作 */}
      <div className="toolbar-group">
        <button className="btn btn-sm" onClick={onLoadDemo} title="加载示例">示例</button>
        <button className="btn btn-sm btn-danger" onClick={onClear} title="清空">清空</button>
      </div>

      {/* 编辑 */}
      <div className="toolbar-group">
        <button className="btn btn-sm btn-icon" onClick={onUndo} disabled={!canUndo} title="撤销 (Ctrl+Z)">↶</button>
        <button className="btn btn-sm btn-icon" onClick={onRedo} disabled={!canRedo} title="重做 (Ctrl+Y)">↷</button>
      </div>

      {/* 调号 */}
      <div className="toolbar-group">
        <span className="input-label">调</span>
        <select value={score.metadata.key} onChange={e => onMetadataChange({ key: e.target.value })}>
          {KEYS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>

      {/* 拍号 */}
      <div className="toolbar-group">
        <span className="input-label">拍</span>
        <select
          value={`${score.metadata.timeNumerator}/${score.metadata.timeDenominator}`}
          onChange={e => {
            const [n, d] = e.target.value.split('/').map(Number);
            onMetadataChange({ timeNumerator: n, timeDenominator: d });
          }}
        >
          <option value="2/4">2/4</option>
          <option value="3/4">3/4</option>
          <option value="4/4">4/4</option>
          <option value="3/8">3/8</option>
          <option value="6/8">6/8</option>
        </select>
      </div>

      {/* 速度 */}
      <div className="toolbar-group">
        <span className="input-label">速度</span>
        <input
          type="number"
          min={40}
          max={240}
          value={score.metadata.tempo}
          onChange={e => onMetadataChange({ tempo: Number(e.target.value) })}
          style={{ width: 56 }}
        />
      </div>

      {/* 时值 */}
      <div className="toolbar-group">
        <span className="input-label">时值</span>
        <select value={currentDuration} onChange={e => onDurationChange(e.target.value as Duration)}>
          {DURATION_LIST.map(d => <option key={d} value={d}>{DURATION_LABELS[d]}</option>)}
        </select>
      </div>

      {/* 移调 */}
      <div className="toolbar-group">
        <span className="input-label">移调</span>
        <button className="btn btn-sm" onClick={() => onTranspose(-1)}>♭</button>
        <button className="btn btn-sm" onClick={() => onTranspose(1)}>♯</button>
        <button className="btn btn-sm" onClick={() => onTranspose(-12)}>-O</button>
        <button className="btn btn-sm" onClick={() => onTranspose(12)}>+O</button>
      </div>

      {/* 小节 */}
      <div className="toolbar-group">
        <button className="btn btn-sm" onClick={onAddMeasure} title="添加小节">+小节</button>
        <button className="btn btn-sm btn-danger" onClick={() => onDeleteMeasure(selectedMeasure)} title="删除当前小节">-小节</button>
      </div>

      {/* 播放 */}
      <div className="toolbar-group">
        {isPlaying ? (
          <button className="btn btn-sm btn-primary" onClick={onStop}>⏹ 停止</button>
        ) : (
          <button className="btn btn-sm btn-primary" onClick={onPlay}>▶ 播放</button>
        )}
      </div>

      {/* 导出 */}
      <div className="toolbar-group">
        <button className="btn btn-sm" onClick={() => onExport('pdf')}>PDF</button>
        <button className="btn btn-sm" onClick={() => onExport('png')}>图片</button>
        <button className="btn btn-sm" onClick={() => onExport('midi')}>MIDI</button>
        <button className="btn btn-sm" onClick={() => onExport('json')}>JSON</button>
      </div>

      {/* 帮助 + 模型管理 */}
      <div className="toolbar-group">
        <button className="btn btn-sm" onClick={onShowModels}>模型管理</button>
        <button className="btn btn-sm" onClick={onShowHelp}>帮助</button>
      </div>
    </div>
  );
};
