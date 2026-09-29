# -*- coding: utf-8 -*-
"""验证：素材时长远大于音符时长时的窗口收窄修复。

背景：上传的"素材"若是整段人声（十几秒）而不是 1s 短样本，
required_ratio = note_sec / core_dur 会小到 0.001 量级；
旧行为用整段核心做 0.001 倍压缩 → 输出近零长度切片 → 合成结果听不见。

本测试断言修复后：
  1. applied_ratio 全部落在安全区间 [0.5, 2.0]（不再刷 WARNING）
  2. 每个音符所属的时间区间都真的有声音（峰值 > 0.05）
  3. 输出总长与 MIDI 末尾对齐
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
sys.path.insert(0, _BACKEND)

from synth_adapter import synth_single_sample_adapter  # noqa: E402

SR = 44100

# --- 12 秒素材（模拟"上传了整段人声"），头尾各 0.2s 静音 ---
dur = 12.0
t = np.arange(int(SR * dur)) / SR
y = (0.6 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
y[: int(0.2 * SR)] = 0
y[-int(0.2 * SR):] = 0

notes = [
    {"id": "a", "start": 0.0, "duration": 0.25, "pitch": 60, "velocity": 100, "enabled": True},
    {"id": "b", "start": 0.25, "duration": 0.25, "pitch": 67, "velocity": 100, "enabled": True},
    {"id": "c", "start": 0.5, "duration": 1.0, "pitch": 72, "velocity": 100, "enabled": True},
]

out, report = synth_single_sample_adapter(y, SR, notes, None, state=None)

print("素材 %.2fs（核心段内） / 输出 %.3fs，峰值 %.4f" % (dur, len(out) / SR, float(np.abs(out).max())))
for r in report:
    print("  note=%s strategy=%s required=%.4f applied=%.4f warns=%s"
          % (r["id"], r["strategy"], r["required_ratio"], r["applied_ratio"], r["warns"]))

assert len(report) == len(notes), "报告条数不符"

for r in report:
    assert r["strategy"] in ("direct", "loop", "stretch_max"), r
    assert 0.5 <= r["applied_ratio"] <= 2.0, "applied_ratio 仍在安全区间外: %s" % r

assert float(np.abs(out).max()) > 0.05, "整轨几乎无声"

for n in notes:
    i0 = int(n["start"] * SR)
    i1 = int((n["start"] + n["duration"]) * SR)
    seg = out[i0:i1]
    assert seg.size > 0, "音符 %s 区间为空" % n["id"]
    assert float(np.abs(seg).max()) > 0.05, "音符 %s 所属区间无声" % n["id"]

assert len(out) >= int(round(1.5 * SR)), "输出总长不足"

print("\nPASS: 长素材 + 短音符 —— applied_ratio 全部回到 [0.5, 2.0]，每个音符区间均有声")
