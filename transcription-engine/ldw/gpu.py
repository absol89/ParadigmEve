"""GPU (Vulkan) capability detection and truthful backend reporting for whisper.cpp.

Two whisper.cpp binaries can be present:

* ``build/bin/Release/whisper-cli.exe``        CPU-only build. Always the CPU route; it does not
  depend on any GPU driver DLL, so it starts on every machine.
* ``build-vulkan/bin/Release/whisper-cli.exe`` Vulkan build, plus ``ggml-probe.exe`` built from the
  same ggml sources.

``probe()`` never trusts flags or file names. It runs ``ggml-probe``, which enumerates the ggml
devices compiled into that build and runs a small matrix multiply on every GPU device, checking the
exact result. The returned ``status`` is one of:

* ``usable``             a Vulkan device ran the compute check correctly;
* ``device-unavailable`` the Vulkan build is present but no device passed (or the Vulkan runtime
                         could not be loaded);
* ``cpu-only-build``     no Vulkan build/probe is installed.

Whether a particular transcription actually used the GPU is decided separately, from whisper.cpp's
own log line (``whisper_backend_init_gpu: using <device> backend``), see ``backend_from_log``.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Dict, List, Optional

from . import paths

PROBE_SCHEMA = "ldw.gpu-probe/1"
CPU_ONLY = "cpu-only-build"
UNAVAILABLE = "device-unavailable"
USABLE = "usable"


def vulkan_bin_dir() -> Path:
    return paths.VENDOR / "whisper.cpp" / "build-vulkan" / "bin" / "Release"


def find_gpu_whisper_cli() -> Optional[Path]:
    candidate = vulkan_bin_dir() / f"whisper-cli{paths.EXE}"
    return candidate if candidate.is_file() else None


def find_probe() -> Optional[Path]:
    candidate = vulkan_bin_dir() / f"ggml-probe{paths.EXE}"
    return candidate if candidate.is_file() else None


def _result(status: str, reason: Optional[str], devices: List[dict], backends: List[str]) -> dict:
    usable = [d for d in devices if d.get("type") == "gpu" and d.get("usable")]
    selected = usable[0] if usable else None
    return {
        "schema": PROBE_SCHEMA,
        "status": status,
        "compiled_backend": "vulkan" if status != CPU_ONLY else None,
        "compiled_backends": backends,
        "reason": reason,
        "devices": devices,
        "selected": None if selected is None else {
            "gpu_index": selected.get("gpu_index"),
            "name": selected.get("name"),
            "description": selected.get("description"),
            "memory_total": selected.get("memory_total"),
        },
    }


def parse_probe_output(text: str) -> dict:
    """Interpret ggml-probe's JSON. Pure so it can be tested without a GPU."""
    data = json.loads(text)
    if data.get("probe") != "ggml-probe/1" or not isinstance(data.get("devices"), list):
        raise ValueError("unexpected probe output")
    backends = [str(b) for b in data.get("backends", [])]
    devices = [d for d in data["devices"] if isinstance(d, dict)]
    gpus = [d for d in devices if d.get("type") == "gpu"]
    if not any(b.lower() == "vulkan" for b in backends):
        return _result(CPU_ONLY, "this whisper.cpp build has no Vulkan backend", devices, backends)
    if not gpus:
        return _result(UNAVAILABLE, "the Vulkan runtime reported no GPU device", devices, backends)
    if not any(d.get("usable") for d in gpus):
        errors = "; ".join(f"{d.get('description') or d.get('name')}: {d.get('error')}" for d in gpus)
        return _result(UNAVAILABLE, f"no GPU passed the compute check ({errors})", devices, backends)
    return _result(USABLE, None, devices, backends)


def probe(timeout: float = 60.0) -> dict:
    probe_exe, gpu_cli = find_probe(), find_gpu_whisper_cli()
    if probe_exe is None or gpu_cli is None:
        return _result(CPU_ONLY, "no Vulkan whisper.cpp build is installed", [], ["CPU"])
    try:
        completed = subprocess.run([str(probe_exe)], capture_output=True, text=True, timeout=timeout,
                                   stdin=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        return _result(UNAVAILABLE, f"GPU probe did not finish within {timeout:.0f} s", [], ["CPU", "Vulkan"])
    except OSError as error:
        return _result(UNAVAILABLE, f"GPU probe could not start: {error}", [], ["CPU", "Vulkan"])
    if completed.returncode != 0:
        # 0xC0000135 (STATUS_DLL_NOT_FOUND): no Vulkan loader (vulkan-1.dll) on this machine.
        code = completed.returncode & 0xFFFFFFFF
        hint = " (vulkan-1.dll missing: install or update the GPU driver)" if code == 0xC0000135 else ""
        return _result(UNAVAILABLE, f"GPU probe exited with code 0x{code:08X}{hint}", [], ["CPU", "Vulkan"])
    try:
        return parse_probe_output(completed.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError, json.JSONDecodeError):
        return _result(UNAVAILABLE, "GPU probe returned unreadable output", [], ["CPU", "Vulkan"])


_GPU_USED = re.compile(r"whisper_backend_init_gpu:\s+using\s+(.+?)\s+backend")
_GPU_ABSENT = re.compile(r"whisper_backend_init_gpu:\s+(no GPU found|device .* not found)", re.I)
_VK_DEVICE = re.compile(r"ggml_vulkan:\s+(\d+)\s*=\s*([^|]+?)\s*\(")


def backend_from_log(lines: List[str]) -> Dict[str, Optional[str]]:
    """What whisper.cpp actually initialised, read from its own log.

    Returns ``{"backend": "vulkan"|"cpu", "device": name-or-None}``. Anything that does not state a
    GPU backend explicitly is treated as CPU: absence of evidence is never reported as GPU.
    """
    device_names = {}
    used = None
    for line in lines:
        match = _VK_DEVICE.search(line)
        if match:
            device_names[f"Vulkan{match.group(1)}"] = match.group(2).strip()
        match = _GPU_USED.search(line)
        if match:
            used = match.group(1).strip()
        if _GPU_ABSENT.search(line):
            used = None
    if used and used.lower().startswith("vulkan"):
        return {"backend": "vulkan", "device": device_names.get(used, used)}
    if used and (used.lower().startswith("mtl") or used.lower().startswith("metal")):
        return {"backend": "metal", "device": used}  # macOS build (not packaged yet)
    return {"backend": "cpu", "device": None}
