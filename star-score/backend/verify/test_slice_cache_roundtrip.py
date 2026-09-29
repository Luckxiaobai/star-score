# -*- coding: utf-8 -*-
"""端到端：素材内容寻址缓存的「存 → 取」往返。

用途：前端刷新后靠 GET /api/slice/cache/{hash} 把素材找回来（音频不进 localStorage），
这里验证该端点确实能取回与导入时一致的内容，且非法/不存在的 hash 返回 404。
"""
import io
import json
import urllib.error
import urllib.request
import wave

import numpy as np

BASE = 'http://127.0.0.1:9874'
SR = 44100

# --- 造一段 0.6s 素材 ---
t = np.arange(int(SR * 0.6)) / SR
y = (0.7 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)
y[: int(SR * 0.03)] = 0
y[-int(SR * 0.03):] = 0
buf = io.BytesIO()
with wave.open(buf, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((y * 32767).astype('<i2').tobytes())
sample_wav = buf.getvalue()


def post_slice_import(data: bytes):
    boundary = '----starpy-slice'
    b = boundary.encode()
    body = b''
    body += b'--' + b + b'\r\n'
    body += b'Content-Disposition: form-data; name="file"; filename="meow.wav"\r\n'
    body += b'Content-Type: audio/wav\r\n\r\n'
    body += data + b'\r\n'
    body += b'--' + b + b'--\r\n'
    req = urllib.request.Request(
        BASE + '/api/slice/import', data=body,
        headers={'Content-Type': 'multipart/form-data; boundary=' + boundary}, method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, json.loads(r.read().decode('utf-8'))


print('--- 1) 导入素材 ---')
st, info = post_slice_import(sample_wav)
print('HTTP', st, json.dumps(info, ensure_ascii=False))
assert st == 200 and info.get('slice_hash'), info
h = info['slice_hash']
assert len(h) == 16, h

print('\n--- 2) 按 hash 取回缓存 ---')
with urllib.request.urlopen(BASE + f'/api/slice/cache/{h}', timeout=30) as r:
    got = r.read()
    ctype = r.headers.get('Content-Type')
print('HTTP 200, Content-Type =', ctype, ', 字节 =', len(got))
with wave.open(io.BytesIO(got)) as w:
    print('取回 WAV: %d Hz, %d 声道, %.3fs' % (w.getframerate(), w.getnchannels(),
                                              w.getnframes() / w.getframerate()))
    assert w.getframerate() == SR and w.getnchannels() == 1
assert len(got) > 1000

print('\n--- 3) 不存在的 hash 应 404 ---')
try:
    urllib.request.urlopen(BASE + '/api/slice/cache/' + '0' * 16, timeout=10)
    raise AssertionError('应返回 404')
except urllib.error.HTTPError as e:
    print('HTTP', e.code)
    assert e.code == 404

print('\n--- 4) 非法 hash 应 400 ---')
try:
    urllib.request.urlopen(BASE + '/api/slice/cache/not-a-hex', timeout=10)
    raise AssertionError('应返回 400')
except urllib.error.HTTPError as e:
    print('HTTP', e.code)
    assert e.code == 400

print('\nE2E PASS：素材缓存 存→取 往返可用，刷新后可恢复素材')
