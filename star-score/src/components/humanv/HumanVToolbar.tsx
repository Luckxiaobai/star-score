import type { MidiDocument } from '../../types/midiProject';
import { TIMBRE_LIST } from '../../core/engine/timbres';

type SnapDivision = 'off' | '4' | '8' | '16';

interface HumanVToolbarProps {
  doc: MidiDocument | null;
  sampleName?: string;
  synthProviderName?: string;
  synthProviderDescription?: string;
  synthBusy: boolean;
  canGenerate: boolean;
  backendOnline: boolean;
  isPlaying: boolean;
  canUndo: boolean;
  canRedo: boolean;
  snapDivision: SnapDivision;
  bpmDraft: string;
  timbreId: string;
  aiBusy: boolean;
  onImportMidi: () => void;
  onOpenCommand: () => void;
  onTogglePlayback: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onExportMidi: () => void;
  onToScore: () => void;
  onSave: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  onZoomIn: () => void;
  onSnapChange: (value: SnapDivision) => void;
  onBpmDraftChange: (value: string) => void;
  onCommitBpm: (value: string) => void;
  onTimeSignatureChange: (value: [number, number]) => void;
  onTimbreChange: (value: string) => void;
  onOpenProject: () => void;
  onUploadSample: () => void;
  onGenerate: () => void;
  onAbort: () => void;
  onOpenAi: () => void;
  onOpenAiMidi: () => void;
}

export function HumanVToolbar({
  doc,
  sampleName,
  synthProviderName,
  synthProviderDescription,
  synthBusy,
  canGenerate,
  backendOnline,
  isPlaying,
  canUndo,
  canRedo,
  snapDivision,
  bpmDraft,
  timbreId,
  aiBusy,
  onImportMidi,
  onOpenCommand,
  onTogglePlayback,
  onUndo,
  onRedo,
  onExportMidi,
  onToScore,
  onSave,
  onZoomOut,
  onFitView,
  onZoomIn,
  onSnapChange,
  onBpmDraftChange,
  onCommitBpm,
  onTimeSignatureChange,
  onTimbreChange,
  onOpenProject,
  onUploadSample,
  onGenerate,
  onAbort,
  onOpenAi,
  onOpenAiMidi,
}: HumanVToolbarProps) {
  return (
    <div className="humanv-toolbar">
      <button className="btn btn-primary" onClick={onImportMidi}>
        导入 MIDI
      </button>
      <button className="btn" onClick={onOpenCommand} title="打开命令面板 (Ctrl+K)">
        命令
      </button>
      <button className="btn" onClick={onOpenAi}>
        {aiBusy ? 'AI 识别中...' : 'AI 歌词'}
      </button>
      <button className="btn" onClick={onOpenAiMidi}>
        AI MIDI
      </button>

      {doc && (
        <>
          <button className="btn" onClick={onTogglePlayback}>
            {isPlaying ? '停止' : '播放MIDI'}
          </button>
          <button className="btn btn-icon" onClick={onUndo} disabled={!canUndo} title="撤销 (Ctrl+Z)">
            ↶
          </button>
          <button className="btn btn-icon" onClick={onRedo} disabled={!canRedo} title="重做 (Ctrl+Y)">
            ↷
          </button>
          <button className="btn" onClick={onExportMidi}>导出 MIDI</button>
          <button className="btn" onClick={onToScore}>生成简谱</button>
          <button className="btn" onClick={onSave} disabled={!backendOnline}>
            保存工程
          </button>

          <span className="humanv-sep" />
          <button className="btn btn-icon" onClick={onZoomOut} title="缩小时间轴">−</button>
          <button className="btn btn-sm" onClick={onFitView} title="适配全部音符">适配</button>
          <button className="btn btn-icon" onClick={onZoomIn} title="放大时间轴">+</button>
          <label className="humanv-inline-field">
            吸附
            <select
              value={snapDivision}
              onChange={(event) => onSnapChange(event.target.value as SnapDivision)}
            >
              <option value="off">关闭</option>
              <option value="4">1/4</option>
              <option value="8">1/8</option>
              <option value="16">1/16</option>
            </select>
          </label>

          <span className="humanv-sep" />
          <label className="humanv-inline-field">
            BPM
            <input
              type="number"
              min={20}
              max={300}
              step={1}
              value={bpmDraft}
              onChange={(event) => onBpmDraftChange(event.target.value)}
              onBlur={(event) => onCommitBpm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onCommitBpm((event.target as HTMLInputElement).value);
              }}
              style={{ width: 62 }}
              title="修改后按回车或点开别处生效"
            />
          </label>
          <label className="humanv-inline-field">
            拍号
            <select
              value={`${doc.time.timeSignature[0]}/${doc.time.timeSignature[1]}`}
              onChange={(event) => {
                const [n, d] = event.target.value.split('/').map(Number);
                onTimeSignatureChange([n, d]);
              }}
            >
              <option value="2/4">2/4</option>
              <option value="3/4">3/4</option>
              <option value="4/4">4/4</option>
              <option value="3/8">3/8</option>
              <option value="6/8">6/8</option>
            </select>
          </label>
          <label className="humanv-inline-field">
            音色
            <select value={timbreId} onChange={(event) => onTimbreChange(event.target.value)}>
              {TIMBRE_LIST.map((timbre) => (
                <option key={timbre.id} value={timbre.id}>{timbre.name}</option>
              ))}
            </select>
          </label>
        </>
      )}

      <span className="humanv-sep" />
      <button className="btn" onClick={onOpenProject} disabled={!backendOnline}>
        打开工程
      </button>
      <button className="btn" onClick={onUploadSample}>
        {sampleName ? `素材: ${sampleName}` : '上传素材音频'}
      </button>

      {synthBusy ? (
        <button className="btn btn-danger" onClick={onAbort}>中止合成</button>
      ) : (
        <button
          className="btn btn-primary"
          onClick={onGenerate}
          disabled={!canGenerate}
          title={synthProviderDescription ?? '先导入 MIDI、素材并保持后端在线'}
        >
          {synthProviderName ? `生成（${synthProviderName}）` : '一键生成'}
        </button>
      )}
    </div>
  );
}
