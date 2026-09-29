# -*- coding: utf-8 -*-
"""人力V工作台 · 单样本循环合成引擎（后端）

契约 v0.3.1 对齐：
  - 拉伸倍率安全区间 0.5 ~ 2.0
  - <0.5：截取素材核心稳态段，只截取一次，不再递归二次截取
  - >2.0：策略二选一 loop（循环填充）/ stretch_max（拉伸2倍+衰减静音）
  - 变调：素材平均基频 -> 目标音符音高（半音偏移）
  - 拼接：相邻片段交叉淡化，消除爆音

音频形变当前实现：numpy + scipy 重采样（线性/FFT 插值）。
预留 pyrubberband 接口：若系统可执行 rubberband 可用，则切换为共振峰保持算法。
"""

import io
import math
import wave

import numpy as np

try:
    from scipy.signal import resample as _scipy_resample
    HAS_SCIPY = True
except Exception:
    HAS_SCIPY = False

# ---------------------------------------------------------------
# 参数（契约 settings 段）
# ---------------------------------------------------------------

MIN_STRETCH_RATIO = 0.5
MAX_STRETCH_RATIO = 2.0
LONG_NOTE_STRATEGY = 'loop'  # 保持 star-score 实际生效策略（前端 HumanVWorkbench 不传 params，长音一直隐式走 loop）；'loop'|'stretch_max'，调用方经 params.strategy 可覆盖。契约线默认 stretch_max，最终统一待拍板
CROSSFADE_MS = 30
SAMPLE_RATE = 44100


# ---------------------------------------------------------------
# 重采样 / 变调 / 变速
# ---------------------------------------------------------------

def _resample(x: np.ndarray, num: int) -> np.ndarray:
    """重采样到指定点数（保持采样率语义：变音高/变速）。"""
    if num <= 0:
        return np.zeros(1, dtype=np.float32)
    if num == len(x):
        return x.copy()
    if HAS_SCIPY:
        return _scipy_resample(x, num).astype(np.float32)
    # 无 scipy 兜底：线性插值
    idx = np.linspace(0, len(x) - 1, num)
    i0 = np.floor(idx).astype(np.int64)
    i1 = np.minimum(i0 + 1, len(x) - 1)
    frac = (idx - i0).astype(np.float32)
    return (x[i0] * (1 - frac) + x[i1] * frac).astype(np.float32)


def pitch_shift(x: np.ndarray, semitones: float) -> np.ndarray:
    """变调（保持时长）。简化双重重采样实现。"""
    if abs(semitones) < 1e-6:
        return x.copy()
    r = 2.0 ** (semitones / 12.0)
    n1 = max(1, int(round(len(x) / r)))
    y = _resample(x, n1)      # 变调（时长随之变化）
    y = _resample(y, len(x))  # 时长复原
    return y


def time_stretch(x: np.ndarray, ratio: float) -> np.ndarray:
    """变速不变调：时长变 ratio 倍，音高保持不变。"""
    if abs(ratio - 1.0) < 1e-6:
        return x.copy()
    n1 = max(1, int(round(len(x) * ratio)))
    y = _resample(x, n1)                       # 变速（音高随之变化）
    y = pitch_shift(y, 12.0 * math.log2(ratio))  # 变调补偿，保持音高
    return y


def loop_fill(x: np.ndarray, target_len: int) -> np.ndarray:
    """循环填充核心段到目标长度，末尾淡出。"""
    if len(x) == 0:
        return np.zeros(target_len, dtype=np.float32)
    reps = int(math.ceil(target_len / len(x)))
    y = np.tile(x, reps)[:target_len].astype(np.float32)
    # 末尾 30ms 淡出，避免循环截断爆音
    fade = min(len(y), int(SAMPLE_RATE * 0.03))
    if fade > 0:
        y[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    return y


# ---------------------------------------------------------------
# 素材特征
# ---------------------------------------------------------------

def detect_core(x: np.ndarray, sr: int, threshold_db: float = -35.0):
    """RMS 能量检测核心发音段（去头尾静音）。返回 (start, end) 采样点。"""
    if len(x) == 0:
        return 0, 0
    hop = max(1, int(sr * 0.01))
    n = len(x) // hop
    if n < 2:
        return 0, len(x)
    frames = x[: n * hop].reshape(n, hop)
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    peak = rms.max()
    if peak < 1e-6:
        return 0, len(x)
    thresh = 10.0 ** (threshold_db / 20.0) * peak
    idx = np.where(rms > thresh)[0]
    if len(idx) == 0:
        return 0, len(x)
    pad = int(sr * 0.02)
    start = max(0, idx[0] * hop - pad)
    end = min(len(x), (idx[-1] + 1) * hop + pad)
    return start, end


def estimate_pitch_midi(x: np.ndarray, sr: int) -> float:
    """自相关法粗略估计素材平均基频，返回 MIDI note number。"""
    frame = x[: min(len(x), sr)].astype(np.float64)
    if len(frame) < sr // 100:
        return 60.0
    frame = frame - frame.mean()
    window = np.hanning(len(frame))
    frame = frame * window
    corr = np.correlate(frame, frame, 'full')[len(frame) - 1:]
    # 搜索范围 50Hz ~ 800Hz
    lo = max(1, int(sr / 800))
    hi = min(len(corr) - 1, int(sr / 50))
    if hi <= lo:
        return 60.0
    seg = corr[lo:hi]
    peak = int(np.argmax(seg)) + lo
    if peak <= 0:
        return 60.0
    freq = sr / peak
    midi = 69.0 + 12.0 * math.log2(freq / 440.0)
    return float(midi)


# ---------------------------------------------------------------
# 主合成：单样本循环
# ---------------------------------------------------------------

def synth_single_sample(
    sample: np.ndarray,
    sr: int,
    notes,
    params: dict | None = None,
) -> tuple[np.ndarray, list[dict]]:
    """单样本循环合成。

    Args:
        sample: float32 mono 素材（基础样本，如 1s 的“喵”）
        sr: 素材采样率
        notes: [{start:秒, duration:秒, pitch:MIDI, velocity:0-127}]
        params: 覆盖默认参数
    Returns:
        (合成音频 float32 mono @44100, 每音符处理报告)
    """
    p = {
        'min_ratio': MIN_STRETCH_RATIO,
        'max_ratio': MAX_STRETCH_RATIO,
        'strategy': LONG_NOTE_STRATEGY,
        'crossfade_ms': CROSSFADE_MS,
        'sample_rate': SAMPLE_RATE,
    }
    if params:
        p.update(params)
    out_sr = int(p['sample_rate'])

    # 素材统一到输出采样率
    if sr != out_sr:
        sample = _resample(sample, int(round(len(sample) * out_sr / sr)))
        sr = out_sr

    core_s, core_e = detect_core(sample, sr)
    core = sample[core_s:core_e] if core_e > core_s else sample
    if len(core) == 0:
        raise ValueError('素材为空')

    src_midi = estimate_pitch_midi(core, sr)
    core_dur = len(core) / sr
    fade_n = int(sr * p['crossfade_ms'] / 1000.0)

    total_len = int(round(max((n.get('start', 0) + n.get('duration', 0) for n in notes), default=0) * sr)) + fade_n + 1
    total = np.zeros(total_len, dtype=np.float32)

    report = []
    for n in notes:
        start = float(n.get('start', 0))
        dur = float(n.get('duration', 0))
        pitch = float(n.get('pitch', 60))
        velocity = int(n.get('velocity', 100))
        note_id = str(n.get('id', ''))

        if dur <= 0 or not n.get('enabled', True):
            report.append({'id': note_id, 'strategy': 'skip'})
            continue

        target_len = int(round(dur * sr))
        required_ratio = dur / core_dur
        applied_ratio = required_ratio
        strategy = 'direct'
        warn = []

        # --- 倍率决策（契约 3.2）---
        if required_ratio < p['min_ratio']:
            # 截取核心段后仍不足，直接接受（不递归二次截取）
            strategy = 'direct'
            applied_ratio = required_ratio
            warn.append('stretch_out_of_range')
        elif required_ratio > p['max_ratio']:
            strategy = p['strategy']
            if strategy == 'stretch_max':
                applied_ratio = p['max_ratio']
                warn.append('stretch_out_of_range')
            else:  # loop
                applied_ratio = required_ratio

        # --- 变调 ---
        semitones = pitch - src_midi
        # 告警边界对齐契约 v0.3.2：黄 5~7 闭区间、红 ≥8（原为 >5 / >8）
        if abs(semitones) >= 8:
            warn.append('pitch_shift_error')
        elif abs(semitones) >= 5:
            warn.append('pitch_shift_warning')

        # --- 渲染该音符音频块 ---
        if strategy == 'loop':
            seg = pitch_shift(core, semitones)
            seg = loop_fill(seg, target_len)
        else:
            seg = pitch_shift(core, semitones)
            seg = time_stretch(seg, applied_ratio)
            if strategy == 'stretch_max':
                # 拉伸到 2 倍后，剩余时长填充衰减静音（延音）
                if len(seg) < target_len:
                    pad = np.zeros(target_len - len(seg), dtype=np.float32)
                    seg = np.concatenate([seg, pad])
                # 末尾淡出
                seg = loop_fill(seg[:target_len], target_len) if False else seg
                seg[-fade_n:] *= np.linspace(1.0, 0.0, fade_n, dtype=np.float32) if fade_n > 0 else 1.0

        # 音量（velocity 映射，契约 3.1：无削波；v<=0 → 静音 -inf，对齐契约 velocity_to_db）
        db = float('-inf') if velocity <= 0 else 20.0 * math.log10(velocity / 127.0)
        seg = seg * (10.0 ** (db / 20.0))

        # --- 放置 + 交叉淡化 ---
        idx0 = int(round(start * sr))
        idx1 = min(idx0 + len(seg), len(total))
        if idx0 >= len(total):
            continue
        seg = seg[: idx1 - idx0]

        if idx0 > 0 and fade_n > 0:
            # 与前一音符重叠/邻接处做淡入
            fade_in = min(fade_n, len(seg))
            seg[:fade_in] *= np.linspace(0.0, 1.0, fade_in, dtype=np.float32)
        total[idx0:idx1] += seg

        report.append({
            'id': note_id,
            'strategy': strategy,
            'required_ratio': round(required_ratio, 3),
            'applied_ratio': round(applied_ratio, 3),
            'semitones': round(semitones, 2),
            'warns': warn,
        })

    return total, report


# ---------------------------------------------------------------
# WAV 编码
# ---------------------------------------------------------------

def encode_wav(x: np.ndarray, sr: int) -> bytes:
    """float32 mono -> 16-bit PCM WAV 字节。"""
    x = np.clip(x, -1.0, 1.0)
    pcm = (x * 32767.0).astype('<i2')
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()
