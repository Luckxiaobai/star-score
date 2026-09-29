# -*- coding: utf-8 -*-
"""星谱识音 StarScore - 多引擎后端

纯标准库核心 + 可选扩展：
  - 人声/伴奏分离（center / demucs）
  - GAME 歌声 MIDI 提取（可选，需安装 game + onnxruntime）
  - HOMR 乐谱图片识别（可选，需安装 homr）

用法:
  py backend/server.py                        # 默认 127.0.0.1:9874
  py backend/server.py --port 8000 --host 0.0.0.0

可选安装:
  pip install onnxruntime                     # GAME CPU 推理
  pip install homr[cpu]                       # HOMR OMR 识别
  pip install demucs                           # AI 人声分离（更高质量）
"""

import argparse
import array
import copy
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
import wave
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# 人力V工作台：单样本循环合成引擎
sys.path.insert(0, os.path.dirname(__file__))
import synth_service
from synth_adapter import synth_single_sample_adapter
from job_manager import JobManager
from ai_provider import generate_midi_plan, list_models, transcribe_audio
# —— 注入 core 路径（与 synth_adapter 同源）——
from pathlib import Path
_CORE = Path(__file__).resolve().parent.parent.parent / "human_vocal_workbench" / "core"
if str(_CORE) not in sys.path:
    sys.path.insert(0, str(_CORE))
from slice_lib import SliceLibrary, cache_slice_to_disk, load_slice_from_disk
from vproj_schema import Project, SliceSample, default_appdata_dir

try:
    import audioop  # Python <= 3.12 标准库
    HAS_AUDIOOP = True
except ImportError:  # Python 3.13+ 已移除
    HAS_AUDIOOP = False


# ================================================================
# 工程状态（契约线 AppState 迁入，star-score 主后端）
# ================================================================

class AppState:
    """后端持有的权威工程状态。阶段1单用户，不加锁。"""
    def __init__(self):
        self.project = None
        self.slice_library = SliceLibrary()
        self.bind_warnings = []
        self.render_warnings = []
        self.last_render_wav = None


app_state = AppState()
RENDER_OUT = default_appdata_dir() / "runtime_render.wav"
SLICE_CACHE_DIR = default_appdata_dir() / "slice_cache"
PROJECTS_DIR = default_appdata_dir() / "projects"
JOB_MANAGER = JobManager(default_appdata_dir() / "jobs")


def _run_single_sample_job(job, cancel_event, progress, audio_bytes, notes, params):
    sr, waveform = _decode_wav(audio_bytes)
    if waveform.size == 0:
        raise ValueError("素材为空")
    out, report = synth_single_sample_adapter(
        waveform,
        sr,
        notes,
        params,
        state=None,
        cancel_event=cancel_event,
        progress=progress,
    )
    wav_bytes = synth_service.encode_wav(out, synth_service.SAMPLE_RATE)
    job.output_path.parent.mkdir(parents=True, exist_ok=True)
    job.output_path.write_bytes(wav_bytes)
    return {
        "wav_size": len(wav_bytes),
        "warnings": sum(1 for item in report if item.get("warns")),
        "notes": len(report),
    }


def _run_render_job(job, cancel_event, progress, project, slice_library):
    from render_engine import render_project_to_wav

    warns = render_project_to_wav(
        project,
        slice_library,
        str(job.output_path),
        cancel_event=cancel_event,
        progress=progress,
    )
    return {
        "wav_size": job.output_path.stat().st_size if job.output_path.exists() else 0,
        "warnings": len(warns),
        "notes": sum(1 for note in project.notes if note.enabled),
    }


# ================================================================
# 模块检测
# ================================================================

def _has_module(name):
    try:
        import importlib.util
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


def _has_demucs():
    return _has_module('demucs')


GAME_MODEL_DIR = os.path.join(os.path.dirname(__file__), 'models', 'game')
GAME_REQUIRED_FILES = ('config.json', 'encoder.onnx', 'segmenter.onnx', 'estimator.onnx')


def _game_model_installed():
    """模型文件是否齐全（不检查 onnxruntime，用于「已下载」状态展示）。"""
    return all(os.path.exists(os.path.join(GAME_MODEL_DIR, f)) for f in GAME_REQUIRED_FILES)


def _has_game():
    """检测 GAME 是否可用（需要 onnxruntime + 模型文件齐全）"""
    return _has_module('onnxruntime') and _game_model_installed()


# ================================================================
# GAME 模型下载（后台线程 + 进度查询）
# ================================================================

# GAME 官方 release（openvpi/GAME v1.0.3）ONNX 模型包
GAME_RELEASE_BASE = 'https://github.com/openvpi/GAME/releases/download/v1.0.3/'
GAME_PACKAGES = {
    'game-small': ('GAME-1.0.3-small-onnx.zip', 45_676_364),
    'game-medium': ('GAME-1.0.3-medium-onnx.zip', 179_775_226),
    'game-large': ('GAME-1.0.3-large-onnx.zip', 361_619_205),
}
# 前端旧 ID 兼容
GAME_ID_ALIASES = {'game': 'game-small'}

# 下载任务状态：{modelId: {status, progress, message, downloadedBytes, totalBytes}}
_DOWNLOAD_STATE = {}
_DOWNLOAD_LOCK = threading.Lock()


def _set_download_state(model_id, **kw):
    with _DOWNLOAD_LOCK:
        st = _DOWNLOAD_STATE.setdefault(model_id, {
            'status': 'idle', 'progress': 0.0, 'message': '',
            'downloadedBytes': 0, 'totalBytes': 0,
        })
        st.update(kw)


def _get_download_state(model_id):
    with _DOWNLOAD_LOCK:
        return dict(_DOWNLOAD_STATE.get(model_id, {
            'status': 'idle', 'progress': 0.0, 'message': '',
            'downloadedBytes': 0, 'totalBytes': 0,
        }))


def _find_game_extract_root(tmp_dir):
    """zip 解压后找到含 config.json 的目录（可能多一层嵌套）。"""
    for root, _dirs, files in os.walk(tmp_dir):
        if 'config.json' in files:
            return root
    return None


def _download_game_model(model_id):
    """后台线程：下载 zip → 解压 → 拷贝到 backend/models/game/。"""
    zip_name, total = GAME_PACKAGES[model_id]
    url = GAME_RELEASE_BASE + zip_name
    _set_download_state(model_id, status='downloading', progress=0.0,
                        message='正在连接 GitHub...',
                        downloadedBytes=0, totalBytes=total)

    tmp_dir = tempfile.mkdtemp(prefix='star-score-game-')
    zip_path = os.path.join(tmp_dir, zip_name)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'StarScore/2.0'})
        with urllib.request.urlopen(req, timeout=60) as resp, open(zip_path, 'wb') as out:
            got = 0
            chunk = 1024 * 256
            while True:
                buf = resp.read(chunk)
                if not buf:
                    break
                out.write(buf)
                got += len(buf)
                pct = min(99.0, got / total * 100.0) if total else 0.0
                _set_download_state(model_id, progress=round(pct, 1),
                                    downloadedBytes=got,
                                    message='下载中 %.1f%% (%d/%d MB)' % (
                                        pct, got // 1048576, total // 1048576))

        _set_download_state(model_id, progress=99.0, message='解压中...')
        extract_dir = os.path.join(tmp_dir, 'extract')
        os.makedirs(extract_dir, exist_ok=True)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(extract_dir)

        src_root = _find_game_extract_root(extract_dir)
        if not src_root:
            raise RuntimeError('解压后未找到 config.json，模型包结构异常')

        os.makedirs(GAME_MODEL_DIR, exist_ok=True)
        for fname in os.listdir(src_root):
            s = os.path.join(src_root, fname)
            d = os.path.join(GAME_MODEL_DIR, fname)
            if os.path.isdir(s):
                if os.path.isdir(d):
                    shutil.rmtree(d)
                shutil.copytree(s, d)
            else:
                shutil.copy2(s, d)

        if not _game_model_installed():
            raise RuntimeError('模型文件不完整，缺少: ' + ', '.join(
                f for f in GAME_REQUIRED_FILES
                if not os.path.exists(os.path.join(GAME_MODEL_DIR, f))))

        # 模型已更新，清掉内存里的 GameModel 缓存
        _GAME_MODEL_CACHE['key'] = None
        _GAME_MODEL_CACHE['model'] = None

        _set_download_state(model_id, status='done', progress=100.0,
                            message='模型下载完成', downloadedBytes=total,
                            totalBytes=total)
    except Exception as exc:
        _set_download_state(model_id, status='error', progress=0.0,
                            message='下载失败: %s' % exc)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _has_homr():
    """检测 HOMR 是否可用"""
    return _has_module('homr')


# ================================================================
# 人声/伴奏分离
# ================================================================

def separate_center(raw, width, nch, mode):
    """中置声道提取 / 去除。返回单声道 16-bit PCM。"""
    if nch == 1:
        return raw
    if HAS_AUDIOOP:
        if mode == 'accompaniment':
            return audioop.tomono(raw, width, 0.5, -0.5)
        return audioop.tomono(raw, width, 0.5, 0.5)
    a = array.array('h')
    a.frombytes(raw)
    left = a[0::2]
    right = a[1::2]
    n = min(len(left), len(right))
    out = array.array('h', [0]) * n
    for i in range(n):
        if mode == 'accompaniment':
            out[i] = (left[i] - right[i]) // 2
        else:
            out[i] = (left[i] + right[i]) // 2
    return out.tobytes()


def run_demucs(wav_bytes, mode):
    """用 demucs 做 AI 分离，返回分离后的 WAV 字节。"""
    with tempfile.TemporaryDirectory() as td:
        inp = os.path.join(td, 'in.wav')
        with open(inp, 'wb') as f:
            f.write(wav_bytes)
        outdir = os.path.join(td, 'out')
        cmd = [sys.executable, '-m', 'demucs', '-n', 'htdemucs_ft',
               '--two-stems=vocals', '-o', outdir, inp]
        try:
            import torch
            if torch.cuda.is_available():
                cmd += ['--device', 'cuda']
        except Exception:
            pass  # 没有 torch 就走 CPU
        # 权重已缓存时跳过联网检查(HF 超时重试会浪费 150s+), 首次下载不受影响
        env = dict(os.environ)
        env['HF_HUB_OFFLINE'] = '1'
        proc = subprocess.run(cmd, capture_output=True, env=env)
        if proc.returncode != 0:
            err = proc.stderr.decode('utf-8', 'ignore')[-400:]
            raise RuntimeError('demucs 运行失败（是否已 pip install demucs？）: ' + err)
        target = 'vocals.wav' if mode != 'accompaniment' else 'no_vocals.wav'
        for root, _dirs, files in os.walk(outdir):
            if target in files:
                with open(os.path.join(root, target), 'rb') as f:
                    return f.read()
    raise RuntimeError('未找到 demucs 输出文件')


# ================================================================
# GAME 歌声 MIDI 提取
# ================================================================

def run_game_extract(audio_bytes, language='zh'):
    """
    使用 GAME ONNX 模型从歌声音频中提取 MIDI 音符。
    纯 numpy + onnxruntime 实现，见 backend/game_onnx.py。
    返回 JSON: { notes: [...], duration: float }
    """
    model_dir = os.path.join(os.path.dirname(__file__), 'models', 'game')
    config_path = os.path.join(model_dir, 'config.json')

    if not os.path.exists(config_path):
        raise RuntimeError('GAME 模型未找到，请在「模型管理」中一键下载模型')
    if not _has_module('onnxruntime'):
        raise RuntimeError('onnxruntime 未安装，请运行: py -m pip install onnxruntime numpy')

    # WAV 解码为 float32 单声道
    sr, waveform = _decode_wav(audio_bytes)

    sys.path.insert(0, os.path.dirname(__file__))
    from game_onnx import GameModel

    model = _get_game_model()
    # 采样率不一致时线性重采样到模型要求的采样率
    if sr != model.samplerate:
        waveform = _resample_linear(waveform, sr, model.samplerate)

    return model.extract(waveform, language=language)


# GAME 模型实例缓存（避免每次请求都重新加载 ONNX session）
_GAME_MODEL_CACHE = {'key': None, 'model': None}


def _get_game_model():
    """按模型目录 mtime 缓存 GameModel；模型更新后自动重载。"""
    model_dir = os.path.join(os.path.dirname(__file__), 'models', 'game')
    try:
        key = os.path.getmtime(os.path.join(model_dir, 'config.json'))
    except OSError:
        key = None
    if _GAME_MODEL_CACHE['model'] is not None and _GAME_MODEL_CACHE['key'] == key:
        return _GAME_MODEL_CACHE['model']

    sys.path.insert(0, os.path.dirname(__file__))
    from game_onnx import GameModel
    model = GameModel(model_dir)
    _GAME_MODEL_CACHE['key'] = key
    _GAME_MODEL_CACHE['model'] = model
    return model


def _decode_wav(data):
    """WAV 字节 → (采样率, float32 单声道 numpy 数组)，范围 [-1, 1]。"""
    import numpy as np
    with wave.open(io.BytesIO(data), 'rb') as w:
        nch = w.getnchannels()
        width = w.getsampwidth()
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    if width == 2:
        pcm = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    elif width == 1:
        pcm = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 4:
        pcm = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2147483648.0
    else:
        raise RuntimeError('不支持的 WAV 位深: %d' % width)
    if nch > 1:
        pcm = pcm.reshape(-1, nch).mean(axis=1)
    return sr, pcm.astype(np.float32)


def _cuda_available():
    """检测 CUDA GPU 是否可用（供 /health 与日志展示）。"""
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _separate_center_wav(data, mode='vocal'):
    """中置声道分离，返回单声道 16-bit WAV 字节。"""
    with wave.open(io.BytesIO(data), 'rb') as w:
        nch = w.getnchannels()
        width = w.getsampwidth()
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    if width != 2:
        raise ValueError('仅支持 16-bit PCM WAV')
    pcm = separate_center(raw, width, nch, mode)
    out = io.BytesIO()
    with wave.open(out, 'wb') as w2:
        w2.setnchannels(1)
        w2.setsampwidth(2)
        w2.setframerate(sr)
        w2.writeframes(pcm)
    return out.getvalue()


def run_transcribe(audio_bytes, separate='demucs', mode='vocal',
                   engine='game', language='zh', range_mode='auto',
                   min_duration=0.08, confidence=0.0, with_musicxml=False):
    """全链路转录：分离 -> GAME 歌声转录 -> music21 后处理。

    这是「准确度优先」的核心链路，一次调用完成：
      1. 可选 Demucs(htdemucs_ft) / center 人声分离
      2. GAME 神经网络歌声转录（原始 MIDI 音符）
      3. music21 专业后处理（短音符/音域/八度纠错/节拍/调号/和弦）
    返回: {notes, duration, engine, separate, tempo, key, chords, musicXml}
    """
    import postprocess as pp

    # 1. 分离（默认 demucs，不可用时降级 center）
    wav = audio_bytes
    if separate == 'demucs':
        if _has_demucs():
            wav = run_demucs(wav, mode)
        else:
            separate = 'center'
    if separate == 'center':
        wav = _separate_center_wav(wav, mode)

    # 2. GAME 转录
    result = run_game_extract(wav, language=language)
    notes = result.get('notes', [])
    duration = result.get('duration', 0.0)

    # 3. music21 后处理
    cleaned, meta = pp.postprocess(
        notes, mode=range_mode, min_duration=min_duration, confidence=confidence)

    out = {
        'notes': cleaned,
        'duration': duration,
        'engine': 'game+music21',
        'separate': separate,
        'tempo': meta.get('tempo', 120),
        'key': meta.get('key', 'C'),
        'chords': meta.get('chords', []),
        'noteCount': meta.get('noteCount', len(cleaned)),
        'filtered': len(notes) - len(cleaned),
    }
    if with_musicxml:
        out['musicXml'] = pp.to_musicxml(cleaned, out['tempo'], out['key'])
    return out


def _resample_linear(x, sr_from, sr_to):
    """线性插值重采样（够用且无需 scipy）。"""
    import numpy as np
    if sr_from == sr_to or x.size == 0:
        return x
    n_to = int(round(x.size * sr_to / float(sr_from)))
    if n_to <= 0:
        return x[:0]
    src_idx = np.linspace(0.0, x.size - 1, n_to)
    i0 = np.floor(src_idx).astype(np.int64)
    i1 = np.minimum(i0 + 1, x.size - 1)
    frac = (src_idx - i0).astype(np.float32)
    return (x[i0] * (1.0 - frac) + x[i1] * frac).astype(np.float32)


# ================================================================
# HOMR 乐谱图片识别
# ================================================================

def run_homr_recognize(image_bytes):
    """
    使用 HOMR 从乐谱图片中识别音符。
    返回 JSON: { notes: [...], key, timeSignature, tempo }
    """
    if not _has_homr():
        raise RuntimeError(
            'HOMR 未安装。请参考 https://github.com/liebharc/homr 安装。\n'
            'pip install homr[cpu]'
        )

    with tempfile.TemporaryDirectory() as td:
        # 写入临时图片文件
        img_path = os.path.join(td, 'input.png')
        with open(img_path, 'wb') as f:
            f.write(image_bytes)

        # 调用 HOMR 进行识别
        from homr import homr
        result = homr.process_image(img_path)

        # 解析 MusicXML 输出，提取音符
        # HOMR 输出 MusicXML 格式，这里解析为简化的音符列表
        notes = parse_musicxml_to_notes(result)

    return {
        'notes': notes,
        'duration': sum(n['endTime'] - n['startTime'] for n in notes),
        'key': 'C',
        'timeSignature': {'numerator': 4, 'denominator': 4},
        'tempo': 120,
    }


def parse_musicxml_to_notes(musicxml_or_result):
    """将 HOMR 输出的 MusicXML 解析为音符列表"""
    # 如果 HOMR 直接返回结构化数据
    if isinstance(musicxml_or_result, list):
        return musicxml_or_result

    # 如果返回 MusicXML 字符串，需要解析
    # 这里提供框架，实际解析逻辑根据 HOMR 版本调整
    notes = []
    # TODO: 根据 MusicXML 格式解析音符
    # 参考 https://www.w3.org/2021/06/musicxml40/
    return notes


# ================================================================
# HTTP 处理器
# ================================================================

class Handler(BaseHTTPRequestHandler):
    server_version = 'StarScore/2.0'

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        # 前端需要读取合成告警计数，跨源下必须显式暴露
        self.send_header('Access-Control-Expose-Headers', 'X-Synth-Warnings')

    def _send(self, code, body, ctype, extra_headers=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self._cors()
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, str(v))
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'),
                   'application/json; charset=utf-8')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        # === 健康检查 ===
        if path == '/health':
            info = {
                'ok': True,
                'service': 'star-score-backend',
                'version': '2.0',
                'modules': {
                    'audioop': HAS_AUDIOOP,
                    'demucs': _has_demucs(),
                    'game': _has_game(),
                    'homr': _has_homr(),
                    'music21': _has_module('music21'),
                    'torch': _has_module('torch'),
                },
                'cuda': _cuda_available(),
            }
            self._send_json(200, info)
            return

        # === GAME 健康检查 ===
        if path == '/api/game/health':
            self._send_json(200, {'ok': _has_game(), 'available': _has_game()})
            return

        # === HOMR 健康检查 ===
        if path == '/api/homr/health':
            self._send_json(200, {'ok': _has_homr(), 'available': _has_homr()})
            return

        # === 模型列表 ===
        if path == '/api/models/list':
            self._handle_models_list()
            return

        # === 模型下载进度 ===
        if path == '/api/models/status':
            qs = parse_qs(urlparse(self.path).query)
            model_id = (qs.get('modelId', [''])[0] or '').strip()
            if not model_id:
                self._send_json(200, {'states': _DOWNLOAD_STATE})
            else:
                self._send_json(200, _get_download_state(model_id))
            return

        # === 工程状态 ===
        if path == '/api/project/current':
            self._handle_project_current()
            return
        if path == '/api/project/list':
            self._handle_project_list()
            return

        # === 渲染产物下载 ===
        if path == '/api/render/download':
            self._handle_render_download()
            return

        # === 素材缓存下载（内容寻址；供前端刷新后恢复素材） ===
        if path.startswith('/api/slice/cache/'):
            self._handle_slice_cache_get(path[len('/api/slice/cache/'):])
            return

        # === 后台任务 ===
        if path == '/api/jobs':
            self._send_json(200, {'jobs': JOB_MANAGER.list()})
            return
        if path.startswith('/api/jobs/'):
            parts = [part for part in path.split('/') if part]
            if len(parts) == 3:
                self._handle_job_status(parts[2])
                return
            if len(parts) == 4 and parts[3] == 'download':
                self._handle_job_download(parts[2])
                return

        self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        path = urlparse(self.path).path

        # === 人声/伴奏分离 ===
        if path == '/separate':
            self._handle_separate()
            return

        # === GAME 歌声提取 ===
        if path == '/api/game/extract':
            self._handle_game_extract()
            return

        # === 全链路转录（分离 -> GAME -> music21 后处理）===
        if path == '/api/transcribe':
            self._handle_transcribe()
            return

        # === 人力V：单样本循环合成 ===
        if path == '/api/synth/single-sample':
            self._handle_synth_single_sample()
            return

        # === 人力V：工程状态 ===
        if path == '/api/project/new':
            self._handle_project_new()
            return
        if path == '/api/slice/import':
            self._handle_slice_import()
            return
        if path == '/api/cache/clear':
            self._handle_cache_clear()
            return
        if path == '/api/bind':
            self._handle_bind()
            return
        if path == '/api/render':
            self._handle_render()
            return
        if path == '/api/project/save':
            self._handle_project_save()
            return
        if path == '/api/project/load':
            self._handle_project_load()
            return

        # === 后台任务 ===
        if path == '/api/jobs/synth/single-sample':
            self._handle_start_single_sample_job()
            return
        if path == '/api/jobs/render':
            self._handle_start_render_job()
            return
        if path.startswith('/api/jobs/') and path.endswith('/cancel'):
            parts = [part for part in path.split('/') if part]
            if len(parts) == 4:
                self._handle_job_cancel(parts[2])
                return

        # === AI：OpenAI 兼容音频转写 ===
        if path == '/api/ai/transcribe':
            self._handle_ai_transcribe()
            return
        if path == '/api/ai/generate-midi':
            self._handle_ai_generate_midi()
            return
        if path == '/api/ai/models':
            self._handle_ai_models()
            return

        # === HOMR 图片识别 ===
        if path == '/api/homr/recognize':
            self._handle_homr_recognize()
            return

        # === 模型下载 ===
        if path == '/api/models/download':
            self._handle_model_download()
            return

        # === 模型删除 ===
        if path == '/api/models/delete':
            self._handle_model_delete()
            return

        self._send_json(404, {'error': 'not found'})

    def _handle_separate(self):
        """处理人声/伴奏分离请求"""
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        mode = (qs.get('mode', ['vocal'])[0] or 'vocal').lower()
        method = (qs.get('method', ['center'])[0] or 'center').lower()
        if mode not in ('vocal', 'accompaniment'):
            mode = 'vocal'

        try:
            length = int(self.headers.get('Content-Length', '0'))
            data = self.rfile.read(length) if length > 0 else b''
            if not data:
                raise ValueError('请求体为空')

            if method == 'demucs':
                body = run_demucs(data, mode)
            else:
                with wave.open(io.BytesIO(data), 'rb') as w:
                    nch = w.getnchannels()
                    width = w.getsampwidth()
                    sr = w.getframerate()
                    n = w.getnframes()
                    raw = w.readframes(n)
                if width != 2:
                    raise ValueError('仅支持 16-bit PCM WAV')
                pcm = separate_center(raw, width, nch, mode)
                out = io.BytesIO()
                with wave.open(out, 'wb') as w2:
                    w2.setnchannels(1)
                    w2.setsampwidth(2)
                    w2.setframerate(sr)
                    w2.writeframes(pcm)
                body = out.getvalue()

            self._send(200, body, 'audio/wav')
        except Exception as exc:
            self._send_json(400, {'error': str(exc)})

    def _handle_game_extract(self):
        """处理 GAME 歌声 MIDI 提取请求"""
        try:
            content_type = self.headers.get('Content-Type', '')
            length = int(self.headers.get('Content-Length', '0'))
            data = self.rfile.read(length) if length > 0 else b''
            if not data:
                raise ValueError('请求体为空')

            # 解析 multipart/form-data
            audio_bytes, form_fields = self._parse_multipart(data, content_type)
            language = form_fields.get('language', 'zh')

            result = run_game_extract(audio_bytes, language=language)
            self._send_json(200, result)
        except Exception as exc:
            self._send_json(400, {'error': str(exc)})

    def _handle_transcribe(self):
        """处理全链路转录请求（分离 -> GAME -> music21 后处理）"""
        try:
            content_type = self.headers.get('Content-Type', '')
            length = int(self.headers.get('Content-Length', '0'))
            data = self.rfile.read(length) if length > 0 else b''
            if not data:
                raise ValueError('请求体为空')

            audio_bytes, fields = self._parse_multipart(data, content_type)
            separate = (fields.get('separate', 'demucs') or 'demucs').lower()
            mode = (fields.get('mode', 'vocal') or 'vocal').lower()
            engine = (fields.get('engine', 'game') or 'game').lower()
            language = fields.get('language', 'zh') or 'zh'
            range_mode = (fields.get('range', 'auto') or 'auto').lower()
            try:
                min_duration = float(fields.get('minDuration', '0.08'))
            except ValueError:
                min_duration = 0.08
            try:
                confidence = float(fields.get('confidence', '0'))
            except ValueError:
                confidence = 0.0
            with_musicxml = fields.get('musicXml', '0') in ('1', 'true', 'yes')

            if engine not in ('game',):
                raise ValueError('未知转录引擎: %s' % engine)
            if not _has_game():
                raise RuntimeError('GAME 模型未下载，请在「模型管理」中一键下载')

            result = run_transcribe(
                audio_bytes, separate=separate, mode=mode, engine=engine,
                language=language, range_mode=range_mode,
                min_duration=min_duration, confidence=confidence,
                with_musicxml=with_musicxml)
            self._send_json(200, result)
        except Exception as exc:
            self._send_json(400, {'error': str(exc)})

    def _handle_synth_single_sample(self):
        """人力V：单样本循环合成。

        multipart/form-data:
          - audio: 素材音频（WAV 字节）
          - notes: JSON 字符串 [{id,start,duration,pitch,velocity,enabled}]
          - params: 可选 JSON（min_ratio/max_ratio/strategy/crossfade_ms）
        返回: audio/wav（合成结果）
        """
        try:
            content_type = self.headers.get('Content-Type', '')
            length = int(self.headers.get('Content-Length', '0'))
            data = self.rfile.read(length) if length > 0 else b''
            if not data:
                raise ValueError('请求体为空')

            audio_bytes, fields = self._parse_multipart(data, content_type)
            if not audio_bytes:
                raise ValueError('缺少 audio 素材文件')
            notes_raw = fields.get('notes', '')
            if not notes_raw:
                raise ValueError('缺少 notes 字段')
            notes = json.loads(notes_raw)
            if not isinstance(notes, list):
                raise ValueError('notes 必须是数组')

            params = None
            if fields.get('params'):
                params = json.loads(fields['params'])

            # 解码素材 WAV -> float32 mono
            sr, waveform = _decode_wav(audio_bytes)
            if waveform.size == 0:
                raise ValueError('素材为空')

            out, report = synth_single_sample_adapter(waveform, sr, notes, params, state=app_state)
            wav_bytes = synth_service.encode_wav(out, synth_service.SAMPLE_RATE)

            # 合成报告：逐音符明细不便塞进 WAV 响应体，只把「有告警的音符数」
            # 通过响应头回传，前端据此在状态栏提示；明细仍留在服务端日志。
            warn_notes = sum(1 for r in report if r.get('warns'))
            self._send(200, wav_bytes, 'audio/wav', {
                'X-Synth-Warnings': warn_notes,
                'X-Synth-Notes': len(report),
            })
        except Exception as exc:
            self._send_json(400, {'error': str(exc)})

    def _job_response(self, job):
        data = job.to_dict()
        if job.status == 'succeeded':
            data['download_url'] = f'/api/jobs/{job.id}/download'
        return data

    def _handle_job_status(self, job_id):
        try:
            self._send_json(200, self._job_response(JOB_MANAGER.get(job_id)))
        except KeyError:
            self._send_json(404, {'error': '任务不存在'})

    def _handle_job_cancel(self, job_id):
        try:
            job = JOB_MANAGER.cancel(job_id)
            self._send_json(202, self._job_response(job))
        except KeyError:
            self._send_json(404, {'error': '任务不存在'})

    def _handle_job_download(self, job_id):
        try:
            job = JOB_MANAGER.get(job_id)
        except KeyError:
            self._send_json(404, {'error': '任务不存在'})
            return
        if job.status != 'succeeded' or job.output_path is None:
            self._send_json(409, {'error': '任务尚未完成'})
            return
        if not job.output_path.exists():
            self._send_json(404, {'error': '任务产物不存在'})
            return
        try:
            self._send(200, job.output_path.read_bytes(), 'audio/wav')
        except Exception as exc:
            self._send_json(500, {'error': f'读取任务产物失败: {exc}'})

    def _handle_start_single_sample_job(self):
        try:
            content_type = self.headers.get('Content-Type', '')
            length = int(self.headers.get('Content-Length', '0'))
            data = self.rfile.read(length) if length > 0 else b''
            if not data:
                raise ValueError('请求体为空')

            audio_bytes, fields = self._parse_multipart(data, content_type)
            if not audio_bytes:
                raise ValueError('缺少 audio 素材文件')
            notes_raw = fields.get('notes', '')
            if not notes_raw:
                raise ValueError('缺少 notes 字段')
            notes = json.loads(notes_raw)
            if not isinstance(notes, list):
                raise ValueError('notes 必须是数组')
            params = json.loads(fields['params']) if fields.get('params') else None

            job = JOB_MANAGER.submit(
                'single-sample',
                lambda record, cancel_event, progress: _run_single_sample_job(
                    record, cancel_event, progress, audio_bytes, notes, params
                ),
                suffix='.wav',
            )
            self._send_json(202, self._job_response(job))
        except Exception as exc:
            self._send_json(400, {'error': str(exc)})

    def _handle_start_render_job(self):
        if app_state.project is None:
            self._send_json(400, {'detail': '请先创建工程'})
            return
        if not app_state.project.notes:
            self._send_json(400, {'detail': '请先保存 MIDI 音符'})
            return
        try:
            project_snapshot = copy.deepcopy(app_state.project)
            library_snapshot = copy.deepcopy(app_state.slice_library)
            job = JOB_MANAGER.submit(
                'backend-render',
                lambda record, cancel_event, progress: _run_render_job(
                    record, cancel_event, progress, project_snapshot, library_snapshot
                ),
                suffix='.wav',
            )
            self._send_json(202, self._job_response(job))
        except Exception as exc:
            self._send_json(500, {'detail': f'创建任务失败: {type(exc).__name__}: {exc}'})

    def _handle_ai_transcribe(self):
        try:
            content_type = self.headers.get('Content-Type', '')
            length = int(self.headers.get('Content-Length', '0'))
            data = self.rfile.read(length) if length > 0 else b''
            if not data:
                raise ValueError('请求体为空')
            audio_bytes, fields = self._parse_multipart(data, content_type)
            if not audio_bytes:
                raise ValueError('缺少音频文件')
            result = transcribe_audio(audio_bytes, {
                'base_url': fields.get('base_url', ''),
                'api_key': fields.get('api_key', ''),
                'model': fields.get('model', 'whisper-1'),
                'language': fields.get('language', ''),
                'prompt': fields.get('prompt', ''),
                'word_timestamps': fields.get('word_timestamps', 'true').lower()
                not in ('0', 'false', 'no'),
            })
            self._send_json(200, result)
        except Exception as exc:
            self._send_json(400, {'error': str(exc)})

    def _handle_ai_generate_midi(self):
        try:
            body = self._read_json_body()
            result = generate_midi_plan(body)
            self._send_json(200, result)
        except Exception as exc:
            self._send_json(400, {'error': str(exc)})

    def _handle_ai_models(self):
        try:
            body = self._read_json_body()
            result = list_models(body)
            self._send_json(200, result)
        except Exception as exc:
            self._send_json(400, {'error': str(exc)})

    def _handle_project_new(self):
        """POST /api/project/new?name=xxx"""
        query = parse_qs(urlparse(self.path).query)
        name = (query.get('name') or ['untitled'])[0]
        app_state.project = Project.new(name)
        app_state.slice_library = SliceLibrary()
        app_state.bind_warnings = []
        app_state.render_warnings = []
        app_state.last_render_wav = None
        self._send_json(200, {"ok": True, "project": app_state.project.to_dict()})

    def _handle_project_current(self):
        """GET /api/project/current"""
        if app_state.project is None:
            self._send_json(404, {"detail": "未加载工程"})
            return
        self._send_json(200, app_state.project.to_dict())

    def _handle_slice_import(self):
        """POST /api/slice/import (multipart: file)"""
        if app_state.project is None:
            app_state.project = Project.new("__draft__")  # 懒建草稿工程（不清空已有 slice_library）
        content_type = self.headers.get('Content-Type', '')
        length = int(self.headers.get('Content-Length', '0'))
        data = self.rfile.read(length) if length > 0 else b''
        audio_bytes, fields = self._parse_multipart(data, content_type)
        if not audio_bytes:
            self._send_json(400, {"detail": "文件为空"})
            return
        filename = fields.get('filename', 'upload.wav') if isinstance(fields, dict) else 'upload.wav'
        suffix = Path(filename).suffix or ".wav"
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name
            item = app_state.slice_library.import_audio(tmp_path)
        except Exception as e:
            self._send_json(400, {"detail": f"导入失败: {type(e).__name__}: {e}"})
            return
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
        sample = SliceSample(
            slice_hash=item.slice_hash,
            original_file=filename,
            chroma_fingerprint=item.chroma_fingerprint,
            avg_f0_hz=item.avg_f0_hz,
            duration_sec=item.duration_sec,
            start_core_sec=item.start_core_sec,
            end_core_sec=item.end_core_sec,
        )
        existing = {s.slice_hash for s in app_state.project.global_samples}
        if item.slice_hash not in existing:
            app_state.project.global_samples.append(sample)
        # 素材落盘缓存（内容寻址）
        try:
            cache_slice_to_disk(item, SLICE_CACHE_DIR)
        except Exception as e:
            # 缓存失败不阻断导入；仅记录
            print(f"[cache] 写盘失败: {type(e).__name__}: {e}")
        self._send_json(200, {
            "ok": True,
            "slice_hash": item.slice_hash,
            "duration_sec": item.duration_sec,
            "start_core_sec": item.start_core_sec,
            "end_core_sec": item.end_core_sec,
            "avg_f0_hz": item.avg_f0_hz,
            "global_samples_count": len(app_state.project.global_samples),
        })

    def _handle_slice_cache_get(self, slice_hash):
        """GET /api/slice/cache/{hash} — 取回内容寻址缓存里的素材 WAV。

        前端刷新后据此恢复素材（音频体积大，不进 localStorage；
        后端在 /api/slice/import 时已按 hash 落盘到 slice_cache）。
        """
        h = (slice_hash or '').strip()
        if len(h) != 16 or any(c not in '0123456789abcdef' for c in h):
            self._send_json(400, {'error': 'hash 非法（应为 16 位小写 hex）'})
            return
        p = SLICE_CACHE_DIR / f"{h}.wav"
        if not p.exists():
            self._send_json(404, {'error': '缓存中无该素材'})
            return
        try:
            with open(p, 'rb') as f:
                data = f.read()
        except Exception as exc:
            self._send_json(500, {'error': f'读取缓存失败: {exc}'})
            return
        self._send(200, data, 'audio/wav')

    def _handle_cache_clear(self):
        """POST /api/cache/clear — 清空素材缓存（用户主动操作）"""
        if not SLICE_CACHE_DIR.exists():
            self._send_json(200, {"ok": True, "removed": 0})
            return
        n = 0
        for f in SLICE_CACHE_DIR.glob("*.wav"):
            try:
                f.unlink()
                n += 1
            except Exception:
                pass
        self._send_json(200, {"ok": True, "removed": n})

    def _read_json_body(self):
        """读取 JSON body（POST JSON 请求用）。"""
        import json
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        data = self.rfile.read(length)
        return json.loads(data.decode("utf-8"))

    def _handle_bind(self):
        """POST /api/bind"""
        if app_state.project is None:
            self._send_json(400, {"detail": "请先创建工程"})
            return
        if not app_state.project.global_samples:
            self._send_json(400, {"detail": "请先上传素材"})
            return
        if not app_state.project.notes:
            self._send_json(400, {"detail": "请先保存 MIDI 音符"})
            return
        try:
            from single_sample_binder import bind_all_notes
            _, warns = bind_all_notes(app_state.project)
        except Exception as e:
            self._send_json(400, {"detail": f"绑定失败: {type(e).__name__}: {e}"})
            return
        app_state.bind_warnings = [
            {"note_id": w.note_id, "kind": w.kind, "message": w.message, "level": w.level}
            for w in warns
        ]
        kinds = {}
        for w in app_state.bind_warnings:
            kinds[w["kind"]] = kinds.get(w["kind"], 0) + 1
        self._send_json(200, {
            "ok": True,
            "bound_notes": len(app_state.project.notes),
            "warnings_count": len(app_state.bind_warnings),
            "warning_kinds": kinds,
            "warnings": app_state.bind_warnings,
        })

    def _handle_render(self):
        """POST /api/render"""
        if app_state.project is None:
            self._send_json(400, {"detail": "请先创建工程"})
            return
        if not app_state.project.notes:
            self._send_json(400, {"detail": "请先保存 MIDI 音符"})
            return
        try:
            from render_engine import render_project_to_wav
            warns = render_project_to_wav(app_state.project, app_state.slice_library, str(RENDER_OUT))
        except Exception as e:
            self._send_json(500, {"detail": f"渲染失败: {type(e).__name__}: {e}"})
            return
        app_state.render_warnings = [
            {"note_id": w.note_id, "kind": w.kind, "message": w.message, "level": w.level}
            for w in warns
        ]
        app_state.last_render_wav = RENDER_OUT
        size = RENDER_OUT.stat().st_size if RENDER_OUT.exists() else 0
        self._send_json(200, {
            "ok": True,
            "wav_path": str(RENDER_OUT),
            "wav_size": size,
            "warnings_count": len(app_state.render_warnings),
            "warnings": app_state.render_warnings,
        })

    def _handle_render_download(self):
        """GET /api/render/download"""
        if app_state.last_render_wav is None or not app_state.last_render_wav.exists():
            self._send_json(404, {"detail": "尚无渲染产物"})
            return
        with open(app_state.last_render_wav, "rb") as f:
            data = f.read()
        self._send(200, data, 'audio/wav')

    def _handle_project_save(self):
        """POST /api/project/save  (JSON body)
        body: {name, midi_meta: {ppq, bpm, time_signature, key_signature?, track_index?},
               notes: [{startTick, durationTick, pitch, velocity, enabled}, ...]}
        """
        from vproj_schema import Note, SliceRef, velocity_to_db, make_note_id, save_project, Project
        body = self._read_json_body()
        name = body.get("name") or "untitled"
        midi_meta = body.get("midi_meta") or {}
        incoming = body.get("notes") or []

        ppq = int(midi_meta.get("ppq", 480))
        bpm = float(midi_meta.get("bpm", 120.0))
        ts = tuple(midi_meta.get("time_signature", [4, 4]))
        key_sig = str(midi_meta.get("key_signature", "C"))
        track_index = int(midi_meta.get("track_index", 0))

        # 创建或更新 project
        if app_state.project is None:
            app_state.project = Project.new(name, ppq=ppq, bpm=bpm,
                                            time_signature=ts, key_signature=key_sig,
                                            source_mode="single_sample_loop",
                                            long_note_default_strategy="loop")
        else:
            app_state.project.midi_config.ppq = ppq
            app_state.project.midi_config.bpm = bpm
            app_state.project.midi_config.time_signature = ts
            app_state.project.midi_config.key_signature = key_sig
            app_state.project.midi_config.track_index = track_index

        # 按 note_id 合并 slice_ref
        existing = {n.note_id: n for n in app_state.project.notes}
        merged = []
        for n in incoming:
            start_tick = int(n["startTick"])
            pitch = int(n["pitch"])
            dur_tick = int(n["durationTick"])
            vel = int(n.get("velocity", 100))
            nid = make_note_id(ppq, start_tick, pitch, dur_tick)
            old_ref = existing[nid].slice_ref if nid in existing else SliceRef(slice_hash="")
            merged.append(Note(
                note_id=nid, midi_pitch=pitch, start_tick=start_tick, duration_tick=dur_tick,
                velocity=vel, enabled=bool(n.get("enabled", True)),
                note_volume_db=velocity_to_db(vel), slice_ref=old_ref,
            ))
        app_state.project.notes = merged

        PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
        out_path = PROJECTS_DIR / f"{name}.vproj"
        app_state.project.project_meta.project_name = Path(out_path).stem  # 文件名单一信息源
        try:
            save_project(app_state.project, out_path)
        except Exception as e:
            self._send_json(500, {"detail": f"保存失败: {type(e).__name__}: {e}"})
            return
        self._send_json(200, {
            "ok": True, "path": str(out_path),
            "notes_count": len(merged),
            "bound_notes_count": sum(1 for n in merged if n.slice_ref.slice_hash),
        })

    def _handle_project_load(self):
        """POST /api/project/load  (JSON body: {name})"""
        from vproj_schema import load_project
        body = self._read_json_body()
        name = body.get("name") or ""
        if not name:
            self._send_json(400, {"detail": "缺少 name"})
            return
        path = PROJECTS_DIR / f"{name}.vproj"
        if not path.exists():
            self._send_json(404, {"detail": f"工程不存在: {name}"})
            return
        try:
            proj = load_project(path)
        except Exception as e:
            self._send_json(400, {"detail": f"加载失败: {type(e).__name__}: {e}"})
            return

        new_lib = SliceLibrary()
        warnings = []
        for s in proj.global_samples:
            item = load_slice_from_disk(s.slice_hash, SLICE_CACHE_DIR)
            if item is None:
                warnings.append({"slice_hash": s.slice_hash, "kind": "cache_missing",
                                 "message": f"素材 {s.original_file} 未在 cache 找到"})
                continue
            new_lib._items[s.slice_hash] = item

        app_state.project = proj
        app_state.slice_library = new_lib
        app_state.bind_warnings = []
        app_state.render_warnings = []
        app_state.last_render_wav = None

        self._send_json(200, {
            "ok": True, "name": name,
            "notes_count": len(proj.notes),
            "global_samples_count": len(proj.global_samples),
            "restored_slices": len(new_lib._items),
            "warnings": warnings,
            "project": proj.to_dict(),          # 完整工程 JSON（前端重绘卷帘用）
        })

    def _handle_project_list(self):
        """GET /api/project/list — 列出 projects/ 下所有 .vproj（轻版：name + mtime）"""
        if not PROJECTS_DIR.exists():
            self._send_json(200, {"projects": []})
            return
        items = []
        for f in PROJECTS_DIR.glob("*.vproj"):
            if f.stem.startswith("__"):
                continue  # 草稿工程不进列表
            try:
                mtime = f.stat().st_mtime
            except OSError:
                mtime = 0.0
            items.append({"name": f.stem, "mtime": mtime})
        items.sort(key=lambda x: x["mtime"], reverse=True)  # 最近修改在前
        self._send_json(200, {"projects": items})

    def _handle_homr_recognize(self):
        """处理 HOMR 乐谱图片识别请求"""
        try:
            content_type = self.headers.get('Content-Type', '')
            length = int(self.headers.get('Content-Length', '0'))
            data = self.rfile.read(length) if length > 0 else b''
            if not data:
                raise ValueError('请求体为空')

            image_bytes, _ = self._parse_multipart(data, content_type)
            result = run_homr_recognize(image_bytes)
            self._send_json(200, result)
        except Exception as exc:
            self._send_json(400, {'error': str(exc)})

    def _handle_model_download(self):
        """处理模型下载请求

        GAME 模型：启动后台线程下载+解压到 backend/models/game/，
        接口立即返回，前端轮询 /api/models/status 获取进度。
        """
        try:
            length = int(self.headers.get('Content-Length', '0'))
            data = self.rfile.read(length) if length > 0 else b''
            req = json.loads(data) if data else {}
            model_id = (req.get('modelId', '') or '').strip()
            model_id = GAME_ID_ALIASES.get(model_id, model_id)

            if model_id not in GAME_PACKAGES:
                raise ValueError(
                    '未知模型 ID: %s（支持: %s）' % (
                        model_id, ', '.join(GAME_PACKAGES)))

            cur = _get_download_state(model_id)
            if cur['status'] == 'downloading':
                self._send_json(200, {
                    'modelId': model_id,
                    'started': False,
                    'message': '已有下载任务进行中',
                    'state': cur,
                })
                return

            zip_name, total = GAME_PACKAGES[model_id]
            _set_download_state(model_id, status='downloading', progress=0.0,
                                message='准备下载...', downloadedBytes=0,
                                totalBytes=total)
            t = threading.Thread(target=_download_game_model,
                                 args=(model_id,), daemon=True)
            t.start()

            self._send_json(200, {
                'modelId': model_id,
                'started': True,
                'package': zip_name,
                'downloadUrl': GAME_RELEASE_BASE + zip_name,
                'targetDir': GAME_MODEL_DIR,
                'message': '下载已开始，请轮询 /api/models/status?modelId=%s' % model_id,
            })
        except Exception as exc:
            self._send_json(400, {'error': str(exc)})

    def _handle_model_delete(self):
        """处理模型删除请求"""
        try:
            length = int(self.headers.get('Content-Length', '0'))
            data = self.rfile.read(length) if length > 0 else b''
            req = json.loads(data) if data else {}
            model_id = req.get('modelId', '')

            if model_id == 'basic-pitch':
                model_dir = os.path.join(os.path.dirname(__file__), '..', 'public', 'models', 'basic-pitch')
            elif model_id.startswith('game'):
                model_dir = os.path.join(os.path.dirname(__file__), 'models', 'game')
            elif model_id == 'homr':
                model_dir = os.path.join(os.path.dirname(__file__), 'models', 'homr')
            else:
                model_dir = os.path.join(os.path.dirname(__file__), 'models', model_id)

            if os.path.isdir(model_dir):
                shutil.rmtree(model_dir)
                self._send_json(200, {'message': f'模型 {model_id} 已删除'})
            else:
                self._send_json(200, {'message': f'模型 {model_id} 不存在，无需删除'})
        except Exception as exc:
            self._send_json(400, {'error': str(exc)})

    def _handle_models_list(self):
        """返回所有模型的安装状态"""
        models_info = []

        # Basic Pitch
        bp_dir = os.path.join(os.path.dirname(__file__), '..', 'public', 'models', 'basic-pitch')
        models_info.append({
            'id': 'basic-pitch',
            'name': 'Basic Pitch',
            'installed': os.path.exists(os.path.join(bp_dir, 'model.json')),
            'requiresBackend': False,
            'size': '~900KB',
        })

        # GAME
        game_dir = os.path.join(os.path.dirname(__file__), 'models', 'game')
        models_info.append({
            'id': 'game',
            'name': 'GAME (small)',
            'installed': _has_game(),
            'requiresBackend': True,
            'size': '~50MB',
        })

        # HOMR
        models_info.append({
            'id': 'homr',
            'name': 'HOMR',
            'installed': _has_homr(),
            'requiresBackend': True,
            'size': '~30MB',
        })

        self._send_json(200, {'models': models_info})

    def _parse_multipart(self, body, content_type):
        """简单解析 multipart/form-data，返回 (文件字节, 字段字典)"""
        file_data = b''
        fields = {}

        if 'multipart/form-data' in content_type:
            boundary = content_type.split('boundary=')[1].encode() if 'boundary=' in content_type else b''
            if boundary:
                parts = body.split(b'--' + boundary)
                for part in parts:
                    if b'Content-Disposition' not in part:
                        continue
                    # 提取字段名
                    disp_line = [l for l in part.split(b'\r\n') if b'Content-Disposition' in l]
                    if not disp_line:
                        continue
                    disp = disp_line[0].decode('utf-8', 'ignore')
                    name_start = disp.find('name="')
                    name_end = disp.find('"', name_start + 6)
                    name = disp[name_start + 6:name_end] if name_start >= 0 else ''

                    if 'filename=' in disp:
                        # 文件部分
                        header_end = part.find(b'\r\n\r\n')
                        if header_end >= 0:
                            file_data = part[header_end + 4:].rstrip(b'\r\n')
                    else:
                        # 普通字段
                        header_end = part.find(b'\r\n\r\n')
                        if header_end >= 0:
                            value = part[header_end + 4:].rstrip(b'\r\n').decode('utf-8', 'ignore')
                            fields[name] = value
        else:
            file_data = body

        return file_data, fields

    def log_message(self, fmt, *args):
        sys.stderr.write('[星谱识音后端] ' + (fmt % args) + '\n')


def main():
    ap = argparse.ArgumentParser(description='星谱识音 多引擎后端')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=9874)
    args = ap.parse_args()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    base = 'http://%s:%d' % (args.host, args.port)
    print('=' * 50)
    print(' 星谱识音 多引擎后端已启动')
    print(' 地址: %s' % base)
    print(' 健康检查: %s/health' % base)
    print(' ---- 模块状态 ----')
    print(' 人声分离 (center):  可用')
    print(' 人声分离 (demucs):  %s' % ('可用' if _has_demucs() else '未安装（可选）'))
    print(' GAME 歌声提取:      %s' % ('可用' if _has_game() else '未安装（可选）'))
    print(' music21 后处理:     %s' % ('可用' if _has_module('music21') else '未安装（可选）'))
    print(' CUDA GPU:           %s' % ('可用' if _cuda_available() else '不可用（CPU 模式）'))
    print(' HOMR 图片识别:      %s' % ('可用' if _has_homr() else '未安装（可选）'))
    print(' ---- API 端点 ----')
    print(' POST /separate               人声/伴奏分离')
    print(' POST /api/game/extract       GAME 歌声 MIDI 提取')
    print(' POST /api/transcribe         全链路: 分离->GAME->music21 后处理')
    print(' POST /api/homr/recognize     HOMR 乐谱图片识别')
    print(' GET  /api/models/list         模型安装状态')
    print(' POST /api/models/download    下载模型')
    print(' POST /api/models/delete       删除模型')
    print(' POST /api/jobs/synth/single-sample  创建单样本合成任务')
    print(' POST /api/jobs/render        创建工程渲染任务')
    print(' GET  /api/jobs/<id>          查询任务状态与进度')
    print(' POST /api/jobs/<id>/cancel   取消任务')
    print(' GET  /api/jobs/<id>/download 下载任务产物')
    print(' 按 Ctrl+C 退出')
    print('=' * 50)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已退出')


if __name__ == '__main__':
    main()
