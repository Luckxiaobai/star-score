# -*- coding: utf-8 -*-
"""后端端点冒烟测试：模拟前端调用 /api/synth/single-sample"""
import io
import json
import os
import sys
import urllib.request
import wave
import numpy as np

SR = 44100

# 1. 生成测试素材（0.5s 模拟“喵”）
t = np.linspace(0, 0.5, int(SR * 0.5), endpoint=False)
f0 = 260 + (330 - 260) * (t / 0.5)
phase = 2 * np.pi * np.cumsum(f0) / SR
meow = 0.8 * np.sin(phase) + 0.25 * np.sin(2 * phase)
env = np.minimum(1.0, t * 50) * np.minimum(1.0, (0.5 - t) * 50)
meow = (meow * env).astype(np.float32)

wav_buf = io.BytesIO()
with wave.open(wav_buf, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((meow * 32767).astype('<i2').tobytes())
sample_wav = wav_buf.getvalue()

# 2. 构造 multipart 请求
boundary = '----starpy-test'
b = boundary.encode()
notes = [
    {'id': 'n1', 'start': 0.0, 'duration': 0.5, 'pitch': 60, 'velocity': 100},
    {'id': 'n2', 'start': 0.5, 'duration': 0.5, 'pitch': 64, 'velocity': 100},
    {'id': 'n3', 'start': 1.0, 'duration': 0.5, 'pitch': 67, 'velocity': 100},
    {'id': 'n4', 'start': 1.5, 'duration': 1.0, 'pitch': 72, 'velocity': 90},
]

body = b''
body += b'--' + b + b'\r\n'
body += b'Content-Disposition: form-data; name="audio"; filename="meow.wav"\r\n'
body += b'Content-Type: audio/wav\r\n\r\n'
body += sample_wav + b'\r\n'
body += b'--' + b + b'\r\n'
body += b'Content-Disposition: form-data; name="notes"\r\n\r\n'
body += json.dumps(notes).encode('utf-8') + b'\r\n'
body += b'--' + b + b'--\r\n'

req = urllib.request.Request(
    'http://127.0.0.1:9874/api/synth/single-sample',
    data=body,
    headers={'Content-Type': 'multipart/form-data; boundary=' + boundary},
    method='POST',
)
resp = urllib.request.urlopen(req, timeout=30)
out = resp.read()
print('HTTP', resp.status, 'Content-Type:', resp.headers.get('Content-Type'))
print('响应字节:', len(out))

with wave.open(io.BytesIO(out)) as w:
    sr = w.getframerate()
    n = w.getnframes()
    ch = w.getnchannels()
    print('合成 WAV: %d Hz, %d 声道, %.3f s' % (sr, ch, n / sr))
assert resp.status == 200
assert n / sr > 2.0
assert ch == 1

out_path = os.path.join(os.path.dirname(__file__), '..', 'exports', 'endpoint_test.wav')
with open(out_path, 'wb') as f:
    f.write(out)
print('已写入 exports/endpoint_test.wav')
print('ENDPOINT PASS')
