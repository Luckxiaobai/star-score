/* ================================================================
 * 星谱识音 · 模型管理器组件
 * ----------------------------------------------------------------
 * 职责：在 UI 中展示/下载/删除各引擎模型
 *
 * 设计理念：
 *   - 用户不需要懂命令行，在界面里点击就能下载模型
 *   - 每个引擎一个卡片，显示状态/大小/版本
 *   - 下载进度条 + 完成提示
 *   - 已下载的模型可以删除释放空间
 *
 * 目录：
 *   [IMPORTS]    导入
 *   [TYPES]      类型定义
 *   [STATE]      状态
 *   [EFFECTS]    副作用（初始化检测模型状态）
 *   [ACTIONS]    操作（下载/删除/刷新）
 *   [RENDER]     JSX 渲染
 * ================================================================ */

/* [IMPORTS] 导入 */
import React, { useState, useEffect, useCallback } from 'react';
import { checkEngineStatus } from '../core/audio/engines';
import { getBackendUrl, setBackendUrl } from '../core/audio/backendConfig';
import '../styles/modelManager.css';

/* [TYPES] 类型定义 */
interface ModelInfo {
  id: string;
  name: string;
  description: string;
  size: string;
  requiresBackend: boolean;
  available: boolean;
  downloadUrl?: string;
  /** 模型来源说明 */
  source: string;
}

/** 预定义模型列表 */
const MODELS: ModelInfo[] = [
  {
    id: 'basic-pitch',
    name: 'Basic Pitch',
    description: 'Spotify 开源神经网络，通用乐器识别，浏览器端运行',
    size: '~900KB',
    requiresBackend: false,
    available: false,
    downloadUrl: 'https://github.com/spotify/basic-pitch-ts/raw/main/model/model.json',
    source: 'GitHub: spotify/basic-pitch-ts',
  },
  {
    id: 'game',
    name: 'GAME (small)',
    description: 'OpenVPI 歌声专用 D3PM 模型（~12M 参数），速度快，需后端',
    size: '~44MB',
    requiresBackend: true,
    available: false,
    downloadUrl: 'https://github.com/openvpi/GAME/releases/download/v1.0.3/GAME-1.0.3-small-onnx.zip',
    source: 'GitHub: openvpi/GAME v1.0.3',
  },
  {
    id: 'game-medium',
    name: 'GAME (medium)',
    description: 'GAME 中等规格模型（~50M 参数），精度更高，体积更大',
    size: '~172MB',
    requiresBackend: true,
    available: false,
    downloadUrl: 'https://github.com/openvpi/GAME/releases/download/v1.0.3/GAME-1.0.3-medium-onnx.zip',
    source: 'GitHub: openvpi/GAME v1.0.3',
  },
  {
    id: 'game-large',
    name: 'GAME (large)',
    description: 'GAME 大规格模型（~100M 参数），精度最高，体积最大',
    size: '~345MB',
    requiresBackend: true,
    available: false,
    downloadUrl: 'https://github.com/openvpi/GAME/releases/download/v1.0.3/GAME-1.0.3-large-onnx.zip',
    source: 'GitHub: openvpi/GAME v1.0.3',
  },
  {
    id: 'homr',
    name: 'HOMR',
    description: '光学乐谱识别，从图片识别乐谱，需后端',
    size: '~30MB',
    requiresBackend: true,
    available: false,
    downloadUrl: 'https://github.com/liebharc/homr/releases/latest',
    source: 'GitHub: liebharc/homr',
  },
];

interface ModelManagerProps {
  onClose: () => void;
}

/* [STATE] + [RENDER] */
export const ModelManager: React.FC<ModelManagerProps> = ({ onClose }) => {
  const [models, setModels] = useState<ModelInfo[]>(MODELS);
  const [backendUrl, setBackendUrlState] = useState(getBackendUrl);
  const [backendOnline, setBackendOnline] = useState(false);
  const [backendSavedMsg, setBackendSavedMsg] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [message, setMessage] = useState('');

  /* [EFFECTS] 副作用 */
  // 初始化：检测引擎状态
  useEffect(() => {
    refreshStatus(getBackendUrl());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 检测后端在线状态
  const checkBackendOnline = useCallback(async (url: string) => {
    try {
      const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      setBackendOnline(resp.ok);
      return resp.ok;
    } catch {
      setBackendOnline(false);
      return false;
    }
  }, []);

  // 刷新所有模型状态（显式传 url，避免闭包拿到旧地址）
  const refreshStatus = useCallback(async (url: string) => {
    await checkBackendOnline(url);
    setBackendUrl(url); // 同步全局地址（引擎+持久化）

    const status = await checkEngineStatus();
    setModels(prev => prev.map(m => {
      // 所有 GAME 规格共用同一份模型目录（backend/models/game/），
      // 因此只要 GAME 引擎可用，三个规格都算「已安装」。
      const isGame = m.id.startsWith('game');
      const s = status.find(st => st.id === (isGame ? 'game' : m.id));
      return { ...m, available: s?.available ?? false };
    }));
  }, [checkBackendOnline]);

  /* [ACTIONS] 操作 */

  // 更新后端地址：先落库同步引擎，再用新地址刷新状态
  const handleBackendChange = useCallback(async (url: string) => {
    const next = setBackendUrl(url);
    setBackendUrlState(next);
    setBackendSavedMsg('已保存');
    window.setTimeout(() => setBackendSavedMsg(''), 1500);
    await refreshStatus(next);
  }, [refreshStatus]);

  // 下载模型
  // 后端 /api/models/download 立即返回，真正的下载在后台线程进行；
  // 这里按固定间隔轮询 /api/models/status 拿到真实进度，直到 done/error。
  const handleDownload = useCallback(async (model: ModelInfo) => {
    setDownloading(model.id);
    setDownloadProgress(0);
    setMessage(`正在下载 ${model.name}...`);

    try {
      const resp = await fetch(`${backendUrl}/api/models/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: model.id }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || '下载请求被拒绝');
      }

      // 轮询进度
      const poll = async (): Promise<void> => {
        const st = await fetch(
          `${backendUrl}/api/models/status?modelId=${encodeURIComponent(model.id)}`
        )
          .then(r => r.json())
          .catch(() => null);

        if (!st) return;
        if (typeof st.progress === 'number') setDownloadProgress(Math.round(st.progress));
        if (st.message) setMessage(st.message);

        if (st.status === 'done') {
          setDownloadProgress(100);
          setMessage(`${model.name} 下载完成！`);
          await refreshStatus(backendUrl);
          return;
        }
        if (st.status === 'error') {
          throw new Error(st.message || '下载失败');
        }
        await new Promise(res => window.setTimeout(res, 800));
        return poll();
      };

      await poll();
    } catch (err) {
      setMessage(`下载失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      window.setTimeout(() => setDownloading(null), 1200);
    }
  }, [backendUrl, refreshStatus]);

  // 删除模型
  const handleDelete = useCallback(async (model: ModelInfo) => {
    try {
      const resp = await fetch(`${backendUrl}/api/models/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: model.id }),
      });

      if (!resp.ok) throw new Error('删除失败');

      setMessage(`${model.name} 已删除`);
      await refreshStatus(backendUrl);
    } catch (err) {
      setMessage(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [backendUrl, refreshStatus]);

  /* [RENDER] JSX 渲染 */
  return (
    <div className="mm-overlay" onClick={onClose}>
      <div className="mm-modal" onClick={e => e.stopPropagation()}>
        {/* 头部 */}
        <div className="mm-header">
          <h2>模型管理</h2>
          <button className="mm-close" onClick={onClose}>×</button>
        </div>

        {/* 后端配置 */}
        <div className="mm-backend">
          <div className="mm-backend-row">
            <span className="mm-backend-label">后端地址</span>
            <input
              type="text"
              value={backendUrl}
              onChange={e => setBackendUrlState(e.target.value)}
              placeholder="http://127.0.0.1:9874"
              className="mm-backend-input"
            />
            <button
              className="mm-btn mm-btn-refresh"
              onClick={() => handleBackendChange(backendUrl)}
            >
              保存
            </button>
            <span className={`mm-backend-dot ${backendOnline ? 'on' : 'off'}`}>
              {backendOnline ? '● 在线' : '○ 离线'}
            </span>
          </div>
          {backendSavedMsg && (
            <div className="mm-backend-hint" style={{ color: '#22c55e' }}>✅ {backendSavedMsg}</div>
          )}
          {!backendOnline && (
            <div className="mm-backend-hint">
              后端未启动，浏览器端引擎（Basic Pitch）可直接使用，后端引擎需启动后端
            </div>
          )}
        </div>

        {/* 模型列表 */}
        <div className="mm-model-list">
          {models.map(model => (
            <div key={model.id} className={`mm-model-card ${model.available ? 'installed' : 'not-installed'}`}>
              <div className="mm-model-info">
                <div className="mm-model-name">
                  {model.name}
                  {model.available && <span className="mm-badge mm-badge-ok">已安装</span>}
                  {!model.available && !model.requiresBackend && <span className="mm-badge mm-badge-warn">未安装</span>}
                  {model.requiresBackend && !model.available && <span className="mm-badge mm-badge-info">需后端</span>}
                </div>
                <div className="mm-model-desc">{model.description}</div>
                <div className="mm-model-meta">
                  <span>大小: {model.size}</span>
                  <span>来源: {model.source}</span>
                  <span>类型: {model.requiresBackend ? '后端推理' : '浏览器端'}</span>
                </div>
              </div>
              <div className="mm-model-actions">
                {downloading === model.id ? (
                  <div className="mm-download-progress">
                    <div className="mm-progress-bar">
                      <div className="mm-progress-fill" style={{ width: `${downloadProgress}%` }} />
                    </div>
                    <span className="mm-progress-text">{downloadProgress}%</span>
                  </div>
                ) : model.available ? (
                  <button className="mm-btn mm-btn-delete" onClick={() => handleDelete(model)}>
                    删除
                  </button>
                ) : (
                  <button
                    className="mm-btn mm-btn-download"
                    onClick={() => handleDownload(model)}
                    disabled={!backendOnline}
                    title={!backendOnline && model.requiresBackend ? '需要后端在线' : ''}
                  >
                    下载
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 消息提示 */}
        {message && (
          <div className="mm-message">{message}</div>
        )}

        {/* 刷新按钮 */}
        <div className="mm-footer">
          <button className="mm-btn mm-btn-refresh" onClick={() => refreshStatus(backendUrl)}>
            刷新状态
          </button>
        </div>
      </div>
    </div>
  );
};
