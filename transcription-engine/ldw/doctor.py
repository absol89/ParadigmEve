"""Prerequisite diagnostics. Never downloads or installs anything."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from typing import List, Tuple

from . import downloads, gpu, paths

OK, WARN, FAIL = "ok", "warn", "fail"


def embedded_runtime() -> bool:
    """True when running the interpreter Eve ships (runtime/python.exe), not a developer venv."""
    bundled = paths.ROOT / "runtime" / ("python.exe" if paths.IS_WINDOWS else "bin/python")
    try:
        return bundled.is_file() and Path(sys.executable).resolve() == bundled.resolve()
    except OSError:
        return False


def _vs_build_tools() -> Tuple[str, str]:
    vswhere = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft Visual Studio/Installer/vswhere.exe"
    if not vswhere.is_file():
        return FAIL, "Visual Studio Build Tools not found (needed once to build whisper.cpp)"
    try:
        out = subprocess.run([str(vswhere), "-latest", "-products", "*", "-requires",
                              "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
                             capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as error:
        return WARN, f"vswhere failed: {error}"
    if not out:
        return FAIL, "Build Tools present but the 'Desktop development with C++' (MSVC x64) workload is missing"
    return OK, out


def checks(whisper_model: str, deep: bool = False) -> List[Tuple[str, str, str]]:
    results: List[Tuple[str, str, str]] = []
    add = lambda name, status, detail: results.append((name, status, detail))

    add("platform", OK if paths.IS_WINDOWS and platform.machine().lower() in {"amd64", "x86_64"} else WARN,
        f"{platform.system()} {platform.release()} {platform.machine()}")
    add("python", OK if sys.version_info >= (3, 9) else FAIL, f"{platform.python_version()} at {sys.executable}")
    embedded = embedded_runtime()
    # Downloads Eve fetches on first use (pinned + SHA-256 verified into the data folder) are not
    # failures for the shipped runtime, only for a developer checkout.
    first_use = WARN if embedded else FAIL
    if embedded:
        add("runtime", OK, "embedded Python shipped with Eve")
    else:
        venv = paths.ROOT / ".venv"
        add("venv", OK if venv.is_dir() else FAIL, str(venv) if venv.is_dir() else "missing: run setup-windows.ps1")
    for module in ("sherpa_onnx", "soundfile", "numpy"):
        found = importlib.util.find_spec(module) is not None
        add(f"python:{module}", OK if found else FAIL, "importable" if found else "not installed in this interpreter")
    found = importlib.util.find_spec("soundcard") is not None
    add("python:soundcard", OK if found else WARN, "importable" if found else "missing: capture disabled")
    upstream = paths.UPSTREAM / "src" / "local_diarization" / "cli.py"
    add("upstream", OK if upstream.is_file() else FAIL, str(paths.UPSTREAM))
    if upstream.is_file() and not (paths.UPSTREAM / ".git").exists():
        # A staged copy has no git metadata; git -C would report the enclosing repository instead.
        add("upstream:commit", OK, f"staged copy of {paths.load_lock()['upstream']['commit'][:12]}")
    elif upstream.is_file():
        try:
            head = subprocess.run(["git", "-C", str(paths.UPSTREAM), "rev-parse", "HEAD"],
                                  capture_output=True, text=True, timeout=15).stdout.strip()
            want = paths.load_lock()["upstream"]["commit"]
            add("upstream:commit", OK if head == want else WARN, head or "unknown")
        except (OSError, subprocess.TimeoutExpired):
            add("upstream:commit", WARN, "git not available to verify")
    for tool in ("ffmpeg", "ffprobe"):
        found = paths.find_tool(tool)
        add(tool, OK if found else first_use, str(found) if found else
            ("downloaded on first use" if embedded else "missing"))
    cli = paths.find_whisper_cli()
    add("whisper-cli", OK if cli else FAIL, str(cli) if cli else "not built")
    if paths.IS_WINDOWS and not cli:
        status, detail = _vs_build_tools()
        add("msvc", status, detail)
        add("cmake", OK if shutil.which("cmake") or status == OK else FAIL,
            shutil.which("cmake") or "use the CMake bundled with Build Tools")
    for item in downloads.plan_items(whisper_model):
        if item.kind != "model":
            continue
        if deep:
            state = downloads.verify_all([item])[item.key]
        else:
            state = "ok" if downloads.is_installed(item) else ("missing" if not item.dest.exists() else "unverified")
        status = OK if state == "ok" else (first_use if state == "missing" else FAIL)
        detail = f"{state} ({item.dest.name})" + (", downloaded on first use" if status == WARN else "")
        add(f"model:{item.key}", status, detail)
    probe = gpu.probe()
    selected = (probe.get("selected") or {}).get("description")
    add("gpu", OK if probe["status"] == gpu.USABLE else WARN,
        f"{probe['compiled_backend'] or 'none'}: {selected}" if probe["status"] == gpu.USABLE
        else f"{probe['status']}: {probe.get('reason') or 'CPU transcription only'}")
    free = shutil.disk_usage(paths.DATA_ROOT if paths.DATA_ROOT.exists() else paths.ROOT).free
    add("disk", OK if free > 2 * 1024 ** 3 else WARN, f"{downloads.format_bytes(free)} free")
    return results


def report(whisper_model: str, deep: bool = False) -> int:
    worst = 0
    for name, status, detail in checks(whisper_model, deep):
        mark = {"ok": "OK  ", "warn": "WARN", "fail": "FAIL"}[status]
        print(f"[{mark}] {name:28} {detail}")
        worst = max(worst, {"ok": 0, "warn": 0, "fail": 1}[status])
    if worst:
        print("\nSome prerequisites are missing. Run .\\setup-windows.ps1 (it shows downloads before fetching).")
    elif embedded_runtime():
        print("\nReady. Missing models and FFmpeg are fetched and verified the first time Eve transcribes.")
    return worst
