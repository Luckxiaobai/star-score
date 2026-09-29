import type {
  AiModelInfo,
  AiProviderConfig,
  AiTranscriptionResult,
} from '../../core/ai/types';

interface AiLyricsPanelProps {
  config: AiProviderConfig;
  result: AiTranscriptionResult | null;
  audioReady: boolean;
  busy: boolean;
  error: string;
  canApply: boolean;
  models: AiModelInfo[];
  modelsLoading: boolean;
  modelsError: string;
  onConfigChange: (patch: Partial<AiProviderConfig>) => void;
  onTranscribe: () => void;
  onApply: () => void;
  onClose: () => void;
  onRefreshModels: () => void;
}

function formatTime(sec: number): string {
  const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}

export function AiLyricsPanel({
  config,
  result,
  audioReady,
  busy,
  error,
  canApply,
  models,
  modelsLoading,
  modelsError,
  onConfigChange,
  onTranscribe,
  onApply,
  onClose,
  onRefreshModels,
}: AiLyricsPanelProps) {
  const units = result?.words.length ? result.words : result?.segments ?? [];

  return (
    <div className="ai-panel">
      <div className="ai-panel-header">
        <div>
          <strong>AI 歌词识别</strong>
          <span>OpenAI 兼容音频转写</span>
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
          模型
          <span className="ai-model-input">
            <input
              list="ai-lyrics-models"
              value={config.model}
              onChange={(event) => onConfigChange({ model: event.target.value })}
              placeholder="whisper-1"
            />
            <button className="btn btn-sm" onClick={onRefreshModels} disabled={modelsLoading}>
              {modelsLoading ? '获取中...' : '获取模型'}
            </button>
          </span>
        </label>
        <label>
          语言
          <input
            value={config.language}
            onChange={(event) => onConfigChange({ language: event.target.value })}
            placeholder="zh / en / ja"
          />
        </label>
      </div>
      <datalist id="ai-lyrics-models">
        {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
      </datalist>

      <label className="ai-prompt-field">
        歌词提示
        <textarea
          value={config.prompt}
          onChange={(event) => onConfigChange({ prompt: event.target.value })}
          placeholder="可选。填入已知歌词，可提高识别准确率"
          rows={3}
        />
      </label>

      <div className="ai-panel-actions">
        <button
          className="btn btn-primary"
          onClick={onTranscribe}
          disabled={!audioReady || busy || !config.baseUrl || !config.model}
        >
          {busy ? '识别中...' : '识别歌词'}
        </button>
        <button
          className="btn"
          onClick={onApply}
          disabled={!canApply || units.length === 0}
        >
          对齐到音符
        </button>
        {!audioReady && <span className="ai-hint">先上传人声素材</span>}
      </div>

      {error && <div className="humanv-error">{error}</div>}
      {modelsError && <div className="ai-hint">{modelsError}</div>}

      {result && (
        <div className="ai-result">
          <div className="ai-result-summary">
            <strong>{result.text || '无识别文本'}</strong>
            <span>{units.length} 个时间片段</span>
          </div>
          <div className="ai-segment-list">
            {units.map((unit, index) => (
              <div className="ai-segment" key={`${unit.start}-${index}`}>
                <span>{formatTime(unit.start)} - {formatTime(unit.end)}</span>
                <strong>{unit.text}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
