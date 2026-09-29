"""
core/audio_utils.py

人力V鬼畜调音工作台 — 音频工具层
对应《核心契约 v0.3.1》

依赖：
  - numpy
  - scipy（重采样）
  - soundfile（音频读写）
  - pyacoustid（可选；指纹功能需 fpcalc.exe）

职责：
  - load_audio：读音频 → 44100 Hz / 单声道 / float32
  - resample_mono：单声道重采样
  - normalize_peak：峰值归一化（默认 -1 dB）
  - compute_audio_hash：音频内容 blake2b 16hex
  - detect_core_region：去头尾静音，返回核心稳态段 [start_sec, end_sec]
  - compute_chroma_fingerprint：chromaprint 指纹（可选）
  - check_fpcalc / check_rubberband：环境探测

约束：
  - 采样率 / 声道 / dtype 必须对齐契约 0 节：44100 / mono / float32
  - blake2b 16hex 用 vproj_schema.blake2b_16hex
"""

from __future__ import annotations

import base64
import logging
import os
import shutil
import sys
from math import gcd
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

# 同目录导入
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from vproj_schema import blake2b_16hex  # noqa: E402

log = logging.getLogger(__name__)


# ============================================================================
# 常量（契约 0 节）
# ============================================================================

TARGET_SR = 44100
TARGET_CHANNELS = 1
TARGET_DTYPE = "float32"

# 核心段检测默认参数
CORE_FRAME_MS = 20
CORE_SILENCE_THRESHOLD_DB = -40.0
CORE_MIN_DURATION_SEC = 0.05

# 归一化目标
DEFAULT_NORMALIZE_TARGET_DB = -1.0


# ============================================================================
# 环境探测（bin/ 前置到 PATH）
# ============================================================================

def _project_bin_dir() -> Path:
    """项目根 /bin 目录。audio_utils.py 位于 core/ 下，往上一级是项目根。"""
    return Path(__file__).resolve().parent.parent / "bin"


def prepend_bin_to_path() -> None:
    """把项目 bin/ 前置到 PATH，供 subprocess 找 fpcalc.exe / rubberband.exe。"""
    b = _project_bin_dir()
    if b.is_dir():
        cur = os.environ.get("PATH", "")
        if str(b) not in cur.split(os.pathsep):
            os.environ["PATH"] = str(b) + os.pathsep + cur


def check_fpcalc() -> Optional[str]:
    """返回 fpcalc 可执行文件完整路径，找不到返回 None。"""
    prepend_bin_to_path()
    return shutil.which("fpcalc")


def check_rubberband() -> Optional[str]:
    """返回 rubberband 可执行文件完整路径，找不到返回 None。"""
    prepend_bin_to_path()
    return shutil.which("rubberband") or shutil.which("rubberband.exe")


# ============================================================================
# 音频读取 / 重采样 / 归一化
# ============================================================================

def resample_mono(audio: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """
    单声道重采样，抗混叠（scipy resample_poly）。
    audio: 1D float32 数组
    """
    if sr_in == sr_out:
        return audio.astype(np.float32, copy=False)
    if sr_in <= 0 or sr_out <= 0:
        raise ValueError(f"invalid sample rate: sr_in={sr_in}, sr_out={sr_out}")
    g = gcd(sr_in, sr_out)
    up = sr_out // g
    down = sr_in // g
    out = resample_poly(audio, up, down)
    return out.astype(np.float32, copy=False)


def load_audio(
    path: str | os.PathLike,
    target_sr: int = TARGET_SR,
) -> Tuple[np.ndarray, int]:
    """
    读音频 → (mono_float32_array, sr)。
    - 多声道自动降为单声道（取均值）
    - 采样率不等于 target_sr 时自动重采样
    """
    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    data = data.astype(np.float32, copy=False)

    if sr != target_sr:
        data = resample_mono(data, sr, target_sr)
        sr = target_sr
    return data, sr


def normalize_peak(
    audio: np.ndarray,
    target_db: float = DEFAULT_NORMALIZE_TARGET_DB,
) -> np.ndarray:
    """
    峰值归一化到 target_db（默认 -1 dB）。
    全零信号原样返回（避免除零）。
    """
    if audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio)))
    if peak <= 0.0:
        return audio
    target_lin = 10.0 ** (target_db / 20.0)
    return (audio * (target_lin / peak)).astype(np.float32, copy=False)


# ============================================================================
# 音频内容哈希
# ============================================================================

def compute_audio_hash(audio: np.ndarray) -> str:
    """
    对音频内容（float32 数组字节）取 blake2b 16hex。
    同一段音频只要 dtype 和采样率一致，哈希稳定。
    """
    b = np.ascontiguousarray(audio, dtype=np.float32).tobytes()
    return blake2b_16hex(b)


# ============================================================================
# 核心稳态段检测
# ============================================================================

def detect_core_region(
    audio: np.ndarray,
    sr: int,
    threshold_db: float = CORE_SILENCE_THRESHOLD_DB,
    frame_ms: int = CORE_FRAME_MS,
    min_dur_sec: float = CORE_MIN_DURATION_SEC,
) -> Tuple[float, float]:
    """
    去头尾静音，返回核心段 [start_sec, end_sec]。
    全静音或过短时返回 (0.0, total_sec)，由调用方决定如何处理。
    """
    total_sec = len(audio) / sr if sr > 0 else 0.0
    if len(audio) == 0 or sr <= 0:
        return 0.0, 0.0

    frame_len = max(1, int(sr * frame_ms / 1000))
    n_frames = len(audio) // frame_len
    if n_frames == 0:
        return 0.0, total_sec

    frames = audio[: n_frames * frame_len].reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    eps = 1e-10
    rms_db = 20.0 * np.log10(np.maximum(rms, eps))

    active = rms_db > threshold_db
    idx = np.where(active)[0]
    if idx.size == 0:
        return 0.0, total_sec

    start_sec = float(idx[0] * frame_len / sr)
    end_sec = float((idx[-1] + 1) * frame_len / sr)

    if end_sec - start_sec < min_dur_sec:
        return 0.0, total_sec
    return start_sec, end_sec


# ============================================================================
# chromaprint 指纹（可选，需 fpcalc.exe）
# ============================================================================

def compute_chroma_fingerprint(audio_path: str | os.PathLike) -> str:
    """
    用 pyacoustid + fpcalc.exe 计算 chromaprint 指纹。
    返回 base64 编码字符串（契约 0 节）。
    fpcalc 或 pyacoustid 不可用时抛 RuntimeError。
    """
    fpcalc = check_fpcalc()
    if fpcalc is None:
        raise RuntimeError(
            "fpcalc 不可用：请在项目 bin/ 目录放置 fpcalc.exe，或将其加入 PATH"
        )
    try:
        import acoustid  # pyacoustid
    except ImportError as e:
        raise RuntimeError("pyacoustid 未安装：pip install pyacoustid") from e

    # 显式指定 fpcalc 路径
    acoustid.FPCALC = fpcalc
    duration, fp = acoustid.fingerprint_file(str(audio_path))
    if isinstance(fp, bytes):
        return base64.b64encode(fp).decode("ascii")
    return str(fp)


# ============================================================================
# 自检（python core/audio_utils.py）
# ============================================================================

def _write_sine(path: str, freq: float, dur: float, sr: int = TARGET_SR,
                silence_head: float = 0.0, silence_tail: float = 0.0) -> None:
    n_head = int(sr * silence_head)
    n_body = int(sr * dur)
    n_tail = int(sr * silence_tail)
    t = np.arange(n_body) / sr
    body = 0.5 * np.sin(2 * np.pi * freq * t).astype(np.float32)
    head = np.zeros(n_head, dtype=np.float32)
    tail = np.zeros(n_tail, dtype=np.float32)
    full = np.concatenate([head, body, tail])
    sf.write(path, full, sr, subtype="PCM_16")


def _self_test() -> None:
    import tempfile

    logging.basicConfig(level=logging.WARNING, format="[%(levelname)s] %(message)s")

    print(f"[audio_utils] numpy={np.__version__}  soundfile={sf.__version__}")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        # ---- 1. 生成 + 读回 ----
        wav = tmp / "sine_440.wav"
        _write_sine(str(wav), freq=440.0, dur=0.5, sr=TARGET_SR)
        audio, sr = load_audio(str(wav))
        assert sr == TARGET_SR, f"sr={sr}"
        assert audio.dtype == np.float32, f"dtype={audio.dtype}"
        assert audio.ndim == 1, f"ndim={audio.ndim}"
        assert 0.4 < audio.size / sr < 0.6, f"dur={audio.size/sr}"
        print(f"[ok] load_audio: sr={sr}, dtype={audio.dtype}, "
              f"samples={audio.size}, dur={audio.size/sr:.3f}s")

        # ---- 2. 哈希稳定性 ----
        h1 = compute_audio_hash(audio)
        h2 = compute_audio_hash(audio.copy())
        assert h1 == h2 and len(h1) == 16, f"hash={h1}"
        print(f"[ok] compute_audio_hash 稳定: {h1}")

        # ---- 3. 重采样 ----
        wav22 = tmp / "sine_22050.wav"
        _write_sine(str(wav22), freq=440.0, dur=0.5, sr=22050)
        a22, sr22 = load_audio(str(wav22), target_sr=TARGET_SR)
        assert sr22 == TARGET_SR, f"sr22→{sr22}"
        # 22050 → 44100 应约等于 2 倍样本数
        assert 0.4 < a22.size / sr22 < 0.6, f"resampled dur={a22.size/sr22}"
        print(f"[ok] resample_mono: 22050 → {sr22}, dur={a22.size/sr22:.3f}s")

        # ---- 4. 归一化 ----
        peak_before = float(np.max(np.abs(audio)))
        normed = normalize_peak(audio, target_db=-1.0)
        peak_after = float(np.max(np.abs(normed)))
        target_lin = 10 ** (-1.0 / 20.0)
        assert abs(peak_after - target_lin) < 1e-3, f"peak_after={peak_after}"
        print(f"[ok] normalize_peak: peak {peak_before:.4f} → {peak_after:.4f} "
              f"(target -1 dB = {target_lin:.4f})")

        # ---- 5. 核心段检测（带前后静音） ----
        wav_sil = tmp / "sine_with_silence.wav"
        _write_sine(str(wav_sil), freq=440.0, dur=0.3, sr=TARGET_SR,
                    silence_head=0.1, silence_tail=0.1)
        a_sil, sr_sil = load_audio(str(wav_sil))
        start_sec, end_sec = detect_core_region(a_sil, sr_sil)
        assert abs(start_sec - 0.1) < 0.03, f"start={start_sec}"
        assert abs(end_sec - 0.4) < 0.03, f"end={end_sec}"
        print(f"[ok] detect_core_region: [{start_sec:.3f}, {end_sec:.3f}]s "
              f"(期望 ≈ [0.100, 0.400])")

        # ---- 6. 环境探测（不强制） ----
        fpcalc = check_fpcalc()
        rb = check_rubberband()
        print(f"[info] fpcalc 路径: {fpcalc or '未找到（指纹功能将不可用）'}")
        print(f"[info] rubberband 路径: {rb or '未找到（音频形变将不可用）'}")

        # ---- 7. 指纹：缺 fpcalc 时应抛明确异常 ----
        try:
            compute_chroma_fingerprint(str(wav))
        except RuntimeError as e:
            print(f"[ok] compute_chroma_fingerprint 正确报错: {str(e)[:60]}...")
        else:
            print("[ok] compute_chroma_fingerprint 执行成功（fpcalc 存在）")

    print("\n[audio_utils] ALL SELF-TESTS PASSED")


if __name__ == "__main__":
    _self_test()
