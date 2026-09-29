import { useCallback, useEffect, useRef, useState } from 'react';

export interface AudioClipPlayer {
  playing: boolean;
  currentTime: number;
  duration: number;
  error: string;
  volume: number;
  rate: number;
  loop: boolean;
  play: () => Promise<void>;
  pause: () => void;
  stop: () => void;
  toggle: () => Promise<void>;
  seek: (sec: number) => void;
  setVolume: (value: number) => void;
  setRate: (value: number) => void;
  setLoop: (value: boolean) => void;
}

/**
 * 管理单个音频片段的播放状态。
 *
 * 合成结果、素材试听和未来的其他音频预览都可以复用这个控制器，
 * 不再把 HTMLAudioElement 的事件处理散落在业务组件里。
 */
export function useAudioClipPlayer(src: string | null): AudioClipPlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const volumeRef = useRef(0.9);
  const rateRef = useRef(1);
  const loopRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState('');
  const [volume, setVolumeState] = useState(0.9);
  const [rate, setRateState] = useState(1);
  const [loop, setLoopState] = useState(false);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.volume = volumeRef.current;
    audio.playbackRate = rateRef.current;
    audio.loop = loopRef.current;
    audioRef.current = audio;

    const syncTime = () => setCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    const syncDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const markPlaying = () => setPlaying(true);
    const markPaused = () => setPlaying(false);
    const handleEnded = () => {
      setPlaying(false);
      setCurrentTime(0);
      audio.currentTime = 0;
    };
    const handleError = () => {
      setPlaying(false);
      setError('音频加载失败，请重新生成或下载后播放');
    };

    audio.addEventListener('timeupdate', syncTime);
    audio.addEventListener('durationchange', syncDuration);
    audio.addEventListener('loadedmetadata', syncDuration);
    audio.addEventListener('play', markPlaying);
    audio.addEventListener('pause', markPaused);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    if (src) {
      audio.src = src;
      audio.load();
    }

    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', syncTime);
      audio.removeEventListener('durationchange', syncDuration);
      audio.removeEventListener('loadedmetadata', syncDuration);
      audio.removeEventListener('play', markPlaying);
      audio.removeEventListener('pause', markPaused);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
      if (audioRef.current === audio) audioRef.current = null;
    };
  }, [src]);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !src) return;
    setError('');
    try {
      if (audio.ended || audio.currentTime >= audio.duration) audio.currentTime = 0;
      await audio.play();
    } catch (e) {
      setPlaying(false);
      setError(e instanceof Error ? e.message : '播放失败');
    }
  }, [src]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setCurrentTime(0);
  }, []);

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      await play();
    } else {
      pause();
    }
  }, [pause, play]);

  const seek = useCallback((sec: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const max = Number.isFinite(audio.duration) ? audio.duration : 0;
    const next = Math.max(0, Math.min(Number.isFinite(sec) ? sec : 0, max));
    audio.currentTime = next;
    setCurrentTime(next);
  }, []);

  const setVolume = useCallback((value: number) => {
    const next = Math.max(0, Math.min(1, value));
    volumeRef.current = next;
    setVolumeState(next);
    if (audioRef.current) audioRef.current.volume = next;
  }, []);

  const setRate = useCallback((value: number) => {
    const next = Math.max(0.5, Math.min(2, value));
    rateRef.current = next;
    setRateState(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }, []);

  const setLoop = useCallback((value: boolean) => {
    loopRef.current = value;
    setLoopState(value);
    if (audioRef.current) audioRef.current.loop = value;
  }, []);

  return {
    playing,
    currentTime,
    duration,
    error,
    volume,
    rate,
    loop,
    play,
    pause,
    stop,
    toggle,
    seek,
    setVolume,
    setRate,
    setLoop,
  };
}
