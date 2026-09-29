import { useMemo, useState } from 'react';

export interface ProjectSummary {
  name: string;
  mtime: number;
}

interface ProjectDialogProps {
  mode: 'open' | 'save';
  projects?: ProjectSummary[];
  initialName?: string;
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onOpen?: (name: string) => void;
  onSave?: (name: string) => void;
}

function formatMtime(value: number): string {
  return new Date(value * 1000).toLocaleString();
}

export function ProjectDialog({
  mode,
  projects = [],
  initialName = 'untitled',
  busy = false,
  error = '',
  onClose,
  onOpen,
  onSave,
}: ProjectDialogProps) {
  const [name, setName] = useState(initialName);
  const [query, setQuery] = useState('');

  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((project) => project.name.toLowerCase().includes(needle));
  }, [projects, query]);

  return (
    <div className="project-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'open' ? '打开工程' : '保存工程'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="project-dialog-header">
          <h3>{mode === 'open' ? '打开工程' : '保存工程'}</h3>
          <button className="btn btn-sm" onClick={onClose}>关闭</button>
        </div>

        {error && <div className="humanv-error">{error}</div>}

        {mode === 'save' ? (
          <form
            className="project-save-form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = name.trim();
              if (value) onSave?.(value);
            }}
          >
            <label htmlFor="project-name">工程名</label>
            <input
              id="project-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：喵喵小星星"
            />
            <button className="btn btn-primary" disabled={busy || !name.trim()}>
              {busy ? '保存中...' : '保存'}
            </button>
          </form>
        ) : (
          <>
            <input
              autoFocus
              className="project-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索工程..."
            />
            <div className="project-list">
              {busy && <div className="project-list-empty">正在读取工程...</div>}
              {!busy && filteredProjects.length === 0 && (
                <div className="project-list-empty">
                  {projects.length === 0 ? '暂无已保存工程' : '没有匹配工程'}
                </div>
              )}
              {filteredProjects.map((project) => (
                <button
                  key={project.name}
                  className="project-list-item"
                  onClick={() => onOpen?.(project.name)}
                  disabled={busy}
                >
                  <span>{project.name}</span>
                  <time>{formatMtime(project.mtime)}</time>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
