"""
core/render_engine.py
人力V鬼畜调音工作台 — 整轨合成引擎
对应《核心契约 v0.3.1》4.3 节的语义（但阶段1为 Python 后端，非前端 Canvas）
依赖：
  - numpy
  - vproj_schema（Project / Note / tick_to_sec）
  - slice_lib（SliceLibrary / SliceItem / render_slice_audio）
  - audio_utils（TARGET_SR）
职责：
  - render_project：输入 Project + SliceLibrary → 整轨单声道 float32 音频
  - render_project_to_wav：同上，直接落盘 WAV
  - 收集渲染告警（切片缺失 / 渲染异常 / 采样溢出）
阶段1约束：
  - 单轨人声，不做 MIDI 伴奏叠加，不做多轨混音
  - 输出采样率固定 TARGET_SR = 44100
  - 单个音符渲染失败不中断整轨，记告警继续
"""
from __future__ import annotations
from concurrent.futures import CancelledError
import logging
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
import numpy as np
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
from vproj_schema import Project, tick_to_sec  # noqa: E402
from slice_lib import SliceLibrary, SliceItem  # noqa: E402
from audio_utils import TARGET_SR  # noqa: E402
log = logging.getLogger(__name__)
# ============================================================================
# 告警结构
# ============================================================================
@dataclass
class RenderWarning:
    note_id: str
    kind: str       # slice_missing | render_failed | overflow
    message: str
    level: str      # yellow | red
# ============================================================================
# 内部工具
# ============================================================================
def _apply_fades(y: np.ndarray, sr: int, fade_in_ms: float, fade_out_ms: float) -> np.ndarray:
    """线性淡入淡出。长度不足时自动缩短窗口。"""
    if y.size == 0:
        return y
    n = y.size
    out = y.astype(np.float32, copy=True)
    fi = int(round(sr * fade_in_ms / 1000.0))
    if fi > 1:
        fi = min(fi, n // 2)
        out[:fi] *= np.linspace(0.0, 1.0, fi, dtype=np.float32)
    fo = int(round(sr * fade_out_ms / 1000.0))
    if fo > 1:
        fo = min(fo, n // 2)
        out[-fo:] *= np.linspace(1.0, 0.0, fo, dtype=np.float32)
    return out
def _db_to_gain(db: float) -> float:
    """dB → 线性增益。-inf → 0。"""
    if db == -float("inf"):
        return 0.0
    return float(10.0 ** (db / 20.0))
# ============================================================================
# 主渲染
# ============================================================================
def render_project(
    project: Project,
    slice_library: SliceLibrary,
    sr: int = TARGET_SR,
    cancel_event=None,
    progress=None,
) -> tuple[np.ndarray, int, list[RenderWarning]]:
    """
    把 Project 里所有 enabled 音符渲染成整轨音频。
    返回 (y, sr, warnings)：
      y         — 单声道 float32，长度 = ceil(max(note_end_sec) * sr)
      sr        — 采样率
      warnings  — 渲染过程收集的告警
    """
    ppq = project.midi_config.ppq
    bpm = project.midi_config.bpm
    warnings: list[RenderWarning] = []
    if cancel_event is not None and cancel_event.is_set():
        raise CancelledError()
    if progress is not None:
        progress(0.02, "准备渲染工程")
    # ---- 1. 预扫描，求总长 ----
    max_end_sec = 0.0
    total_notes = max(1, len(project.notes))
    for note in project.notes:
        if cancel_event is not None and cancel_event.is_set():
            raise CancelledError()
        if not note.enabled:
            continue
        start_sec = tick_to_sec(note.start_tick, ppq, bpm)
        dur_sec = tick_to_sec(note.duration_tick, ppq, bpm)
        end_sec = start_sec + dur_sec
        if end_sec > max_end_sec:
            max_end_sec = end_sec
    total_samples = max(1, int(round(max_end_sec * sr)))
    buf = np.zeros(total_samples, dtype=np.float32)
    # ---- 2. 逐音符渲染并叠加 ----
    n_rendered = 0
    n_skipped = 0
    for note_index, note in enumerate(project.notes, start=1):
        if cancel_event is not None and cancel_event.is_set():
            raise CancelledError()
        if progress is not None:
            progress(
                0.05 + 0.85 * (note_index - 1) / total_notes,
                f"正在渲染音符 {note_index}/{total_notes}",
            )
        if not note.enabled:
            n_skipped += 1
            continue
        ref = note.slice_ref
        if not ref or not ref.slice_hash:
            warnings.append(RenderWarning(
                note_id=note.note_id, kind="slice_missing",
                message=f"slice_hash 为空（未绑定素材）", level="red",
            ))
            n_skipped += 1
            continue
        slice_item: Optional[SliceItem] = slice_library.find_slice(ref.slice_hash)
        if slice_item is None or slice_item.audio is None:
            warnings.append(RenderWarning(
                note_id=note.note_id, kind="slice_missing",
                message=f"切片 {ref.slice_hash} 未在库中找到", level="red",
            ))
            n_skipped += 1
            continue
        target_note_sec = tick_to_sec(note.duration_tick, ppq, bpm)
        start_sec = tick_to_sec(note.start_tick, ppq, bpm)
        try:
            y_note = slice_library.render_slice_audio(
                slice_item=slice_item,
                src_start_sec=ref.src_start_sec,
                src_end_sec=ref.src_end_sec,
                semitone_shift=ref.semitone_shift,
                required_ratio=ref.required_ratio,
                applied_ratio=ref.applied_ratio,
                strategy=ref.strategy,
                target_note_sec=target_note_sec,
            )
        except Exception as e:  # noqa: BLE001
            warnings.append(RenderWarning(
                note_id=note.note_id, kind="render_failed",
                message=f"渲染异常：{type(e).__name__}: {e}", level="red",
            ))
            n_skipped += 1
            continue
        # 音量
        gain = _db_to_gain(note.note_volume_db)
        if gain == 0.0:
            n_skipped += 1
            continue
        y_note = y_note * gain
        # 淡入淡出
        y_note = _apply_fades(y_note, sr, ref.fade_in_ms, ref.fade_out_ms)
        # 叠加到缓冲
        start_idx = int(round(start_sec * sr))
        if start_idx >= total_samples:
            warnings.append(RenderWarning(
                note_id=note.note_id, kind="overflow",
                message=f"起始位置 {start_sec:.3f}s 超出总长 {max_end_sec:.3f}s",
                level="yellow",
            ))
            n_skipped += 1
            continue
        end_idx = min(start_idx + len(y_note), total_samples)
        seg_len = end_idx - start_idx
        if seg_len <= 0:
            n_skipped += 1
            continue
        buf[start_idx:end_idx] += y_note[:seg_len]
        n_rendered += 1
    log.info("render_project: %d 音符渲染 / %d 跳过 / 总长 %.3fs",
             n_rendered, n_skipped, total_samples / sr)
    return buf, sr, warnings
# ============================================================================
# 落盘
# ============================================================================
def render_project_to_wav(
    project: Project,
    slice_library: SliceLibrary,
    out_path: str,
    sr: int = TARGET_SR,
    cancel_event=None,
    progress=None,
) -> list[RenderWarning]:
    """渲染并写 WAV（PCM_16）。返回告警列表。"""
    import soundfile as sf
    y, sr_out, warns = render_project(
        project,
        slice_library,
        sr=sr,
        cancel_event=cancel_event,
        progress=progress,
    )
    if cancel_event is not None and cancel_event.is_set():
        raise CancelledError()
    # 峰值保护（仅防削波，不做响度归一）
    peak = float(np.max(np.abs(y))) if y.size > 0 else 0.0
    if peak > 1.0:
        log.warning("渲染峰值 %.3f > 1.0，做 -%.2f dB 全局保护", peak, 20.0 * np.log10(peak))
        y = (y / peak * 0.99).astype(np.float32, copy=False)
    if progress is not None:
        progress(0.96, "写入 WAV")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(out_path, y, sr_out, subtype="PCM_16")
    if progress is not None:
        progress(0.99, "渲染完成")
    return warns
# ============================================================================
# 自检（py core\\render_engine.py）
# ============================================================================
def _make_project_with_two_notes() -> tuple[Project, SliceLibrary, object]:
    """构造 2 音符工程 + 一个 440Hz/0.5s 素材，返回 (project, lib, slice_item)。"""
    from vproj_schema import (
        Project, Note, SliceRef, SliceSample,
        make_note_id, velocity_to_db,
    )
    proj = Project.new("render_test", ppq=480, bpm=120.0)
    proj.global_samples.append(SliceSample(
        slice_hash="b" * 16,
        original_file="miao.wav",
        chroma_fingerprint="",
        avg_f0_hz=440.0,
        duration_sec=0.5,
        start_core_sec=0.0,
        end_core_sec=0.5,
    ))
    # 素材：440Hz 0.5s，直接构造进 SliceLibrary
    lib = SliceLibrary()
    sr = TARGET_SR
    t = np.arange(int(sr * 0.5)) / sr
    y = (0.5 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)
    item = SliceItem(
        slice_hash="b" * 16, duration_sec=0.5,
        original_file="miao.wav", avg_f0_hz=440.0,
        start_core_sec=0.0, end_core_sec=0.5,
        audio=y, sr=sr,
    )
    lib._items["b" * 16] = item
    # note1: A4(69), start=0, dur=480tick=0.5s → semitone=0, ratio=1.0, direct
    n1_id = make_note_id(480, 0, 69, 480)
    proj.notes.append(Note(
        note_id=n1_id, midi_pitch=69, start_tick=0, duration_tick=480,
        velocity=127, enabled=True, note_volume_db=velocity_to_db(127),
        slice_ref=SliceRef(
            slice_hash="b" * 16, src_file_name="miao.wav",
            src_start_sec=0.0, src_end_sec=0.5,
            semitone_shift=0.0, required_ratio=1.0, applied_ratio=1.0,
            strategy="direct", fade_in_ms=0.0, fade_out_ms=0.0,
        ),
    ))
    # note2: A4(69), start=480, dur=480 → 与 note1 无重叠
    n2_id = make_note_id(480, 480, 69, 480)
    proj.notes.append(Note(
        note_id=n2_id, midi_pitch=69, start_tick=480, duration_tick=480,
        velocity=127, enabled=True, note_volume_db=velocity_to_db(127),
        slice_ref=SliceRef(
            slice_hash="b" * 16, src_file_name="miao.wav",
            src_start_sec=0.0, src_end_sec=0.5,
            semitone_shift=0.0, required_ratio=1.0, applied_ratio=1.0,
            strategy="direct", fade_in_ms=0.0, fade_out_ms=0.0,
        ),
    ))
    return proj, lib, item
def _self_test() -> None:
    import tempfile
    logging.basicConfig(level=logging.WARNING, format="[%(levelname)s] %(message)s")
    print(f"[render_engine] SR = {TARGET_SR}")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # ---- 1. 两音符顺序渲染，长度正确 ----
        proj, lib, _item = _make_project_with_two_notes()
        y, sr, warns = render_project(proj, lib)
        # 总长 = 960 tick = 1.0s
        expected = int(round(1.0 * sr))
        assert abs(len(y) - expected) <= 2, f"总长 = {len(y)}（期望 {expected}）"
        assert y.dtype == np.float32, f"dtype = {y.dtype}"
        assert sr == TARGET_SR
        assert len(warns) == 0, f"不应有告警，却有 {len(warns)}"
        print(f"[ok] 两音符渲染: 长度 = {len(y)} samples (= 1.0s), 无告警")
        # ---- 2. 非零区域分布正确 ----
        # 前半段 note1 在 [0, 0.5s]，后半段 note2 在 [0.5s, 1.0s]
        seg1 = y[: sr // 2]
        seg2 = y[sr // 2 :]
        p1 = float(np.max(np.abs(seg1)))
        p2 = float(np.max(np.abs(seg2)))
        assert p1 > 0.4, f"note1 区域峰值 {p1}"
        assert p2 > 0.4, f"note2 区域峰值 {p2}"
        print(f"[ok] 峰值分布: seg1={p1:.3f}, seg2={p2:.3f}")
        # ---- 3. 中间边界不应该有能量溢出 ----
        # 只要相邻音符首尾相接，无 fade 时边界处波形仍能连续
        mid_idx = sr // 2
        edge_rms = float(np.sqrt(np.mean((y[mid_idx-50:mid_idx+50].astype(np.float64))**2)))
        print(f"[ok] 边界 RMS = {edge_rms:.4f}（无特殊约束）")
        # ---- 4. enabled=False 跳过 ----
        proj2, lib2, _ = _make_project_with_two_notes()
        proj2.notes[1].enabled = False
        y2, _sr, warns2 = render_project(proj2, lib2)
        # 总长仍 1.0s（预扫描仍取 enabled 音符的最大 end；note2 关闭后 max_end=0.5s）
        expected2 = int(round(0.5 * sr))
        assert abs(len(y2) - expected2) <= 2, f"总长 = {len(y2)}（期望 {expected2}）"
        p2b = float(np.max(np.abs(y2[sr // 2 - 10:]))) if len(y2) > sr // 2 else 0.0
        assert p2b < 0.01, f"note2 关闭后后半段应静音，实际峰值 {p2b}"
        print(f"[ok] enabled=False: 总长 = {len(y2)} samples (= 0.5s), 无残留")
        # ---- 5. 缺失切片 → 告警而非崩溃 ----
        proj3, lib3, _ = _make_project_with_two_notes()
        proj3.notes[1].slice_ref.slice_hash = "0" * 16  # 不存在的 hash
        y3, _sr, warns3 = render_project(proj3, lib3)
        kinds3 = [w.kind for w in warns3]
        assert "slice_missing" in kinds3, f"应报 slice_missing，实际 {kinds3}"
        print(f"[ok] 切片缺失: {len(warns3)} 条告警，kind={kinds3}")
        # ---- 6. 音量衰减生效（velocity=64 → -5.95dB → 增益 ≈ 0.504） ----
        proj4, lib4, _ = _make_project_with_two_notes()
        from vproj_schema import velocity_to_db
        proj4.notes[0].velocity = 64
        proj4.notes[0].note_volume_db = velocity_to_db(64)
        y4, _sr, _ = render_project(proj4, lib4)
        peak4 = float(np.max(np.abs(y4[: sr // 2])))
        expect_gain = 10.0 ** (velocity_to_db(64) / 20.0)
        assert abs(peak4 - 0.5 * expect_gain) < 0.02, \
            f"衰减后峰值 {peak4:.4f}（期望 {0.5*expect_gain:.4f}）"
        print(f"[ok] 音量衰减: velocity=64 → peak={peak4:.4f}（期望 {0.5*expect_gain:.4f}）")
        # ---- 7. 落盘 WAV + 读回 ----
        out_wav = tmp / "render_out.wav"
        render_project_to_wav(proj, lib, str(out_wav))
        import soundfile as sf
        y_back, sr_back = sf.read(str(out_wav), dtype="float32")
        assert sr_back == TARGET_SR
        assert abs(len(y_back) - len(y)) <= 2, \
            f"落盘-读回长度 {len(y_back)} vs {len(y)}"
        print(f"[ok] 落盘 WAV: {out_wav.name}, 长度 {len(y_back)}, sr={sr_back}")
    print("\n[render_engine] ALL SELF-TESTS PASSED")
if __name__ == "__main__":
    _self_test()
