"""
backend/test_slice_cache.py — 第二批验收
直接测 cache_slice_to_disk / load_slice_from_disk，不经 HTTP。
"""
import sys, tempfile
from pathlib import Path
import numpy as np

_CORE = Path(__file__).resolve().parent.parent.parent / "human_vocal_workbench" / "core"
if str(_CORE) not in sys.path:
    sys.path.insert(0, str(_CORE))

from slice_lib import SliceLibrary, cache_slice_to_disk, load_slice_from_disk
from audio_utils import TARGET_SR

def _self_test():
    with tempfile.TemporaryDirectory() as tmp:
        cache_dir = Path(tmp) / "slice_cache"
        sr = TARGET_SR
        t = np.arange(int(sr * 0.5)) / sr
        y = (0.5 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)

        lib = SliceLibrary()
        item = lib.import_from_array(y, sr, normalize=True)
        print(f"[ok] import_from_array: hash={item.slice_hash}")

        # 1. 写盘
        p = cache_slice_to_disk(item, cache_dir)
        assert p.exists(), f"cache 文件不存在: {p}"
        assert p.name == f"{item.slice_hash}.wav"
        print(f"[ok] cache_slice_to_disk: {p.name}")

        # 2. 幂等
        p2 = cache_slice_to_disk(item, cache_dir)
        assert p2 == p
        n_files = len(list(cache_dir.glob("*.wav")))
        assert n_files == 1, f"幂等失败，文件数={n_files}"
        print(f"[ok] 幂等：重复写只 1 份")

        # 3. 读回
        loaded = load_slice_from_disk(item.slice_hash, cache_dir)
        assert loaded is not None
        assert loaded.slice_hash == item.slice_hash
        assert abs(loaded.duration_sec - item.duration_sec) < 1e-3
        assert abs(loaded.start_core_sec - item.start_core_sec) < 0.01
        assert abs(loaded.end_core_sec - item.end_core_sec) < 0.01
        assert abs(loaded.avg_f0_hz - item.avg_f0_hz) < 1.0
        print(f"[ok] load_slice_from_disk: dur={loaded.duration_sec:.3f}s, "
              f"core=[{loaded.start_core_sec:.3f},{loaded.end_core_sec:.3f}], "
              f"f0={loaded.avg_f0_hz:.1f}Hz")

        # 4. 不存在 hash 返回 None
        none_item = load_slice_from_disk("0" * 16, cache_dir)
        assert none_item is None
        print(f"[ok] 不存在 hash → None")

    print("\n[test_slice_cache] ALL PASSED")

if __name__ == "__main__":
    _self_test()
