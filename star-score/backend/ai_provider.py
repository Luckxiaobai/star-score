"""OpenAI-compatible AI provider proxy.

The browser sends requests to the local backend so API keys are not embedded
in frontend code and CORS does not constrain provider compatibility.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid


def _endpoint(base_url: str, suffix: str) -> str:
    base = (base_url or "").strip().rstrip("/")
    if not base:
        raise ValueError("缺少 base_url")
    if base.endswith(suffix):
        return base
    return base + suffix


def _multipart(parts: list[tuple[str, str]], file_field: str, filename: str,
               file_bytes: bytes, content_type: str = "audio/wav") -> tuple[bytes, str]:
    boundary = "----StarScore" + uuid.uuid4().hex
    body = bytearray()
    for name, value in parts:
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8")
        )
        body.extend(str(value).encode("utf-8"))
        body.extend(b"\r\n")

    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(
        (
            f'Content-Disposition: form-data; name="{file_field}"; '
            f'filename="{filename}"\r\n'
        ).encode("utf-8")
    )
    body.extend(f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"))
    body.extend(file_bytes)
    body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode("utf-8"))
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def _request_json(url: str, body: bytes, content_type: str,
                  headers: dict[str, str], timeout: int = 180) -> dict:
    req_headers = {"Content-Type": content_type, **headers}
    req = urllib.request.Request(url, data=body, headers=req_headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "ignore")
        raise RuntimeError(
            f"AI 服务返回 HTTP {exc.code}: {detail[:500]}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 AI 服务: {exc.reason}") from exc


def _request_json_get(url: str, headers: dict[str, str], timeout: int = 30) -> dict:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "ignore")
        raise RuntimeError(
            f"AI 服务返回 HTTP {exc.code}: {detail[:500]}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 AI 服务: {exc.reason}") from exc


def list_models(config: dict) -> dict:
    """Fetch model IDs from an OpenAI-compatible /models endpoint."""
    headers = {}
    api_key = str(config.get("api_key") or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = _request_json_get(
        _endpoint(str(config.get("base_url") or ""), "/models"),
        headers,
        timeout=int(config.get("timeout") or 30),
    )
    raw_models = payload.get("data") or payload.get("models") or []
    models = []
    for item in raw_models:
        if isinstance(item, str):
            model_id = item.strip()
            if model_id:
                models.append({"id": model_id, "name": model_id})
            continue
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or item.get("name") or "").strip()
        if not model_id:
            continue
        models.append({
            "id": model_id,
            "name": str(item.get("name") or model_id),
        })
    models.sort(key=lambda item: item["id"].lower())
    return {"models": models}


def transcribe_audio(audio_bytes: bytes, config: dict) -> dict:
    """Transcribe audio through an OpenAI-compatible transcription endpoint."""
    model = str(config.get("model") or "whisper-1")
    language = str(config.get("language") or "").strip()
    prompt = str(config.get("prompt") or "").strip()
    include_words = bool(config.get("word_timestamps", True))

    parts = [
        ("model", model),
        ("response_format", "verbose_json"),
        ("timestamp_granularities[]", "segment"),
    ]
    if include_words:
        parts.append(("timestamp_granularities[]", "word"))
    if language:
        parts.append(("language", language))
    if prompt:
        parts.append(("prompt", prompt))

    body, content_type = _multipart(
        parts,
        file_field="file",
        filename=str(config.get("filename") or "sample.wav"),
        file_bytes=audio_bytes,
    )
    headers = {}
    api_key = str(config.get("api_key") or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = _request_json(
        _endpoint(str(config.get("base_url") or ""), "/audio/transcriptions"),
        body,
        content_type,
        headers,
        timeout=int(config.get("timeout") or 180),
    )
    segments = []
    for item in payload.get("segments") or []:
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        segments.append({
            "text": text,
            "start": float(item.get("start") or 0.0),
            "end": float(item.get("end") or 0.0),
        })
    words = []
    for item in payload.get("words") or []:
        text = str(item.get("word") or item.get("text") or "").strip()
        if not text:
            continue
        words.append({
            "text": text,
            "start": float(item.get("start") or 0.0),
            "end": float(item.get("end") or 0.0),
        })
    return {
        "text": str(payload.get("text") or "").strip(),
        "segments": segments,
        "words": words,
        "provider": "openai-compatible",
        "model": model,
    }


def _extract_json_object(text: str) -> dict:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].lstrip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("AI 未返回 JSON 对象")
    try:
        return json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"AI 返回的 MIDI JSON 无法解析: {exc}") from exc


def _completion_text(payload: dict) -> str:
    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError("AI 响应缺少 choices")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            str(item.get("text") or "")
            for item in content
            if isinstance(item, dict)
        )
    raise RuntimeError("AI 响应缺少文本内容")


def generate_midi_plan(config: dict) -> dict:
    """Generate a structured MIDI plan through an OpenAI-compatible chat API."""
    model = str(config.get("midi_model") or config.get("model") or "gpt-4o-mini")
    prompt = str(config.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("缺少生成要求")
    bpm = max(20, min(300, int(config.get("bpm") or 120)))
    bars = max(1, min(128, int(config.get("bars") or 8)))
    key = str(config.get("key") or "C")
    style = str(config.get("style") or "")

    system = (
        "You are a MIDI composition engine. Return JSON only, no markdown. "
        "Schema: {title:string,bpm:number,time_signature:[number,number],"
        "notes:[{start_beat:number,duration_beats:number,pitch:number,"
        "velocity:number,lyric?:string}]}. "
        "pitch is MIDI 0-127. start_beat is zero-based. Keep notes inside "
        "the requested bar count. Prefer musical, playable monophonic or "
        "light polyphonic material."
    )
    user = (
        f"Create {bars} bars of MIDI. BPM={bpm}, key={key}, style={style}. "
        f"Request: {prompt}"
    )
    payload_in = {
        "model": model,
        "temperature": 0.7,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    headers = {}
    api_key = str(config.get("api_key") or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    response = _request_json(
        _endpoint(str(config.get("base_url") or ""), "/chat/completions"),
        json.dumps(payload_in, ensure_ascii=False).encode("utf-8"),
        "application/json",
        headers,
        timeout=int(config.get("timeout") or 180),
    )
    plan = _extract_json_object(_completion_text(response))

    notes = []
    for note in (plan.get("notes") or [])[:10000]:
        try:
            duration = float(note.get("duration_beats") or 0)
            if duration <= 0:
                continue
            item = {
                "start_beat": max(0.0, float(note.get("start_beat") or 0)),
                "duration_beats": min(32.0, duration),
                "pitch": max(0, min(127, int(round(float(note.get("pitch") or 60))))),
                "velocity": max(1, min(127, int(note.get("velocity") or 96))),
            }
            lyric = str(note.get("lyric") or "").strip()
            if lyric:
                item["lyric"] = lyric
            notes.append(item)
        except (TypeError, ValueError):
            continue
    if not notes:
        raise RuntimeError("AI 返回的 MIDI 没有有效音符")
    notes.sort(key=lambda item: (item["start_beat"], item["pitch"]))

    ts = plan.get("time_signature") or [4, 4]
    try:
        time_signature = [max(1, int(ts[0])), max(1, int(ts[1]))]
    except (TypeError, ValueError, IndexError):
        time_signature = [4, 4]
    return {
        "title": str(plan.get("title") or "AI MIDI").strip(),
        "bpm": max(20, min(300, int(plan.get("bpm") or bpm))),
        "time_signature": time_signature,
        "bars": bars,
        "notes": notes,
        "provider": "openai-compatible",
        "model": model,
    }
