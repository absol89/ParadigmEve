"""Workspace layout and path safety."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys
from typing import Iterable, Optional

ROOT = Path(os.environ.get("LDW_ROOT") or Path(__file__).resolve().parents[1])
DATA_ROOT = Path(os.environ.get("LDW_DATA_ROOT") or ROOT)
UPSTREAM = ROOT / "upstream"
LOCK_FILE = ROOT / "lock" / "components.json"
MODELS = DATA_ROOT / ".models"
TOOLS = DATA_ROOT / ".tools"
VENDOR = ROOT / ".vendor"
STATE = DATA_ROOT / ".state"
TEMP = DATA_ROOT / ".tmp"
OUTPUTS = DATA_ROOT / "outputs"
RECORDINGS = DATA_ROOT / "recordings"
CONFIG = DATA_ROOT / "config"

IS_WINDOWS = sys.platform == "win32"
EXE = ".exe" if IS_WINDOWS else ""

JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def load_lock() -> dict:
    return json.loads(LOCK_FILE.read_text(encoding="utf-8"))


def import_upstream():
    """Import the unmodified upstream module from ``upstream/src``."""
    source = str(UPSTREAM / "src")
    if source not in sys.path:
        sys.path.insert(0, source)
    from local_diarization import cli  # type: ignore

    return cli


def whisper_model_path(name: str) -> Path:
    if not re.fullmatch(r"[a-z0-9.\-_]+", name):
        raise ValueError(f"Invalid Whisper model name {name!r}")
    return MODELS / f"ggml-{name}.bin"


def segmentation_model_path() -> Path:
    return MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"


def embedding_model_path() -> Path:
    return MODELS / "nemo_en_titanet_small.onnx"


def find_whisper_cli() -> Optional[Path]:
    build = VENDOR / "whisper.cpp" / "build" / "bin"
    for candidate in (build / "Release" / f"whisper-cli{EXE}", build / f"whisper-cli{EXE}"):
        if candidate.is_file():
            return candidate
    return None


def find_tool(name: str) -> Optional[Path]:
    """Bundled FFmpeg/ffprobe first, then PATH. Never a relative or cwd lookup."""
    bundled = TOOLS / "ffmpeg"
    if bundled.is_dir():
        for candidate in bundled.glob(f"*/bin/{name}{EXE}"):
            return candidate
    import shutil

    found = shutil.which(name)
    return Path(found).resolve() if found else None


def is_within(path: Path, roots: Iterable[Path]) -> bool:
    resolved = path.resolve()
    for root in roots:
        root = root.resolve()
        if resolved == root or root in resolved.parents:
            return True
    return False


def safe_child(root: Path, name: str) -> Path:
    """Join a single untrusted path component under ``root`` or raise."""
    if not name or name in {".", ".."} or any(ch in name for ch in '/\\:*?"<>|\0'):
        raise ValueError(f"Unsafe path component {name!r}")
    target = (root / name).resolve()
    if not is_within(target, [root]):
        raise ValueError(f"Path escapes {root}: {name!r}")
    return target


def safe_stem(name: str, limit: int = 80) -> str:
    """Filesystem-friendly directory name derived from an untrusted filename.

    Keeps Unicode letters (Windows handles them) but drops separators, control
    characters, reserved device names and trailing dots/spaces.
    """
    cleaned = "".join(ch if (ch.isalnum() or ch in " ._-") else "_" for ch in name)
    cleaned = cleaned.strip(" .") or "recording"
    if cleaned.split(".")[0].upper() in {
        "CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))
    }:
        cleaned = "_" + cleaned
    return cleaned[:limit]


def ascii_safe(path: Path) -> Path:
    """Return a path whisper.cpp can open on Windows.

    whisper-cli opens files with narrow-character APIs, so non-ANSI characters
    in a path can fail. Use the 8.3 short name when the long path is not
    representable in the active code page.
    """
    if not IS_WINDOWS:
        return path
    text = str(path)
    try:
        text.encode("mbcs", errors="strict")
        return path
    except UnicodeEncodeError:
        pass
    import ctypes

    buffer = ctypes.create_unicode_buffer(32768)
    length = ctypes.windll.kernel32.GetShortPathNameW(text, buffer, len(buffer))
    if length == 0 or length > len(buffer):
        raise RuntimeError(
            "This path contains characters whisper.cpp cannot open and has no 8.3 short "
            f"name: {path}. Move the workspace to an ASCII path."
        )
    return Path(buffer.value)
