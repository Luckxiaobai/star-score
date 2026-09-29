"""
core/main.py
人力V鬼畜调音工作台 — FastAPI 后端入口
对应《核心契约 v0.3.1》2 节
用法：
  py core\main.py            # 跑自检
  py core\main.py --serve    # 启动 uvicorn 服务（默认 127.0.0.1:8120）
依赖：
  fastapi, uvicorn[standard], python-multipart, httpx（TestClient）
"""
from __future__ import annotations
import argparse
import logging
import os
import socket
import sys
import tempfile
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
from vproj_schema import (  # noqa: E402
    Project, SliceSample, VERSION, save_project, load_project,
)
from midi_doc import MidiDocument  # noqa: E402
from slice_lib import SliceLibrary  # noqa: E402
from single_sample_binder import bind_all_notes  # noqa: E402
from render_engine import render_project_to_wav  # noqa: E402
from audio_utils import TARGET_SR  # noqa: E402
log = logging.getLogger(__name__)
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8120
# ============================================================================
# 全局状态（阶段1单用户，不加锁）
# ============================================================================
class AppState:
    def __init__(self):
        self.project: Optional[Project] = None
        self.slice_library: SliceLibrary = SliceLibrary()
        self.bind_warnings: list = []
        self.render_warnings: list = []
        self.last_render_wav: Optional[Path] = None
        self.last_render_warnings_count: int = 0
state = AppState()
def _reset_state() -> None:
    state.project = None
    state.slice_library = SliceLibrary()
    state.bind_warnings = []
    state.render_warnings = []
    state.last_render_wav = None
    state.last_render_warnings_count = 0
# ============================================================================
# WebSocket 广播
# ============================================================================
class WSManager:
    def __init__(self):
        self.active: list = []
    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.append(ws)
    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.active:
            self.active.remove(ws)
    async def broadcast(self, msg: dict) -> None:
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)
ws_manager = WSManager()
# ============================================================================
# FastAPI app
# ============================================================================
app = FastAPI(title="HumanV Workbench", version=VERSION)
# ---- Health ----
@app.get("/api/health")
async def api_health():
    return {
        "status": "ok",
        "version": VERSION,
        "project_loaded": state.project is not None,
    }
# ---- 工程管理 ----
@app.post("/api/project/new")
async def api_project_new(name: str = "untitled"):
    _reset_state()
    state.project = Project.new(name)
    return {"ok": True, "project": state.project.to_dict()}
@app.get("/api/project/current")
async def api_project_current():
    if state.project is None:
        raise HTTPException(status_code=404, detail="未加载工程")
    return state.project.to_dict()
@app.post("/api/project/save")
async def api_project_save(path: str = Form(...)):
    if state.project is None:
        raise HTTPException(status_code=400, detail="未加载工程")
    try:
        save_project(state.project, path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存失败：{e}")
    return {"ok": True, "path": str(Path(path).resolve())}
@app.post("/api/project/load")
async def api_project_load(path: str = Form(...)):
    try:
        proj = load_project(path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"加载失败：{e}")
    _reset_state()
    state.project = proj
    return {"ok": True, "notes": len(proj.notes)}
# ---- MIDI ----
@app.post("/api/midi/import")
async def api_midi_import(
    file: UploadFile = File(...),
    track_index: int = Form(0),
):
    if state.project is None:
        raise HTTPException(status_code=400, detail="请先创建工程")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="文件为空")
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".mid", delete=False) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name
        doc = MidiDocument.load_midi(tmp_path, track_index=track_index)
        notes = doc.clean_midi(state.project.midi_config.clean_settings)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"MIDI 解析失败：{type(e).__name__}: {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
    state.project.notes = notes
    state.project.midi_config.ppq = doc.ppq
    state.project.midi_config.bpm = doc.bpm
    state.project.midi_config.time_signature = doc.time_signature
    state.project.midi_config.key_signature = doc.key_signature
    state.project.midi_config.track_index = track_index
    return {
        "ok": True,
        "ppq": doc.ppq,
        "bpm": doc.bpm,
        "time_signature": list(doc.time_signature),
        "key_signature": doc.key_signature,
        "raw_notes": len(doc.notes_raw),
        "cleaned_notes": len(notes),
        "notes": [n.to_dict() for n in notes],
    }
# ---- 音频素材 ----
@app.post("/api/slice/import")
async def api_slice_import(file: UploadFile = File(...)):
    if state.project is None:
        raise HTTPException(status_code=400, detail="请先创建工程")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="文件为空")
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name
        item = state.slice_library.import_audio(tmp_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"音频导入失败：{type(e).__name__}: {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
    sample = SliceSample(
        slice_hash=item.slice_hash,
        original_file=file.filename or item.original_file,
        chroma_fingerprint=item.chroma_fingerprint,
        avg_f0_hz=item.avg_f0_hz,
        duration_sec=item.duration_sec,
        start_core_sec=item.start_core_sec,
        end_core_sec=item.end_core_sec,
    )
    existing = {s.slice_hash for s in state.project.global_samples}
    if item.slice_hash not in existing:
        state.project.global_samples.append(sample)
    return {
        "ok": True,
        "slice_hash": item.slice_hash,
        "duration_sec": item.duration_sec,
        "start_core_sec": item.start_core_sec,
        "end_core_sec": item.end_core_sec,
        "avg_f0_hz": item.avg_f0_hz,
        "global_samples_count": len(state.project.global_samples),
    }
# ---- 单样本循环批量绑定 ----
@app.post("/api/bind")
async def api_bind():
    if state.project is None:
        raise HTTPException(status_code=400, detail="请先创建工程")
    if not state.project.global_samples:
        raise HTTPException(status_code=400, detail="请先上传音频素材")
    if not state.project.notes:
        raise HTTPException(status_code=400, detail="请先导入 MIDI")
    try:
        _, warns = bind_all_notes(state.project)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"绑定失败：{type(e).__name__}: {e}")
    state.bind_warnings = [
        {"note_id": w.note_id, "kind": w.kind, "message": w.message, "level": w.level}
        for w in warns
    ]
    kinds: dict = {}
    for w in state.bind_warnings:
        kinds[w["kind"]] = kinds.get(w["kind"], 0) + 1
    await ws_manager.broadcast({
        "type": "render_notify",
        "payload": {"event": "bind_complete", "warnings_count": len(state.bind_warnings)},
    })
    return {
        "ok": True,
        "bound_notes": len(state.project.notes),
        "warnings_count": len(state.bind_warnings),
        "warning_kinds": kinds,
        "warnings": state.bind_warnings,
    }
# ---- 整轨渲染 ----
@app.post("/api/render")
async def api_render():
    if state.project is None:
        raise HTTPException(status_code=400, detail="请先创建工程")
    if not state.project.notes:
        raise HTTPException(status_code=400, detail="请先导入 MIDI")
    out_path = Path(tempfile.gettempdir()) / f"humanv_render_{os.getpid()}.wav"
    try:
        warns = render_project_to_wav(
            state.project, state.slice_library, str(out_path)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"渲染失败：{type(e).__name__}: {e}")
    state.render_warnings = [
        {"note_id": w.note_id, "kind": w.kind, "message": w.message, "level": w.level}
        for w in warns
    ]
    state.last_render_wav = out_path
    state.last_render_warnings_count = len(state.render_warnings)
    await ws_manager.broadcast({
        "type": "render_notify",
        "payload": {
            "event": "render_complete",
            "wav": str(out_path),
            "warnings_count": state.last_render_warnings_count,
        },
    })
    size = out_path.stat().st_size if out_path.exists() else 0
    return {
        "ok": True,
        "wav_path": str(out_path),
        "wav_size": size,
        "warnings_count": state.last_render_warnings_count,
        "warnings": state.render_warnings,
    }
@app.get("/api/render/download")
async def api_render_download():
    if state.last_render_wav is None or not state.last_render_wav.exists():
        raise HTTPException(status_code=404, detail="尚无渲染产物")
    return FileResponse(
        str(state.last_render_wav),
        media_type="audio/wav",
        filename="render.wav",
    )
# ---- WebSocket ----
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws_manager.connect(ws)
    try:
        await ws.send_json({
            "type": "render_notify",
            "payload": {
                "event": "connected",
                "project_loaded": state.project is not None,
            },
        })
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "ping":
                await ws.send_json({
                    "type": "render_notify",
                    "payload": {"event": "pong"},
                })
            # 其他类型（playhead / note_select / mode_switch）阶段1不处理后端逻辑
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("WebSocket 异常：%s", e)
    finally:
        ws_manager.disconnect(ws)
# ============================================================================
# 静态资源挂载（必须放最后，避免覆盖 API 路由）
# ============================================================================
frontend_dir = _HERE.parent / "frontend"
if frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
else:
    @app.get("/")
    async def root_no_frontend():
        return {
            "message": "frontend/ 尚未创建；API 端点可用",
            "version": VERSION,
            "health": "/api/health",
        }
# ============================================================================
# 启动 uvicorn（带端口冲突检测）
# ============================================================================
def _serve(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> None:
    import uvicorn
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
        sock.close()
    except OSError:
        print(
            f"[ERROR] 端口 {port} 被占用，请关闭其他实例后重试",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"[main] 启动 {host}:{port} (version {VERSION})")
    uvicorn.run(app, host=host, port=port, log_level="info")
# ============================================================================
# 自检（py core\\main.py）
# ============================================================================
def _build_simple_midi(path: str) -> None:
    """3 音符 MIDI：C4 0-480, E4 480-960, G4 960-1440（各 0.5s @120BPM）"""
    import mido
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(120.0), time=0))
    track.append(mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0))
    track.append(mido.MetaMessage("key_signature", key="C", time=0))
    events = [
        (0, "on", 60, 100), (480, "off", 60, 0),
        (480, "on", 64, 100), (960, "off", 64, 0),
        (960, "on", 67, 100), (1440, "off", 67, 0),
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
def _self_test() -> None:
    import numpy as np
    import soundfile as sf
    from fastapi.testclient import TestClient
    logging.basicConfig(level=logging.WARNING, format="[%(levelname)s] %(message)s")
    print(f"[main] version = {VERSION}")
    _reset_state()
    client = TestClient(app)
    # ---- 1. health ----
    r = client.get("/api/health")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok"
    print(f"[ok] GET /api/health: status=ok, version={r.json()['version']}")
    # ---- 2. 创建工程 ----
    r = client.post("/api/project/new", params={"name": "selftest"})
    assert r.status_code == 200, r.text
    assert r.json()["ok"]
    print("[ok] POST /api/project/new: 工程创建成功")
    # ---- 3. 上传 MIDI ----
    with tempfile.TemporaryDirectory() as tmp:
        mid_path = Path(tmp) / "selftest.mid"
        _build_simple_midi(str(mid_path))
        with open(mid_path, "rb") as f:
            r = client.post(
                "/api/midi/import",
                files={"file": ("selftest.mid", f, "audio/midi")},
                data={"track_index": "0"},
            )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["cleaned_notes"] == 3, f"cleaned_notes={data['cleaned_notes']}"
        assert data["ppq"] == 480
        assert abs(data["bpm"] - 120.0) < 0.01
        print(f"[ok] POST /api/midi/import: raw={data['raw_notes']}, "
              f"cleaned={data['cleaned_notes']}, ppq={data['ppq']}, bpm={data['bpm']:.1f}")
    # ---- 4. 上传音频素材 ----
    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "sine440.wav"
        sr = TARGET_SR
        t = np.arange(int(sr * 0.5)) / sr
        y = (0.5 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)
        sf.write(str(wav_path), y, sr, subtype="PCM_16")
        with open(wav_path, "rb") as f:
            r = client.post(
                "/api/slice/import",
                files={"file": ("sine440.wav", f, "audio/wav")},
            )
        assert r.status_code == 200, r.text
        data = r.json()
        assert len(data["slice_hash"]) == 16
        assert abs(data["duration_sec"] - 0.5) < 0.01
        print(f"[ok] POST /api/slice/import: hash={data['slice_hash']}, "
              f"dur={data['duration_sec']:.3f}s, f0={data['avg_f0_hz']:.1f}Hz")
    # ---- 5. 绑定 ----
    r = client.post("/api/bind")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["bound_notes"] == 3
    print(f"[ok] POST /api/bind: 绑定 {data['bound_notes']} 个音符, "
          f"告警 {data['warnings_count']} 条 ({data['warning_kinds']})")
    # ---- 6. 渲染 ----
    r = client.post("/api/render")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["ok"] and data["wav_size"] > 1000
    print(f"[ok] POST /api/render: WAV {data['wav_size']} bytes, "
          f"告警 {data['warnings_count']} 条")
    # ---- 7. 下载 ----
    r = client.get("/api/render/download")
    assert r.status_code == 200
    assert len(r.content) > 1000
    # WAV header 前 12 字节：RIFF....WAVE
    assert r.content[:4] == b"RIFF"
    assert r.content[8:12] == b"WAVE"
    print(f"[ok] GET /api/render/download: {len(r.content)} bytes, RIFF/WAVE header 正确")
    # ---- 8. WebSocket ----
    with client.websocket_connect("/ws") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "render_notify"
        assert msg["payload"]["event"] == "connected"
        ws.send_json({"type": "ping"})
        msg = ws.receive_json()
        assert msg["payload"]["event"] == "pong"
    print("[ok] WebSocket: 连接 + ping/pong 往返正确")
    # ---- 9. 工程 JSON 快照 ----
    r = client.get("/api/project/current")
    assert r.status_code == 200
    proj = r.json()
    assert len(proj["notes"]) == 3
    assert proj["midi_config"]["ppq"] == 480
    print(f"[ok] GET /api/project/current: {len(proj['notes'])} notes, "
          f"ppq={proj['midi_config']['ppq']}")
    print("\n[main] ALL SELF-TESTS PASSED")
# ============================================================================
# 入口
# ============================================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true", help="启动 uvicorn 服务")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    if args.serve:
        _serve(args.host, args.port)
    else:
        _self_test()
