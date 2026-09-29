import type { BackendHealthStatus } from '../../hooks/useBackendHealth';

interface WorkflowStripProps {
  hasMidi: boolean;
  hasSample: boolean;
  dirty: boolean;
  backendStatus: BackendHealthStatus;
  providerName?: string;
  onRefreshBackend?: () => void;
}

export function WorkflowStrip({
  hasMidi,
  hasSample,
  dirty,
  backendStatus,
  providerName,
  onRefreshBackend,
}: WorkflowStripProps) {
  const ready = hasMidi && hasSample && backendStatus === 'online';

  return (
    <div className="humanv-workflow">
      <span className={`workflow-step ${hasMidi ? 'is-done' : ''}`}>① MIDI</span>
      <span className="workflow-arrow">→</span>
      <span className={`workflow-step ${hasSample ? 'is-done' : ''}`}>② 素材</span>
      <span className="workflow-arrow">→</span>
      <span className={`workflow-step ${ready ? 'is-ready' : ''}`}>③ 合成</span>
      <span className="workflow-spacer" />
      <button
        className={`backend-pill is-${backendStatus}`}
        onClick={onRefreshBackend}
        title="点击重新检测后端"
      >
        {backendStatus === 'online' ? '后端在线' : backendStatus === 'offline' ? '后端离线' : '检测中'}
      </button>
      {providerName && ready && <span className="workflow-provider">{providerName}</span>}
      {dirty && <span className="workflow-dirty">工程有修改，草稿已自动保存</span>}
    </div>
  );
}
