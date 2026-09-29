/* ================================================================
 * 星谱识音 · 谱面渲染组件
 * ----------------------------------------------------------------
 * 职责：将 Score 数据渲染为可视化简谱谱面
 *
 * 目录（搜索关键词快速定位）：
 *   [IMPORTS]     导入
 *   [TYPES]       Props 类型定义
 *   [CONSTANTS]   布局常量（宽度 / 高度 / 间距）
 *   [HELPERS]     辅助函数（音符宽度 / 音符显示文字）
 *   [LAYOUT]      布局计算（分行 / 小节定位 / 音符定位）
 *   [BEAM]        连音下划线分组
 *   [RENDER]      JSX 渲染
 *
 * 渲染结构：
 *   .score-container
 *     .score-inner
 *       .score-title-block      标题 + 作者
 *       .score-line (× N)       每行
 *         .score-header         行头（调号/拍号/速度，仅首行）
 *         .measure (× M)        小节
 *           .chord-row           和弦行
 *           .note-row            音符行
 *             .beam-line         连音下划线
 *             .note-cell         音符单元格
 *               .octave-dots     八度点
 *               .note-number     数字
 *               .note-dot        附点
 *               .note-dash       延长线
 *           .lyric-row           歌词行
 * ================================================================ */

/* [IMPORTS] 导入 */
import React, { useRef, useCallback } from 'react';
import type { Score, Note, Measure } from '../types/score';
import { DURATION_UNDERLINES } from '../types/score';
import '../styles/score.css';

/* [TYPES] Props 类型定义 */
interface ScoreRendererProps {
  score: Score;
  selectedMeasure: number;
  selectedNote: number;
  cursorMeasure: number;
  cursorNote: number;
  playingMeasure: number;
  playingNote: number;
  onNoteClick: (measureIdx: number, noteIdx: number) => void;
  onMeasureClick: (measureIdx: number) => void;
}

/* [CONSTANTS] 布局常量 */
/* 这些常量控制谱面的像素级布局，调整时可统一修改 */
// 音符渲染宽度
const NOTE_W = 26;
const NOTE_H = 28;
const UNDERLINE_GAP = 3;
const LINE_HEIGHT = 80;
const LEFT_PAD = 16;
const TOP_PAD = 10;
const MAX_W = 880;
const CHORD_H = 20;
const BARLINE_W = 14;

/* [HELPERS] 辅助函数 */

/** 计算单个音符的渲染宽度（含附点/时值扩展） */
function getNoteWidth(note: Note): number {  let w = NOTE_W;
  if (note.dotted) w += 6;
  if (note.duration === 'half') w += 20;
  if (note.duration === 'whole') w += 56;
  return w;
}

/** 获取音符的显示文字（含升降号） */
function getNoteDisplay(note: Note): string {
  if (note.pitch === 0) return '0';
  let s = String(note.pitch);
  if (note.accidental === 'sharp') s = '#' + s;
  if (note.accidental === 'flat') s = 'b' + s;
  return s;
}

export const ScoreRenderer: React.FC<ScoreRendererProps> = ({
  score,
  selectedMeasure,
  selectedNote,
  cursorMeasure,
  cursorNote,
  playingMeasure,
  playingNote,
  onNoteClick,
  onMeasureClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  /* [LAYOUT] 布局计算 */
  /* 将 score.measures 按行宽度分行，计算每个小节和音符的绝对坐标 */
  const layout = useCallback(() => {
    const lines: { measures: { measure: Measure; mIdx: number; x: number; notes: { note: Note; nIdx: number; x: number; w: number }[]; w: number; barline: string }[]; y: number }[] = [];
    let currentLine: typeof lines[0]['measures'] = [];
    let currentX = LEFT_PAD;
    let currentY = TOP_PAD + CHORD_H;
    let lineStartY = currentY;

    // 头部宽度 (调号、拍号、速度)
    const headerW = 100;
    currentX += headerW;

    score.measures.forEach((measure, mIdx) => {
      // 计算小节宽度
      let measureW = BARLINE_W;
      const notePositions: { note: Note; nIdx: number; x: number; w: number }[] = [];
      let noteX = currentX + BARLINE_W;

      measure.notes.forEach((note, nIdx) => {
        const nw = getNoteWidth(note);
        notePositions.push({ note, nIdx, x: noteX, w: nw });
        noteX += nw;
      });
      measureW = (noteX - currentX) + BARLINE_W;

      // 换行检查
      if (currentX + measureW > MAX_W && currentLine.length > 0) {
        lines.push({ measures: currentLine, y: lineStartY });
        currentLine = [];
        currentX = LEFT_PAD + headerW;
        lineStartY += LINE_HEIGHT;
        // 重新计算
        noteX = currentX + BARLINE_W;
        notePositions.forEach((np) => {
          np.x = noteX;
          noteX += np.w;
        });
        measureW = (noteX - currentX) + BARLINE_W;
      }

      currentLine.push({
        measure,
        mIdx,
        x: currentX,
        notes: notePositions,
        w: measureW,
        barline: measure.barline,
      });
      currentX += measureW;
    });

    if (currentLine.length > 0) {
      lines.push({ measures: currentLine, y: lineStartY });
    }

    return { lines, headerW };
  }, [score]);

  const { lines, headerW } = layout();

  /* [BEAM] 连音下划线分组 */
  /**
   * 简谱减时线按"层级"连通：第 k 条线贯穿所有下划线数 ≥ k 的连续音符。
   * 例如 八分(1) 十六分(2) 十六分(2) 八分(1)：
   *   层级1 = 四个音一整条；层级2 = 中间两个音一条。
   * 休止符不画减时线，并把连线切断。
   */
  function getBeamSegments(
    notes: { note: Note; nIdx: number; x: number; w: number }[]
  ): { level: number; left: number; width: number }[] {
    const segments: { level: number; left: number; width: number }[] = [];
    const maxLevel = Math.max(
      1,
      ...notes.map((np) =>
        np.note.pitch === 0 ? 0 : DURATION_UNDERLINES[np.note.duration] || 0
      )
    );
    for (let level = 1; level <= maxLevel; level++) {
      let start = -1;
      const flush = (endExclusive: number) => {
        if (start < 0) return;
        const first = notes[start];
        const last = notes[endExclusive - 1];
        segments.push({
          level,
          left: first.x,
          width: last.x + last.w - first.x,
        });
        start = -1;
      };
      notes.forEach((np, i) => {
        const ul = np.note.pitch === 0 ? 0 : DURATION_UNDERLINES[np.note.duration] || 0;
        if (ul >= level) {
          if (start < 0) start = i;
        } else {
          flush(i);
        }
      });
      flush(notes.length);
    }
    return segments;
  }

  /* [RENDER] JSX 渲染 */
  return (
    <div className="score-container" ref={containerRef}>
      <div className="score-inner">
        {/* 标题 */}
        <div className="score-title-block">
          <div className="score-title">{score.metadata.title}</div>
          {score.metadata.artist && <div className="score-artist">{score.metadata.artist}</div>}
        </div>
        {lines.map((line, lineIdx) => (
          <div className="score-line" key={lineIdx} style={{ height: LINE_HEIGHT, position: 'relative' }}>
            {/* 行头: 调号、拍号、速度 */}
            {lineIdx === 0 && (
              <div className="score-header" style={{ position: 'absolute', left: LEFT_PAD, top: 0, width: headerW }}>
                <div className="header-key">{score.metadata.key}</div>
                <div className="header-time">{score.metadata.timeNumerator}/{score.metadata.timeDenominator}</div>
                <div className="header-tempo">?={score.metadata.tempo}</div>
              </div>
            )}

            {/* 小节 */}
            {line.measures.map((m, mInLine) => (
              <div
                className={`measure ${selectedMeasure === m.mIdx ? 'measure-selected' : ''}`}
                key={m.mIdx}
                style={{
                  position: 'absolute',
                  left: m.x,
                  top: 0,
                  width: m.w,
                  height: LINE_HEIGHT,
                }}
                onClick={(e) => { e.stopPropagation(); onMeasureClick(m.mIdx); }}
              >
                {/* 行首小节线（每行仅第一条） */}
                {mInLine === 0 && <div className="barline barline-line-start" />}
                {/* 和弦行 */}
                <div className="chord-row" style={{ height: CHORD_H }}>
                  {m.notes.map((np) => np.note.chord && (
                    <span
                      key={np.nIdx}
                      className="chord-text"
                      style={{ left: np.x - m.x, width: np.w }}
                    >
                      {np.note.chord}
                    </span>
                  ))}
                </div>

                {/* 音符行：数字 0~NOTE_H，其下为八度点 / 减时线预留区 */}
                <div className="note-row" style={{ height: NOTE_H + 18, position: 'relative' }}>
                  {/* 连音下划线：贴音符行底部按层级向上排列，绝不压数字 */}
                  {getBeamSegments(m.notes).map((seg) => (
                    <div
                      key={`beam-${seg.level}-${seg.left}`}
                      className="beam-line"
                      style={{
                        left: seg.left - m.x,
                        bottom: 2 + (seg.level - 1) * UNDERLINE_GAP,
                        width: seg.width,
                      }}
                    />
                  ))}

                  {/* 音符 */}
                  {m.notes.map((np) => {
                    const isSel = selectedMeasure === m.mIdx && selectedNote === np.nIdx;
                    const isCursor = cursorMeasure === m.mIdx && cursorNote === np.nIdx;
                    const isPlaying = playingMeasure === m.mIdx && playingNote === np.nIdx;
                    const disp = getNoteDisplay(np.note);

                    return (
                      <div
                        key={np.nIdx}
                        className={`note-cell ${isSel ? 'note-selected' : ''} ${isCursor ? 'note-cursor' : ''} ${isPlaying ? 'note-playing' : ''}`}
                        style={{ left: np.x - m.x, width: np.w }}
                        onClick={(e) => { e.stopPropagation(); onNoteClick(m.mIdx, np.nIdx); }}
                      >
                        {/* 高八度点 */}
                        {np.note.pitch !== 0 && np.note.octave > 0 && (
                          <div className="octave-dots octave-up">
                            {Array.from({ length: np.note.octave }).map((_, i) => (
                              <span key={i} className="dot" />
                            ))}
                          </div>
                        )}
                        {/* 低八度点 */}
                        {np.note.pitch !== 0 && np.note.octave < 0 && (
                          <div className="octave-dots octave-down">
                            {Array.from({ length: -np.note.octave }).map((_, i) => (
                              <span key={i} className="dot" />
                            ))}
                          </div>
                        )}
                        {/* 音符数字 */}
                        <span className="note-number">{disp}</span>
                        {/* 附点 */}
                        {np.note.dotted && <span className="note-dot">·</span>}
                        {/* 拍数延长线 */}
                        {np.note.duration === 'half' && <span className="note-dash">—</span>}
                        {np.note.duration === 'whole' && <span className="note-dash">——</span>}
                      </div>
                    );
                  })}
                </div>

                {/* 歌词行 */}
                <div className="lyric-row">
                  {m.notes.map((np) => np.note.lyric && (
                    <span
                      key={np.nIdx}
                      className="lyric-text"
                      style={{ left: np.x - m.x, width: np.w }}
                    >
                      {np.note.lyric}
                    </span>
                  ))}
                </div>

                {/* 小节线 */}
                <div className={`barline barline-end barline-${m.barline}`} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
