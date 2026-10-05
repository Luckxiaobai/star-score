import type { MidiDocument, MidiNote } from '../../types/midiProject';
import { noteId } from '../../types/midiProject';
import type { Command, NewNote } from './command';

/**
 * 把 Command[] 解释成对 MidiDocument 的不可变更新（M5 适配层）。
 *
 * 纯函数：不碰 UI、不碰网络、不碰后端。非法命令直接抛错——
 * dispatch 之前应先校验，保证事务原子性（要么整组应用，要么整体失败）。
 *
 * 注意：note.move 保持音符 id 不变（即便 startTick/pitch 变了，
 * id 仍按移动前的稳定 ID 引用，避免打断工程内的引用关系）。
 */
export function applyCommands(prev: MidiDocument, commands: Command[]): MidiDocument {
  let notes: MidiNote[] = prev.notes;

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'note.add': {
        const ppq = prev.time.ppq;
        const added = cmd.p.notes.map((n: NewNote, i: number): MidiNote => {
          if (!Number.isFinite(n.pitch) || !Number.isFinite(n.startTick) || !Number.isFinite(n.durationTick)) {
            throw new Error(`note.add[${i}] has invalid pitch/startTick/durationTick`);
          }
          return {
            id: noteId(ppq, n.startTick, n.pitch, n.durationTick),
            pitch: n.pitch,
            startTick: n.startTick,
            durationTick: n.durationTick,
            velocity: n.velocity ?? 96,
            enabled: n.enabled ?? true,
            track: n.track ?? 0,
            lyric: n.lyric,
          };
        });
        notes = [...notes, ...added];
        break;
      }
      case 'note.remove': {
        const ids = new Set(cmd.p.ids);
        notes = notes.filter((n) => !ids.has(n.id));
        break;
      }
      case 'note.move': {
        notes = notes.map((n) => {
          const d = cmd.p.deltas.find((x) => x.id === n.id);
          if (!d) return n;
          return {
            ...n,
            pitch: n.pitch + (d.pitchDelta ?? 0),
            startTick: n.startTick + (d.startTickDelta ?? 0),
            durationTick: n.durationTick + (d.durationTickDelta ?? 0),
          };
        });
        break;
      }
      case 'lyric.set': {
        notes = notes.map((n) => (n.id === cmd.p.id ? { ...n, lyric: cmd.p.text } : n));
        break;
      }
      default: {
        const unhandled: never = cmd;
        throw new Error(`Unknown command type: ${(unhandled as { type: string }).type}`);
      }
    }
  }

  const totalTicks = notes.reduce((max, n) => Math.max(max, n.startTick + n.durationTick), 0);
  return { ...prev, notes, totalTicks };
}
