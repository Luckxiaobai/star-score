"""
E2E 验收：模拟前端全流程（先素材→后MIDI→保存→加载→渲染）
运行：py backend/verify/test_e2e.py（需 server 已启动，端口 9874）
"""
import json
import subprocess
import sys
from pathlib import Path
import urllib.request

BACKEND = "http://127.0.0.1:9874"


def _post_json(path, body):
    req = urllib.request.Request(
        BACKEND + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def _post_multipart(path, file_path):
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", BACKEND + path,
         "-F", f"file=@{file_path}"],
        capture_output=True, text=True,
    )
    if not r.stdout:
        raise RuntimeError(f"curl 无输出，stderr={r.stderr}")
    return json.loads(r.stdout)


def _get_json(path):
    with urllib.request.urlopen(BACKEND + path) as r:
        return json.loads(r.read())


def main():
    test_wav = Path(__file__).parent / "test_sine.wav"
    if not test_wav.exists():
        try:
            import numpy as np
            import soundfile as sf
        except ImportError:
            print("需要 numpy + soundfile 生成测试音频")
            sys.exit(1)
        sr = 44100
        t = np.arange(int(sr * 0.5)) / sr
        y = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        sf.write(str(test_wav), y, sr, subtype="PCM_16")
        print(f"已生成测试音频: {test_wav}")

    print("[步 1] slice/import（后端无工程 → 应懒建 __draft__）")
    r1 = _post_multipart("/api/slice/import", str(test_wav))
    assert r1.get("ok"), f"slice/import 失败: {r1}"
    assert len(r1["slice_hash"]) == 16
    print(f"      slice_hash={r1['slice_hash']}, global_samples={r1['global_samples_count']}")

    print("[步 2] project/save（工程名 e2e_verify，写入 1 个音符）")
    body = {
        "name": "e2e_verify",
        "midi_meta": {"ppq": 480, "bpm": 120, "time_signature": [4, 4]},
        "notes": [{"startTick": 0, "durationTick": 480, "pitch": 69,
                   "velocity": 100, "enabled": True}],
    }
    r2 = _post_json("/api/project/save", body)
    assert r2.get("ok"), f"save 失败: {r2}"
    assert r2["notes_count"] == 1
    print(f"      notes={r2['notes_count']}, bound={r2['bound_notes_count']}")

    print("[步 2b] save __draft__（落盘草稿，供步 6 验证过滤生效）")
    r2b = _post_json("/api/project/save", {**body, "name": "__draft__"})
    assert r2b.get("ok"), f"save __draft__ 失败: {r2b}"
    print(f"      ok={r2b['ok']}")

    print("[步 3] project/save 再存一次")
    r3 = _post_json("/api/project/save", body)
    print(f"      notes={r3['notes_count']}, bound={r3['bound_notes_count']}")

    print("[步 4] bind（自动绑定）")
    r4 = _post_json("/api/bind", {})
    assert r4.get("ok"), f"bind 失败: {r4}"
    print(f"      bound_notes={r4['bound_notes']}, warnings={r4['warnings_count']}")

    print("[步 5] project/save 三次（写 slice_ref 落盘）")
    r5 = _post_json("/api/project/save", body)
    assert r5["bound_notes_count"] == 1, f"应绑定 1，实际 {r5['bound_notes_count']}"
    print(f"      bound_notes_count={r5['bound_notes_count']}")

    print("[步 6] project/list（应含 e2e_verify，不含 __draft__）")
    r6 = _get_json("/api/project/list")
    names = [p["name"] for p in r6["projects"]]
    assert "e2e_verify" in names, f"e2e_verify 不在列表: {names}"
    assert "__draft__" not in names, f"__draft__ 应被过滤: {names}"
    print(f"      projects={names}")

    print("[步 7] project/load（应含 project 字段 + restored_slices>=1）")
    r7 = _post_json("/api/project/load", {"name": "e2e_verify"})
    assert r7.get("ok"), f"load 失败: {r7}"
    assert "project" in r7, "load 应返回 project 字段"
    assert r7["restored_slices"] >= 1, f"restored_slices={r7['restored_slices']}"
    print(f"      notes={r7['notes_count']}, restored={r7['restored_slices']}")

    print("[步 8] render（用后端素材渲染）")
    r8 = _post_json("/api/render", {})
    assert r8.get("ok") and r8["wav_size"] > 1000
    print(f"      wav_size={r8['wav_size']}")

    print("[步 9] render/download")
    with urllib.request.urlopen(BACKEND + "/api/render/download") as r:
        data = r.read()
    assert data[:4] == b"RIFF" and data[8:12] == b"WAVE"
    print(f"      {len(data)} bytes, RIFF/WAVE ✓")

    print("\n[E2E] ALL PASSED")
    print("清理：手动删 %APPDATA%/human_vocal_workbench/projects/e2e_verify.vproj 与 __draft__.vproj")


if __name__ == "__main__":
    main()
