# -*- coding: utf-8 -*-
"""合成引擎冒烟测试：合成一段模拟“喵”素材，渲染小星星片段，验证输出。"""
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from synth_service import synth_single_sample, encode_wav, estimate_pitch_midi, detect_core

SR = 44100

# --- 生成模拟“喵”素材：0.6s，基频 250Hz -> 320Hz 扫频 + 谐波 ---
t = np.linspace(0, 0.6, int(SR * 0.6), endpoint=False)
f0 = 250 + (320 - 250) * (t / 0.6)
phase = 2 * np.pi * np.cumsum(f0) / SR
meow = 0.8 * np.sin(phase) + 0.3 * np.sin(2 * phase) + 0.15 * np.sin(3 * phase)
env = np.minimum(1.0, t * 40) * np.minimum(1.0, (0.6 - t) * 40)
meow = (meow * env).astype(np.float32)
meow[: int(SR * 0.05)] = 0
meow[-int(SR * 0.05):] = 0

core_s, core_e = detect_core(meow, SR)
print('core 区间: %.3f ~ %.3f s' % (core_s / SR, core_e / SR))
midi = estimate_pitch_midi(meow, SR)
print('估计素材 MIDI: %.1f (%.0f Hz)' % (midi, 440 * 2 ** ((midi - 69) / 12)))

# --- 音符序列（小星星开头，每音 0.5s）---
notes = [
    {'id': 'n1', 'start': 0.0, 'duration': 0.5, 'pitch': 60, 'velocity': 100},
    {'id': 'n2', 'start': 0.5, 'duration': 0.5, 'pitch': 60, 'velocity': 100},
    {'id': 'n3', 'start': 1.0, 'duration': 0.5, 'pitch': 67, 'velocity': 100},
    {'id': 'n4', 'start': 1.5, 'duration': 0.5, 'pitch': 67, 'velocity': 100},
    {'id': 'n5', 'start': 2.0, 'duration': 1.0, 'pitch': 69, 'velocity': 100},  # 长音 > 素材
    {'id': 'n6', 'start': 3.0, 'duration': 0.125, 'pitch': 72, 'velocity': 80},  # 极短音 < 0.5 倍
]

out, report = synth_single_sample(meow, SR, notes)
print('\n每音符报告:')
for r in report:
    print('  ', r)

expect_len = int(round((3.0 + 0.125) * SR)) + SR // 33 + 1
print('\n输出时长: %.3f s (期望 >= %.3f s)' % (len(out) / SR, (3.0 + 0.125)))
assert len(out) >= int(round(3.125 * SR)), '输出太短'
assert out.dtype == np.float32
assert not np.isnan(out).any(), '输出含 NaN'

wav = encode_wav(out, SR)
print('WAV 字节: %d, 峰值: %.3f' % (len(wav), np.abs(out).max()))
assert len(wav) > 1000

with open(os.path.join(os.path.dirname(__file__), '..', 'exports', 'test_synth.wav'), 'wb') as f:
    f.write(wav)
print('已写入 exports/test_synth.wav')
print('\nALL PASS')
