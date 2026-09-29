import { useState, useCallback, useEffect, useRef } from 'react';
import type { Score, Note, Pitch, Duration } from '../types/score';
import {
  createEmptyScore, createNote, createMeasure, genId,
} from '../types/score';
import { transposeNote } from '../core/theory/musicTheory';

const STORAGE_KEY = 'star-score';

export function useScore() {
  const [score, setScore] = useState<Score>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return createEmptyScore();
  });

  const [history, setHistory] = useState<Score[]>([]);
  const [redoStack, setRedoStack] = useState<Score[]>([]);
  const historyRef = useRef(history);
  historyRef.current = history;

  // 自动保存
  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(score));
    }, 500);
    return () => clearTimeout(timer);
  }, [score]);

  // 推入历史
  const pushHistory = useCallback((prev: Score) => {
    setHistory(h => [...h.slice(-49), prev]);
    setRedoStack([]);
  }, []);

  // 更新谱面 (带撤销)
  const updateScore = useCallback((updater: (prev: Score) => Score) => {
    setScore(prev => {
      pushHistory(prev);
      return updater(prev);
    });
  }, [pushHistory]);

  // 撤销
  const undo = useCallback(() => {
    setHistory(h => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setScore(current => {
        setRedoStack(r => [...r, current]);
        return prev;
      });
      return h.slice(0, -1);
    });
  }, []);

  // 重做
  const redo = useCallback(() => {
    setRedoStack(r => {
      if (r.length === 0) return r;
      const next = r[r.length - 1];
      setScore(current => {
        setHistory(h => [...h, current]);
        return next;
      });
      return r.slice(0, -1);
    });
  }, []);

  // === 音符编辑 ===

  // 在光标位置插入音符
  const insertNote = useCallback((pitch: Pitch, duration: Duration, cursorMeasure: number, cursorNote: number) => {
    updateScore(prev => {
      const newScore = JSON.parse(JSON.stringify(prev)) as Score;
      const measure = newScore.measures[cursorMeasure];
      if (!measure) return prev;
      const note = createNote(pitch, duration);
      measure.notes.splice(cursorNote, 0, note);
      return newScore;
    });
  }, [updateScore]);

  // 修改选中的音符
  const updateNote = useCallback((measureIdx: number, noteIdx: number, updates: Partial<Note>) => {
    updateScore(prev => {
      const newScore = JSON.parse(JSON.stringify(prev)) as Score;
      const note = newScore.measures[measureIdx]?.notes[noteIdx];
      if (!note) return prev;
      Object.assign(note, updates);
      return newScore;
    });
  }, [updateScore]);

  // 删除音符
  const deleteNote = useCallback((measureIdx: number, noteIdx: number) => {
    updateScore(prev => {
      const newScore = JSON.parse(JSON.stringify(prev)) as Score;
      const measure = newScore.measures[measureIdx];
      if (!measure) return prev;
      measure.notes.splice(noteIdx, 1);
      return newScore;
    });
  }, [updateScore]);

  // 添加小节
  const addMeasure = useCallback((afterIdx: number = -1) => {
    updateScore(prev => {
      const newScore = JSON.parse(JSON.stringify(prev)) as Score;
      const newMeasure = createMeasure();
      if (afterIdx < 0 || afterIdx >= newScore.measures.length) {
        newScore.measures.push(newMeasure);
      } else {
        newScore.measures.splice(afterIdx + 1, 0, newMeasure);
      }
      return newScore;
    });
  }, [updateScore]);

  // 删除小节
  const deleteMeasure = useCallback((idx: number) => {
    updateScore(prev => {
      if (prev.measures.length <= 1) return prev;
      const newScore = JSON.parse(JSON.stringify(prev)) as Score;
      newScore.measures.splice(idx, 1);
      return newScore;
    });
  }, [updateScore]);

  // 移调
  const transpose = useCallback((semitones: number) => {
    updateScore(prev => {
      const newScore = JSON.parse(JSON.stringify(prev)) as Score;
      newScore.measures.forEach(m => {
        m.notes.forEach((n, i) => {
          m.notes[i] = transposeNote(n, semitones);
        });
      });
      return newScore;
    });
  }, [updateScore]);

  // 更新元数据
  const updateMetadata = useCallback((updates: Partial<Score['metadata']>) => {
    updateScore(prev => ({
      ...prev,
      metadata: { ...prev.metadata, ...updates },
    }));
  }, [updateScore]);

  // 设置音符时值
  const setNoteDuration = useCallback((measureIdx: number, noteIdx: number, duration: Duration) => {
    updateScore(prev => {
      const newScore = JSON.parse(JSON.stringify(prev)) as Score;
      const note = newScore.measures[measureIdx]?.notes[noteIdx];
      if (!note) return prev;
      note.duration = duration;
      return newScore;
    });
  }, [updateScore]);

  // 八度升降
  const shiftOctave = useCallback((measureIdx: number, noteIdx: number, delta: number) => {
    updateScore(prev => {
      const newScore = JSON.parse(JSON.stringify(prev)) as Score;
      const note = newScore.measures[measureIdx]?.notes[noteIdx];
      if (!note || note.pitch === 0) return prev;
      note.octave = Math.max(-2, Math.min(2, note.octave + delta));
      return newScore;
    });
  }, [updateScore]);

  // 切换附点
  const toggleDot = useCallback((measureIdx: number, noteIdx: number) => {
    updateScore(prev => {
      const newScore = JSON.parse(JSON.stringify(prev)) as Score;
      const note = newScore.measures[measureIdx]?.notes[noteIdx];
      if (!note) return prev;
      note.dotted = !note.dotted;
      return newScore;
    });
  }, [updateScore]);

  // 设置歌词
  const setLyric = useCallback((measureIdx: number, noteIdx: number, lyric: string) => {
    updateScore(prev => {
      const newScore = JSON.parse(JSON.stringify(prev)) as Score;
      const note = newScore.measures[measureIdx]?.notes[noteIdx];
      if (!note) return prev;
      note.lyric = lyric || undefined;
      return newScore;
    });
  }, [updateScore]);

  // 设置和弦
  const setChord = useCallback((measureIdx: number, noteIdx: number, chord: string) => {
    updateScore(prev => {
      const newScore = JSON.parse(JSON.stringify(prev)) as Score;
      const note = newScore.measures[measureIdx]?.notes[noteIdx];
      if (!note) return prev;
      note.chord = chord || undefined;
      return newScore;
    });
  }, [updateScore]);

  // 清空
  const clearScore = useCallback(() => {
    updateScore(() => createEmptyScore());
  }, [updateScore]);

  // 加载示例
  const loadDemo = useCallback(() => {
    const demo: Score = {
      metadata: {
        title: '小星星',
        artist: '传统民谣',
        key: '1=C',
        timeNumerator: 4,
        timeDenominator: 4,
        tempo: 100,
        style: '',
      },
      measures: [
        {
          id: genId(),
          barline: 'single',
          notes: [
            { id: genId(), pitch: 1, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '一', chord: 'C' },
            { id: genId(), pitch: 1, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '闪' },
            { id: genId(), pitch: 5, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '一' },
            { id: genId(), pitch: 5, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '闪' },
          ],
        },
        {
          id: genId(),
          barline: 'single',
          notes: [
            { id: genId(), pitch: 6, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '亮', chord: 'G' },
            { id: genId(), pitch: 6, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '晶' },
            { id: genId(), pitch: 5, octave: 0, duration: 'half', dotted: false, accidental: 'none', tie: 'none', lyric: '晶' },
          ],
        },
        {
          id: genId(),
          barline: 'single',
          notes: [
            { id: genId(), pitch: 4, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '满', chord: 'F' },
            { id: genId(), pitch: 4, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '天' },
            { id: genId(), pitch: 3, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '都' },
            { id: genId(), pitch: 3, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '是' },
          ],
        },
        {
          id: genId(),
          barline: 'single',
          notes: [
            { id: genId(), pitch: 2, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '小', chord: 'C' },
            { id: genId(), pitch: 2, octave: 0, duration: 'quarter', dotted: false, accidental: 'none', tie: 'none', lyric: '星' },
            { id: genId(), pitch: 1, octave: 0, duration: 'half', dotted: false, accidental: 'none', tie: 'none', lyric: '星' },
          ],
        },
        {
          id: genId(),
          barline: 'final',
          notes: [],
        },
      ],
    };
    updateScore(() => demo);
  }, [updateScore]);

  return {
    score,
    updateScore,
    undo,
    redo,
    canUndo: history.length > 0,
    canRedo: redoStack.length > 0,
    insertNote,
    updateNote,
    deleteNote,
    addMeasure,
    deleteMeasure,
    transpose,
    updateMetadata,
    setNoteDuration,
    shiftOctave,
    toggleDot,
    setLyric,
    setChord,
    clearScore,
    loadDemo,
  };
}
