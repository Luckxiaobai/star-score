import { forwardRef, useImperativeHandle } from 'react';
import { useAudioClipPlayer } from '../hooks/useAudioClipPlayer';

interface SynthPlaybackBarProps {
  src: string;
  downloadUrl: string;
  onBeforePlay?: () => void;
}

export interface SynthPlaybackHandle {
  stop: () => void;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const whole = Math.floor(sec);
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export const SynthPlaybackBar = forwardRef<SynthPlaybackHandle, SynthPlaybackBarProps>(
  function SynthPlaybackBar({ src, downloadUrl, onBeforePlay }, ref) {
    const player = useAudioClipPlayer(src);
    const hasAudio = player.duration > 0;

    useImperativeHandle(ref, () => ({ stop: player.stop }), [player.stop]);

    const handleToggle = () => {
      if (!player.playing) onBeforePlay?.();
      void player.toggle();
    };

    return (
      <div className="synth-playback" role="group" aria-label="合成结果播放控制">
        <button
          className="btn btn-primary btn-sm"
          onClick={handleToggle}
          disabled={!hasAudio}
          title={player.playing ? '暂停合成结果' : '播放合成结果'}
        >
          {player.playing ? '暂停' : '播放合成'}
        </button>
        <button
          className="btn btn-sm"
          onClick={player.stop}
          disabled={!hasAudio}
          title="停止并回到开头"
        >
          停止
        </button>
        <span className="synth-playback-time">
          {formatTime(player.currentTime)} / {formatTime(player.duration)}
        </span>
        <input
          className="synth-playback-progress"
          type="range"
          min={0}
          max={hasAudio ? player.duration : 0}
          step={0.01}
          value={hasAudio ? Math.min(player.currentTime, player.duration) : 0}
          onChange={(e) => player.seek(Number(e.target.value))}
          disabled={!hasAudio}
          aria-label="合成结果播放进度"
        />
        <label className="synth-playback-volume">
          音量
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={player.volume}
            onChange={(event) => player.setVolume(Number(event.target.value))}
            aria-label="合成结果音量"
          />
        </label>
        <select
          value={player.rate}
          onChange={(event) => player.setRate(Number(event.target.value))}
          aria-label="合成结果播放速度"
        >
          <option value={0.75}>0.75x</option>
          <option value={1}>1.0x</option>
          <option value={1.25}>1.25x</option>
          <option value={1.5}>1.5x</option>
        </select>
        <button
          className={`btn btn-sm ${player.loop ? 'btn-active' : ''}`}
          onClick={() => player.setLoop(!player.loop)}
          title="循环播放"
        >
          循环
        </button>
        <a className="btn btn-sm" href={downloadUrl} download="humanv_synth.wav">
          下载合成
        </a>
        {player.error && <span className="synth-playback-error">{player.error}</span>}
      </div>
    );
  },
);
