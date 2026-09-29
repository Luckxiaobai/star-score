/* ================================================================
 * 星谱识音 · 音频识别对话框组件
 * ----------------------------------------------------------------
 * 职责：音频上传 + 人声分离（可选后端） + 音高分析 + 结果预览
 *
 * 目录（搜索关键词快速定位）：
 *   [IMPORTS]    导入
 *   [TYPES]      Props 类型定义
 *   [STATE]      局部状态（文件/分析/分离/可视化）
 *   [EFFECTS]    副作用（引擎初始化 + 波形绘制 + 清理）
 *   [ACTIONS]    用户操作（文件选择/拖拽/分析/应用结果）
 *   [RENDER]     JSX 渲染
 *   [HELPERS]    辅助函数（音频预览/波形峰值计算）
 *
 * 对话框流程：
 *   上传区 → 文件信息 → 预览播放 → 分离面板（可选）→ 分析
 *   → 进度条 → 结果统计 + 波形可视化 → 导入编辑器
 * ================================================================ */

/* [IMPORTS] 导入 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { Score } from '../types/score';
import { analyzeAudio, convertToScore, type AnalysisResult, checkEngineStatus } from '../pipeline/analyze';
import { checkBackend, type SeparateMode } from '../core/audio/separate';
import { getBackendUrl, setBackendUrl as persistBackendUrl } from '../core/audio/backendConfig';
import { AudioEngine } from '../core/engine/AudioEngine';
import { freqToMidi } from '../pipeline/analyze';
import '../styles/audioImport.css';

/* [TYPES] Props 类型定义 */
interface AudioImportProps {
  onResult: (score: Score, analysis: AnalysisResult) => void;
  onClose: () => void;
}

export const AudioImport: React.FC<AudioImportProps> = ({ onResult, onClose }) => {
  /* [STATE] 局部状态 */
  // --- 文件 & 分析 ---
  const [file, setFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [error, setError] = useState('');
  const [waveform, setWaveform] = useState<number[]>([]);
  const [pitchTrack, setPitchTrack] = useState<{ time: number; midi: number; conf: number }[]>([]);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // --- 人声 / 伴奏分离（可选，需要本地后端） ---
  const [useSeparate, setUseSeparate] = useState(false);
  const [separateMode, setSeparateMode] = useState<SeparateMode>('vocal');
  const [backendUrl, setBackendUrlLocal] = useState(getBackendUrl);
  const [backendState, setBackendState] = useState<'unknown' | 'ok' | 'down'>('unknown');
  const [backendSavedMsg, setBackendSavedMsg] = useState('');

  // --- 引擎状态 ---
  const [engineStatus, setEngineStatus] = useState<{ id: string; name: string; available: boolean; requiresBackend: boolean }[]>([]);

  // --- DOM refs ---
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioEngineRef = useRef<AudioEngine | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);

  /* [EFFECTS] 副作用 */
  // 初始化音频引擎
  useEffect(() => {
    audioEngineRef.current = new AudioEngine();
    return () => { audioEngineRef.current?.stop(); };
  }, []);

  // 检测可用引擎状态
  useEffect(() => {
    checkEngineStatus().then(setEngineStatus).catch(() => {});
  }, [backendUrl]);

  /* [ACTIONS] 用户操作 */

  // 处理文件选择
  const handleFile = useCallback(async (selectedFile: File) => {
    if (!selectedFile.type.startsWith('audio/') && !selectedFile.name.match(/\.(mp3|wav|ogg|m4a|flac|aac)$/i)) {
      setError('请选择音频文件 (MP3, WAV, OGG, M4A)');
      return;
    }

    setError('');
    setFile(selectedFile);
    setAnalyzing(false);
    setProgress(0);
    setProgressMsg('');
    setWaveform([]);
    setPitchTrack([]);
    setAnalysisResult(null);

    // 创建预览URL
    if (audioRef.current) {
      audioRef.current.src = URL.createObjectURL(selectedFile);
    }
  }, []);

  // 拖拽处理
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) handleFile(droppedFile);
  }, [handleFile]);

  // 开始分析
  const handleAnalyze = useCallback(async () => {
    if (!file) return;
    setAnalyzing(true);
    setError('');

    try {
      const { analysis } = await analyzeAudio(
        file,
        (pct, msg) => {
          setProgress(pct);
          setProgressMsg(msg);
        },
        { separate: { enabled: useSeparate, baseUrl: backendUrl, mode: separateMode } }
      );

      setAnalysisResult(analysis);

      // 生成波形预览
      const { channelData } = await getAudioPreview(file);
      const peaks = computeWaveformPeaks(channelData, 200);
      setWaveform(peaks);

      // 生成音高轨迹预览
      const pitchPreview = analysis.notes.map(n => ({
        time: n.startTime,
        midi: freqToMidi(n.frequency),
        conf: n.confidence,
      }));
      setPitchTrack(pitchPreview.slice(0, 200));

      setAnalyzing(false);
      setProgress(1);
      setProgressMsg('分析完成!');
    } catch (err) {
      setAnalyzing(false);
      setError(`分析失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [file, useSeparate, backendUrl, separateMode]);

  // 应用结果到主编辑器
  // 直接用已缓存的识别结果生成简谱，不重新跑 analyzeAudio。
  // 旧版重新跑分析会创建多个临时 AudioContext，可能导致
  // 后续播放时 AudioContext 冲突或资源耗尽 → 无声。
  const handleApply = useCallback(() => {
    if (!analysisResult) return;
    const score = convertToScore(
      analysisResult.notes,
      analysisResult.estimatedTempo,
      analysisResult.estimatedKey
    );
    onResult(score, analysisResult);
  }, [analysisResult, onResult]);

  // 绘制波形
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas || (waveform.length === 0 && pitchTrack.length === 0)) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    // 清空
    ctx.clearRect(0, 0, W, H);

    // 绘制波形
    if (waveform.length > 0) {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
      const barWidth = W / waveform.length;
      for (let i = 0; i < waveform.length; i++) {
        const h = waveform[i] * H * 0.4;
        ctx.fillRect(i * barWidth, (H - h) / 2, barWidth * 0.8, h);
      }
    }

    // 绘制音高轨迹
    if (pitchTrack.length > 0) {
      const minMidi = 40;
      const maxMidi = 90;
      const range = maxMidi - minMidi;
      const duration = pitchTrack[pitchTrack.length - 1]?.time || 1;

      // 连线
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (const pt of pitchTrack) {
        const x = (pt.time / duration) * W;
        const y = H - ((pt.midi - minMidi) / range) * H;
        if (pt.conf > 0.5) {
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        } else {
          if (started) {
            ctx.stroke();
            ctx.beginPath();
            started = false;
          }
        }
      }
      if (started) ctx.stroke();

      // 点
      ctx.fillStyle = '#ef4444';
      for (const pt of pitchTrack) {
        if (pt.conf > 0.5) {
          const x = (pt.time / duration) * W;
          const y = H - ((pt.midi - minMidi) / range) * H;
          ctx.beginPath();
          ctx.arc(x, y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }, [waveform, pitchTrack]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    return () => {
      audio.pause();
    };
  }, []);

  /* [RENDER] JSX 渲染 */
  return (
    <div className="modal-overlay" onClick={onClose}>
        <div className="audio-modal" onClick={e => e.stopPropagation()}>
        <div className="audio-modal-header">
          <h2>音频智能识别</h2>
          <button className="btn btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="audio-modal-body">
          {/* 上传区 */}
          {!file && (
            <div
              className={`upload-zone ${dragOver ? 'drag-over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="upload-icon">🎵</div>
              <div className="upload-text">拖拽音频文件到这里，或点击选择</div>
              <div className="upload-hint">支持 MP3, WAV, OGG, M4A · 建议人声或旋律清晰的音频</div>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
            </div>
          )}

          {/* 文件信息 */}
          {file && (
            <div className="file-info">
              <div className="file-name">📄 {file.name}</div>
              <div className="file-meta">{(file.size / 1024 / 1024).toFixed(2)} MB</div>
              <button className="btn btn-sm" onClick={() => fileInputRef.current?.click()}>更换</button>
            </div>
          )}

          {/* 预览播放 */}
          {file && (
            <div className="audio-preview">
              <audio ref={audioRef} controls style={{ width: '100%', height: 36 }} />
            </div>
          )}

          {/* 人声 / 伴奏分离（可选后端） */}
          {file && !analyzing && !analysisResult && (
            <div className="separate-panel">
              <label className="separate-toggle">
                <input
                  type="checkbox"
                  checked={useSeparate}
                  onChange={e => setUseSeparate(e.target.checked)}
                />
                <span>人声 / 伴奏分离（提升识别准确度，需后端）</span>
              </label>
              {useSeparate && (
                <div className="separate-body">
                  <div className="separate-row">
                    <span className="separate-label">保留</span>
                    <select
                      value={separateMode}
                      onChange={e => setSeparateMode(e.target.value as SeparateMode)}
                    >
                      <option value="vocal">人声（推荐，识别主旋律）</option>
                      <option value="accompaniment">伴奏</option>
                    </select>
                  </div>
                  <div className="separate-row">
                    <span className="separate-label">后端</span>
                    <input
                      type="text"
                      value={backendUrl}
                      onChange={e => {
                        setBackendUrlLocal(e.target.value);
                        setBackendState('unknown');
                      }}
                      style={{ flex: 1 }}
                    />
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        const next = persistBackendUrl(backendUrl);
                        setBackendUrlLocal(next);
                        setBackendState('unknown');
                        setBackendSavedMsg('已保存');
                        window.setTimeout(() => setBackendSavedMsg(''), 1500);
                      }}
                    >
                      保存
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        setBackendState('unknown');
                        const r = await checkBackend(backendUrl);
                        setBackendState(r.ok ? 'ok' : 'down');
                      }}
                    >
                      检测
                    </button>
                  </div>
                  <div className="separate-hint">
                    {backendSavedMsg && <span style={{ color: '#22c55e', marginRight: 8 }}>✅ {backendSavedMsg}</span>}
                    {backendState === 'ok' && '✅ 后端在线'}
                    {backendState === 'down' && '❌ 后端未启动，请双击 backend/启动后端.bat'}
                    {backendState === 'unknown' && '未检测。启动命令：py backend/server.py'}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 引擎状态面板 */}
          {engineStatus.length > 0 && file && !analyzing && !analysisResult && (
            <div className="engine-status-panel">
              <div className="sidebar-title">可用引擎</div>
              <div className="engine-status-list">
                {engineStatus.map(eng => (
                  <div key={eng.id} className={`engine-status-item ${eng.available ? 'ok' : 'off'}`}>
                    <span className="engine-dot">{eng.available ? '●' : '○'}</span>
                    <span className="engine-name">{eng.name}</span>
                    <span className="engine-tag">
                      {eng.requiresBackend ? '后端' : '浏览器'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 分析按钮 */}
          {file && !analyzing && !analysisResult && (
            <button className="btn btn-primary audio-analyze-btn" onClick={handleAnalyze}>
              🔍 开始识别
            </button>
          )}

          {/* 进度条 */}
          {analyzing && (
            <div className="analysis-progress">
              <div className="progress-bar-bg">
                <div className="progress-bar-fill" style={{ width: `${progress * 100}%` }} />
              </div>
              <div className="progress-text">{progressMsg} ({Math.round(progress * 100)}%)</div>
              <div className="progress-hint">
                {progress < 0.15 && '正在加载神经网络模型...'}
                {progress >= 0.15 && progress < 0.85 && '神经网络推理中，识别音符和音高...'}
                {progress >= 0.85 && progress < 0.92 && '估计节拍和调号...'}
                {progress >= 0.92 && '生成简谱...'}
              </div>
            </div>
          )}

          {/* 错误提示 */}
          {error && <div className="audio-error">⚠️ {error}</div>}

          {/* 分析结果 */}
          {analysisResult && (
            <div className="analysis-result">
              <h3>识别结果</h3>

              {/* 统计信息 */}
              <div className="result-stats">
                <div className="stat-item">
                  <div className="stat-value">{analysisResult.estimatedTempo}</div>
                  <div className="stat-label">BPM 节拍</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{analysisResult.estimatedKey}</div>
                  <div className="stat-label">调号 ({Math.round(analysisResult.keyConfidence * 100)}%)</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{analysisResult.notes.length}</div>
                  <div className="stat-label">音符数</div>
                </div>
                <div className="stat-item">
                  <div className="stat-value">{analysisResult.duration.toFixed(1)}s</div>
                  <div className="stat-label">时长</div>
                </div>
              </div>

              {/* 引擎标识 */}
              {analysisResult.engineId && (
                <div className="result-hint" style={{ marginBottom: 0, padding: '8px 16px', fontSize: 12 }}>
                  {analysisResult.engineId === 'game'
                    ? '🧠 GAME 离散扩散模型引擎（歌声专用，精度最高）'
                    : analysisResult.engineId === 'basic-pitch'
                    ? '🧠 Basic Pitch 神经网络引擎（浏览器端）'
                    : '📊 YIN 信号处理引擎（兜底模式）'}
                </div>
              )}

              {/* 波形 + 音高可视化 */}
              <div className="viz-section">
                <div className="viz-title">波形 & 音高轨迹</div>
                <canvas
                  ref={waveformCanvasRef}
                  width={520}
                  height={120}
                  className="viz-canvas"
                />
                <div className="viz-legend">
                  <span className="legend-item"><span className="legend-dot" style={{ background: 'rgba(59,130,246,0.3)' }}></span>波形</span>
                  <span className="legend-item"><span className="legend-dot" style={{ background: '#ef4444' }}></span>音高</span>
                </div>
              </div>

              {/* 提示 */}
              <div className="result-hint">
                💡 自动识别会有误差，导入后可在编辑器中精修。改一个音，立刻能听见对不对。
              </div>

              {/* 操作按钮 */}
              <div className="result-actions">
                <button className="btn" onClick={handleAnalyze}>重新识别</button>
                <button className="btn btn-primary" onClick={handleApply}>导入到编辑器 →</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* [HELPERS] 辅助函数 */

/** 解码音频文件，获取声道数据用于波形预览 */
async function getAudioPreview(file: File): Promise<{ channelData: Float32Array; sampleRate: number }> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    await ctx.close();
    return { channelData, sampleRate: audioBuffer.sampleRate };
  } catch {
    await ctx.close();
    return { channelData: new Float32Array(0), sampleRate: 44100 };
  }
}

/** 将 PCM 数据降采样为指定数量的峰值，用于波形可视化 */
function computeWaveformPeaks(data: Float32Array, numPeaks: number): number[] {
  if (data.length === 0) return [];
  const peaks: number[] = [];
  const samplesPerPeak = Math.floor(data.length / numPeaks);
  for (let i = 0; i < numPeaks; i++) {
    let max = 0;
    const start = i * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, data.length);
    for (let j = start; j < end; j++) {
      const abs = Math.abs(data[j]);
      if (abs > max) max = abs;
    }
    peaks.push(max);
  }
  return peaks;
}
