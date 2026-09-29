import type { BackendHealthStatus } from '../../hooks/useBackendHealth';

interface WorkbenchEmptyStateProps {
  hasSample: boolean;
  sampleName?: string;
  sampleDurationSec?: number;
  backendStatus: BackendHealthStatus;
  onImportMidi: () => void;
  onUploadSample: () => void;
}

export function WorkbenchEmptyState({
  hasSample,
  sampleName,
  sampleDurationSec,
  backendStatus,
  onImportMidi,
  onUploadSample,
}: WorkbenchEmptyStateProps) {
  return (
    <div className="humanv-empty">
      <div className="humanv-empty-copy">
        <strong>从 MIDI 到“喵喵”成品</strong>
        <span>也可以直接把 `.mid` 或音频文件拖到页面中</span>
      </div>

      <div className="humanv-start-grid">
        <button className="humanv-start-card" onClick={onImportMidi}>
          <span className="humanv-start-index">1</span>
          <strong>导入 MIDI</strong>
          <span>支持标准 `.mid` / `.midi`，导入后自动清洗</span>
        </button>

        <button className="humanv-start-card" onClick={onUploadSample}>
          <span className={`humanv-start-index ${hasSample ? 'is-done' : ''}`}>2</span>
          <strong>{hasSample ? '更换人声素材' : '上传人声素材'}</strong>
          <span>
            {hasSample && sampleName
              ? `${sampleName} · ${sampleDurationSec?.toFixed(2) ?? '?'}s`
              : '建议 0.3 到 1.5 秒，例如“喵”“啊”“嘿”'}
          </span>
        </button>

        <div className={`humanv-start-card is-static ${hasSample ? 'is-done' : ''}`}>
          <span className="humanv-start-index">3</span>
          <strong>一键生成</strong>
          <span>
            {backendStatus === 'online'
              ? '导入 MIDI 和素材后即可生成'
              : '后端离线，请运行一键启动或刷新连接'}
          </span>
        </div>
      </div>
    </div>
  );
}
