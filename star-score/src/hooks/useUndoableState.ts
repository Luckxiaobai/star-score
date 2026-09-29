import { useCallback, useReducer } from 'react';

interface UndoState<T> {
  past: T[];
  present: T;
  future: T[];
}

type SetOptions = { record?: boolean };

type UndoAction<T> =
  | { type: 'checkpoint' }
  | { type: 'set'; updater: (prev: T) => T; record: boolean }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; value: T };

const MAX_HISTORY = 100;

function pushPast<T>(past: T[], value: T): T[] {
  const next = [...past, value];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

function reducer<T>(state: UndoState<T>, action: UndoAction<T>): UndoState<T> {
  switch (action.type) {
    case 'checkpoint':
      return { ...state, past: pushPast(state.past, state.present), future: [] };
    case 'set': {
      const next = action.updater(state.present);
      if (Object.is(next, state.present)) return state;
      return {
        past: action.record ? pushPast(state.past, state.present) : state.past,
        present: next,
        future: action.record ? [] : state.future,
      };
    }
    case 'undo': {
      if (state.past.length === 0) return state;
      const present = state.past[state.past.length - 1];
      return {
        past: state.past.slice(0, -1),
        present,
        future: [state.present, ...state.future],
      };
    }
    case 'redo': {
      if (state.future.length === 0) return state;
      const [present, ...future] = state.future;
      return {
        past: pushPast(state.past, state.present),
        present,
        future,
      };
    }
    case 'reset':
      return { past: [], present: action.value, future: [] };
  }
}

export interface UndoableState<T> {
  present: T;
  canUndo: boolean;
  canRedo: boolean;
  historyDepth: number;
  set: (updater: T | ((prev: T) => T), options?: SetOptions) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  reset: (value: T) => void;
}

/**
 * 小型快照式撤销栈。
 *
 * 适用于当前 MIDI 工程这种“文档整体替换”模型，也方便以后把编辑命令
 * 升级成更细粒度的 operation 历史。
 */
export function useUndoableState<T>(initial: T): UndoableState<T> {
  const [state, dispatch] = useReducer(reducer<T>, {
    past: [],
    present: initial,
    future: [],
  });

  const set = useCallback((updater: T | ((prev: T) => T), options?: SetOptions) => {
    dispatch({
      type: 'set',
      updater: typeof updater === 'function'
        ? updater as (prev: T) => T
        : () => updater,
      record: options?.record ?? true,
    });
  }, []);

  const checkpoint = useCallback(() => dispatch({ type: 'checkpoint' }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const reset = useCallback((value: T) => dispatch({ type: 'reset', value }), []);

  return {
    present: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    historyDepth: state.past.length,
    set,
    checkpoint,
    undo,
    redo,
    reset,
  };
}
