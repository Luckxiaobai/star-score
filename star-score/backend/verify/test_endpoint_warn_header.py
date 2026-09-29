# -*- coding: utf-8 -*-
"""端到端：验证 /api/synth/single-sample 在「长素材 + 短音符」下
   1) 返回 200 且产物有声
   2) 通过 X-Synth-Warnings 响应头回传告警音符数（前端不再只能看控制台）
"""
import io
import json
import urllib.request
import wave

import numpy as np

BASE = 'http://127.0.0.1:9874'
SR = 44100

# --- 12 秒长素材 ---
dur = 12.0
t = np.arange(int(SR * dur)) / SR
y = (0.6 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
y[: int(0.2 * SR)] = 0
y[-int(0.2 * SR):] = 0

buf = io.BytesIO()
with wave.open(buf, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((y * 32767).astype('<i2').tobytes())
sample_wav = buf.getvalue()

notes = [
    {"id": "a", "start": 0.0, "duration": 0.25, "pitch": 60, "velocity": 100, "enabled": True},
    {"id": "b", "start": 0.25, "duration": 0.25, "pitch": 67, "velocity": 100, "enabled": True},
    {"id": "c", "start": 0.5, "duration": 1.0, "pitch": 72, "velocity": 100, "enabled": True},
]

boundary = '----starpy-e2e'
b = boundary.encode()
body = b''
body += b'--' + b + b'\r\n'
body += b'Content-Disposition: form-data; name="audio"; filename="sample.wav"\r\n'
body += b'Content-Type: audio/wav\r\n\r\n'
body += sample_wav + b'\r\n'
body += b'--' + b + b'\r\n'
body += b'Content-Disposition: form-data; name="notes"\r\n\r\n'
body += json.dumps(notes).encode('utf-8') + b'\r\n'
body += b'--' + b + b'--\r\n'

req = urllib.request.Request(
    BASE + '/api/synth/single-sample', data=body,
    headers={'Content-Type': 'multipart/form-data; boundary=' + boundary}, method='POST')
resp = urllib.request.urlopen(req, timeout=180)
out = resp.read()

print('HTTP', resp.status)
print('X-Synth-Warnings =', resp.headers.get('X-Synth-Warnings'))
print('X-Synth-Notes    =', resp.headers.get('X-Synth-Notes'))
print('响应字节 =', len(out))

with wave.open(io.BytesIO(out)) as w:
    sr = w.getframerate()
    n = w.getnframes()
    ch = w.getnchannels()
    data = np.frombuffer(w.readframes(n), dtype='<i2').astype(np.float32) / 32768.0

peak = float(np.abs(data).max())
print('产物 %.3fs  %d Hz  %d 声道  峰值 %.4f' % (n / sr, sr, ch, peak))

assert resp.status == 200
assert ch == 1 and sr == 44100
assert n / sr > 1.4, '产物过短'
assert peak > 0.05, '产物几乎无声'
assert resp.headers.get('X-Synth-Warnings') is not None, '缺少 X-Synth-Warnings 头'
print('\nE2E PASS')
