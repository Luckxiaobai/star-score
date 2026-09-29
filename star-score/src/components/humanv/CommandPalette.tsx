import { useMemo, useState } from 'react';

export interface CommandPaletteItem {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

interface CommandPaletteProps {
  commands: CommandPaletteItem[];
  onClose: () => void;
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) => {
      const haystack = `${command.label} ${command.group} ${command.keywords ?? ''}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [commands, query]);

  const execute = (command: CommandPaletteItem | undefined) => {
    if (!command || command.disabled) return;
    onClose();
    void command.run();
  };

  return (
    <div className="command-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          className="command-search"
          value={query}
          placeholder="输入命令..."
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) => Math.min(index + 1, Math.max(0, filtered.length - 1)));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              execute(filtered[activeIndex]);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="command-list">
          {filtered.length === 0 && <div className="command-empty">没有匹配命令</div>}
          {filtered.map((command, index) => (
            <button
              key={command.id}
              className={`command-item ${index === activeIndex ? 'is-active' : ''}`}
              disabled={command.disabled}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => execute(command)}
            >
              <span className="command-group">{command.group}</span>
              <span className="command-label">{command.label}</span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
