"""Local HTTP-server checks for the OpenAI-compatible provider."""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from ai_provider import generate_midi_plan, list_models, transcribe_audio  # noqa: E402


class _Handler(BaseHTTPRequestHandler):
    request_path = ""
    auth_header = ""
    request_body = b""

    def do_GET(self):
        type(self).request_path = self.path
        type(self).auth_header = self.headers.get("Authorization", "")
        payload = {
            "data": [
                {"id": "qwen2.5:7b", "name": "Qwen 2.5 7B"},
                {"id": "whisper-local"},
            ]
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        type(self).request_path = self.path
        type(self).auth_header = self.headers.get("Authorization", "")
        length = int(self.headers.get("Content-Length", "0"))
        type(self).request_body = self.rfile.read(length)
        if self.path.endswith("/chat/completions"):
            content = json.dumps({
                "title": "Test MIDI",
                "bpm": 110,
                "time_signature": [4, 4],
                "notes": [
                    {"start_beat": 0, "duration_beats": 1, "pitch": 60, "velocity": 100},
                    {"start_beat": 1, "duration_beats": 1, "pitch": 64, "velocity": 95},
                ],
            }, ensure_ascii=False)
            payload = {"choices": [{"message": {"content": content}}]}
        else:
            payload = {
                "text": "你好",
                "segments": [{"start": 0.1, "end": 0.7, "text": "你好"}],
                "words": [
                    {"word": "你", "start": 0.1, "end": 0.35},
                    {"word": "好", "start": 0.35, "end": 0.7},
                ],
            }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, _fmt, *args):
        return


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        result = transcribe_audio(b"fake-audio", {
            "base_url": f"http://127.0.0.1:{port}/v1",
            "api_key": "test-key",
            "model": "whisper-test",
            "language": "zh",
        })
        assert _Handler.request_path == "/v1/audio/transcriptions"
        assert _Handler.auth_header == "Bearer test-key"
        assert b'name="model"' in _Handler.request_body
        assert b"whisper-test" in _Handler.request_body
        assert result["text"] == "你好"
        assert result["segments"][0]["start"] == 0.1
        assert result["words"][1]["text"] == "好"

        plan = generate_midi_plan({
            "base_url": f"http://127.0.0.1:{port}/v1",
            "api_key": "test-key",
            "midi_model": "chat-test",
            "prompt": "写两拍旋律",
            "bpm": 110,
            "bars": 2,
            "key": "C",
        })
        assert _Handler.request_path == "/v1/chat/completions"
        assert plan["bpm"] == 110
        assert len(plan["notes"]) == 2
        assert plan["notes"][1]["pitch"] == 64

        model_list = list_models({
            "base_url": f"http://127.0.0.1:{port}/v1",
            "api_key": "test-key",
        })
        assert _Handler.request_path == "/v1/models"
        assert [item["id"] for item in model_list["models"]] == [
            "qwen2.5:7b",
            "whisper-local",
        ]
    finally:
        server.shutdown()
        server.server_close()
    print("ai provider checks passed")


if __name__ == "__main__":
    main()
