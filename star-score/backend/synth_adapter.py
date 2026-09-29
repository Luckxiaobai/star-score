"""
backend/synth_adapter.py
star-score 合成入口适配器：把 synth_service.synth_single_sample 的语义
翻译为契约线 core 引擎调用。前端零改动（签名/入参/返回格式不变）。
依赖：
  - core（human_vocal_workbench/core）：slice_lib / audio_utils
  - synth_service（star-score 保留的基础设施）：estimate_pitch_midi
约束：
  - 归一化：跳过（保 star-score 原音量行为）
  - 峰值保护：保留（>1.0 时 y/peak*0.99，差异 5 向契约线对齐）
  - src_midi：用 star-score 自相关估计（比 FFT 峰值更不易八度错）
"""
from __future__ import annotations
from concurrent.futures import CancelledError
import logging
import sys
from pathlib import Path
from typing import Optional
import numpy as np
# ---- 契约线 core 导入 ----
_CORE = Path(__file__).resolve().parent.parent.parent / "human_vocal_workbench" / "core"
if str(_CORE) not in sys.path:
    sys.path.insert(0, str(_CORE))
from slice_lib import SliceLibrary  # noqa: E402
from audio_utils import TARGET_SR  # noqa: E402
from vproj_schema import RATIO_MIN, RATIO_MAX  # noqa: E402
# ---- star-score 保留的基础设施 ----
from synth_service import estimate_pitch_midi  # noqa: E402
log = logging.getLogger(__name__)


def _velocity_to_gain(velocity: int) -> float:
    """velocity → 线性增益。v<=0 返回 0（静音）。"""
    if velocity <= 0:
        return 0.0
    db = 20.0 * np.log10(velocity / 127.0)
    return float(10.0 ** (db / 20.0))


def synth_single_sample_adapter(
    sample: np.ndarray,
    sr: int,
    notes: list,
    params: Optional[dict] = None,
    state=None,
    cancel_event=None,
    progress=None,
) -> tuple[np.ndarray, list[dict]]:
    """
    与 synth_service.synth_single_sample 签名一致。
    内部改用契约线 core 引擎。
    输入：
      sample: 素材 numpy 数组（mono 或 stereo）
      sr: sample 采样率
      notes: [{id, start:秒, duration:秒, pitch:MIDI, velocity, enabled}]
      params: 可选 {strategy, ...}
      state: 可选 AppState；有 state.slice_library 时用之（顺手缓存素材），
             无 state 时退回新建临时 SliceLibrary（保旧路径兼容）。
    返回：
      (out: np.ndarray float32, report: list[dict])
    """
    params = params or {}
    strategy_default = params.get("strategy", "loop")  # 契约线默认

    # ---- 1. 建 SliceItem（跳过归一化，保 star-score 音量）----
    if state is not None and hasattr(state, "slice_library"):
        lib = state.slice_library                        # 用 AppState 的库
    else:
        lib = SliceLibrary()                             # 无 state 退回
    slice_item = lib.import_from_array(sample, sr, normalize=False)

    # ---- 2. 素材基准 MIDI pitch（自相关估计）----
    core_y = slice_item.audio[
        int(round(slice_item.start_core_sec * slice_item.sr)):
        int(round(slice_item.end_core_sec * slice_item.sr))
    ]
    src_midi = float(estimate_pitch_midi(core_y, slice_item.sr))

    # ---- 3. 预扫描总长 ----
    enabled_notes = [n for n in notes if n.get("enabled", True)]
    if cancel_event is not None and cancel_event.is_set():
        raise CancelledError()
    if progress is not None:
        progress(0.02, "准备合成")
    max_end = 0.0
    for n in enabled_notes:
        end = float(n["start"]) + float(n["duration"])
        if end > max_end:
            max_end = end
    total_samples = max(1, int(round(max_end * TARGET_SR)))
    total = np.zeros(total_samples, dtype=np.float32)

    # ---- 4. 逐音符渲染 + 叠加 ----
    report: list[dict] = []
    core_dur = slice_item.end_core_sec - slice_item.start_core_sec
    if core_dur <= 0:
        core_dur = slice_item.duration_sec or 1.0
    log.info(
        "[synth] 素材 dur=%.3fs core=[%.3f, %.3f]s (%.3fs) 基准 MIDI=%.1f 音符=%d",
        slice_item.duration_sec, slice_item.start_core_sec,
        slice_item.start_core_sec + core_dur, core_dur, src_midi, len(enabled_notes),
    )
    clamped_notes = 0
    total_notes = max(1, len(enabled_notes))
    for note_index, n in enumerate(enabled_notes, start=1):
        if cancel_event is not None and cancel_event.is_set():
            raise CancelledError()
        if progress is not None:
            progress(
                0.05 + 0.9 * (note_index - 1) / total_notes,
                f"正在合成音符 {note_index}/{total_notes}",
            )
        note_sec = float(n["duration"])
        start_sec = float(n["start"])
        target_pitch = int(n["pitch"])
        velocity = int(n.get("velocity", 100))
        nid = n.get("id", "?")
        # 策略判定（契约线阈值）
        required_ratio = note_sec / core_dur if core_dur > 0 else 1.0
        semitone = float(target_pitch) - src_midi
        warns: list[str] = []
        src_start = slice_item.start_core_sec
        src_end = slice_item.start_core_sec + core_dur
        if required_ratio < RATIO_MIN:
            # 素材时长远大于音符时长（例如上传的是整段人声，而非 1s 短样本）：
            # 用整段核心做 0.00x 压缩只会得到近零长度切片（听不见）。
            # 改为只取「目标时长 / 安全下限」的短窗口，并把 applied_ratio 拉回
            # 安全区间下限；输出长度依旧等于音符时长。
            strategy = "direct"
            applied_ratio = RATIO_MIN
            window = min(core_dur, note_sec / RATIO_MIN)
            src_end = src_start + window
            warns.append("stretch_out_of_range")
            clamped_notes += 1
        elif required_ratio <= RATIO_MAX:
            strategy = "direct"
            applied_ratio = required_ratio
        else:
            strategy = strategy_default
            applied_ratio = RATIO_MAX if strategy == "stretch_max" else 1.0
        a = abs(semitone)
        if a >= 8:
            warns.append("pitch_shift_error")
        elif a >= 5:
            warns.append("pitch_shift_warning")
        # 渲染
        try:
            seg = lib.render_slice_audio(
                slice_item=slice_item,
                src_start_sec=src_start,
                src_end_sec=src_end,
                semitone_shift=semitone,
                required_ratio=required_ratio,
                applied_ratio=applied_ratio,
                strategy=strategy,
                target_note_sec=note_sec,
            )
        except Exception as e:
            warns.append(f"render_failed: {type(e).__name__}")
            report.append({
                "id": nid, "strategy": strategy,
                "required_ratio": required_ratio, "applied_ratio": applied_ratio,
                "semitones": semitone, "warns": warns,
            })
            continue
        # 音量
        gain = _velocity_to_gain(velocity)
        if gain == 0.0:
            continue
        seg = seg * gain
        # 叠加
        idx0 = int(round(start_sec * TARGET_SR))
        idx1 = min(idx0 + len(seg), total_samples)
        if idx1 > idx0:
            total[idx0:idx1] += seg[: idx1 - idx0]
        report.append({
            "id": nid,
            "strategy": strategy,
            "required_ratio": required_ratio,
            "applied_ratio": applied_ratio,
            "semitones": semitone,
            "warns": warns,
        })

    # ---- 5. 峰值保护（仅超 1.0 时触发）----
    peak = float(np.max(np.abs(total))) if total.size > 0 else 0.0
    if peak > 1.0:
        total = (total / peak * 0.99).astype(np.float32, copy=False)
    if progress is not None:
        progress(0.98, "写入合成结果")
    return total, report
