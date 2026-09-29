"""
core/vproj_schema.py

人力V鬼畜调音工作台 — 工程 schema 与序列化层
对应《核心契约 v0.3.1》

职责：
  - .vproj 工程 JSON 的 dataclass 定义
  - 序列化 / 反序列化 / 版本校验
  - 稳定 note_id 生成
  - velocity → dB 映射
  - tick ↔ 秒换算（权威实现，其他模块必须 import 本模块的版本）
  - project_hash（session 文件命名）
  - session.json 读写

设计约束：
  - 纯标准库，不引入 numpy / mido / librosa 等任何第三方依赖
  - 所有可选浮点字段判断空值必须用 `is None`，禁止 `or`
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ============================================================================
# 常量（契约 0 节）
# ============================================================================

VERSION = "v0.3.1"

RATIO_MIN = 0.5
RATIO_MAX = 2.0

SEMITONE_GREEN_MAX = 4     # abs(shift) <= 4  → 绿
SEMITONE_YELLOW_MAX = 7    # 5 <= abs(shift) <= 7 → 黄；>=8 → 红

DEFAULT_BPM = 120.0
DEFAULT_PPQ = 480
DEFAULT_LONG_NOTE_STRATEGY = "loop"  # 契约 v0.3.2 修订：stretch_max→loop（依据：star-score 前端不传 params、后端默认 loop 构成隐式使用习惯，人力V 定位下 loop 为实际基准）
DEFAULT_MERGE_GAP_DIVISOR = 32
DEFAULT_VELOCITY_JUMP_THRESHOLD = 30
DEFAULT_MIN_NOTE_DIVISOR = 16

VALID_STRATEGIES = {"direct", "loop", "stretch_max"}
VALID_SOURCE_MODES = {"single_sample_loop", "multi_syllable_dtw"}
VALID_LONG_NOTE_STRATEGIES = {"loop", "stretch_max"}


# ============================================================================
# 全局工具函数（契约 0 节，权威实现）
# ============================================================================

def tick_to_sec(tick: int, ppq: int, bpm: float) -> float:
    """契约 0 节：tick → 秒。所有模块必须调用此函数。"""
    if ppq <= 0:
        raise ValueError(f"ppq must be positive, got {ppq}")
    if bpm <= 0:
        raise ValueError(f"bpm must be positive, got {bpm}")
    return tick / ppq * (60.0 / bpm)


def sec_to_tick(sec: float, ppq: int, bpm: float) -> int:
    """契约 0 节：秒 → tick。"""
    if ppq <= 0:
        raise ValueError(f"ppq must be positive, got {ppq}")
    if bpm <= 0:
        raise ValueError(f"bpm must be positive, got {bpm}")
    return round(sec * ppq * bpm / 60.0)


def velocity_to_db(velocity: int) -> float:
    """
    契约 3.1 节：MIDI velocity → note_volume_db
      velocity=127 → 0 dB
      velocity=64  → -5.95 dB
      velocity=1   → -42 dB
      velocity=0   → -inf
    """
    if velocity <= 0:
        return -float("inf")
    return 20.0 * math.log10(velocity / 127.0)


def make_note_id(ppq: int, start_tick: int, midi_pitch: int, duration_tick: int) -> str:
    """
    契约 3 节：内容派生的稳定 note_id，12 位十六进制。
    清洗 / 重载后，只要 ppq / start_tick / pitch / duration 不变，ID 就不变。
    """
    payload = f"{ppq}|{start_tick}|{midi_pitch}|{duration_tick}".encode("utf-8")
    return hashlib.blake2b(payload, digest_size=6).hexdigest()  # 6 bytes = 12 hex


def project_hash_from_path(project_path: str | os.PathLike) -> str:
    """
    契约 3 节：project_hash = 工程文件绝对路径的 blake2b 前 8 位 hex。
    用于 session_{project_hash}.json 命名。
    """
    abs_path = os.path.abspath(os.fspath(project_path))
    return hashlib.blake2b(abs_path.encode("utf-8"), digest_size=4).hexdigest()  # 4 bytes = 8 hex


def blake2b_16hex(data: bytes) -> str:
    """契约 1 节：音频切片哈希，blake2b 16 位 hex。"""
    return hashlib.blake2b(data, digest_size=8).hexdigest()  # 8 bytes = 16 hex


# ============================================================================
# dataclass 定义（契约 3 节 JSON schema）
# ============================================================================

@dataclass
class CleanSettings:
    merge_gap_tick: int
    velocity_jump_threshold: int = DEFAULT_VELOCITY_JUMP_THRESHOLD
    min_note_tick: int = 0  # 0 表示"未显式设置"，由 PPQ 派生默认值

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "CleanSettings":
        return cls(
            merge_gap_tick=int(d["merge_gap_tick"]),
            velocity_jump_threshold=int(d.get("velocity_jump_threshold", DEFAULT_VELOCITY_JUMP_THRESHOLD)),
            min_note_tick=int(d.get("min_note_tick", 0)),
        )


@dataclass
class MidiConfig:
    ppq: int
    bpm: float
    time_signature: tuple
    key_signature: str
    track_index: int
    clean_settings: CleanSettings

    def to_dict(self) -> dict:
        return {
            "ppq": self.ppq,
            "bpm": self.bpm,
            "time_signature": list(self.time_signature),
            "key_signature": self.key_signature,
            "track_index": self.track_index,
            "clean_settings": self.clean_settings.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "MidiConfig":
        ts = d["time_signature"]
        return cls(
            ppq=int(d["ppq"]),
            bpm=float(d["bpm"]),
            time_signature=(int(ts[0]), int(ts[1])),
            key_signature=str(d.get("key_signature", "C")),
            track_index=int(d.get("track_index", 0)),
            clean_settings=CleanSettings.from_dict(d["clean_settings"]),
        )


@dataclass
class SliceRef:
    slice_hash: str
    src_file_name: str = ""
    src_start_sec: Optional[float] = None
    src_end_sec: Optional[float] = None
    semitone_shift: float = 0.0
    required_ratio: float = 1.0
    applied_ratio: float = 1.0
    strategy: str = "direct"
    fade_in_ms: float = 0.0
    fade_out_ms: float = 0.0
    # 阶段1 预留字段，渲染时固定为 0，不参与音频处理
    vibrato_depth: float = 0.0
    vibrato_rate: float = 0.0
    portamento_semitones: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "SliceRef":
        return cls(
            slice_hash=str(d["slice_hash"]),
            src_file_name=str(d.get("src_file_name", "")),
            # 严格 None 判断：0.0 是合法值，不能与 None 混淆
            src_start_sec=(None if d.get("src_start_sec") is None else float(d["src_start_sec"])),
            src_end_sec=(None if d.get("src_end_sec") is None else float(d["src_end_sec"])),
            semitone_shift=float(d.get("semitone_shift", 0.0)),
            required_ratio=float(d.get("required_ratio", 1.0)),
            applied_ratio=float(d.get("applied_ratio", 1.0)),
            strategy=str(d.get("strategy", "direct")),
            fade_in_ms=float(d.get("fade_in_ms", 0.0)),
            fade_out_ms=float(d.get("fade_out_ms", 0.0)),
            vibrato_depth=float(d.get("vibrato_depth", 0.0)),
            vibrato_rate=float(d.get("vibrato_rate", 0.0)),
            portamento_semitones=float(d.get("portamento_semitones", 0.0)),
        )


@dataclass
class Note:
    note_id: str
    midi_pitch: int
    start_tick: int
    duration_tick: int
    velocity: int
    enabled: bool
    note_volume_db: float
    slice_ref: SliceRef

    def to_dict(self) -> dict:
        return {
            "note_id": self.note_id,
            "midi_pitch": self.midi_pitch,
            "start_tick": self.start_tick,
            "duration_tick": self.duration_tick,
            "velocity": self.velocity,
            "enabled": self.enabled,
            "note_volume_db": self.note_volume_db,
            "slice_ref": self.slice_ref.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Note":
        return cls(
            note_id=str(d["note_id"]),
            midi_pitch=int(d["midi_pitch"]),
            start_tick=int(d["start_tick"]),
            duration_tick=int(d["duration_tick"]),
            velocity=int(d["velocity"]),
            enabled=bool(d["enabled"]),
            note_volume_db=float(d["note_volume_db"]),
            slice_ref=SliceRef.from_dict(d["slice_ref"]),
        )


@dataclass
class SliceSample:
    slice_hash: str
    original_file: str
    chroma_fingerprint: str
    avg_f0_hz: float
    duration_sec: float
    start_core_sec: float
    end_core_sec: float

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "SliceSample":
        return cls(
            slice_hash=str(d["slice_hash"]),
            original_file=str(d.get("original_file", "")),
            chroma_fingerprint=str(d.get("chroma_fingerprint", "")),
            avg_f0_hz=float(d.get("avg_f0_hz", 0.0)),
            duration_sec=float(d["duration_sec"]),
            start_core_sec=float(d.get("start_core_sec", 0.0)),
            end_core_sec=float(d.get("end_core_sec", 0.0)),
        )


@dataclass
class ProjectMeta:
    version: str
    project_name: str
    created_at: str
    source_mode: str
    long_note_default_strategy: str

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ProjectMeta":
        return cls(
            version=str(d["version"]),
            project_name=str(d.get("project_name", "untitled")),
            created_at=str(d.get("created_at", "")),
            source_mode=str(d["source_mode"]),
            long_note_default_strategy=str(d["long_note_default_strategy"]),
        )


@dataclass
class Project:
    project_meta: ProjectMeta
    midi_config: MidiConfig
    notes: list = field(default_factory=list)
    global_samples: list = field(default_factory=list)

    # ------------------------------------------------------------------
    # 序列化
    # ------------------------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "project_meta": self.project_meta.to_dict(),
            "midi_config": self.midi_config.to_dict(),
            "notes": [n.to_dict() for n in self.notes],
            "slice_library": {
                "global_samples": [s.to_dict() for s in self.global_samples],
            },
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Project":
        sl = d.get("slice_library") or {}
        return cls(
            project_meta=ProjectMeta.from_dict(d["project_meta"]),
            midi_config=MidiConfig.from_dict(d["midi_config"]),
            notes=[Note.from_dict(n) for n in d.get("notes", [])],
            global_samples=[SliceSample.from_dict(s) for s in sl.get("global_samples", [])],
        )

    # ------------------------------------------------------------------
    # 工厂方法
    # ------------------------------------------------------------------

    @classmethod
    def new(
        cls,
        project_name: str,
        ppq: int = DEFAULT_PPQ,
        bpm: float = DEFAULT_BPM,
        time_signature: tuple = (4, 4),
        key_signature: str = "C",
        source_mode: str = "single_sample_loop",
        long_note_default_strategy: str = DEFAULT_LONG_NOTE_STRATEGY,
    ) -> "Project":
        if source_mode not in VALID_SOURCE_MODES:
            raise ValueError(f"invalid source_mode: {source_mode}")
        if long_note_default_strategy not in VALID_LONG_NOTE_STRATEGIES:
            raise ValueError(f"invalid long_note_default_strategy: {long_note_default_strategy}")
        if ppq <= 0:
            raise ValueError(f"ppq must be positive, got {ppq}")
        return cls(
            project_meta=ProjectMeta(
                version=VERSION,
                project_name=project_name,
                created_at=datetime.now(timezone.utc).isoformat(),
                source_mode=source_mode,
                long_note_default_strategy=long_note_default_strategy,
            ),
            midi_config=MidiConfig(
                ppq=ppq,
                bpm=bpm,
                time_signature=time_signature,
                key_signature=key_signature,
                track_index=0,
                clean_settings=CleanSettings(
                    merge_gap_tick=max(1, ppq // DEFAULT_MERGE_GAP_DIVISOR),
                    velocity_jump_threshold=DEFAULT_VELOCITY_JUMP_THRESHOLD,
                    min_note_tick=max(1, ppq // DEFAULT_MIN_NOTE_DIVISOR),
                ),
            ),
            notes=[],
            global_samples=[],
        )


# ============================================================================
# 版本校验（契约 3.7 节）
# ============================================================================

class VersionMismatchError(Exception):
    """工程版本与当前支持的版本不一致。"""
    pass


def assert_version_supported(version: str) -> None:
    if version != VERSION:
        raise VersionMismatchError(
            f"工程版本不匹配：当前 {version}，本阶段仅支持 {VERSION}"
        )


# ============================================================================
# 工程文件读写
# ============================================================================

def save_project(project: Project, path: str | os.PathLike) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as f:
        json.dump(project.to_dict(), f, ensure_ascii=False, indent=2)


def load_project(path: str | os.PathLike) -> Project:
    p = Path(path)
    with p.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    version = raw.get("project_meta", {}).get("version", "")
    assert_version_supported(version)
    return Project.from_dict(raw)


# ============================================================================
# session 文件（契约 3 节）
# ============================================================================

@dataclass
class SessionState:
    view_start_tick: int = 0
    view_width_tick: int = 1920
    pitch_min: int = 36
    pitch_max: int = 84
    playhead_tick: int = 0
    is_playing: bool = False
    selected_note_ids: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "SessionState":
        return cls(
            view_start_tick=int(d.get("view_start_tick", 0)),
            view_width_tick=int(d.get("view_width_tick", 1920)),
            pitch_min=int(d.get("pitch_min", 36)),
            pitch_max=int(d.get("pitch_max", 84)),
            playhead_tick=int(d.get("playhead_tick", 0)),
            is_playing=bool(d.get("is_playing", False)),
            selected_note_ids=list(d.get("selected_note_ids", [])),
        )


def default_appdata_dir() -> Path:
    """
    契约 5 节：%APPDATA%/human_vocal_workbench
    非 Windows 平台退化到 ~/.human_vocal_workbench，便于跨平台开发测试。
    """
    if os.name == "nt":
        base = os.environ.get("APPDATA")
        if not base:
            base = str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "human_vocal_workbench"
    return Path.home() / ".human_vocal_workbench"


def session_path_for_project(
    project_path: str | os.PathLike,
    appdata_dir: Optional[Path] = None,
) -> Path:
    base = appdata_dir or default_appdata_dir()
    ph = project_hash_from_path(project_path)
    return base / f"session_{ph}.json"


def save_session(
    session: SessionState,
    project_path: str | os.PathLike,
    appdata_dir: Optional[Path] = None,
) -> Path:
    path = session_path_for_project(project_path, appdata_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(session.to_dict(), f, ensure_ascii=False, indent=2)
    return path


def load_session(
    project_path: str | os.PathLike,
    appdata_dir: Optional[Path] = None,
) -> Optional[SessionState]:
    path = session_path_for_project(project_path, appdata_dir)
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    return SessionState.from_dict(raw)


# ============================================================================
# 自检（python core/vproj_schema.py）
# ============================================================================

def _self_test() -> None:
    import tempfile

    print(f"[vproj_schema] VERSION = {VERSION}")

    # 1) tick ↔ 秒 round-trip
    t = 960
    s = tick_to_sec(t, ppq=480, bpm=120.0)
    assert abs(s - 1.0) < 1e-9, f"tick_to_sec failed: {s}"
    assert sec_to_tick(1.0, 480, 120.0) == 960
    print("[ok] tick_to_sec / sec_to_tick round-trip")

    # 2) velocity → dB（精确值：20*log10(64/127) ≈ -5.9524）
    assert velocity_to_db(127) == 0.0
    v64 = velocity_to_db(64)
    assert -5.96 < v64 < -5.94, f"velocity_to_db(64) = {v64}"
    v1 = velocity_to_db(1)
    assert -42.1 < v1 < -42.0, f"velocity_to_db(1) = {v1}"
    assert velocity_to_db(0) == -float("inf")
    print(f"[ok] velocity_to_db  (v=64 → {v64:.4f} dB, v=1 → {v1:.4f} dB)")

    # 3) note_id 稳定性
    a = make_note_id(480, 960, 60, 480)
    b = make_note_id(480, 960, 60, 480)
    c = make_note_id(480, 960, 61, 480)
    assert a == b and a != c and len(a) == 12
    print(f"[ok] make_note_id stable: {a}")

    # 4) 构造工程 → round-trip
    proj = Project.new("selftest", ppq=480, bpm=120.0)
    proj.global_samples.append(SliceSample(
        slice_hash="a" * 16,
        original_file="miao.wav",
        chroma_fingerprint="BASE64==",
        avg_f0_hz=440.0,
        duration_sec=1.0,
        start_core_sec=0.1,
        end_core_sec=0.9,
    ))
    for i in range(4):
        nid = make_note_id(480, i * 480, 60 + i, 480)
        proj.notes.append(Note(
            note_id=nid,
            midi_pitch=60 + i,
            start_tick=i * 480,
            duration_tick=480,
            velocity=100,
            enabled=True,
            note_volume_db=velocity_to_db(100),
            slice_ref=SliceRef(
                slice_hash="a" * 16,
                src_file_name="miao.wav",
                src_start_sec=0.1,
                src_end_sec=0.9,
                semitone_shift=float(i),
                required_ratio=0.5,
                applied_ratio=0.5,
                strategy="direct",
            ),
        ))

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "selftest.vproj"
        save_project(proj, path)
        loaded = load_project(path)
        assert loaded.to_dict() == proj.to_dict(), "round-trip mismatch"
        print(f"[ok] project round-trip via {path.name}")

        # 5) session 读写
        s = SessionState(view_start_tick=100, selected_note_ids=[proj.notes[0].note_id])
        sp = save_session(s, path, appdata_dir=Path(tmp) / "_appdata")
        s2 = load_session(path, appdata_dir=Path(tmp) / "_appdata")
        assert s2 is not None and s2.selected_note_ids == s.selected_note_ids
        print(f"[ok] session save/load via {sp.name}")

        # 6) 版本校验
        bad = path.parent / "bad.vproj"
        d = proj.to_dict()
        d["project_meta"]["version"] = "v0.0.0"
        bad.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        try:
            load_project(bad)
        except VersionMismatchError:
            print("[ok] VersionMismatchError raised for wrong version")
        else:
            raise AssertionError("expected VersionMismatchError")

    print("\n[vproj_schema] ALL SELF-TESTS PASSED")


if __name__ == "__main__":
    _self_test()
