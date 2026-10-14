"""Verified download manager.

* Every file has a pinned URL, size and SHA-256 in ``lock/components.json``.
* A plan (size, destination, license, hosts) is shown before anything is fetched,
  and nothing downloads without explicit confirmation.
* Downloads go to ``<dest>.part`` and resume with HTTP Range after interruption.
* A file is only moved into place after its size and hash match.
* Provenance (origin URL, final host, hash, size, time) goes to ``.state/installed.json``.
* Archives are extracted with path-traversal checks. Nothing downloaded is executed.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import time
from typing import Callable, Dict, List, Optional
from urllib.parse import urlparse
import urllib.request
import zipfile

from . import paths

ALLOWED_HOSTS = {
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "huggingface.co",
    "cdn-lfs.huggingface.co",
    "cdn-lfs-us-1.huggingface.co",
    "us.aws.cdn.hf.co",
    "cas-bridge.xethub.hf.co",
}
ALLOWED_HOST_SUFFIXES = (".hf.co", ".huggingface.co", ".githubusercontent.com")
USER_AGENT = "local-diarization-windows/0.1 (+verified-download)"


class ChecksumError(RuntimeError):
    pass


@dataclass
class Item:
    key: str
    kind: str
    url: str
    size: int
    sha256: str
    license: str
    dest: Path
    extract: Optional[str] = None
    extract_to: Optional[Path] = None
    expect: Optional[Path] = None

    @property
    def host(self) -> str:
        return urlparse(self.url).hostname or ""


def plan_items(whisper_model: Optional[str] = None, platform: str = "windows",
               lock: Optional[dict] = None) -> List[Item]:
    lock = lock or paths.load_lock()
    items: List[Item] = []
    for key, spec in lock["downloads"].items():
        if platform not in spec.get("platforms", [platform]):
            continue
        items.append(Item(
            key=key, kind=spec["kind"], url=spec["url"], size=int(spec["size"]),
            sha256=spec["sha256"], license=spec["license"], dest=paths.DATA_ROOT / spec["dest"],
            extract=spec.get("extract"),
            extract_to=paths.DATA_ROOT / spec["extract_to"] if spec.get("extract_to") else None,
            expect=paths.DATA_ROOT / spec["expect"] if spec.get("expect") else None,
        ))
    name = whisper_model or lock["default_whisper_model"]
    models = lock["whisper_models"]
    if name not in models or name.startswith("_"):
        raise ValueError(f"Unknown Whisper model {name!r}. Known: {', '.join(k for k in models if not k.startswith('_'))}")
    items.append(Item(
        key=f"whisper:{name}", kind="model",
        url=f"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin",
        size=int(models[name]["size"]), sha256=models[name]["sha256"],
        license="MIT (OpenAI Whisper weights, ggml conversion by whisper.cpp)",
        dest=paths.whisper_model_path(name),
    ))
    return items


def sha256_file(path: Path, progress: Optional[Callable[[int], None]] = None) -> str:
    hasher = hashlib.sha256()
    done = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            hasher.update(chunk)
            done += len(chunk)
            if progress:
                progress(done)
    return hasher.hexdigest()


def is_installed(item: Item, deep: bool = False) -> bool:
    """Cheap check uses the recorded provenance; ``deep`` re-hashes the file."""
    if not item.dest.is_file() or item.dest.stat().st_size != item.size:
        return False
    if deep:
        return sha256_file(item.dest) == item.sha256
    record = read_state().get("files", {}).get(item.key)
    return bool(record and record.get("sha256") == item.sha256)


def format_bytes(count: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if count < 1024 or unit == "GB":
            return f"{count:.0f} {unit}" if unit == "B" else f"{count:.1f} {unit}"
        count /= 1024
    return f"{count:.1f} GB"


def describe_plan(items: List[Item]) -> str:
    pending = [i for i in items if not is_installed(i)]
    lines = ["Downloads required:" if pending else "All pinned files are already installed and verified."]
    for item in pending:
        lines.append(f"  - {item.key}: {format_bytes(item.size)} from {item.host}")
        lines.append(f"      to {item.dest}")
        lines.append(f"      license: {item.license}")
    if pending:
        total = sum(i.size for i in pending)
        free = shutil.disk_usage(paths.DATA_ROOT).free
        lines.append(f"Total: {format_bytes(total)} (free disk here: {format_bytes(free)})")
        lines.append("Network: HTTPS to " + ", ".join(sorted({i.host for i in pending})) + " (plus their CDNs).")
        lines.append("After this, transcription and diarization run fully offline.")
    return "\n".join(lines)


def _check_host(url: str) -> None:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme != "https" or not (host in ALLOWED_HOSTS or host.endswith(ALLOWED_HOST_SUFFIXES)):
        raise RuntimeError(f"Refusing download from unexpected location: {parsed.scheme}://{host}")


class _Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _opener():
    return urllib.request.build_opener(_Redirects())


def fetch(item: Item, progress: Optional[Callable[[str, int, int], None]] = None,
          timeout: float = 60, retries: int = 4, cancelled: Callable[[], bool] = lambda: False) -> str:
    """Download ``item`` with resume and verification. Returns the final host."""
    _check_host(item.url)
    item.dest.parent.mkdir(parents=True, exist_ok=True)
    part = item.dest.with_name(item.dest.name + ".part")
    final_host = item.host
    attempt = 0
    while True:
        have = part.stat().st_size if part.exists() else 0
        if have > item.size:
            part.unlink()
            have = 0
        if have == item.size:
            break
        request = urllib.request.Request(item.url, headers={"User-Agent": USER_AGENT})
        if have:
            request.add_header("Range", f"bytes={have}-")
        try:
            with _opener().open(request, timeout=timeout) as response:
                final_host = urlparse(response.geturl()).hostname or final_host
                status = getattr(response, "status", 200)
                if have and status != 206:
                    have = 0  # server ignored Range; start over
                mode = "ab" if have else "wb"
                with part.open(mode) as out:
                    done = have
                    while True:
                        if cancelled():
                            raise KeyboardInterrupt("Download cancelled")
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        done += len(chunk)
                        if progress:
                            progress(item.key, done, item.size)
        except (OSError, urllib.error.URLError) as error:
            attempt += 1
            if attempt > retries:
                raise RuntimeError(
                    f"Download of {item.key} failed after {retries} retries: {error}. "
                    f"Partial data kept at {part}; rerun setup to resume."
                ) from error
            time.sleep(min(16, 2 ** attempt))
            continue
        if part.stat().st_size >= item.size:
            break

    if part.stat().st_size != item.size:
        raise ChecksumError(f"{item.key}: expected {item.size} bytes, got {part.stat().st_size}")
    actual = sha256_file(part)
    if actual != item.sha256:
        bad = part.with_name(part.name + ".corrupt")
        part.replace(bad)
        raise ChecksumError(
            f"{item.key}: checksum mismatch (expected {item.sha256}, got {actual}). "
            f"The file was moved to {bad.name} and will be downloaded again next time."
        )
    os.replace(part, item.dest)
    return final_host


def _safe_target(root: Path, member: str) -> Path:
    target = (root / member).resolve()
    if not paths.is_within(target, [root]):
        raise RuntimeError(f"Unsafe path in archive: {member}")
    return target


def extract(item: Item) -> None:
    if not item.extract or item.extract_to is None:
        return
    root = item.extract_to
    root.mkdir(parents=True, exist_ok=True)
    if item.extract == "zip":
        staging = root.with_name(root.name + ".extracting")
        if staging.exists():
            shutil.rmtree(staging)
        with zipfile.ZipFile(item.dest) as archive:
            for member in archive.namelist():
                _safe_target(staging, member)
            archive.extractall(staging)
        if root.exists():
            shutil.rmtree(root)
        staging.replace(root)
    elif item.extract == "tar.bz2":
        with tarfile.open(item.dest, "r:bz2") as archive:
            members = archive.getmembers()
            for member in members:
                _safe_target(root, member.name)
                if member.issym() or member.islnk() or member.isdev():
                    raise RuntimeError(f"Refusing link or device in archive: {member.name}")
            archive.extractall(root, members=members)
    else:
        raise RuntimeError(f"Unknown archive type {item.extract}")
    if item.expect is not None and not item.expect.exists():
        raise RuntimeError(f"{item.key}: {item.expect} missing after extraction")


def read_state() -> dict:
    state_file = paths.STATE / "installed.json"
    if state_file.is_file():
        try:
            return json.loads(state_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"files": {}, "components": {}}


def write_state(state: dict) -> None:
    paths.STATE.mkdir(parents=True, exist_ok=True)
    target = paths.STATE / "installed.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, target)


def record(item: Item, final_host: str) -> None:
    state = read_state()
    state.setdefault("files", {})[item.key] = {
        "url": item.url,
        "final_host": final_host,
        "path": str(item.dest.relative_to(paths.DATA_ROOT)),
        "size": item.size,
        "sha256": item.sha256,
        "license": item.license,
        "verified_at": datetime.now(timezone.utc).isoformat(),
    }
    write_state(state)


def _console_progress(key: str, done: int, total: int, _last={"t": 0.0}) -> None:
    now = time.monotonic()
    if now - _last["t"] < 0.5 and done < total:
        return
    _last["t"] = now
    percent = done * 100 / total if total else 100
    print(f"\r  {key}: {percent:5.1f}% ({format_bytes(done)} / {format_bytes(total)})",
          end="", file=sys.stderr, flush=True)
    if done >= total:
        print(file=sys.stderr)


def ensure(items: List[Item], assume_yes: bool = False, deep_verify: bool = False) -> None:
    pending = [i for i in items if not is_installed(i, deep=deep_verify)]
    print(describe_plan(items), file=sys.stderr)
    if not pending:
        for item in items:
            if item.extract and item.expect and not item.expect.exists():
                extract(item)
        return
    if not assume_yes:
        if not sys.stdin.isatty():
            raise SystemExit("Refusing to download without confirmation. Re-run with --yes after reviewing the plan.")
        answer = input("Download these files now? [y/N] ").strip().lower()
        if answer not in {"y", "yes"}:
            raise SystemExit("Nothing downloaded.")
    for item in pending:
        print(f"Fetching {item.key}...", file=sys.stderr)
        host = fetch(item, progress=_console_progress)
        extract(item)
        record(item, host)
    for item in items:
        if item.extract and item.expect and not item.expect.exists():
            extract(item)


def verify_all(items: List[Item]) -> Dict[str, str]:
    """Re-hash every installed file. Returns key -> ok|missing|corrupt."""
    result = {}
    for item in items:
        if not item.dest.is_file():
            result[item.key] = "missing"
        elif item.dest.stat().st_size != item.size or sha256_file(item.dest) != item.sha256:
            result[item.key] = "corrupt"
        else:
            result[item.key] = "ok"
    return result
