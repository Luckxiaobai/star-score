import { useState } from 'react';
import type {
  AiModelInfo,
  AiProviderConfig,
  MidiGenerationPlan,
  MidiGenerationRequest,
} from '../../core/ai/types';

interface AiMidiPanelProps {
  config: AiProviderConfig;
  plan: MidiGenerationPlan | null;
  busy: boolean;
  error: string;
  models: AiModelInfo[];
  modelsLoading: boolean;
  modelsError: string;
  onConfigChange: (patch: Partial<AiProviderConfig>) => void;
  onGenerate: (request: MidiGenerationRequest) => void;
  onApply: (mode: 'replace' | 'append') => void;
  onClose: () => void;
  onRefreshModels: () => void;
}

export function AiMidiPanel({
  config,
  plan,
  busy,
  error,
  models,
  modelsLoading,
  modelsError,
  onConfigChange,
  onGenerate,
  onApply,
  onClose,
  onRefreshModels,
}: AiMidiPanelProps) {
  const [prompt, setPrompt] = useState('写一段轻快的 8 小节主旋律，适合“喵喵”唱');
  const [style, setStyle] = useState('流行、朗朗上口');
  const [bpm, setBpm] = useState(110);
  const [bars, setBars] = useState(8);
  const [key, setKey] = useState('C');

  return (
    <div className="ai-panel">
      <div className="ai-panel-header">
        <div>
          <strong>AI 生成 MIDI</strong>
          <span>文字需求 → 可编辑钢琴卷帘</span>
        </div>
        <button className="btn btn-sm" onClick={onClose}>关闭</button>
      </div>

      <div className="ai-config-grid">
        <label>
          Base URL
          <input
            value={config.baseUrl}
            onChange={(event) => onConfigChange({ baseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={config.apiKey}
            onChange={(event) => onConfigChange({ apiKey: event.target.value })}
            placeholder="sk-..."
          />
        </label>
        <label>
          文本模型
          <span className="ai-model-input">
            <input
              list="ai-midi-models"
              value={config.midiModel}
              onChange={(event) => onConfigChange({ midiModel: event.target.value })}
              placeholder="gpt-4o-mini"
            />
            <button className="btn btn-sm" onClick={onRefreshModels} disabled={modelsLoading}>
              {modelsLoading ? '获取中...' : '获取模型'}
            </button>
          </span>
        </label>
        <label>
          调性
          <input value={key} onChange={(event) => setKey(event.target.value)} />
        </label>
        <label>
          BPM
          <input
            type="number"
            min={20}
            max={300}
            value={bpm}
            onChange={(event) => setBpm(Number(event.target.value))}
          />
        </label>
        <label>
          小节数
          <input
            type="number"
            min={1}
            max={128}
            value={bars}
            onChange={(event) => setBars(Number(event.target.value))}
          />
        </label>
      </div>
      <datalist id="ai-midi-models">
        {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
      </datalist>

      <label className="ai-prompt-field">
        生成要求
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={4}
          placeholder="例如：写一段适合人声的 8 小节旋律，节奏简单"
        />
      </label>
      <label className="ai-prompt-field">
        风格
        <input
          value={style}
          onChange={(event) => setStyle(event.target.value)}
          placeholder="流行 / 古风 / 电子"
        />
      </label>

      <div className="ai-panel-actions">
        <button
          className="btn btn-primary"
          onClick={() => onGenerate({ prompt, style, bpm, bars, key })}
          disabled={busy || !prompt.trim() || !config.baseUrl || !config.midiModel}
        >
          {busy ? '生成中...' : '生成 MIDI'}
        </button>
        {plan && (
          <>
            <button className="btn" onClick={() => onApply('replace')}>替换工作台</button>
            <button className="btn" onClick={() => onApply('append')}>追加到末尾</button>
          </>
        )}
      </div>

      {error && <div className="humanv-error">{error}</div>}
      {modelsError && <div className="ai-hint">{modelsError}</div>}

      {plan && (
        <div className="ai-result">
          <div className="ai-result-summary">
            <strong>{plan.title}</strong>
            <span>{plan.notes.length} 音符 · {plan.bpm} BPM · {plan.bars} 小节</span>
          </div>
          <div className="ai-segment-list">
            {plan.notes.slice(0, 16).map((note, index) => (
              <div className="ai-segment" key={`${note.start_beat}-${index}`}>
                <span>{note.start_beat.toFixed(2)} 拍</span>
                <strong>
                  MIDI {note.pitch}
                  {note.lyric ? ` · ${note.lyric}` : ''}
                </strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
