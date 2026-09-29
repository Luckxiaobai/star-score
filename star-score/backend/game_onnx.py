# -*- coding: utf-8 -*-
"""星谱识音 StarScore - GAME ONNX 纯推理实现

不依赖 PyTorch / lightning / 上游 lib & modules，只依赖：
  - numpy
  - onnxruntime
  - scipy（做高斯模糊解码；缺失时退化为纯 numpy 实现）

模型来自 openvpi/GAME 官方 release 的 *-onnx.zip，解压后目录结构：
  models/game/
    config.json
    encoder.onnx
    segmenter.onnx
    estimator.onnx
    dur2bd.onnx
    bd2dur.onnx

ONNX 变量契约见 https://github.com/openvpi/GAME/blob/main/ONNX.md
"""

import json
import os

import numpy as np

# ----------------------------------------------------------------
# 模型文件清单与配置
# ----------------------------------------------------------------

REQUIRED_FILES = (
    'config.json',
    'encoder.onnx',
    'segmenter.onnx',
    'estimator.onnx',
)

OPTIONAL_FILES = (
    'dur2bd.onnx',
    'bd2dur.onnx',
)


class GameModel:
    """加载并持有一组 GAME ONNX session，提供 extract() 推理入口。"""

    def __init__(self, model_dir: str):
        self.model_dir = model_dir
        self.config = self._load_config(model_dir)
        self.samplerate = int(self.config.get('samplerate', 44100))
        self.timestep = float(self.config.get('timestep', 0.01))
        self.languages = self.config.get('languages') or None
        self.use_loop = bool(self.config.get('loop', True))
        self.embedding_dim = int(self.config.get('embedding_dim', 256))

        import onnxruntime as ort

        # 静默日志; 有 CUDA 用 GPU(onnxruntime-gpu), 否则 CPU
        so = ort.SessionOptions()
        so.log_severity_level = 3
        so.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 2)

        self._ort = ort
        self._so = so
        self._sessions = {}

    # ---------- 加载 ----------

    @staticmethod
    def _load_config(model_dir: str) -> dict:
        cfg_path = os.path.join(model_dir, 'config.json')
        with open(cfg_path, 'r', encoding='utf-8') as f:
            return json.load(f)

    def session(self, name: str):
        """按需加载并缓存 onnx session（首次推理才真正载入，加快健康检查）。"""
        if name in self._sessions:
            return self._sessions[name]
        path = os.path.join(self.model_dir, name + '.onnx')
        if not os.path.exists(path):
            raise RuntimeError('缺少模型文件: %s' % path)
        avail = self._ort.get_available_providers()
        providers = [p for p in ('CUDAExecutionProvider', 'CPUExecutionProvider')
                     if p in avail] or (avail or ['CPUExecutionProvider'])
        sess = self._ort.InferenceSession(
            path, sess_options=self._so, providers=providers
        )
        self._sessions[name] = sess
        return sess

    # ---------- 工具 ----------

    def _run(self, name, feed):
        """运行一个 session；自动裁剪 feed 到该模型实际声明的输入。"""
        sess = self.session(name)
        want = {i.name for i in sess.get_inputs()}
        sub = {k: v for k, v in feed.items() if k in want}
        return sess.run(None, sub)

    def language_id(self, lang: str) -> int:
        """把 'zh' / 'en' 等语言码映射成模型 config.json 里的整型 id。"""
        if not self.languages:
            return 0
        if not lang:
            return 0
        key = str(lang).strip().lower()
        # 允许直接传数字字符串
        if key.isdigit():
            return int(key)
        # 常见别名
        alias = {'cn': 'zh', 'cmn': 'zh', 'chs': 'zh', 'jp': 'ja', 'jpn': 'ja'}
        key = alias.get(key, key)
        return int(self.languages.get(key, 0) or 0)

    # ---------- 推理 ----------

    MAX_SEGMENT_SECONDS = 60.0       # 单段 GAME 推理的最大时长; 超过则分段, 防止 segmenter 内存爆炸
    SEGMENT_OVERLAP_SECONDS = 2.0    # 段间重叠, 给跨段音符足够的边界上下文

    def extract(self, waveform: np.ndarray, language: str = 'zh',
                boundary_threshold: float = 0.2,
                boundary_radius: int = 2,
                score_threshold: float = 0.2,
                n_steps: int = 8):
        """主入口: 自动判断是否需要分段, 长音频分段推理后合并, 返回全曲音符。

        :param waveform: 单声道 float32 波形, 采样率必须等于 config.samplerate
        :return: dict(notes=[...], duration=float, language=..., config=...)
        """
        wav = np.asarray(waveform, dtype=np.float32)
        if wav.ndim > 1:
            wav = wav.mean(axis=-1) if wav.shape[0] > wav.shape[-1] else wav.mean(axis=0)
        if wav.size == 0:
            raise RuntimeError('音频为空')

        # 整段归一化一次, 避免分段后各段音量不一致
        peak = float(np.max(np.abs(wav)))
        if peak > 1e-6:
            wav = wav / peak * 0.95

        duration_s = float(wav.shape[0]) / float(self.samplerate)

        if duration_s <= self.MAX_SEGMENT_SECONDS:
            return self._extract_segment(
                wav, language, boundary_threshold, boundary_radius,
                score_threshold, n_steps)

        # ---- 长音频: 分段推理 + 合并 ----
        seg_len = self.MAX_SEGMENT_SECONDS
        overlap = self.SEGMENT_OVERLAP_SECONDS
        step = seg_len - overlap
        seg_n = int(np.ceil(duration_s / step))
        seg_sr = int(seg_len * self.samplerate)
        step_sr = int(step * self.samplerate)
        cut_s = seg_len - overlap   # 除最后一段外, 每段丢弃尾部 overlap 秒, 由下一段覆盖

        merged = []
        for i in range(seg_n):
            start = i * step_sr
            end = min(start + seg_sr, wav.shape[0])
            seg = wav[start:end]
            res = self._extract_segment(
                seg, language, boundary_threshold, boundary_radius,
                score_threshold, n_steps)
            offset = i * step
            last = (i == seg_n - 1)
            for n in res['notes']:
                if not last and n['startTime'] >= cut_s:
                    continue
                merged.append({
                    'startTime': round(n['startTime'] + offset, 4),
                    'endTime': round(n['endTime'] + offset, 4),
                    'midi': n['midi'],
                    'confidence': n['confidence'],
                    'voiced': n['voiced'],
                })
        merged.sort(key=lambda x: x['startTime'])

        return {
            'notes': merged,
            'duration': duration_s,
            'frameCount': int(round(duration_s / self.timestep)),
            'language': language,
            'modelConfig': {
                'samplerate': self.samplerate,
                'timestep': self.timestep,
                'loop': self.use_loop,
            },
        }

    def _extract_segment(self, wav: np.ndarray, language: str = 'zh',
                         boundary_threshold: float = 0.2,
                         boundary_radius: int = 2,
                         score_threshold: float = 0.2,
                         n_steps: int = 8):
        """单段推理(输入为已归一化波形, 时长 <= MAX_SEGMENT_SECONDS)。"""
        duration_s = float(wav.shape[0]) / float(self.samplerate)

        # --- Encoder: 输入为原始波形 [B, L], 模型内部转 mel ---
        wav_in = wav[None, :].astype(np.float32)  # [B=1, L]
        duration_arr = np.array([duration_s], dtype=np.float32)
        enc_out = self._run('encoder', {
            'waveform': wav_in,
            'duration': duration_arr,
        })
        # 按名字取, 避免依赖输出顺序
        sess = self.session('encoder')
        names = [o.name for o in sess.get_outputs()]
        outs = dict(zip(names, enc_out))
        x_seg = outs.get('x_seg')
        x_est = outs.get('x_est')
        mask = outs.get('maskT')
        if x_seg is None or x_est is None:
            # 退化: 若只输出 2 个张量, 按顺序取
            vals = list(enc_out)
            x_seg, x_est = vals[0], vals[1]
        if mask is None:
            L = int(round(duration_s / self.timestep))
            T = int(np.asarray(x_seg).shape[1])
            mask = (np.arange(T)[None, :] < L).astype(bool)

        x_seg = np.asarray(x_seg, dtype=np.float32)
        x_est = np.asarray(x_est, dtype=np.float32)
        mask = np.asarray(mask).astype(bool)
        T = int(mask.shape[1])

        # --- Segmenter ---
        lang_id = self.language_id(language)
        language_arr = np.array([lang_id], dtype=np.int64)

        known_durations = np.array([duration_s], dtype=np.float32)  # [1, 1]
        known_boundaries = _durations_to_boundaries(
            known_durations, T, self.timestep
        ) & mask

        if self.use_loop:
            ts = np.linspace(0.0, 1.0, n_steps + 1)[:-1].astype(np.float32)
            prev = known_boundaries
            for t_val in ts:
                t_arr = np.array([t_val], dtype=np.float32)
                out = self._run('segmenter', {
                    'x_seg': x_seg,
                    'known_boundaries': known_boundaries,
                    'prev_boundaries': prev,
                    'maskT': mask,
                    'language': language_arr,
                    't': t_arr,
                    'threshold': np.array(boundary_threshold, dtype=np.float32),
                    'radius': np.array(boundary_radius, dtype=np.int64),
                })
                boundaries = _pick_boundaries(out, prev)
                prev = boundaries
            boundaries = prev
        else:
            out = self._run('segmenter', {
                'x_seg': x_seg,
                'known_boundaries': known_boundaries,
                'maskT': mask,
                'language': language_arr,
                'threshold': np.array(boundary_threshold, dtype=np.float32),
                'radius': np.array(boundary_radius, dtype=np.int64),
            })
            boundaries = _pick_boundaries(out, known_boundaries)

        boundaries = np.asarray(boundaries).astype(bool) & mask

        # --- Estimator: 输入需要 maskN; 输出 presence / scores, 时长由边界计算 ---
        regions = _boundaries_to_regions(boundaries)
        max_n = int(regions.max())
        if max_n < 1:
            max_n = 1
        mask_n = np.ones((1, max_n), dtype=bool)
        est_out = self._run('estimator', {
            'x_est': x_est,
            'boundaries': boundaries,
            'maskT': mask,
            'maskN': mask_n,
            'threshold': np.array(score_threshold, dtype=np.float32),
        })
        est_sess = self.session('estimator')
        e_names = [o.name for o in est_sess.get_outputs()]
        e_outs = dict(zip(e_names, est_out))
        presence = e_outs.get('presence')
        scores = e_outs.get('scores')
        if presence is None or scores is None:
            # 兜底: 按形状猜
            presence, _dur_guess, scores = _pick_estimator(
                est_out, boundaries, self.timestep, mask)
        presence = np.asarray(presence).astype(bool)
        scores = np.asarray(scores, dtype=np.float32)
        if presence.ndim == 1:
            presence = presence[None, :]
        if scores.ndim == 1:
            scores = scores[None, :]
        # 时长由边界区域帧数计算（模型不输出 durations）
        durations = _regions_to_durations(regions, max_n) * self.timestep

        notes = _assemble_notes(durations, presence, scores, mask)
        return {
            'notes': notes,
            'duration': duration_s,
            'frameCount': int(T),
            'language': language,
            'modelConfig': {
                'samplerate': self.samplerate,
                'timestep': self.timestep,
                'loop': self.use_loop,
            },
        }


# ----------------------------------------------------------------
# 数值工具（与上游 modules/functional、modules/decoding 语义对齐）
# ----------------------------------------------------------------

def _durations_to_boundaries(durations, length, timestep):
    """秒 → 帧级边界布尔矩阵 [B, T]（对齐上游 format_boundaries）。"""
    d = np.asarray(durations, dtype=np.float32)
    if d.ndim == 1:
        d = d[None, :]
    B = d.shape[0]
    out = np.zeros((B, length), dtype=bool)
    for b in range(B):
        acc = 0.0
        out[b, 0] = True
        for v in d[b]:
            acc += float(v)
            idx = int(round(acc / timestep))
            if 0 <= idx < length:
                out[b, idx] = True
    return out


def _boundaries_to_regions(boundaries):
    """边界布尔 → 每个帧所属的音符序号 [B, T]（1 起始，0 为无）。"""
    b = np.asarray(boundaries).astype(bool)
    if b.ndim == 1:
        b = b[None, :]
    B, T = b.shape
    regions = np.zeros((B, T), dtype=np.int64)
    for i in range(B):
        cur = 0
        for t in range(T):
            if b[i, t]:
                cur += 1
            regions[i, t] = cur
    return regions


def _pick_boundaries(outs, fallback):
    """从 segmenter 输出里挑出边界矩阵（可能叫 boundaries / out / 第一个张量）。"""
    arrs = [np.asarray(o) for o in outs]
    for a in arrs:
        if a.ndim == 2 and a.dtype == bool:
            return a
    for a in arrs:
        if a.ndim == 2 and a.shape == np.asarray(fallback).shape:
            return a.astype(bool)
    return arrs[0].astype(bool)


def _pick_estimator(outs, boundaries, timestep, mask):
    """从 estimator 输出里解析 (durations, presence, scores)，容忍输出顺序差异。"""
    arrs = [np.asarray(o) for o in outs]
    durations = presence = scores = None

    for a in arrs:
        if a.dtype == bool and a.ndim == 2 and presence is None:
            presence = a
        elif a.dtype == np.float32 or a.dtype == np.float64:
            if scores is None:
                scores = a.astype(np.float32)
            elif durations is None:
                durations = a.astype(np.float32)
        elif np.issubdtype(a.dtype, np.floating):
            if scores is None:
                scores = a.astype(np.float32)
            elif durations is None:
                durations = a.astype(np.float32)

    regions = _boundaries_to_regions(boundaries & mask)
    max_n = int(regions.max())

    if durations is None:
        durations = _regions_to_durations(regions, max_n) * timestep
    if presence is None:
        presence = np.ones_like(durations, dtype=bool)
    if scores is None:
        scores = np.zeros_like(durations, dtype=np.float32)

    return durations, presence.astype(bool), scores


def _regions_to_durations(regions, max_n):
    """每个音符持续的帧数 → [B, N]（未乘 timestep）。"""
    B, T = regions.shape
    out = np.zeros((B, max_n), dtype=np.float32)
    for b in range(B):
        counts = np.bincount(regions[b], minlength=max_n + 1)
        out[b, :max_n] = counts[1:max_n + 1]
    return out


def _assemble_notes(durations, presence, scores, mask):
    """把 [B, N] 的时长/存在/音高拼成音符列表（只取 batch 0）。"""
    d = np.asarray(durations)
    if d.ndim == 1:
        d = d[None, :]
    p = np.asarray(presence)
    if p.ndim == 1:
        p = p[None, :]
    s = np.asarray(scores)
    if s.ndim == 1:
        s = s[None, :]

    d0 = d[0]
    p0 = p[0]
    s0 = s[0]
    n = min(d0.shape[0], p0.shape[0], s0.shape[0])

    notes = []
    t = 0.0
    for i in range(n):
        dur = float(d0[i])
        if dur <= 0:
            continue
        start = t
        t += dur
        notes.append({
            'startTime': round(start, 4),
            'endTime': round(t, 4),
            'midi': round(float(s0[i]), 3),
            'confidence': 0.9 if bool(p0[i]) else 0.0,
            'voiced': bool(p0[i]),
        })
    return notes