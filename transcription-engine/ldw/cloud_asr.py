"""Opt-in cloud transcription (Groq or OpenAI). Speaker separation stays local.

This is the only module that sends audio off the machine. It runs only when the user
passes ``--asr groq`` or ``--asr openai``. The transcript records
``privacy.processing = "cloud_asr"`` and the exact selected recipient.
The provider's API key is read from its environment variable and never logged.

The response is converted to the same whisper.cpp ``-ojf`` JSON shape the rest of the
pipeline expects. Groq returns word timestamps but no per-word probabilities, so ASR
confidence is left null (not invented). Segment ``avg_logprob`` and ``no_speech_prob``
are kept on each item for inspection.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable, List, Optional
import errno
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
    """A bounded, safe failure report; upstream response text and OS paths never escape.

    The CLI and RPC surface use ``str(error)``; Prime can parse the fixed fields
    without receiving API response bodies, keys, request headers or file names.
    ``retryable`` is advice for a *new user-authorized attempt*, not permission
    to replay an audio upload automatically.
    """

    def __init__(self, *, provider: str, model: Optional[str], category: str,
                 retryable: bool = False, status: Optional[int] = None,
                 code: Optional[str] = None):
        self.provider = provider if provider in PROVIDERS else "unknown"
        valid_models = PROVIDERS.get(self.provider, {}).get("models", ())
        self.model = model if model in valid_models else None
        self.category = category if category in _SAFE_CATEGORIES else "unknown"
        self.retryable = bool(retryable)
        self.status = status if isinstance(status, int) and 100 <= status <= 599 else None
        self.code = code if code in _SAFE_ERROR_CODES else None
        # Single stable marker for the main-process stderr parser (never raw HTTP data).
        super().__init__(
            f"CLOUD_ASR_ERROR provider={self.provider} "
            f"status={self.status if self.status is not None else 'none'} "
            f"category={self.category}"
            + (f" code={self.code}" if self.code else "")
            + f" retryable={str(self.retryable).lower()}"
        )

    def as_dict(self) -> dict:
        return {"provider": self.provider, "model": self.model, "category": self.category,
                "http_status": self.status, "retryable": self.retryable, "code": self.code}


# Only these fixed known values can be extracted from an untrusted provider error body.
# Never forward error.message, error.type, request ids, headers or arbitrary error.code.
_SAFE_ERROR_CODES = frozenset({
    "invalid_api_key", "insufficient_quota", "billing_hard_limit_reached",
    "rate_limit_exceeded", "model_not_found", "invalid_request_error",
    "unsupported_value", "unsupported_parameter",
})
_QUOTA_CODES = frozenset({"insufficient_quota", "billing_hard_limit_reached"})
_SAFE_CATEGORIES = frozenset({
    "authentication", "permission_denied", "quota", "rate_limit", "timeout",
    "server_error", "invalid_request", "unavailable", "unknown", "network",
    "response", "configuration", "invalid_audio",
})


def _safe_error_code(error: urllib.error.HTTPError) -> Optional[str]:
    try:
        payload = json.loads(error.read(8192).decode("utf-8"))
        detail = payload.get("error") if isinstance(payload, dict) else None
        value = detail.get("code") if isinstance(detail, dict) else None
        return value if isinstance(value, str) and value in _SAFE_ERROR_CODES else None
    except (ValueError, UnicodeError, OSError, TypeError):
        return None


def _http_error(provider: str, model: str, status: int, code: Optional[str]) -> CloudError:
    if status == 401:
        category, retryable = "authentication", False
    elif status == 403:
        category, retryable = "permission_denied", False
    elif code in _QUOTA_CODES:
        category, retryable = "quota", False
    elif status == 429:
        category, retryable = "rate_limit", True
    elif status in (408, 504):
        category, retryable = "timeout", True
    elif status >= 500:
        category, retryable = "server_error", True
    elif status in (400, 413, 415, 422):
        category, retryable = "invalid_request", False
    elif status == 404:
        category, retryable = "unavailable", False
    else:
        category, retryable = "unknown", False
    return CloudError(provider=provider, model=model, status=status,
                      category=category, retryable=retryable, code=code)


def api_key(provider: str = "groq", model: Optional[str] = None) -> str:
    name = PROVIDERS[provider]["key_env"]
    key = os.environ.get(name, "").strip()
    if not key:
        raise CloudError(provider=provider, model=model, category="configuration",
                         code=None, retryable=False)
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


def _post(body: bytes, content_type: str, key: str, timeout: float, *,
          provider: str, model: str, url: str) -> dict:
    # Transcription POSTs are not idempotent: a timeout does not prove the service
    # missed the upload. Never automatically replay any chunk, including 429/5xx.
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": content_type,
        "User-Agent": "local-diarization-windows/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Unexpected provider response")
            return payload
    except urllib.error.HTTPError as error:
        raise _http_error(provider, model, error.code, _safe_error_code(error)) from None
    except urllib.error.URLError as error:
        reason = error.reason
        is_timeout = isinstance(reason, TimeoutError) or (
            isinstance(reason, OSError) and reason.errno == errno.ETIMEDOUT
        ) or (isinstance(reason, str) and "timed out" in reason.lower())
        raise CloudError(provider=provider, model=model,
                         category="timeout" if is_timeout else "network",
                         retryable=True) from None
    except TimeoutError:
        raise CloudError(provider=provider, model=model, category="timeout",
                         retryable=True) from None
    except OSError:
        raise CloudError(provider=provider, model=model, category="network",
                         retryable=True) from None
    except (ValueError, UnicodeError, TypeError):
        raise CloudError(provider=provider, model=model, category="response",
                         retryable=False) from None


def transcribe(wav: Path, duration: float, language: str, model: Optional[str] = None,
               cancel: Optional[procs.CancelToken] = None,
               progress: Optional[Callable[[str, float], None]] = None, tmp: Optional[Path] = None,
               provider: str = "groq") -> dict:
    spec = PROVIDERS[provider]
    model = model or spec["default"]
    if model not in spec["models"]:
        raise ValueError(f"{provider} model must be one of {spec['models']}")
    key = api_key(provider, model)
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
        try:
            _encode(wav, piece, start, length, cancel)
            if piece.stat().st_size > MAX_UPLOAD_BYTES:
                raise CloudError(provider=provider, model=model,
                                 category="invalid_audio", retryable=False)
            fields = {"model": model, "response_format": "verbose_json",
                      "timestamp_granularities[]": ["segment", "word"], "temperature": "0"}
            if language and language != "auto":
                fields["language"] = language
            body, content_type = _multipart(fields, "file", piece)
            uploaded += len(body)
            result = _post(body, content_type, key, timeout=max(120, length),
                           provider=provider, model=model, url=spec["url"])
        finally:
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
