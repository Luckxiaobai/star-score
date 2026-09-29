"""
core/slice_lib.py
人力V鬼畜调音工作台 — 切片素材库 + 音频形变调度
对应《核心契约 v0.3.1》
依赖：
  - numpy / scipy / soundfile
  - audio_utils（load_audio / normalize_peak / compute_audio_hash / detect_core_region / check_rubberband）
  - vproj_schema（常量、blake2b_16hex）
  - pyrubberband（可选；缺失走 scipy 降级）
职责：
  - import_audio：读音频 → SliceItem（含 hash / core 区间 / avg_f0）
  - find_slice：按 slice_hash 命中缓存
  - render_slice_audio：变调 + 时长拉伸 + 三种策略（direct / loop / stretch_max）
  - get_final_duration：渲染后的实际时长，给前端画波形用
约束：
  - 契约 0 节：安全区间 0.5~2.0；越界打 WARNING 但不阻止渲染
  - src_start_sec / src_end_sec 严格用 is None 判断
  - 变调先执行（保持时长），时长拉伸后执行（改变时长）
"""
from __future__ import annotations
import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
import numpy as np
from scipy.signal import resample as scipy_resample
# 同目录导入
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
from vproj_schema import RATIO_MIN, RATIO_MAX  # noqa: E402
from audio_utils import (  # noqa: E402
    load_audio,
    normalize_peak,
    compute_audio_hash,
    detect_core_region,
    resample_mono,
    check_rubberband,
    TARGET_SR,
)
log = logging.getLogger(__name__)

# ----------------------------------------------------------------------------
# 告警去重：同一类问题只报一次
# 背景：合成一首 MIDI 会对每个音符调用一次 render_slice_audio，逐音符打 WARNING
# 会把控制台刷满（实测一首曲子几千行），既盖住真正的错误，也让人误以为失败。
# 结论不变（仍然 WARNING），只是同一 key 只输出一次。
# ----------------------------------------------------------------------------
_WARNED_ONCE: set[str] = set()


def _warn_once(key: str, msg: str, *args) -> None:
    """同一 key 的 WARNING 每个进程只打一次；后续静默。"""
    if key in _WARNED_ONCE:
        return
    _WARNED_ONCE.add(key)
    log.warning(msg, *args)


# ============================================================================
# SliceItem
# ============================================================================
@dataclass
class SliceItem:
    """运行时切片对象。audio / sr 是内存缓存，不参与工程序列化。"""
    slice_hash: str
    duration_sec: float
    original_file: str = ""
    chroma_fingerprint: str = ""
    avg_f0_hz: float = 0.0
    start_core_sec: float = 0.0
    end_core_sec: float = 0.0
    audio: Optional[np.ndarray] = field(default=None, repr=False)
    sr: int = TARGET_SR
# ============================================================================
# 内部：pyrubberband lazy import + 检测
# ============================================================================
def _try_import_pyrubberband():
    try:
        import pyrubberband as pyrb
        return pyrb
    except ImportError:
        return None
def _rubberband_available() -> bool:
    return check_rubberband() is not None and _try_import_pyrubberband() is not None
# ============================================================================
# 内部：变调 + 时长拉伸
# ============================================================================
def _render_scipy(y: np.ndarray, sr: int, semitones: float, ratio: float) -> np.ndarray:
    """
    scipy 降级路径：
      1) 变调：FFT-based resample 改变采样密度（保持周期数）
      2) 时长对齐：扩展走 _loop_fill（保音高），压缩走截断（保音高）
    物理限制：纯 resample/interp 无法同时保音高 + 改时长，所以扩展端用
    循环拼接而非插值拉伸。代价是拼接点有轻微痕，音质不如 RubberBand。
    """
    orig_len = len(y)
    orig_dur = orig_len / sr
    target_samples = max(1, int(round(orig_dur * ratio * sr)))
    # 1. 变调
    pitch_factor = 2.0 ** (semitones / 12.0)
    if abs(pitch_factor - 1.0) > 1e-6:
        n_after = max(2, int(round(orig_len / pitch_factor)))
        y = scipy_resample(y, n_after).astype(np.float32)
    # 2. 时长对齐到 target_samples
    if len(y) == target_samples:
        return y
    if len(y) > target_samples:
        return y[:target_samples].astype(np.float32, copy=False)
    return _loop_fill(y, target_samples / sr, sr)
def _render_rubberband(y: np.ndarray, sr: int, semitones: float, ratio: float) -> np.ndarray:
    """pyrubberband 主路径：pitch_shift 保持时长，time_stretch 改时长。"""
    pyrb = _try_import_pyrubberband()
    assert pyrb is not None, "pyrubberband 未安装"
    # 1. 变调（时长不变）
    if abs(semitones) > 1e-6:
        y = pyrb.pitch_shift(y, sr, semitones)
    # 2. 时长拉伸（ratio = 目标/原始；rate = 1/ratio）
    if abs(ratio - 1.0) > 1e-6:
        rate = 1.0 / ratio
        y = pyrb.time_stretch(y, sr, rate)
    return np.asarray(y, dtype=np.float32)
def _pitch_and_stretch(y: np.ndarray, sr: int, semitones: float, ratio: float) -> np.ndarray:
    """统一入口：无操作短路；否则优先 pyrubberband，失败 / 缺失时降级 scipy。"""
    if abs(semitones) < 1e-6 and abs(ratio - 1.0) < 1e-6:
        return y.astype(np.float32, copy=True)
    if _rubberband_available():
        try:
            return _render_rubberband(y, sr, semitones, ratio)
        except Exception as e:  # noqa: BLE001
            log.warning("pyrubberband 调用失败，降级到 scipy：%s", e)
    _warn_once("rubberband_fallback", "rubberband 未就绪，使用 scipy 降级路径（音质有限）")
    return _render_scipy(y, sr, semitones, ratio)
# ============================================================================
# 内部：loop 循环填充（含交叉淡化）
# ============================================================================
def _loop_fill(y: np.ndarray, target_sec: float, sr: int, fade_ms: float = 20.0) -> np.ndarray:
    """
    把 y 循环拼接到 target_sec 长度。
    相邻片段间做 fade_ms 交叉淡化（消除拼接断层爆音）。
    契约 3.3：loop 策略下最终时长 = target_note_sec。
    """
    target_samples = max(1, int(round(target_sec * sr)))
    if len(y) == 0:
        return np.zeros(target_samples, dtype=np.float32)
    if len(y) >= target_samples:
        return y[:target_samples].astype(np.float32, copy=True)
    fade_len = min(int(sr * fade_ms / 1000), len(y) // 4, target_samples // 4)
    if fade_len <= 1:
        # 太短，直接平铺
        n_rep = int(np.ceil(target_samples / len(y)))
        out = np.tile(y, n_rep)[:target_samples]
        return out.astype(np.float32, copy=True)
    fade_out = np.linspace(1.0, 0.0, fade_len, dtype=np.float32)
    fade_in = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)
    out = y.astype(np.float32, copy=True)
    while len(out) < target_samples:
        tail = out[-fade_len:]
        head = y[:fade_len]
        mixed = tail * fade_out + head * fade_in
        out = np.concatenate([out[:-fade_len], mixed, y[fade_len:]])
    return out[:target_samples].astype(np.float32, copy=False)
# ============================================================================
# SliceLibrary
# ============================================================================
class SliceLibrary:
    """切片素材库。缓存导入过的 SliceItem，支持 hash 命中查询。"""
    def __init__(self) -> None:
        self._items: dict[str, SliceItem] = {}
    # ------------------------------------------------------------------
    # 导入
    # ------------------------------------------------------------------
    def import_from_array(
        self,
        y: np.ndarray,
        sr: int,
        normalize: bool = False,
        original_file: str = "",
    ) -> SliceItem:
        """
        从内存数组导入切片。支持直接喂 ndarray（不落盘）。
        - 多声道自动降为单声道
        - 采样率不等于 TARGET_SR 时重采样
        - normalize=True 时做 -1dB 峰值归一化（契约线默认行为）
        - normalize=False 时保持原样（adapter 复用 star-score 行为）
        """
        if y.ndim > 1:
            y = y.mean(axis=1)
        y = y.astype(np.float32, copy=False)
        if sr != TARGET_SR:
            y = resample_mono(y, sr, TARGET_SR)
            sr = TARGET_SR
        if normalize:
            y = normalize_peak(y, target_db=-1.0)
        h = compute_audio_hash(y)
        start_core, end_core = detect_core_region(y, sr)
        f0 = _estimate_f0(y, sr)
        item = SliceItem(
            slice_hash=h,
            duration_sec=len(y) / sr,
            original_file=original_file,
            chroma_fingerprint="",  # 需 fpcalc，import 阶段先留空
            avg_f0_hz=f0,
            start_core_sec=start_core,
            end_core_sec=end_core,
            audio=y,
            sr=sr,
        )
        self._items[h] = item
        return item

    def import_audio(self, audio_path: str | os.PathLike) -> SliceItem:
        """读音频 → 归一化（-1dB）→ 计算 hash / 核心段 / 平均基频 → 缓存并返回。"""
        y, sr = load_audio(str(audio_path), target_sr=TARGET_SR)
        return self.import_from_array(
            y, sr, normalize=True, original_file=Path(audio_path).name
        )
    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------
    def find_slice(self, slice_hash: str, chroma_fp: str = "") -> Optional[SliceItem]:
        """按 hash 命中；未命中时返回 None（指纹兜底由上层调用方负责）。"""
        return self._items.get(slice_hash)
    def all_items(self) -> list:
        return list(self._items.values())
    # ------------------------------------------------------------------
    # 形变渲染
    # ------------------------------------------------------------------
    def render_slice_audio(
        self,
        slice_item: SliceItem,
        src_start_sec: Optional[float],
        src_end_sec: Optional[float],
        semitone_shift: float,
        required_ratio: float,
        applied_ratio: float,
        strategy: str,
        target_note_sec: float,
    ) -> np.ndarray:
        """
        输出为按策略渲染好的单声道 float32 音频。
        契约 3.3：direct 返回拉伸后长度；stretch_max / loop 都返回 target_note_sec 长度。
        """
        if strategy not in ("direct", "loop", "stretch_max"):
            raise ValueError(f"unknown strategy: {strategy}")
        if slice_item.audio is None:
            raise ValueError("SliceItem.audio 为空，未正确 import")
        sr = slice_item.sr
        y_full = slice_item.audio
        # 严格 None 判断
        start = src_start_sec if src_start_sec is not None else 0.0
        end = src_end_sec if src_end_sec is not None else slice_item.duration_sec
        s_idx = max(0, int(round(start * sr)))
        e_idx = min(len(y_full), int(round(end * sr)))
        if e_idx <= s_idx:
            raise ValueError(f"无效截取区间：[{start}, {end}]s")
        y_cut = y_full[s_idx:e_idx].astype(np.float32, copy=True)
        # 契约告警：direct 策略下越界（不阻止）；同类问题每进程只报一次
        if strategy == "direct" and (applied_ratio < RATIO_MIN or applied_ratio > RATIO_MAX):
            _warn_once(
                "direct_ratio_out_of_range",
                "direct 策略 applied_ratio=%.3f 超出安全区间 [%.1f, %.1f]（同类仅首次提示）",
                applied_ratio, RATIO_MIN, RATIO_MAX,
            )
        # ---- 1. 变调 + 拉伸 ----
        y_processed = _pitch_and_stretch(y_cut, sr, semitone_shift, applied_ratio)
        # ---- 2. 策略分支 ----
        if strategy == "direct":
            return y_processed
        if strategy == "stretch_max":
            # 拉伸至 applied_ratio（通常 2.0），超出部分填衰减静音到 target_note_sec
            target_samples = max(1, int(round(target_note_sec * sr)))
            if len(y_processed) >= target_samples:
                return y_processed[:target_samples].astype(np.float32, copy=False)
            pad = target_samples - len(y_processed)
            tail_val = float(y_processed[-1]) if len(y_processed) > 0 else 0.0
            fade = (np.linspace(1.0, 0.0, pad, dtype=np.float32) ** 2) * tail_val
            return np.concatenate([y_processed, fade]).astype(np.float32, copy=False)
        # strategy == "loop"
        return _loop_fill(y_processed, target_note_sec, sr)
    # ------------------------------------------------------------------
    # 派生时长
    # ------------------------------------------------------------------
    def get_final_duration(
        self,
        slice_item: SliceItem,
        src_start_sec: Optional[float],
        src_end_sec: Optional[float],
        applied_ratio: float,
        strategy: str,
        target_note_sec: float,
    ) -> float:
        """契约 3.3：direct = src_dur * applied_ratio；stretch_max / loop = target_note_sec。"""
        if strategy == "direct":
            start = src_start_sec if src_start_sec is not None else 0.0
            end = src_end_sec if src_end_sec is not None else slice_item.duration_sec
            return (end - start) * applied_ratio
        if strategy in ("stretch_max", "loop"):
            return target_note_sec
        raise ValueError(f"unknown strategy: {strategy}")
# ============================================================================
# 切片持久化（slice_cache 内容寻址）
# ============================================================================
def cache_slice_to_disk(slice_item: SliceItem, cache_dir) -> "Path":
    """
    把 SliceItem 归一化后的波形写到 cache_dir/{hash}.wav（PCM_16）。
    幂等：文件已存在则跳过。
    写盘的是 slice_item.audio（归一化后波形），与 slice_hash 内容一致。
    """
    from pathlib import Path
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"{slice_item.slice_hash}.wav"
    if out.exists():
        return out
    import soundfile as sf
    sf.write(str(out), slice_item.audio, slice_item.sr, subtype="PCM_16")
    return out


def load_slice_from_disk(slice_hash: str, cache_dir):
    """
    从 cache_dir/{hash}.wav 恢复 SliceItem。
    - hash 用文件名（不重算，保证与工程引用一致）
    - core / f0 在 16bit 量化后波形上重算（量化误差 <1 样本，不可感知）
    - 文件不存在返回 None
    """
    from pathlib import Path
    cache_dir = Path(cache_dir)
    path = cache_dir / f"{slice_hash}.wav"
    if not path.exists():
        return None
    import soundfile as sf
    y, sr = sf.read(str(path), dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    y = y.astype(np.float32, copy=False)
    start_core, end_core = detect_core_region(y, sr)
    f0 = _estimate_f0(y, sr)
    return SliceItem(
        slice_hash=slice_hash,
        duration_sec=len(y) / sr,
        original_file="",
        chroma_fingerprint="",
        avg_f0_hz=f0,
        start_core_sec=start_core,
        end_core_sec=end_core,
        audio=y,
        sr=sr,
    )
# ============================================================================
# 内部：简单 F0 估计（FFT 峰值，80~800 Hz 范围内）
# ============================================================================
def _estimate_f0(y: np.ndarray, sr: int) -> float:
    if len(y) < 256:
        return 0.0
    w = np.hanning(len(y)).astype(np.float32)
    spec = np.abs(np.fft.rfft(y * w))
    freqs = np.fft.rfftfreq(len(y), 1.0 / sr)
    mask = (freqs >= 80.0) & (freqs <= 800.0)
    if not mask.any():
        return 0.0
    masked = np.where(mask, spec, 0.0)
    return float(freqs[int(np.argmax(masked))])
# ============================================================================
# 自检（py core\\slice_lib.py）
# ============================================================================
def _write_sine(path: str, freq: float, dur: float, sr: int = TARGET_SR) -> None:
    import soundfile as sf
    t = np.arange(int(sr * dur)) / sr
    y = (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    sf.write(path, y, sr, subtype="PCM_16")
def _peak_freq(y: np.ndarray, sr: int) -> float:
    w = np.hanning(len(y)).astype(np.float32)
    spec = np.abs(np.fft.rfft(y * w))
    freqs = np.fft.rfftfreq(len(y), 1.0 / sr)
    return float(freqs[int(np.argmax(spec))])
def _self_test() -> None:
    import tempfile
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    print(f"[slice_lib] rubberband={'可用' if check_rubberband() else '未找到'}"
          f"  pyrubberband={'已装' if _try_import_pyrubberband() else '未装'}")
    if not _rubberband_available():
        print("[slice_lib] 当前走 scipy 降级路径（自检仍可全部通过）")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        wav = tmp / "sine440.wav"
        _write_sine(str(wav), freq=440.0, dur=0.5)
        lib = SliceLibrary()
        # ---- 1. import_audio ----
        item = lib.import_audio(str(wav))
        assert len(item.slice_hash) == 16, f"hash={item.slice_hash}"
        assert abs(item.duration_sec - 0.5) < 0.01, f"dur={item.duration_sec}"
        assert item.start_core_sec < 0.05 and item.end_core_sec > 0.45, \
            f"core=[{item.start_core_sec}, {item.end_core_sec}]"
        assert 400 < item.avg_f0_hz < 480, f"f0={item.avg_f0_hz}"
        print(f"[ok] import_audio: hash={item.slice_hash}, dur={item.duration_sec:.3f}s, "
              f"core=[{item.start_core_sec:.3f}, {item.end_core_sec:.3f}], f0={item.avg_f0_hz:.1f}Hz")
        # ---- 1b. import_from_array（不归一化）----
        y_raw, sr_raw = load_audio(str(wav))
        item2 = SliceLibrary().import_from_array(y_raw, sr_raw, normalize=False)
        assert len(item2.slice_hash) == 16, f"hash={item2.slice_hash}"
        assert abs(item2.duration_sec - 0.5) < 0.01, f"dur={item2.duration_sec}"
        print(f"[ok] import_from_array(normalize=False): hash={item2.slice_hash}")
        # ---- 2. find_slice ----
        hit = lib.find_slice(item.slice_hash)
        assert hit is item, "find_slice 未命中"
        assert lib.find_slice("0" * 16) is None, "空 hash 不应命中"
        print(f"[ok] find_slice: 命中 & 未命中行为正确")
        # ---- 3. direct + 无变调无拉伸 → 原样 ----
        y_same = lib.render_slice_audio(
            item, src_start_sec=None, src_end_sec=None,
            semitone_shift=0.0, required_ratio=1.0, applied_ratio=1.0,
            strategy="direct", target_note_sec=0.5,
        )
        assert abs(len(y_same) - len(item.audio)) <= 2, \
            f"len diff={len(y_same)} vs {len(item.audio)}"
        print(f"[ok] direct (semitone=0, ratio=1.0): 长度不变 ({len(y_same)} samples)")
        # ---- 4. direct + 变调 +12 半音 → FFT 主频 ≈ 880 Hz ----
        y_up = lib.render_slice_audio(
            item, src_start_sec=None, src_end_sec=None,
            semitone_shift=12.0, required_ratio=1.0, applied_ratio=1.0,
            strategy="direct", target_note_sec=0.5,
        )
        f_up = _peak_freq(y_up, TARGET_SR)
        assert 840 < f_up < 920, f"变调后主频 = {f_up} Hz（期望 ~880）"
        print(f"[ok] direct (semitone=+12): FFT 主频 = {f_up:.1f} Hz (期望 ~880)")
        # ---- 5. stretch_max: applied_ratio=2.0, target=1.0s ----
        y_sm = lib.render_slice_audio(
            item, src_start_sec=None, src_end_sec=None,
            semitone_shift=0.0, required_ratio=3.0, applied_ratio=2.0,
            strategy="stretch_max", target_note_sec=1.0,
        )
        expected_sm = int(1.0 * TARGET_SR)
        assert abs(len(y_sm) - expected_sm) <= 2, \
            f"stretch_max 长度 = {len(y_sm)}（期望 {expected_sm}）"
        print(f"[ok] stretch_max: 输出长度 = {len(y_sm)} samples (= 1.0s)")
        # ---- 6. loop: ratio=1.0, target=1.5s ----
        y_lp = lib.render_slice_audio(
            item, src_start_sec=None, src_end_sec=None,
            semitone_shift=0.0, required_ratio=3.0, applied_ratio=1.0,
            strategy="loop", target_note_sec=1.5,
        )
        expected_lp = int(1.5 * TARGET_SR)
        assert abs(len(y_lp) - expected_lp) <= 2, \
            f"loop 长度 = {len(y_lp)}（期望 {expected_lp}）"
        print(f"[ok] loop: 输出长度 = {len(y_lp)} samples (= 1.5s)")
        # ---- 7. get_final_duration ----
        d1 = lib.get_final_duration(item, None, None, 1.0, "direct", 0.5)
        assert abs(d1 - 0.5) < 1e-6
        d2 = lib.get_final_duration(item, None, None, 2.0, "stretch_max", 1.0)
        assert abs(d2 - 1.0) < 1e-6
        d3 = lib.get_final_duration(item, None, None, 1.0, "loop", 1.5)
        assert abs(d3 - 1.5) < 1e-6
        print(f"[ok] get_final_duration: direct={d1:.3f}s, stretch_max={d2:.3f}s, loop={d3:.3f}s")
    print("\n[slice_lib] ALL SELF-TESTS PASSED")
if __name__ == "__main__":
    _self_test()
