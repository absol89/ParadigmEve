"""Native pipeline: ffmpeg -> whisper.cpp -> sherpa-onnx -> upstream alignment/rendering.

All heavy steps are bounded child processes (see ``procs``). Upstream functions are
used for segment parsing, alignment and rendering so output formats are unchanged.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys
import tempfile
import time
from typing import Callable, Dict, Optional

from . import __version__, contract, paths, procs
from .settings import RunSettings

ProgressFn = Callable[[str, float], None]  # (stage, fraction 0..1)

AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".mp4", ".aac", ".flac", ".ogg", ".opus", ".webm", ".wma", ".mkv", ".mov"}
MAX_INPUT_BYTES = 8 * 1024 ** 3


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def inspect_audio(audio: Path, timeout: float = 60) -> dict:
    """Probe an untrusted media file with ffprobe (local files only)."""
    audio = validate_input(audio)
    ffprobe = paths.find_tool("ffprobe")
    if ffprobe is None:
        raise FileNotFoundError("ffprobe was not found. Run setup-windows.ps1 or 'diarize doctor'.")
    with tempfile.TemporaryDirectory(dir=_temp_root(None)) as tmp:
        out = Path(tmp) / "probe.json"
        procs.run([
            ffprobe, "-v", "error", "-protocol_whitelist", "file",
            "-show_entries", "format=duration,format_name,size:stream=codec_type,codec_name,sample_rate,channels",
            "-of", "json", "-o", str(out), "file:" + str(audio),
        ], name="ffprobe", timeout=timeout)
        data = json.loads(out.read_text(encoding="utf-8"))
    streams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
    if not streams:
        raise RuntimeError("The file contains no audio stream")
    fmt = data.get("format", {})
    return {
        "file_name": audio.name,
        "size_bytes": audio.stat().st_size,
        "duration_seconds": round(float(fmt.get("duration", 0) or 0), 3),
        "container": fmt.get("format_name"),
        "audio_streams": [{k: s.get(k) for k in ("codec_name", "sample_rate", "channels")} for s in streams],
    }


def validate_input(audio: Path) -> Path:
    audio = Path(audio).expanduser()
    if not audio.is_absolute():
        audio = Path.cwd() / audio
    audio = audio.resolve()
    if not audio.is_file():
        raise FileNotFoundError(f"Input recording was not found: {audio.name}")
    if audio.suffix.lower() not in AUDIO_EXTENSIONS:
        raise ValueError(f"Unsupported input type {audio.suffix!r}")
    if audio.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("Input recording is larger than 8 GB")
    return audio


def _temp_root(requested: Optional[Path]) -> Path:
    root = Path(requested) if requested else paths.TEMP
    root.mkdir(parents=True, exist_ok=True)
    return root


def output_directory(audio: Path, requested: Optional[Path], allowed_roots=None) -> Path:
    if requested is not None:
        requested = Path(requested).expanduser().resolve()
        if allowed_roots is not None and not paths.is_within(requested, allowed_roots):
            raise ValueError("Output directory is outside the allowed output roots")
        requested.mkdir(parents=True, exist_ok=True)
        return requested
    paths.OUTPUTS.mkdir(parents=True, exist_ok=True)
    stem = paths.safe_stem(audio.stem)
    for index in range(1, 10000):
        name = stem if index == 1 else f"{stem}-{index}"
        candidate = paths.safe_child(paths.OUTPUTS, name)
        try:
            candidate.mkdir()
            return candidate
        except FileExistsError:
            continue
    raise RuntimeError("Could not allocate an output directory")


def _require(path: Optional[Path], what: str) -> Path:
    if path is None or not Path(path).is_file():
        raise FileNotFoundError(f"{what} is missing. Run 'diarize doctor' for setup instructions.")
    return Path(path)


def _stats(bp: procs.BoundedProcess) -> dict:
    return {"peak_memory_bytes": bp.peak_memory_bytes, "cpu_seconds": round(bp.cpu_seconds, 3) if bp.cpu_seconds else None,
            "wall_seconds": round(bp.wall_seconds, 3) if bp.wall_seconds else None}


def device_args(backend: str, gpu_index: Optional[int]) -> list:
    """whisper-cli flags for the backend actually being used. CPU always passes -ng, so a Vulkan
    binary used as CPU fallback cannot quietly pick up a GPU."""
    if backend == "vulkan":
        return ["-dev", str(gpu_index or 0)]
    return ["-ng"]


def plan_asr_execution(settings: RunSettings, probe: Optional[dict]) -> dict:
    """Decide which whisper.cpp binary/backend to try first. Pure, so it is unit-testable."""
    from . import gpu as gpu_mod

    cpu_cli = paths.find_whisper_cli()
    if settings.asr_device != "gpu":
        return {"requested": "cpu", "backend": "cpu", "cli": cpu_cli, "gpu_index": None, "device": None,
                "fallback_reason": None}
    if not probe or probe.get("status") != gpu_mod.USABLE:
        reason = (probe or {}).get("reason") or "GPU capability was not proven"
        return {"requested": "gpu", "backend": "cpu", "cli": cpu_cli, "gpu_index": None, "device": None,
                "fallback_reason": f"{(probe or {}).get('status', 'unknown')}: {reason}"}
    selected = probe["selected"]
    index = settings.gpu_device if settings.gpu_device is not None else selected["gpu_index"]
    devices = {d.get("gpu_index"): d for d in probe.get("devices", []) if d.get("type") == "gpu"}
    if index not in devices or not devices[index].get("usable"):
        return {"requested": "gpu", "backend": "cpu", "cli": cpu_cli, "gpu_index": None, "device": None,
                "fallback_reason": f"device-unavailable: GPU {index} did not pass the compute check"}
    return {"requested": "gpu", "backend": "vulkan", "cli": gpu_mod.find_gpu_whisper_cli(), "gpu_index": index,
            "device": devices[index].get("description") or devices[index].get("name"), "fallback_reason": None}


def _transcribe(whisper_cli: Path, whisper_model: Path, wav: Path, tmp_path: Path, settings: RunSettings,
                timeout: float, cancel, progress, timings: dict, peaks: dict,
                backend: str = "cpu", gpu_index: Optional[int] = None, log: Optional[list] = None) -> dict:
    progress("transcribe", 0.0)
    prefix = tmp_path / "whisper"
    command = [
        whisper_cli, "-m", paths.ascii_safe(whisper_model), "-f", wav,
        "-l", settings.language, "-t", str(settings.threads), "-ojf", "-of", prefix,
        "-pp", *device_args(backend, gpu_index),
    ]
    if settings.decoding == "greedy":
        command += ["-bs", "1", "-bo", "1"]
    if settings.max_context is not None:
        command += ["-mc", str(settings.max_context)]

    def on_whisper(line: str) -> None:
        if log is not None and len(log) < 400:
            log.append(line)
        match = re.search(r"progress\s*=\s*(\d+)%", line)
        if match:
            progress("transcribe", int(match.group(1)) / 100)

    t0 = time.perf_counter()
    bp = procs.run(command, name="whisper-cli", timeout=timeout, cancel=cancel,
                   priority=settings.priority, memory_limit=settings.process_memory_limit,
                   on_stderr_line=on_whisper)
    timings["transcription"] = time.perf_counter() - t0
    peaks["whisper"] = _stats(bp)
    whisper_json = prefix.with_suffix(".json")
    if not whisper_json.is_file():
        raise RuntimeError("Whisper did not produce a JSON result")
    return json.loads(whisper_json.read_text(encoding="utf-8"))


def _apply_capture_evidence(audio: Path, segments) -> Optional[dict]:
    """If ``audio`` is the mix.wav of a ``diarize record`` folder, add capture-integrity and
    source-track evidence to every segment. Returns the integrity summary or None."""
    folder = audio.parent
    if audio.name != "mix.wav" or not (folder / "capture.json").is_file() or not (folder / "mic.wav").is_file():
        return None
    from . import integrity
    import numpy as np
    import soundfile as sf

    capture = json.loads((folder / "capture.json").read_text(encoding="utf-8"))
    report = capture.get("integrity") or integrity.assess(folder)
    tracks = {}
    for label in ("mic", "system"):
        path = folder / f"{label}.wav"
        if path.is_file():
            data, rate = sf.read(str(path), dtype="float32", always_2d=True)
            tracks[label] = (data.mean(axis=1), rate)

    def levels(start: float, end: float) -> dict:
        out = {}
        for label, (data, rate) in tracks.items():
            chunk = data[int(start * rate):int(end * rate)]
            out[label] = round(float(20 * np.log10(np.sqrt(np.mean(chunk ** 2)) + 1e-9)), 1) if len(chunk) else None
        return out

    contract.apply_capture(segments, report.get("anomalies", []), levels)
    summary = {k: v for k, v in report.items() if k != "anomalies"}
    summary["anomaly_spans"] = len(report.get("anomalies", []))
    return summary


def rediarize(out_dir: Path, settings: RunSettings, output: Optional[Path] = None, cancel=None,
              progress=None) -> Path:
    """Re-run only speaker diarization and re-align the saved raw Whisper result.

    Results go to a NEW folder (default ``<out_dir>-rediarized``, numbered if taken); earlier
    output is never rewritten. Names and roles are not carried over because cluster numbers
    can change; they are listed under ``source.derived_from`` for explicit re-application.
    """
    out_dir = Path(out_dir).resolve()
    document = contract.read(out_dir / "eve-transcript.json")
    whisper_json = out_dir / "whisper.json"
    if not whisper_json.is_file():
        raise FileNotFoundError("whisper.json is missing; a full run is needed")
    if output is None:
        for index in range(1, 1000):
            candidate = out_dir.with_name(out_dir.name + ("-rediarized" if index == 1 else f"-rediarized-{index}"))
            if not candidate.exists():
                output = candidate
                break
    output = Path(output).resolve()
    if output == out_dir or (output / "eve-transcript.json").exists():
        raise ValueError("rediarize writes to a new folder; it never rewrites an existing transcript")
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(whisper_json, output / "whisper.json")  # first-pass ASR, copied unchanged
    previous = document["provenance"].get("settings", {})
    settings.whisper_model = previous.get("whisper_model", settings.whisper_model)
    settings.language = previous.get("language", settings.language)
    derived = {"derived_from": {
        "path": str(out_dir), "transcript_id": document["transcript_id"],
        "previous_speakers": [{k: sp.get(k) for k in ("id", "name", "role")} for sp in document["speakers"]],
        "note": "Names and roles were not carried over: cluster numbers can change."}}
    return run(Path(document["source"]["path"]), settings, output=output, cancel=cancel, progress=progress,
               source_extra={**{k: v for k, v in document["source"].items() if k == "capture"}, **derived},
               reuse_whisper_json=output / "whisper.json")


def _python_for_worker() -> str:
    venv = paths.ROOT / "runtime" / ("python.exe" if paths.IS_WINDOWS else "bin/python")
    return str(venv) if venv.is_file() else sys.executable


def _transcribe_local(whisper_model: Path, wav: Path, tmp_path: Path, settings: RunSettings, timeout: float,
                      cancel, progress, timings: dict, peaks: dict) -> tuple:
    """Local whisper.cpp on the requested device. Returns (whisper_document, asr_execution).

    asr_execution says what really ran: ``backend`` is "vulkan" only when whisper.cpp's own log
    reports initialising the Vulkan device. A GPU run that fails, or that whisper.cpp silently runs
    on CPU, is never reported as GPU; with ``gpu_fallback`` it is rerun on the CPU binary and the
    fallback and its reason are recorded.
    """
    from . import gpu as gpu_mod

    probe = gpu_mod.probe() if settings.asr_device == "gpu" else None
    plan = plan_asr_execution(settings, probe)
    execution = {"requested": plan["requested"], "backend": "cpu", "device": None, "gpu_index": None,
                 "binary": "cpu", "fallback": None,
                 "probe": None if probe is None else {k: probe.get(k) for k in ("status", "reason", "selected")}}
    if plan["requested"] == "gpu" and plan["backend"] != "vulkan":
        if not settings.gpu_fallback:
            raise RuntimeError(f"GPU transcription unavailable ({plan['fallback_reason']}) and CPU fallback is off")
        execution["fallback"] = {"from": "gpu", "to": "cpu", "reason": plan["fallback_reason"]}
        _log(f"GPU transcription unavailable ({plan['fallback_reason']}); using CPU.")
    if plan["backend"] == "vulkan":
        log: list = []
        try:
            document = _transcribe(plan["cli"], whisper_model, wav, tmp_path, settings, timeout, cancel, progress,
                                   timings, peaks, backend="vulkan", gpu_index=plan["gpu_index"], log=log)
            observed = gpu_mod.backend_from_log(log)
            if observed["backend"] == "vulkan":
                execution.update({"backend": "vulkan", "device": observed["device"] or plan["device"],
                                  "gpu_index": plan["gpu_index"], "binary": "vulkan"})
                execution["cli_path"] = plan["cli"]
                return document, execution
            reason = "whisper.cpp did not report initialising the Vulkan device"
        except procs.Cancelled:
            raise
        except Exception as error:  # GPU run failed (driver, out of VRAM, crash)
            reason = f"GPU run failed: {error}"[:400]
        if not settings.gpu_fallback:
            raise RuntimeError(f"GPU transcription failed ({reason}) and CPU fallback is off")
        execution["fallback"] = {"from": "gpu", "to": "cpu", "reason": reason}
        _log(f"GPU transcription failed ({reason}); retrying on CPU.")
        timings["transcription_gpu_attempt"] = timings.pop("transcription", 0.0)
        peaks["whisper_gpu_attempt"] = peaks.pop("whisper", None)
    cpu_cli = paths.find_whisper_cli()
    _require(cpu_cli, "whisper-cli (whisper.cpp CPU build)")
    document = _transcribe(cpu_cli, whisper_model, wav, tmp_path, settings, timeout, cancel, progress,
                           timings, peaks, backend="cpu")
    execution["cli_path"] = cpu_cli
    return document, execution


def run(audio: Path, settings: RunSettings, output: Optional[Path] = None,
        names: Optional[Dict[int, str]] = None, cancel: Optional[procs.CancelToken] = None,
        progress: Optional[ProgressFn] = None, allowed_output_roots=None,
        source_extra: Optional[dict] = None, reuse_whisper_json: Optional[Path] = None) -> Path:
    """Full pipeline. With ``reuse_whisper_json`` the transcription step is skipped and the
    saved raw Whisper result is re-aligned against a fresh diarization (``rediarize``)."""
    settings.resolved()
    cancel = cancel or procs.CancelToken()
    progress = progress or (lambda stage, fraction: None)
    upstream = paths.import_upstream()
    names = names or {}

    audio = validate_input(audio)
    ffmpeg = _require(paths.find_tool("ffmpeg"), "FFmpeg")
    whisper_cli = paths.find_whisper_cli()
    if settings.asr == "local":
        _require(whisper_cli, "whisper-cli (whisper.cpp build)")
    asr_execution: dict = ({"requested": "cloud", "backend": settings.asr, "device": None, "fallback": None}
                           if settings.asr in ("groq", "openai") else
                           {"requested": "reused", "backend": None, "device": None, "fallback": None,
                            "note": "first-pass ASR reused from an earlier run; see its provenance"})
    whisper_model = paths.whisper_model_path(settings.whisper_model)
    if reuse_whisper_json is None:
        _require(whisper_model, f"Whisper model {settings.whisper_model}")
    segmentation = _require(paths.segmentation_model_path(), "Segmentation model")
    embedding = _require(paths.embedding_model_path(), "Speaker embedding model")

    out_dir = output_directory(audio, output, allowed_output_roots)
    started = time.perf_counter()
    peaks: Dict[str, dict] = {}
    timings: Dict[str, float] = {}
    _log(f"Output: {out_dir}")

    progress("hash", 0.0)
    recording_id = "sha256:" + file_sha256(audio)
    cancel.check()

    with tempfile.TemporaryDirectory(prefix="ldw-", dir=_temp_root(settings.temp_dir)) as tmp:
        tmp_path = Path(tmp)
        wav = tmp_path / "audio.wav"

        progress("convert", 0.0)
        t0 = time.perf_counter()
        bp = procs.run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-protocol_whitelist", "file", "-i", "file:" + str(audio),
            "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav),
        ], name="ffmpeg", timeout=settings.timeout_seconds or 3600, cancel=cancel,
            priority=settings.priority, memory_limit=settings.process_memory_limit)
        timings["convert"] = time.perf_counter() - t0
        peaks["ffmpeg"] = _stats(bp)
        duration = os.path.getsize(wav) / (16000 * 2)
        # Generous default: 6x real time per stage, at least 10 minutes.
        stage_timeout = settings.timeout_seconds or max(600.0, duration * 6)

        if reuse_whisper_json is not None:
            whisper_document = json.loads(Path(reuse_whisper_json).read_text(encoding="utf-8"))
        else:
            if settings.asr in ("groq", "openai"):
                from . import cloud_asr

                _log(f"Uploading audio to {settings.asr} for transcription (--asr {settings.asr}). "
                     "Speaker separation stays local.")
                progress("transcribe", 0.0)
                t0 = time.perf_counter()
                whisper_document = cloud_asr.transcribe(wav, duration, settings.language, settings.cloud_model,
                                                        cancel=cancel, progress=progress, tmp=tmp_path,
                                                        provider=settings.asr)
                timings["transcription"] = time.perf_counter() - t0
                (tmp_path / "whisper.json").write_text(json.dumps(whisper_document, ensure_ascii=False), encoding="utf-8")
            else:
                whisper_document, asr_execution = _transcribe_local(whisper_model, wav, tmp_path, settings,
                                                                   stage_timeout, cancel, progress, timings, peaks)
                whisper_cli = asr_execution.pop("cli_path")
            shutil.copyfile(tmp_path / "whisper.json", out_dir / "whisper.json")

        progress("diarize", 0.0)
        request = tmp_path / "diarize-request.json"
        result = tmp_path / "diarize-result.json"
        request.write_text(json.dumps({
            "upstream_src": str(paths.UPSTREAM / "src"),
            "audio": str(wav), "segmentation_model": str(segmentation), "embedding_model": str(embedding),
            "speakers": settings.speakers, "threads": settings.threads, "threshold": settings.cluster_threshold,
            "merge_small_share": settings.merge_small_share,
        }), encoding="utf-8")

        def on_diarize(line: str) -> None:
            match = re.search(r"Diarization:\s*(\d+)%", line)
            if match:
                progress("diarize", int(match.group(1)) / 100)

        env = dict(os.environ, PYTHONPATH=str(paths.ROOT), PYTHONIOENCODING="utf-8")
        t0 = time.perf_counter()
        bp = procs.run([_python_for_worker(), "-m", "ldw.diarize_worker", request, result],
                       name="diarization", timeout=stage_timeout, cancel=cancel,
                       priority=settings.priority, memory_limit=settings.process_memory_limit,
                       on_stderr_line=on_diarize, env=env, cwd=paths.ROOT)
        timings["diarization"] = time.perf_counter() - t0
        peaks["diarization"] = _stats(bp)
        diarization_document = json.loads(result.read_text(encoding="utf-8"))

        # Audio evidence per segment, then selective recovery of suspect spans.
        from . import evidence

        progress("verify", 0.0)
        for stale in ("recovery.json", "whisper.recovered.json"):
            (out_dir / stale).unlink(missing_ok=True)
        audio_data = evidence.Audio(wav)
        evidence.measure(whisper_document, audio_data, diarization_document["segments"])
        if settings.recover and whisper_cli is not None and whisper_model.is_file():
            def transcribe_span(start: float, end: float) -> dict:
                span_dir = Path(tempfile.mkdtemp(prefix="span-", dir=tmp_path))
                prefix = span_dir / "whisper"
                procs.run([whisper_cli, "-m", paths.ascii_safe(whisper_model), "-f", wav,
                           "-l", settings.language, "-t", str(settings.threads), "-ojf", "-of", prefix,
                           *device_args(asr_execution.get("backend") or "cpu", asr_execution.get("gpu_index")),
                           "-mc", "0", "-ot", str(int(start * 1000)), "-d", str(int((end - start) * 1000))],
                          name="whisper-cli (recovery)", timeout=stage_timeout, cancel=cancel,
                          priority=settings.priority, memory_limit=settings.process_memory_limit)
                return json.loads(prefix.with_suffix(".json").read_text(encoding="utf-8"))

            t0 = time.perf_counter()
            recovery_log = evidence.recover(whisper_document, transcribe_span, duration, audio_data,
                                            diarization_document["segments"])
            timings["recovery"] = time.perf_counter() - t0
            (out_dir / "recovery.json").write_text(json.dumps(recovery_log, ensure_ascii=False, indent=2), encoding="utf-8")
            if recovery_log["spans"]:
                (out_dir / "whisper.recovered.json").write_text(
                    json.dumps(evidence.clean_for_storage(whisper_document), ensure_ascii=False, indent=2), encoding="utf-8")
        del audio_data

        if settings.keep_intermediate_wav:
            shutil.copyfile(wav, out_dir / "audio-16k-mono.wav")

    cancel.check()
    progress("align", 0.0)
    (out_dir / "diarization.json").write_text(json.dumps(diarization_document, ensure_ascii=False, indent=2), encoding="utf-8")
    segments = contract.build_segments(upstream, whisper_document, diarization_document["segments"],
                                       recording_id, settings.split_turns)
    capture_report = _apply_capture_evidence(audio, segments)
    if capture_report is not None:
        source_extra = {**(source_extra or {}), "capture_integrity": capture_report}
    detected = whisper_document.get("result", {}).get("language", settings.language)
    lock = paths.load_lock()
    model_hashes = {
        "whisper": {"name": whisper_model.name, "sha256": lock["whisper_models"].get(settings.whisper_model, {}).get("sha256")},
        "segmentation": {"name": "sherpa-onnx-pyannote-segmentation-3-0", "archive_sha256": lock["downloads"]["segmentation"]["sha256"]},
        "embedding": {"name": embedding.name, "sha256": lock["downloads"]["embedding"]["sha256"]},
    }
    provenance = {
        "pipeline": {"name": "local-diarization-windows", "version": __version__},
        "upstream": {"repository": lock["upstream"]["repository"], "commit": lock["upstream"]["commit"]},
        "whisper_cpp": {"tag": lock["whisper_cpp"]["tag"], "commit": lock["whisper_cpp"]["commit"],
                        "backend": asr_execution.get("backend")},
        # What really transcribed the words: cpu | vulkan | groq | openai, the GPU device name when
        # one was used, and whether a requested GPU run fell back to CPU (and why).
        "asr_execution": asr_execution,
        "models": model_hashes,
        "settings": settings.to_json(),
        "host": {"os": platform.platform(), "machine": platform.machine(), "python": platform.python_version()},
    }
    source = {
        "recording_id": recording_id,
        "file_name": audio.name,
        "path": str(audio),
        "size_bytes": audio.stat().st_size,
        "duration_seconds": diarization_document.get("duration_seconds"),
        **(source_extra or {}),
    }
    document = contract.build_document(
        segments=segments, diarization_segments=diarization_document["segments"], source=source,
        language={"requested": settings.language, "detected": detected}, provenance=provenance,
        names=contract.names_from_mapping(names),
        raw_files={"whisper": "whisper.json", "diarization": "diarization.json", "run": "run.json",
                   **({"recovery": "recovery.json"} if (out_dir / "recovery.json").is_file() else {}),
                   **({"whisper_recovered": "whisper.recovered.json"} if (out_dir / "whisper.recovered.json").is_file() else {})},
    )
    if settings.asr in ("groq", "openai"):
        document["privacy"].update({
            "processing": "cloud_asr", "network_used": True,
            "cloud_transfer": {"authorized": True, "authorized_by": f"user (--asr {settings.asr})",
                               "destination": settings.asr,
                               "data": "audio (opus 32 kbps) for transcription; speaker separation ran locally"},
        })
        document["provenance"]["asr"] = whisper_document.get("model")
    contract.write(out_dir / "eve-transcript.json", document)
    render_all(out_dir, document)

    total = time.perf_counter() - started
    (out_dir / "run.json").write_text(json.dumps({
        "title": audio.stem,
        "source": str(audio),
        "language": detected,
        "requested_speakers": settings.speakers,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "tool_version": __version__,
        "upstream_commit": lock["upstream"]["commit"],
        "runtime_seconds": {**{k: round(v, 3) for k, v in timings.items()},
                            "diarization_inner": diarization_document.get("elapsed_seconds"),
                            "total": round(total, 3)},
        "audio_seconds": diarization_document.get("duration_seconds"),
        "real_time_factor": round(total / diarization_document["duration_seconds"], 4)
        if diarization_document.get("duration_seconds") else None,
        "processes": peaks,
        "asr_execution": asr_execution,
        "logical_cpus": os.cpu_count(),
        "models": {k: v["name"] for k, v in model_hashes.items()},
        "settings": settings.to_json(),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    progress("done", 1.0)
    _log(f"Finished in {total:.1f} seconds")
    return out_dir


def render_all(out_dir: Path, document: dict) -> None:
    """Render md/txt/srt/transcript.json with the upstream renderer from the contract."""
    upstream = paths.import_upstream()
    aligned = contract.to_upstream_aligned(document["segments"])
    metadata = {
        "title": Path(document["source"].get("file_name", "recording")).stem,
        "source": document["source"].get("path", document["source"].get("file_name")),
        "language": document["language"].get("detected"),
        "requested_speakers": document["provenance"].get("settings", {}).get("speakers"),
        "created_at": document["created_at"],
        "tool_version": __version__,
        "contract": {"schema": document["schema"], "schema_version": document["schema_version"],
                     "transcript_id": document["transcript_id"]},
    }
    upstream.render_outputs(out_dir, aligned, contract.upstream_names(document), metadata)
    _append_evidence_section(out_dir / "transcript.md", document)


def _append_evidence_section(md_path: Path, document: dict) -> None:
    """Add an evidence summary to transcript.md so readers see what the labels do not prove."""
    segments = document["segments"]
    counts = document.get("quality", {}).get("evidence_status_counts", {})
    upstream_mod = paths.import_upstream()
    stamp = upstream_mod.readable_timestamp
    turns = len(upstream_mod.group_segments(contract.to_upstream_aligned(segments), contract.upstream_names(document)))
    text = md_path.read_text(encoding="utf-8")
    # The upstream line says "Confidence"; make clear what that number measures.
    text = re.sub(r"^- Segments: (\d+)$",
                  lambda m: f"- Segments: {m.group(1)} in eve-transcript.json, shown above as {turns} turns "
                            "(consecutive segments from the same speaker with the same score are merged)",
                  text, flags=re.M)
    text = re.sub(r"^- Confidence: ", "- Speaker-overlap (alignment) score, not word accuracy: ", text, flags=re.M)
    md_path.write_text(text, encoding="utf-8")
    lines = ["", "## Evidence", "",
             "Speaker labels and the confidence counts above come from timestamp overlap. They do not "
             "verify the words. Nothing here has been checked by a person.", "",
             "- Segment evidence: " + (", ".join(f"{v} {k.replace('_', ' ')}" for k, v in sorted(counts.items())) or "not measured")]
    provenance_counts = {}
    for seg in segments:
        kind = seg.get("content_provenance", {}).get("kind", "unclassified")
        provenance_counts[kind] = provenance_counts.get(kind, 0) + 1
    lines.append("- Content provenance: " + ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in sorted(provenance_counts.items()))
                 + ". Speaker roles come only from relabel --role; until set, nothing counts as a user instruction.")
    eligible = sum(1 for seg in segments if seg.get("content_provenance", {}).get("may_contain_user_instruction"))
    lines.append(f"- Segments eligible to carry a user instruction: {eligible} (live human speech, verified evidence, no doubted words)")
    capture = document["source"].get("capture_integrity")
    if capture:
        mic = capture.get("tracks", {}).get("mic", {})
        lines.append(f"- Capture integrity: **{capture.get('status')}**"
                     + (f" ({mic.get('exact_zero_seconds', 0)} s of exact digital silence in the mic track, "
                        f"{mic.get('drift_vs_wall_clock_seconds')} s drift vs wall clock)" if mic else ""))
        anomalous = sum(1 for seg in segments if "capture_anomaly" in seg["flags"])
        if anomalous:
            lines.append(f"  - {anomalous} segments overlap capture anomalies and are treated as unverified.")
    if segments:
        duration = document["source"].get("duration_seconds") or segments[-1]["end"]
        if segments[0]["start"] < 0.3:
            lines.append("- The recording starts mid-speech (first words at 00:00); earlier context is missing.")
        if duration and duration - segments[-1]["end"] < 0.3:
            lines.append("- The recording ends mid-speech; later context is missing.")
        gaps = [(a["end"], b["start"]) for a, b in zip(segments, segments[1:]) if b["start"] - a["end"] >= 3]
        if gaps:
            lines.append("- Gaps with no transcribed speech (3 s or longer): "
                         + ", ".join(f"{stamp(a)}–{stamp(b)}" for a, b in gaps))
    names = {s["id"]: s.get("name") or f"Speaker {s['cluster']}" for s in document["speakers"]}
    suppressed = [s for s in segments if s.get("evidence", {}).get("status") == "suppressed"]
    recovered = [s for s in segments if s.get("evidence", {}).get("status") == "recovered"]
    upstream = paths.import_upstream()
    stamp = upstream.readable_timestamp
    if suppressed:
        lines += ["", "**Suppressed (no verified speech; shown as placeholders above, not attributed to anyone):**", ""]
        for s in suppressed:
            lines.append(f"- [{stamp(s['start'])}–{stamp(s['end'])}] first-pass text: \"{s['evidence']['suppressed_text']}\"")
    if recovered:
        lines += ["", "**Recovered by re-transcribing a suspect span on its own:**", ""]
        groups = {}
        for s in recovered:
            key = json.dumps(s["evidence"].get("replaced_first_pass", []))
            groups.setdefault(key, []).append(s)
        for key, members in groups.items():
            originals = json.loads(key)
            collapsed = []
            for original in originals:
                if collapsed and collapsed[-1]["text"] == original["text"]:
                    collapsed[-1]["count"] += 1
                    collapsed[-1]["end"] = original["end"]
                else:
                    collapsed.append({**original, "count": 1})
            lines.append("- First pass:")
            for item in collapsed:
                repeat = f" (x{item['count']})" if item["count"] > 1 else ""
                lines.append(f"  - [{stamp(item['start'])}–{stamp(item['end'])}] \"{item['text']}\"{repeat}")
            lines.append("- Second pass:")
            for s in members:
                lines.append(f"  - [{stamp(s['start'])}] {names.get(s['speaker_id'], 'Uncertain speaker')}: \"{s['text']}\"")
    low = [(s, w) for s in segments for w in s["asr"].get("low_confidence_words", [])]
    seen_first = set()
    for s in recovered:  # doubts from a first pass that recovery replaced still matter
        for original in s["evidence"].get("replaced_first_pass", []):
            for w in original.get("low_confidence_words", []):
                key = (w["word"], w["start"])
                if key not in seen_first:
                    seen_first.add(key)
                    low.append((s, {**w, "word": w["word"] + " [first pass]"}))
    if low:
        lines += ["", "**Words Whisper itself was unsure of (token probability < 0.5):**", ""]
        lines.append(", ".join(f"\"{w['word']}\" ({w['probability']:.2f}) at {stamp(w['start'])}" for s, w in low[:60])
                     + (f", and {len(low) - 60} more" if len(low) > 60 else ""))
    with md_path.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def relabel(out_dir: Path, mapping: Dict[str, str], roles: Optional[Dict[str, str]] = None) -> dict:
    """Rename speakers (keys like 'S0' or '0') and set roles without re-running any model.
    Raw model outputs are untouched; every change is appended to ``label_history``."""
    out_dir = Path(out_dir).resolve()
    path = out_dir / "eve-transcript.json"
    document = contract.read(path)
    names = {}
    known = {s["id"] for s in document["speakers"]}
    for key, value in mapping.items():
        key = key if str(key).startswith("S") else f"S{int(key)}"
        if key not in known:
            raise ValueError(f"Unknown speaker {key}; known: {', '.join(sorted(known))}")
        value = str(value).strip()
        if not value or len(value) > 100 or any(ord(c) < 32 for c in value):
            raise ValueError("Speaker names must be 1-100 printable characters")
        names[key] = value
    role_map = {}
    for key, value in (roles or {}).items():
        key = key if str(key).startswith("S") else f"S{int(key)}"
        if key not in known:
            raise ValueError(f"Unknown speaker {key}; known: {', '.join(sorted(known))}")
        role_map[key] = value
    contract.apply_names(document, names, role_map)
    document.setdefault("label_history", []).append(
        {"at": datetime.now(timezone.utc).isoformat(), "names": names, "roles": role_map})
    contract.write(path, document)
    render_all(out_dir, document)
    return document
