"""
core/midi_doc.py

人力V鬼畜调音工作台 — MIDI 解析 / 清洗 / 导出
对应《核心契约 v0.3.1》

依赖：
  - mido（pip install mido）
  - vproj_schema（同目录）

职责：
  - load_midi：读 MIDI 文件，取 PPQ / BPM / 拍号 / 调号 / 指定轨音符
  - clean_midi：毛刺过滤 + 三条件同音合并
  - export_midi：Note 列表写回 MIDI 文件
  - export_musicxml：阶段1唯一乐谱出口（基础五线谱，MuseScore 可打开）

约束：
  - BPM 只取第一个；检测到多个 BPM 事件时打 warning（契约 3.6 节）
  - 稳定 note_id 用 vproj_schema.make_note_id，禁止自己实现
  - velocity → dB 用 vproj_schema.velocity_to_db
"""

from __future__ import annotations

import logging
import os
import sys
import xml.etree.ElementTree as ET
import xml.dom.minidom
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

try:
    import mido
except ImportError as e:
    raise ImportError(
        "midi_doc.py 依赖 mido，请先执行: pip install mido"
    ) from e

# 同目录 / 包导入两用的 sys.path 兜底
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from vproj_schema import (  # noqa: E402
    Note,
    SliceRef,
    CleanSettings,
    make_note_id,
    velocity_to_db,
    DEFAULT_BPM,
    DEFAULT_PPQ,
    DEFAULT_MERGE_GAP_DIVISOR,
    DEFAULT_VELOCITY_JUMP_THRESHOLD,
    DEFAULT_MIN_NOTE_DIVISOR,
)

log = logging.getLogger(__name__)


# ============================================================================
# MidiDocument
# ============================================================================

@dataclass
class MidiDocument:
    ppq: int
    bpm: float
    time_signature: tuple
    key_signature: str
    track_index: int
    notes_raw: list           # 未清洗的原始 Note 列表（enabled 全 True）

    # ------------------------------------------------------------------
    # 加载
    # ------------------------------------------------------------------

    @staticmethod
    def load_midi(file_path: str, track_index: int = 0) -> "MidiDocument":
        """
        加载 MIDI 文件。
        - PPQ / BPM / 拍号 / 调号从全部轨道汇总取（tempo map 通常在轨 0）
        - 音符从指定 track_index 读取
        - 变速 MIDI 只取第一个 BPM，多余 BPM 事件打 warning
        """
        mid = mido.MidiFile(file_path)
        ppq = mid.ticks_per_beat

        # ---- 汇总 tempo / time_signature / key_signature ----
        bpm_events = []
        time_sig = None
        key_sig = "C"
        for track in mid.tracks:
            for msg in track:
                if msg.type == "set_tempo":
                    bpm_events.append(mido.tempo2bpm(msg.tempo))
                elif msg.type == "time_signature" and time_sig is None:
                    time_sig = (int(msg.numerator), int(msg.denominator))
                elif msg.type == "key_signature" and key_sig == "C":
                    key_sig = str(msg.key)

        if not bpm_events:
            bpm = DEFAULT_BPM
            log.warning("MIDI 无 tempo 事件，使用默认 BPM=%.1f", bpm)
        else:
            bpm = float(bpm_events[0])
            if len(bpm_events) > 1:
                log.warning(
                    "检测到变速 MIDI（%d 个 BPM 事件），阶段1仅使用第一个 BPM=%.2f，变速点会被忽略",
                    len(bpm_events), bpm,
                )

        if time_sig is None:
            time_sig = (4, 4)
            log.warning("MIDI 无拍号事件，使用默认 4/4")

        # ---- 读指定轨音符 ----
        if track_index < 0 or track_index >= len(mid.tracks):
            raise IndexError(
                f"track_index={track_index} 超出范围，文件共 {len(mid.tracks)} 轨"
            )

        track = mid.tracks[track_index]
        abs_tick = 0
        pending = {}   # (channel, pitch) -> (start_tick, velocity)
        notes: list = []

        for msg in track:
            abs_tick += msg.time  # delta → absolute
            if msg.type == "note_on" and msg.velocity > 0:
                pending[(msg.channel, msg.note)] = (abs_tick, int(msg.velocity))
            elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
                key = (msg.channel, msg.note)
                if key in pending:
                    start, vel = pending.pop(key)
                    dur = abs_tick - start
                    if dur <= 0:
                        continue  # 忽略零时长
                    nid = make_note_id(ppq, start, msg.note, dur)
                    notes.append(Note(
                        note_id=nid,
                        midi_pitch=int(msg.note),
                        start_tick=int(start),
                        duration_tick=int(dur),
                        velocity=int(vel),
                        enabled=True,
                        note_volume_db=velocity_to_db(int(vel)),
                        slice_ref=SliceRef(slice_hash=""),  # 阶段1未绑素材
                    ))

        # 未配对的 note_on（文件截断）
        for (channel, pitch), (start, vel) in pending.items():
            log.warning("未配对的 note_on: pitch=%d start_tick=%d", pitch, start)
            nid = make_note_id(ppq, start, pitch, 1)
            notes.append(Note(
                note_id=nid,
                midi_pitch=int(pitch),
                start_tick=int(start),
                duration_tick=1,
                velocity=int(vel),
                enabled=True,
                note_volume_db=velocity_to_db(int(vel)),
                slice_ref=SliceRef(slice_hash=""),
            ))

        return MidiDocument(
            ppq=ppq,
            bpm=bpm,
            time_signature=time_sig,
            key_signature=key_sig,
            track_index=track_index,
            notes_raw=notes,
        )

    # ------------------------------------------------------------------
    # 清洗
    # ------------------------------------------------------------------

    def clean_midi(self, clean_settings) -> list:
        """
        清洗：
          1) 过滤毛刺（duration_tick < min_note_tick）
          2) 合并连续同音：音高相同 + gap < merge_gap_tick + velocity 差 < velocity_jump_threshold
        返回新的 list[Note]；note_id 会重新派生（因为合并改变了 start/duration）。
        """
        if isinstance(clean_settings, dict):
            cs = CleanSettings.from_dict(clean_settings)
        else:
            cs = clean_settings

        # 补默认值
        min_tick = cs.min_note_tick if cs.min_note_tick > 0 else max(1, self.ppq // DEFAULT_MIN_NOTE_DIVISOR)
        merge_gap = cs.merge_gap_tick if cs.merge_gap_tick > 0 else max(1, self.ppq // DEFAULT_MERGE_GAP_DIVISOR)
        vel_jump = cs.velocity_jump_threshold

        # ---- 1. 过滤毛刺 ----
        filtered = [n for n in self.notes_raw if n.duration_tick >= min_tick]
        n_removed = len(self.notes_raw) - len(filtered)

        # ---- 2. 排序 ----
        filtered.sort(key=lambda n: (n.start_tick, n.midi_pitch))

        # ---- 3. 合并连续同音 ----
        merged: list = []
        i = 0
        n_merged_ops = 0
        while i < len(filtered):
            current = filtered[i]
            j = i + 1
            while j < len(filtered):
                nxt = filtered[j]
                if nxt.midi_pitch != current.midi_pitch:
                    break
                gap = nxt.start_tick - (current.start_tick + current.duration_tick)
                if gap >= merge_gap:
                    break
                if abs(nxt.velocity - current.velocity) >= vel_jump:
                    break
                # 合并
                new_end = max(
                    current.start_tick + current.duration_tick,
                    nxt.start_tick + nxt.duration_tick,
                )
                new_dur = new_end - current.start_tick
                new_vel = (current.velocity + nxt.velocity) // 2
                current = Note(
                    note_id=make_note_id(self.ppq, current.start_tick, current.midi_pitch, new_dur),
                    midi_pitch=current.midi_pitch,
                    start_tick=current.start_tick,
                    duration_tick=new_dur,
                    velocity=new_vel,
                    enabled=True,
                    note_volume_db=velocity_to_db(new_vel),
                    slice_ref=current.slice_ref,
                )
                n_merged_ops += 1
                j += 1
            merged.append(current)
            i = j

        log.info("清洗完成：毛刺过滤 %d 个，同音合并 %d 次，%d → %d",
                 n_removed, n_merged_ops, len(self.notes_raw), len(merged))
        return merged

    # ------------------------------------------------------------------
    # 导出 MIDI
    # ------------------------------------------------------------------

    def export_midi(self, out_path: str, notes: list) -> None:
        """把 Note 列表写回 MIDI 文件（type=1 单轨）。"""
        mid = mido.MidiFile(type=1, ticks_per_beat=self.ppq)
        track = mido.MidiTrack()
        mid.tracks.append(track)

        track.append(mido.MetaMessage(
            "set_tempo", tempo=mido.bpm2tempo(self.bpm), time=0
        ))
        track.append(mido.MetaMessage(
            "time_signature",
            numerator=self.time_signature[0],
            denominator=self.time_signature[1],
            time=0,
        ))
        track.append(mido.MetaMessage(
            "key_signature", key=self.key_signature, time=0
        ))

        # 收集事件 → 同一 tick 的 note_off 先于 note_on
        events = []
        for n in notes:
            if not n.enabled:
                continue
            events.append((n.start_tick, 0, "on", n.midi_pitch, n.velocity))
            events.append((n.start_tick + n.duration_tick, 0, "off", n.midi_pitch, 0))
        events.sort(key=lambda e: (e[0], 0 if e[2] == "off" else 1))

        current_tick = 0
        for tick, _, typ, pitch, vel in events:
            delta = tick - current_tick
            if typ == "on":
                track.append(mido.Message("note_on", note=pitch, velocity=vel, time=delta))
            else:
                track.append(mido.Message("note_off", note=pitch, velocity=0, time=delta))
            current_tick = tick

        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        mid.save(out_path)

    # ------------------------------------------------------------------
    # 导出 MusicXML（阶段1基础版）
    # ------------------------------------------------------------------

    def export_musicxml(self, out_path: str, notes: list) -> None:
        """
        基础单声部五线谱 MusicXML。
        局限：跨小节音符按小节边界截断；未处理连音/附点精确组合。
        足够 MuseScore 打开并查看，六线谱由用户自行在 MuseScore 转换。
        """
        # MIDI pitch → (step, alter, octave)
        def p2so(p: int):
            pc = p % 12
            octave = p // 12 - 1
            table = {
                0: ("C", 0), 1: ("C", 1), 2: ("D", 0), 3: ("E", -1),
                4: ("E", 0), 5: ("F", 0), 6: ("F", 1), 7: ("G", 0),
                8: ("A", -1), 9: ("A", 0), 10: ("B", -1), 11: ("B", 0),
            }
            step, alter = table[pc]
            return step, alter, octave

        def dur_to_type(dur: int, ppq: int) -> str:
            r = dur / ppq
            if r >= 3.5: return "whole"
            if r >= 1.75: return "half"
            if r >= 0.875: return "quarter"
            if r >= 0.4375: return "eighth"
            if r >= 0.21875: return "16th"
            return "32nd"

        numerator, denominator = self.time_signature
        measure_ticks = int(numerator * self.ppq * 4 / denominator)
        divisions = self.ppq

        sorted_notes = sorted(
            [n for n in notes if n.enabled], key=lambda n: n.start_tick
        )

        # 按小节分组
        from collections import defaultdict
        buckets = defaultdict(list)
        for n in sorted_notes:
            buckets[n.start_tick // measure_ticks].append(n)
        max_m = max(buckets.keys()) if buckets else 0
        measures = [buckets.get(m, []) for m in range(max_m + 1)]

        # 生成 XML
        root = ET.Element("score-partwise", version="3.1")
        part_list = ET.SubElement(root, "part-list")
        sp = ET.SubElement(part_list, "score-part", id="P1")
        ET.SubElement(sp, "part-name").text = "Vocal"
        part = ET.SubElement(root, "part", id="P1")

        for m_idx, m_notes in enumerate(measures):
            measure = ET.SubElement(part, "measure", number=str(m_idx + 1))
            if m_idx == 0:
                attrs = ET.SubElement(measure, "attributes")
                ET.SubElement(attrs, "divisions").text = str(divisions)
                key_el = ET.SubElement(attrs, "key")
                ET.SubElement(key_el, "fifths").text = "0"
                t_el = ET.SubElement(attrs, "time")
                ET.SubElement(t_el, "beats").text = str(numerator)
                ET.SubElement(t_el, "beat-type").text = str(denominator)
                clef = ET.SubElement(attrs, "clef")
                ET.SubElement(clef, "sign").text = "G"
                ET.SubElement(clef, "line").text = "2"

            cursor = m_idx * measure_ticks
            for n in m_notes:
                if n.start_tick > cursor:
                    # 前导休止
                    rest = ET.SubElement(measure, "note")
                    ET.SubElement(rest, "rest")
                    rd = n.start_tick - cursor
                    ET.SubElement(rest, "duration").text = str(rd)
                    ET.SubElement(rest, "type").text = dur_to_type(rd, divisions)
                    cursor = n.start_tick

                note_el = ET.SubElement(measure, "note")
                step, alter, octave = p2so(n.midi_pitch)
                pitch_el = ET.SubElement(note_el, "pitch")
                ET.SubElement(pitch_el, "step").text = step
                if alter != 0:
                    ET.SubElement(pitch_el, "alter").text = str(alter)
                ET.SubElement(pitch_el, "octave").text = str(octave)

                # 小节内截断
                eff_dur = min(
                    n.duration_tick,
                    (m_idx + 1) * measure_ticks - n.start_tick,
                )
                ET.SubElement(note_el, "duration").text = str(eff_dur)
                ET.SubElement(note_el, "type").text = dur_to_type(eff_dur, divisions)
                cursor = n.start_tick + eff_dur

        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        raw = ET.tostring(root, encoding="utf-8")
        pretty = xml.dom.minidom.parseString(raw).toprettyxml(indent="  ")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(pretty)


# ============================================================================
# 自检用：构造测试 MIDI
# ============================================================================

def _build_test_midi(path: str) -> None:
    """
    构造 5 个 note_on/off：
      #1 C4(60) 0-480   vel 100
      #2 C4(60) 485-965 vel 100   ← gap=5 < 10，应与 #1 合并
      #3 E4(64) 960-1440 vel 100
      #4 G4(67) 1440-1480 vel 80  ← 40 tick < 120，应被过滤
      #5 C5(72) 1440-2400 vel 100
    预期：raw=5，clean 后=3
    """
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120.0), time=0))
    track.append(mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0))
    track.append(mido.MetaMessage("key_signature", key="C", time=0))

    events = [
        (0,    "on",  60, 100),
        (480,  "off", 60, 0),
        (485,  "on",  60, 100),
        (965,  "off", 60, 0),
        (960,  "on",  64, 100),
        (1440, "off", 64, 0),
        (1440, "on",  67, 80),
        (1480, "off", 67, 0),
        (1440, "on",  72, 100),
        (2400, "off", 72, 0),
    ]
    events.sort(key=lambda e: (e[0], 0 if e[1] == "off" else 1))

    cur = 0
    for tick, typ, pitch, vel in events:
        delta = tick - cur
        if typ == "on":
            track.append(mido.Message("note_on", note=pitch, velocity=vel, time=delta))
        else:
            track.append(mido.Message("note_off", note=pitch, velocity=0, time=delta))
        cur = tick
    mid.save(path)


# ============================================================================
# 自检（python core/midi_doc.py）
# ============================================================================

def _self_test() -> None:
    import tempfile

    logging.basicConfig(level=logging.WARNING, format="[%(levelname)s] %(message)s")

    import importlib.metadata as _md
    print(f"[midi_doc] mido version = {_md.version('mido')}")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        # 1) 构造测试 MIDI
        in_mid = tmp / "test_input.mid"
        _build_test_midi(str(in_mid))
        print(f"[ok] 构造测试 MIDI: {in_mid.name}")

        # 2) load_midi
        doc = MidiDocument.load_midi(str(in_mid), track_index=0)
        assert doc.ppq == 480, f"ppq={doc.ppq}"
        assert abs(doc.bpm - 120.0) < 0.01, f"bpm={doc.bpm}"
        assert doc.time_signature == (4, 4), f"ts={doc.time_signature}"
        assert doc.key_signature == "C", f"key={doc.key_signature}"
        assert len(doc.notes_raw) == 5, f"raw notes={len(doc.notes_raw)}"
        print(f"[ok] load_midi: ppq={doc.ppq}, bpm={doc.bpm:.1f}, "
              f"ts={doc.time_signature}, key={doc.key_signature}, raw={len(doc.notes_raw)}")

        # 3) clean_midi
        cs = CleanSettings(
            merge_gap_tick=10,
            velocity_jump_threshold=30,
            min_note_tick=120,
        )
        cleaned = doc.clean_midi(cs)
        assert len(cleaned) == 3, f"cleaned notes={len(cleaned)} (期望 3)"
        print(f"[ok] clean_midi: raw=5 → cleaned={len(cleaned)} (期望 3)")

        # 4) export_midi → reload round-trip
        out_mid = tmp / "test_output.mid"
        doc.export_midi(str(out_mid), cleaned)
        doc2 = MidiDocument.load_midi(str(out_mid), track_index=0)
        assert len(doc2.notes_raw) == len(cleaned), \
            f"reload notes={len(doc2.notes_raw)} != {len(cleaned)}"
        print(f"[ok] export_midi → reload: notes={len(doc2.notes_raw)} (一致)")

        # 5) export_musicxml
        out_xml = tmp / "test_output.musicxml"
        doc.export_musicxml(str(out_xml), cleaned)
        assert out_xml.exists()
        tree = ET.parse(str(out_xml))
        root = tree.getroot()
        assert root.tag == "score-partwise", f"root tag={root.tag}"
        print(f"[ok] export_musicxml: {out_xml.name} 合法 XML, tag={root.tag}")

        # 6) note_id 稳定性（同一输入两次清洗应产生相同 ID 序列）
        cleaned2 = doc.clean_midi(cs)
        ids1 = [n.note_id for n in cleaned]
        ids2 = [n.note_id for n in cleaned2]
        assert ids1 == ids2, "note_id 不稳定"
        print(f"[ok] note_id 稳定性: 两次清洗产生相同的 {len(ids1)} 个 note_id")

    print("\n[midi_doc] ALL SELF-TESTS PASSED")


if __name__ == "__main__":
    _self_test()
