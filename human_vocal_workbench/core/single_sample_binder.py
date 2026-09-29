"""
core/single_sample_binder.py
人力V鬼畜调音工作台 — 单样本循环模式批量绑定
对应《核心契约 v0.3.1》3.2 节
依赖：
  - vproj_schema（Note / SliceRef / SliceSample / tick_to_sec / velocity_to_db /
                  make_note_id / RATIO_MIN / RATIO_MAX / SEMITONE_*）
职责：
  - bind_all_notes：把 global_samples[0] 绑定到 Project 每个 note 的 slice_ref
  - 计算 semitone_shift / required_ratio / applied_ratio / strategy
  - 输出告警列表（越界 / 二度越界 / 变调黄红）
⚠️ 对契约 3.2 字面伪代码的两处偏离（已在代码注释中标明）：
  1. required_ratio 以【核心段】为基准，而非素材总时长。
     理由：src_start/end 始终指向核心段；若基准用总时长，会出现
           "基准与区间不一致"的语义裂缝。
  2. loop 策略下 applied_ratio = 1.0，而非 required_ratio。
     理由：loop 的本质是"不拉伸、循环铺满"；若设成 required_ratio，
           会先被 _pitch_and_stretch 拉伸到目标长度，再被 _loop_fill 截断，
           退化为 stretch 而非 loop。
"""
from __future__ import annotations
import logging
import math
import sys
from dataclasses import dataclass
from pathlib import Path
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
from vproj_schema import (  # noqa: E402
    Project,
    Note,
    SliceRef,
    SliceSample,
    tick_to_sec,
    velocity_to_db,
    make_note_id,
    RATIO_MIN,
    RATIO_MAX,
    SEMITONE_GREEN_MAX,
    SEMITONE_YELLOW_MAX,
)
log = logging.getLogger(__name__)
# ============================================================================
# 告警结构
# ============================================================================
@dataclass
class BindWarning:
    note_id: str
    kind: str       # ratio_low | ratio_high | ratio_second_out
                    # | semitone_yellow | semitone_red
    message: str
    level: str      # yellow | red
# ============================================================================
# 内部工具
# ============================================================================
def _midi_pitch_from_f0(f0_hz: float) -> float:
    """素材基频 → 对应 MIDI pitch（浮点，不取整）。A4=440Hz → 69。"""
    if f0_hz <= 0:
        return 0.0
    return 69.0 + 12.0 * math.log2(f0_hz / 440.0)
def _semitone_shift_for_note(target_pitch: int, sample: SliceSample) -> float:
    """目标音符 MIDI pitch - 素材基准 MIDI pitch（浮点差）。"""
    base_pitch = _midi_pitch_from_f0(sample.avg_f0_hz)
    return float(target_pitch) - base_pitch
# ============================================================================
# 核心绑定
# ============================================================================
def bind_all_notes(project: Project) -> tuple[Project, list[BindWarning]]:
    """
    单样本循环模式批量绑定。
    输入：
      project — 需已含 midi_config、notes、global_samples（≥1）
    输出：
      (project, warnings)   — project 就地修改并返回
    契约语义（3.2）：
      - 锁定 global_samples[0]
      - 始终使用核心段 [start_core_sec, end_core_sec] 作为素材区间
      - required_ratio 以核心段为基准（见文件头偏离说明 1）
      - 0.5 ≤ r ≤ 2.0：direct，applied = r
      - r < 0.5     ：direct，applied = r，标黄（核心段已截，不再二次截取）
      - r > 2.0     ：走 long_note_default_strategy
          stretch_max → applied = 2.0
          loop        → applied = 1.0（见文件头偏离说明 2）
    """
    if not project.global_samples:
        raise ValueError("project.global_samples 为空，无可绑定素材")
    sample = project.global_samples[0]
    ppq = project.midi_config.ppq
    bpm = project.midi_config.bpm
    strategy_high = project.project_meta.long_note_default_strategy
    core_dur = sample.end_core_sec - sample.start_core_sec
    if core_dur <= 0:
        raise ValueError(
            f"素材核心段无效：[{sample.start_core_sec}, {sample.end_core_sec}]"
        )
    warnings: list[BindWarning] = []
    for note in project.notes:
        note_dur_sec = tick_to_sec(note.duration_tick, ppq, bpm)
        required_ratio = note_dur_sec / core_dur
        semitone = _semitone_shift_for_note(note.midi_pitch, sample)
        # ---- 策略判定 ----
        if RATIO_MIN <= required_ratio <= RATIO_MAX:
            strategy = "direct"
            applied_ratio = required_ratio
        elif required_ratio < RATIO_MIN:
            strategy = "direct"
            applied_ratio = required_ratio
            warnings.append(BindWarning(
                note_id=note.note_id,
                kind="ratio_second_out",
                message=(
                    f"音符 {note_dur_sec*1000:.1f}ms 远小于核心段 "
                    f"{core_dur*1000:.1f}ms，ratio={required_ratio:.3f} < 0.5，"
                    f"将硬压缩（音色可能崩坏）"
                ),
                level="yellow",
            ))
        else:
            if strategy_high == "stretch_max":
                strategy = "stretch_max"
                applied_ratio = RATIO_MAX
            else:  # loop
                strategy = "loop"
                applied_ratio = 1.0  # 见文件头偏离说明 2
            warnings.append(BindWarning(
                note_id=note.note_id,
                kind="ratio_high",
                message=(
                    f"音符 {note_dur_sec*1000:.1f}ms > 核心段×2，"
                    f"required={required_ratio:.3f}，走 {strategy}"
                ),
                level="yellow",
            ))
        # ---- 变调告警 ----
        a = abs(semitone)
        if a > SEMITONE_YELLOW_MAX:
            warnings.append(BindWarning(
                note_id=note.note_id,
                kind="semitone_red",
                message=f"变调 {semitone:+.2f} 半音（≥8）音色极可能崩坏",
                level="red",
            ))
        elif a > SEMITONE_GREEN_MAX:
            warnings.append(BindWarning(
                note_id=note.note_id,
                kind="semitone_yellow",
                message=f"变调 {semitone:+.2f} 半音（5~7）音色可能失真",
                level="yellow",
            ))
        # ---- 回写 slice_ref ----
        note.slice_ref = SliceRef(
            slice_hash=sample.slice_hash,
            src_file_name=sample.original_file,
            src_start_sec=sample.start_core_sec,
            src_end_sec=sample.end_core_sec,
            semitone_shift=semitone,
            required_ratio=required_ratio,
            applied_ratio=applied_ratio,
            strategy=strategy,
            fade_in_ms=10.0,
            fade_out_ms=10.0,
            vibrato_depth=0.0,
            vibrato_rate=0.0,
            portamento_semitones=0.0,
        )
    return project, warnings
# ============================================================================
# 自检（py core\\single_sample_binder.py）
# ============================================================================
def _self_test() -> None:
    logging.basicConfig(level=logging.WARNING, format="[%(levelname)s] %(message)s")
    print("[single_sample_binder] 构造测试项目 ...")
    proj = Project.new("binder_test", ppq=480, bpm=120.0)
    proj.project_meta.long_note_default_strategy = "stretch_max"  # 显式设，自检不依赖默认值（测 stretch 分支）
    proj.global_samples.append(SliceSample(
        slice_hash="a" * 16,
        original_file="miao.wav",
        chroma_fingerprint="",
        avg_f0_hz=440.0,
        duration_sec=1.0,
        start_core_sec=0.2,
        end_core_sec=0.8,
    ))
    core_dur = 0.6
    # 120 BPM / PPQ 480 → 1 tick = 60/(120×480) s
    #   16分 = 120 tick = 0.125s → r = 0.125/0.6 ≈ 0.208 (<0.5, 二度越界)
    #    4分 = 480 tick = 0.500s → r ≈ 0.833  (direct)
    #   全音符 = 1920 tick = 2.000s → r ≈ 3.333 (>2, stretch_max)
    #   超长 = 3840 tick = 4.000s → r ≈ 6.667 (>2, stretch_max)
    cases = [
        # (pitch, start, dur, 描述, 期望策略, 期望 applied)
        (60, 0,    120,  "16分 pitch=60", "direct",      0.125 / core_dur),
        (64, 480,  480,  "4分 pitch=64",  "direct",      0.500 / core_dur),
        (67, 960,  1920, "全音符 pitch=67","stretch_max", 2.0),
        (72, 2880, 3840, "超长 pitch=72", "stretch_max", 2.0),
    ]
    for (pitch, st, dur, _desc, _s, _r) in cases:
        nid = make_note_id(480, st, pitch, dur)
        proj.notes.append(Note(
            note_id=nid, midi_pitch=pitch, start_tick=st, duration_tick=dur,
            velocity=100, enabled=True, note_volume_db=velocity_to_db(100),
            slice_ref=SliceRef(slice_hash=""),
        ))
    proj, warnings = bind_all_notes(proj)
    for note, (pitch, _st, _dur, desc, exp_strat, exp_ratio) in zip(proj.notes, cases):
        assert note.slice_ref.strategy == exp_strat, \
            f"{desc}: strategy={note.slice_ref.strategy} ≠ {exp_strat}"
        assert abs(note.slice_ref.applied_ratio - exp_ratio) < 1e-6, \
            f"{desc}: applied={note.slice_ref.applied_ratio} ≠ {exp_ratio}"
        exp_shift = pitch - 69.0
        assert abs(note.slice_ref.semitone_shift - exp_shift) < 1e-6, \
            f"{desc}: semitone={note.slice_ref.semitone_shift} ≠ {exp_shift}"
        assert note.slice_ref.src_start_sec == 0.2
        assert note.slice_ref.src_end_sec == 0.8
        assert note.slice_ref.slice_hash == "a" * 16
    print("[ok] 4 个音符策略绑定正确（direct×2 / stretch_max×2）")
    print("[ok] semitone_shift 均基于 A4 基准（440Hz = MIDI 69）")
    print("[ok] src_start/end 统一指向核心段 [0.2, 0.8]")
    kinds: dict[str, int] = {}
    for w in warnings:
        kinds[w.kind] = kinds.get(w.kind, 0) + 1
    print(f"[ok] 告警汇总: {kinds}")
    assert kinds.get("ratio_second_out", 0) >= 1, "缺 16分音符的二度越界告警"
    assert kinds.get("ratio_high", 0) >= 2, "缺长音符的 ratio_high 告警"
    # 切 loop 策略再跑
    proj2 = Project.new("binder_test_loop", ppq=480, bpm=120.0)
    proj2.global_samples = list(proj.global_samples)
    proj2.project_meta.long_note_default_strategy = "loop"
    for note in proj.notes:
        proj2.notes.append(Note(
            note_id=note.note_id, midi_pitch=note.midi_pitch,
            start_tick=note.start_tick, duration_tick=note.duration_tick,
            velocity=note.velocity, enabled=note.enabled,
            note_volume_db=note.note_volume_db,
            slice_ref=SliceRef(slice_hash=""),
        ))
    proj2, _ = bind_all_notes(proj2)
    for note, (_p, _st, _d, desc, _s, _r) in zip(proj2.notes, cases):
        if note.duration_tick >= 1920:
            assert note.slice_ref.strategy == "loop", \
                f"{desc}: 期望 loop, 实际 {note.slice_ref.strategy}"
            assert note.slice_ref.applied_ratio == 1.0, \
                f"{desc}: loop 的 applied_ratio 应为 1.0"
    print("[ok] loop 策略生效：长音符走循环填充, applied_ratio=1.0")
    print("\n[single_sample_binder] ALL SELF-TESTS PASSED")
if __name__ == "__main__":
    _self_test()
