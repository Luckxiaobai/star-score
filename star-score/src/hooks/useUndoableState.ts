import { useCallback, useReducer, useMemo } from 'react';

export type CommandSource = 'user' | 'ai' | 'import' | 'align';

/** 历史里的一条记录：snapshot 是「操作前」的状态。 */
export interface HistoryEntry<T> {
  snapshot: T;
  label: string;
  source: CommandSource;
  createdAt: number;
}

/** 一次可撤销的编辑事务（B1 统一命令层）。 */
export interface EditBatch<T> {
  label: string;
  source: CommandSource;
  apply: (prev: T) => T;
}

interface State<T> {
  past: HistoryEntry<T>[];
  present: T;
  future: HistoryEntry<T>[];
}

type Action<T> =
  | { type: 'set'; updater: (prev: T) => T; label: string; source: CommandSource; record: boolean }
  | { type: 'checkpoint'; label: string; source: CommandSource }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; value: T };

const MAX_HISTORY = 100;

function makeEntry<T>(snapshot: T, label: string, source: CommandSource): HistoryEntry<T> {
  return { snapshot, label, source, createdAt: Date.now() };
}

function reducer<T>(state: State<T>, action: Action<T>): State<T> {
  switch (action.type) {
    case 'set': {
      const present = action.updater(state.present);
      if (Object.is(present, state.present)) return state;
      if (!action.record) {
        // 静默更新（拖拽过程中的高频中间态），不入撤销栈
        return { ...state, present };
      }
      const entry = makeEntry(state.present, action.label, action.source);
      return {
        past: [...state.past, entry].slice(-MAX_HISTORY),
        present,
        future: [],
      };
    }
    case 'checkpoint': {
      // 手动打快照（如拖拽开始），把当前 present 压入 past，整段拖拽算一步
      const entry = makeEntry(state.present, action.label, action.source);
      return { ...state, past: [...state.past, entry].slice(-MAX_HISTORY), future: [] };
    }
    case 'undo': {
      if (state.past.length === 0) return state;
      const entry = state.past[state.past.length - 1];
      const redoEntry = makeEntry(state.present, entry.label, entry.source);
      return {
        past: state.past.slice(0, -1),
        present: entry.snapshot,
        future: [redoEntry, ...state.future],
      };
    }
    case 'redo': {
      if (state.future.length === 0) return state;
      const [entry, ...future] = state.future;
      const undoEntry = makeEntry(state.present, entry.label, entry.source);
      return {
        past: [...state.past, undoEntry].slice(-MAX_HISTORY),
        present: entry.snapshot,
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
  /** 最近一次可撤销操作的名称（UI 显示「撤销：xxx」）。 */
  lastLabel: string | null;
  /** 低层入口：兼容旧调用；label/source 可选，record=false 时不入历史。 */
  set: (
    updater: T | ((prev: T) => T),
    options?: { label?: string; source?: CommandSource; record?: boolean },
  ) => void;
  /** 手动打快照（拖拽开始时调用，把整段交互合成一步撤销）。 */
  checkpoint: (label?: string, source?: CommandSource) => void;
  /** B1 统一入口：一次带标签的编辑事务。 */
  dispatch: (batch: EditBatch<T>) => void;
  undo: () => void;
  redo: () => void;
  reset: (value: T) => void;
}

export function useUndoableState<T>(initial: T): UndoableState<T> {
  const [state, rawDispatch] = useReducer(reducer<T>, {
    past: [],
    present: initial,
    future: [],
  });

  const set = useCallback(
    (
      updater: T | ((prev: T) => T),
      options?: { label?: string; source?: CommandSource; record?: boolean },
    ) => {
      rawDispatch({
        type: 'set',
        updater: typeof updater === 'function' ? (updater as (prev: T) => T) : () => updater,
        label: options?.label ?? '编辑',
        source: options?.source ?? 'user',
        record: options?.record ?? true,
      });
    },
    [],
  );

  const checkpoint = useCallback((label?: string, source?: CommandSource) => {
    rawDispatch({ type: 'checkpoint', label: label ?? '编辑', source: source ?? 'user' });
  }, []);

  const dispatch = useCallback((batch: EditBatch<T>) => {
    rawDispatch({
      type: 'set',
      updater: batch.apply,
      label: batch.label,
      source: batch.source,
      record: true,
    });
  }, []);

  const undo = useCallback(() => rawDispatch({ type: 'undo' }), []);
  const redo = useCallback(() => rawDispatch({ type: 'redo' }), []);
  const reset = useCallback((value: T) => rawDispatch({ type: 'reset', value }), []);

  const lastLabel = useMemo(() => {
    if (state.past.length > 0) return state.past[state.past.length - 1].label;
    if (state.future.length > 0) return state.future[0].label;
    return null;
  }, [state.past, state.future]);

  return {
    present: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    lastLabel,
    set,
    checkpoint,
    dispatch,
    undo,
    redo,
    reset,
  };
}
