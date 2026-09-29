# -*- coding: utf-8 -*-
"""星谱识音 · 专业后处理模块

对识别引擎（GAME / Basic Pitch / YIN）输出的原始音符做清洗与乐理修正。
这是落谱类工具准确度优势的核心来源 —— AI 模型永远输出"草稿"，
真正决定谱面质量的是大量手写后处理规则：

  1. 短音符过滤     —— 泛音/噪声假音符大多只有几十毫秒，直接删
  2. 置信度过滤     —— 低置信度音符删除（可配置）
  3. 音域过滤       —— 硬阈值（人声 45-84 / 乐器 24-100）或动态音域
  4. 八度纠错       —— 先尝试 ±12/±24 挪回主体音域，救不回再删
  5. 节拍估计       —— 基于音符间隔中位数 + 倍频校正
  6. 调号估计       —— Krumhansl-Schmuckler 调性轮廓相关
  7. 和弦识别       —— 按小节音级匹配常见三和弦（C/Am/G7 等）
  8. MusicXML 生成  —— 供导出（依赖 music21，失败时降级为 None）

输入音符格式（与前端 DetectedNote 一致）：
  [{"startTime": 0.1, "endTime": 0.5, "midi": 60, "confidence": 0.9}, ...]
"""

import os
import tempfile
import statistics

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:  # pragma: no cover
    HAS_NUMPY = False

try:
    import music21  # noqa: F401
    HAS_MUSIC21 = True
except ImportError:
    HAS_MUSIC21 = False

# 人声主旋律常见音域（A2 ~ C6）
VOCAL_LO, VOCAL_HI = 45, 84
# 乐器/钢琴常见音域
INSTR_LO, INSTR_HI = 24, 100
# 短音符过滤阈值（秒）—— 0.08s 是稳妥经验值，可删掉大部分泛音假音符
DEFAULT_MIN_DURATION = 0.08
# 距离主体音域超过这个范围直接删除（不纠错）
RANGE_SLACK = 24

_PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# Krumhansl-Schmuckler 调性轮廓
_K_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_K_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def _duration(n):
    return max(0.0, n.get('endTime', 0) - n.get('startTime', 0))


def _midis(notes):
    return [float(n['midi']) for n in notes]


# ================================================================
# 1. 短音符过滤
# ================================================================

def filter_short(notes, min_duration=DEFAULT_MIN_DURATION):
    """删除时值过短的噪声音符（泛音/噪声假音符大多一闪而过）。"""
    return [n for n in notes if _duration(n) >= min_duration]


# ================================================================
# 2. 置信度过滤
# ================================================================

def filter_confidence(notes, threshold=0.0):
    """删除低置信度音符（threshold <= 0 表示不过滤）。"""
    if threshold <= 0:
        return notes
    return [n for n in notes if n.get('confidence', 1.0) >= threshold]


# ================================================================
# 3. 动态音域 / 八度纠错
# ================================================================

def dynamic_range(notes, span=24):
    """统计主体音域：以音高中位数为轴心 ± span 半音。

    中位数抗异常值（比 P15/P85 分位数稳健）——少数离谱高/低音
    不会把主体区间拉宽，从而能准确圈出"主流旋律音域"。
    """
    if not notes:
        return VOCAL_LO, VOCAL_HI
    mids = sorted(_midis(notes))
    median = mids[len(mids) // 2]
    return max(0, int(round(median)) - span), int(round(median)) + span


def octave_correct(notes, lo, hi, median):
    """八度纠错：对超出主体音域的音符尝试 ±12/±24 挪回，救不回则删除。

    很多时候不是该音符不存在，而是 AI 识别错八度（±12/±24 半音）。
    先修正而非直接删除，是商业扒谱软件的做法。
    候选优先落在主体音域内，其次允许 ±6 半音的容差。
    """
    out = []
    for n in notes:
        m = float(n['midi'])
        if lo <= m <= hi:
            out.append(n)
            continue
        best, best_d = None, None
        for cand in (m - 24, m - 12, m + 12, m + 24):
            if lo - 6 <= cand <= hi + 6:
                d = abs(cand - median)
                if best_d is None or d < best_d:
                    best, best_d = cand, d
        if best is not None:
            nn = dict(n)
            nn['midi'] = round(best)
            nn['octaveCorrected'] = round(m)
            out.append(nn)
    return out


def filter_range(notes, mode='auto', lo=None, hi=None):
    """音域过滤：先删离群太远的，再对剩余做八度纠错，纠不回才删。"""
    if not notes:
        return []
    if lo is None or hi is None:
        if mode == 'vocal':
            lo, hi = VOCAL_LO, VOCAL_HI
        elif mode == 'instrument':
            lo, hi = INSTR_LO, INSTR_HI
        else:
            lo, hi = dynamic_range(notes)

    # 第一步：距离主体音域太远（>24 半音）的，救不回，直接删
    kept = [n for n in notes if lo - RANGE_SLACK <= float(n['midi']) <= hi + RANGE_SLACK]
    if not kept:
        return []

    mids = sorted(_midis(kept))
    median = mids[len(mids) // 2]
    # 第二步：超出主体音域的优先八度纠错
    return octave_correct(kept, lo, hi, median)


# ================================================================
# 4. 节拍估计（基于音符起点间隔中位数 + 倍频校正）
# ================================================================

def estimate_tempo(notes, min_bpm=60, max_bpm=180, fallback=120):
    if len(notes) < 4:
        return fallback
    onsets = sorted(float(n['startTime']) for n in notes)
    gaps = [b - a for a, b in zip(onsets, onsets[1:]) if 0.25 <= (b - a) <= 2.0]
    if not gaps:
        return fallback
    med = statistics.median(gaps)
    bpm = 60.0 / med
    while bpm < min_bpm:
        bpm *= 2
    while bpm > max_bpm:
        bpm /= 2
    return round(bpm)


# ================================================================
# 5. 调号估计（Krumhansl-Schmuckler）
# ================================================================

def estimate_key(notes, fallback='C'):
    """调号估计：优先 music21 KrumhanslSchmuckler（专业实现，相关系数）；
    失败降级为手工 K-S（均值中心化，避免点积偏向）。
    """
    if not notes:
        return fallback

    # 优先 music21 官方实现（对 C 大调/Am 等区分更可靠）
    try:
        from music21 import stream as m21stream, note as m21note
        from music21.analysis.discrete import KrumhanslSchmuckler
        s = m21stream.Stream()
        for n in notes:
            d = _duration(n)
            if d <= 0:
                continue
            nt = m21note.Note(midi=float(n['midi']))
            nt.quarterLength = d * 4.0  # 时值比例无关
            s.append(nt)
        if s.notes:
            k = KrumhanslSchmuckler().getSolution(s)
            return k.tonic.name + ('m' if k.mode == 'minor' else '')
    except Exception:
        pass

    # --- 兜底：手工 K-S（均值中心化） ---
    dur = [0.0] * 12
    total = 0.0
    for n in notes:
        d = _duration(n)
        pc = int(round(float(n['midi']))) % 12
        dur[pc] += d
        total += d
    if total <= 0:
        return fallback

    dur_mean = total / 12.0
    best_key, best_corr = fallback, -1e18
    for root in range(12):
        for minor in (False, True):
            prof = _K_MINOR if minor else _K_MAJOR
            prof_mean = sum(prof) / 12.0
            corr = 0.0
            for i in range(12):
                corr += (dur[(i - root) % 12] - dur_mean) * (prof[i] - prof_mean)
            name = _PITCH_NAMES[root] + ('m' if minor else '')
            if corr > best_corr:
                best_corr, best_key = corr, name
    return best_key


# ================================================================
# 6. 和弦识别（按小节匹配常见三和弦，旋律线简化版）
# ================================================================

# 常见三和弦：根音 + 音级集合（0=根音, 4=大三度, 3=小三度, 7=五度）
_CHORD_TEMPLATES = [
    ('', (0, 4, 7)),      # 大和弦
    ('m', (0, 3, 7)),     # 小三和弦
    ('7', (0, 4, 7, 10)), # 属七
    ('m7', (0, 3, 7, 10)),
    ('sus4', (0, 5, 7)),
    ('dim', (0, 3, 6)),
]

# 在目标调内优先的和弦（简化：不处理转调，只给相对调内和弦标记）
def detect_chords(notes, key_name='C', beats_per_bar=4, tempo=120, fallback_bar=3.0):
    """按小节统计音级集合，匹配常见三和弦。

    返回：[{"time": 秒, "chord": "C" / "Am" / ...}, ...]
    """
    if not notes:
        return []
    try:
        root = _PITCH_NAMES.index(key_name.rstrip('m#')) % 12
    except ValueError:
        root = 0
    bar_len = 60.0 / max(tempo, 30) * beats_per_bar

    # 按小节分组
    bars = {}
    for n in notes:
        bar_idx = int(float(n['startTime']) // bar_len)
        pc = int(round(float(n['midi']))) % 12
        rel = (pc - root) % 12
        bars.setdefault(bar_idx, set()).add(rel)

    chords = []
    for bar_idx in sorted(bars):
        pcs = bars[bar_idx]
        best_name, best_score = None, -1
        for suffix, template in _CHORD_TEMPLATES:
            score = 0
            for t in template:
                if t % 12 in pcs:
                    score += 1
            # 五度最有力，根音其次
            if 7 % 12 in pcs:
                score += 0.5
            if 0 in pcs:
                score += 0.3
            if score > best_score:
                best_score, best_name = score, _PITCH_NAMES[root] + suffix
        chords.append({'time': round(bar_idx * bar_len, 2), 'chord': best_name})
    return chords


# ================================================================
# 7. 音符时值量化（供 MusicXML 使用）
# ================================================================

_QUANT_GRID = (0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0)  # 以四分音符为单位

def quantize_beats(beats):
    """对数距离量化到标准时值表（含附点）。"""
    if beats <= 0:
        return 0.25
    best, best_d = 0.25, float('inf')
    for g in _QUANT_GRID:
        d = abs(__import__('math').log2(beats) - __import__('math').log2(g))
        if d < best_d:
            best, best_d = g, d
    return best


# ================================================================
# 8. 完整后处理管道
# ================================================================

def postprocess(notes, mode='auto', min_duration=DEFAULT_MIN_DURATION,
                confidence=0.0, lo=None, hi=None, estimate=True):
    """完整的音符级后处理管道。返回 (清洗后的 notes, 元数据 dict)。"""
    if not notes:
        return [], {'tempo': 120, 'key': 'C', 'noteCount': 0}

    notes = filter_short(notes, min_duration)
    notes = filter_confidence(notes, confidence)
    notes = filter_range(notes, mode=mode, lo=lo, hi=hi)

    meta = {'noteCount': len(notes)}
    if estimate and notes:
        meta['tempo'] = estimate_tempo(notes)
        meta['key'] = estimate_key(notes)
        meta['chords'] = detect_chords(notes, meta['key'], tempo=meta['tempo'])
    else:
        meta['tempo'] = 120
        meta['key'] = 'C'
        meta['chords'] = []
    return notes, meta


# ================================================================
# 9. MusicXML 生成（依赖 music21，失败降级 None）
# ================================================================

def to_musicxml(notes, tempo=120, key_name='C', time_numerator=4, time_denominator=4,
                title='星谱识音'):
    """把清洗后的音符生成 MusicXML 字符串（用于导出）。失败返回 None。"""
    if not HAS_MUSIC21 or not notes:
        return None
    try:
        from music21 import stream, note, meter, key as m21key, tempo as m21tempo

        s = stream.Score()
        p = stream.Part()
        s.append(p)

        ts = meter.TimeSignature('%d/%d' % (time_numerator, time_denominator))
        p.append(ts)

        # 调号（先剥掉小调后缀）
        root_name = key_name.rstrip('m#')
        try:
            ks = m21key.KeySignature(0)
            if root_name != 'C':
                # 用 key.Key 更准确
                from music21 import key as _k
                k = _k.Key(root_name)
                p.append(k)
            else:
                p.append(ks)
        except Exception:
            p.append(m21key.KeySignature(0))

        p.append(m21tempo.MetronomeMark(number=tempo))

        spb = 60.0 / max(tempo, 30)
        prev_end = 0.0
        for n in sorted(notes, key=lambda x: x['startTime']):
            start = float(n['startTime'])
            dur = _duration(n)
            # 音符前的空隙补休止
            gap = start - prev_end
            if gap > 0.05:
                q = quantize_beats(gap / spb)
                if q > 0.1:
                    r = note.Rest()
                    r.quarterLength = q
                    p.append(r)
            qn = quantize_beats(dur / spb)
            nt = note.Note(int(round(float(n['midi']))))
            nt.quarterLength = qn
            p.append(nt)
            prev_end = max(prev_end, start + dur)

        # 输出 MusicXML 字符串
        tmp = tempfile.mktemp(suffix='.musicxml')
        try:
            s.write('musicxml', fp=tmp)
            with open(tmp, 'r', encoding='utf-8') as f:
                return f.read()
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    except Exception:
        return None


# ================================================================
# 自测
# ================================================================

if __name__ == '__main__':
    # 模拟真实场景：主体旋律集中在 55-70，混入短噪声、离谱高音、低音假音符
    test_notes = [
        {'startTime': 0.00, 'endTime': 0.05, 'midi': 96, 'confidence': 0.3},   # 短噪声 → 删
        {'startTime': 0.10, 'endTime': 1.10, 'midi': 60, 'confidence': 0.9},   # C4 保留
        {'startTime': 1.20, 'endTime': 2.20, 'midi': 62, 'confidence': 0.8},   # D4 保留
        {'startTime': 2.30, 'endTime': 3.30, 'midi': 64, 'confidence': 0.85},  # E4 保留
        {'startTime': 3.40, 'endTime': 4.40, 'midi': 65, 'confidence': 0.8},   # F4 保留
        {'startTime': 4.50, 'endTime': 5.00, 'midi': 96, 'confidence': 0.7},   # 高八度假音 → 纠到 72
        {'startTime': 5.10, 'endTime': 5.60, 'midi': 108, 'confidence': 0.9},  # 极高 → 删/纠
        {'startTime': 5.70, 'endTime': 6.20, 'midi': 24, 'confidence': 0.9},   # 低八度假音 → 纠到 48
    ]
    cleaned, meta = postprocess(test_notes, mode='auto')
    print('清洗后:')
    for n in cleaned:
        print('  midi=%s dur=%.2f conf=%.1f%s' % (
            n['midi'], _duration(n), n.get('confidence', 1),
            ' (原 %s)' % n['octaveCorrected'] if 'octaveCorrected' in n else ''))
    print('元数据:', meta)
    if HAS_MUSIC21:
        xml = to_musicxml(cleaned, meta['tempo'], meta['key'])
        print('MusicXML 长度:', len(xml) if xml else 0)
