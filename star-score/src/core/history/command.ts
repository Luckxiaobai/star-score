import type { CommandSource } from '../../hooks/useUndoableState';

/**
 * B1 统一命令层对外契约。
 *
 * 当前 `dispatch` 只认 `apply` 函数（见 useUndoableState）。
 * LLM 无法产出闭包，只能产出 JSON，所以 M5 层会把下面的 Command[]
 * 解释成一个 `apply(prev)`。解释器放在 M5 附近，B1 本身不感知 AI。
 */

/** LLM 产出的结构化命令（M5 适配，B1 不解释）。 */
export type Command =
  | { type: 'note.add'; p: { notes: unknown[] } }
  | { type: 'note.remove'; p: { ids: string[] } }
  | { type: 'note.move'; p: { deltas: unknown[] } }
  | { type: 'lyric.set'; p: { id: string; text: string } };

/** 一组来自同一来源的命令，最终由 M5 解释为一次 dispatch。 */
export interface CommandBatch {
  label: string;
  source: CommandSource;
  commands: Command[];
}
