"""Opt-in cloud transcription (Groq). Speaker separation always stays local.

This is the only module that sends audio off the machine. It runs only when the user
passes ``--asr groq``. The transcript then records ``privacy.processing = "cloud_asr"``
and which service received the audio. The API key is read from the GROQ_API_KEY
environment variable and is never logged or written to disk.

The response is converted to the same whisper.cpp ``-ojf`` JSON shape the rest of the
pipeline expects. Groq returns word timestamps but no per-word probabilities, so ASR
confidence is left null (not invented). Segment ``avg_logprob`` and ``no_speech_prob``
are kept on each item for inspection.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import time
from typing import Callable, List, Optional
import urllib.error
import urllib.request
import uuid

from . import paths, procs

PROVIDERS = {
    # whisper-1 is OpenAI's transcription model that returns word/segment timestamps,
    # which local speaker alignment needs; gpt-4o-transcribe returns plain text only.
    "groq": {"url": "https://api.groq.com/openai/v1/audio/transcriptions", "key_env": "GROQ_API_KEY",
             "models": ("whisper-large-v3-turbo", "whisper-large-v3"), "default": "whisper-large-v3-turbo"},
    "openai": {"url": "https://api.openai.com/v1/audio/transcriptions", "key_env": "OPENAI_API_KEY",
               "models": ("whisper-1",), "default": "whisper-1"},
}
GROQ_URL = PROVIDERS["groq"]["url"]
GROQ_MODELS = PROVIDERS["groq"]["models"]
MAX_UPLOAD_BYTES = 24 * 1024 * 1024  # free-tier request limit is 25 MB
CHUNK_SECONDS = 20 * 60


class CloudError(RuntimeError):
    pass


def api_key(provider: str = "groq") -> str:
    name = PROVIDERS[provider]["key_env"]
    key = os.environ.get(name, "").strip()
    if not key:
        raise CloudError(f"{name} is not set. Set it in your own terminal (setx {name} ...) "
                         "and restart; never paste keys into chat or config files.")
    return key


def _encode(wav: Path, out: Path, start: float, duration: float, cancel) -> None:
    ffmpeg = paths.find_tool("ffmpeg")
    procs.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", f"{start:.3f}",
               "-t", f"{duration:.3f}", "-i", wav, "-ac", "1", "-ar", "16000", "-c:a", "libopus",
               "-b:a", "32k", "-application", "voip", out], name="ffmpeg (encode for upload)", timeout=600, cancel=cancel)


def _multipart(fields: dict, file_field: str, file_path: Path) -> tuple:
    boundary = uuid.uuid4().hex
    parts: List[bytes] = []
    for name, value in fields.items():
        values = value if isinstance(value, list) else [value]
        for v in values:
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="audio.ogg"\r\n'
                 f'Content-Type: audio/ogg\r\n\r\n'.encode())
    parts.append(file_path.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _post(body: bytes, content_type: str, key: str, timeout: float, retries: int = 3, url: str = GROQ_URL) -> dict:
    provider = "OpenAI" if "openai.com" in url else "Groq"
    for attempt in range(retries + 1):
        request = urllib.request.Request(url, data=body, method="POST", headers={
            "Authorization": f"Bearer {key}", "Content-Type": content_type,
            "User-Agent": "local-diarization-windows/0.1"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:300]
            if error.code in (429, 500, 502, 503) and attempt < retries:
                time.sleep(min(30, 2 ** (attempt + 1)))
                continue
            raise CloudError(f"{provider} returned HTTP {error.code}: {detail}") from None
        except urllib.error.URLError as error:
            if attempt < retries:
                time.sleep(2 ** (attempt + 1))
                continue
            raise CloudError(f"Could not reach {provider}: {error.reason}") from None
    raise CloudError(f"{provider} request failed")


def transcribe(wav: Path, duration: float, language: str, model: Optional[str] = None,
               cancel: Optional[procs.CancelToken] = None,
               progress: Optional[Callable[[str, float], None]] = None, tmp: Optional[Path] = None,
               provider: str = "groq") -> dict:
    spec = PROVIDERS[provider]
    model = model or spec["default"]
    if model not in spec["models"]:
        raise ValueError(f"{provider} model must be one of {spec['models']}")
    key = api_key(provider)
    tmp = Path(tmp or paths.TEMP)
    items: List[dict] = []
    detected = None
    chunks = max(1, int(-(-duration // CHUNK_SECONDS)))
    uploaded = 0
    for index in range(chunks):
        if cancel is not None:
            cancel.check()
        start = index * CHUNK_SECONDS
        length = min(CHUNK_SECONDS, duration - start)
        piece = tmp / f"groq-chunk-{index}.ogg"
        _encode(wav, piece, start, length, cancel)
        if piece.stat().st_size > MAX_UPLOAD_BYTES:
            raise CloudError("Encoded chunk exceeds the upload limit")
        fields = {"model": model, "response_format": "verbose_json",
                  "timestamp_granularities[]": ["segment", "word"], "temperature": "0"}
        if language and language != "auto":
            fields["language"] = language
        body, content_type = _multipart(fields, "file", piece)
        uploaded += len(body)
        result = _post(body, content_type, key, timeout=max(120, length), url=spec["url"])
        piece.unlink(missing_ok=True)
        detected = detected or result.get("language")
        words = result.get("words") or []
        for seg in result.get("segments") or []:
            s, e = float(seg["start"]) + start, float(seg["end"]) + start
            seg_words = [w for w in words if float(w["start"]) + start >= s - 0.01 and float(w["end"]) + start <= e + 0.05]
            tokens = [{"text": " " + str(w["word"]).strip(),
                       "offsets": {"from": int(round((float(w["start"]) + start) * 1000)),
                                   "to": int(round((float(w["end"]) + start) * 1000))},
                       "p": None} for w in seg_words]
            items.append({
                "offsets": {"from": int(round(s * 1000)), "to": int(round(e * 1000))},
                "text": " " + str(seg.get("text", "")).strip(),
                "tokens": tokens,
                "cloud": {"avg_logprob": seg.get("avg_logprob"), "no_speech_prob": seg.get("no_speech_prob"),
                          "compression_ratio": seg.get("compression_ratio")},
            })
        if progress:
            progress("transcribe", (index + 1) / chunks)
    return {"systeminfo": f"{provider}:{model}", "model": {"provider": provider, "name": model},
            "result": {"language": _language_code(detected) or language},
            "transcription": items, "upload": {"bytes": uploaded, "chunks": chunks, "codec": "opus 32 kbps mono 16 kHz"}}


_NAMES = {"english": "en", "swedish": "sv", "finnish": "fi", "german": "de", "norwegian": "no", "danish": "da"}


def _language_code(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    name = str(name).lower()
    return _NAMES.get(name, name if len(name) <= 3 else None)
