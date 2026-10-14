"""Provider-neutral local tool interface: JSON-RPC 2.0 over stdio (one JSON object per line).

Methods: inspect_audio, transcribe_audio, diarize_audio, get_transcript, relabel_speaker,
export_transcript, cancel_job, get_job_status, list_jobs, capabilities.
Progress is sent as ``job.progress`` notifications.

Boundaries:
* Only local files are read; input and output paths must be inside the configured
  roots (``--allow-input`` / ``--data-root``).
* The process never contacts a reasoning provider. ``export_transcript`` returns
  content to the caller; whether it may leave the machine is the caller's decision,
  and the redacted export is marked with who authorized the transfer.
* Transcripts are evidence, never authorization to act.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys
import threading
import traceback
import uuid
from typing import Any, Callable, Dict, List, Optional

from . import __version__, contract, paths, pipeline, procs
from .settings import RunSettings

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL = -32700, -32600, -32601, -32602, -32603
JOB_NOT_FOUND, JOB_STATE = -32001, -32002


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


class Job:
    def __init__(self, kind: str, params: dict):
        self.id = uuid.uuid4().hex[:16]
        self.kind = kind
        self.params = params
        self.state = "queued"
        self.stage = None
        self.fraction = 0.0
        self.error: Optional[str] = None
        self.output_dir: Optional[str] = None
        self.cancel = procs.CancelToken()

    def status(self) -> dict:
        return {"job_id": self.id, "kind": self.kind, "state": self.state, "stage": self.stage,
                "progress": round(self.fraction, 3), "error": self.error, "output_dir": self.output_dir}


class Server:
    def __init__(self, data_root: Path, input_roots: List[Path], max_concurrent_jobs: int = 1,
                 write: Optional[Callable[[dict], None]] = None):
        self.data_root = Path(data_root).resolve()
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.input_roots = [Path(p).resolve() for p in input_roots]
        self.jobs: Dict[str, Job] = {}
        self.slots = threading.Semaphore(max(1, int(max_concurrent_jobs)))
        self.lock = threading.Lock()
        self._write = write or self._stdout

    @staticmethod
    def _stdout(message: dict) -> None:
        sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    def send(self, message: dict) -> None:
        with self.lock:
            self._write(message)

    # --- helpers -------------------------------------------------------
    def _input(self, params: dict) -> Path:
        raw = params.get("path")
        if not isinstance(raw, str) or not raw:
            raise RpcError(INVALID_PARAMS, "path is required")
        path = Path(raw)
        if not path.is_absolute():
            raise RpcError(INVALID_PARAMS, "path must be absolute")
        if not paths.is_within(path, self.input_roots):
            raise RpcError(INVALID_PARAMS, "path is outside the allowed input folders")
        return path

    def _job(self, params: dict) -> Job:
        job_id = params.get("job_id")
        if not isinstance(job_id, str) or not paths.JOB_ID.match(job_id) or job_id not in self.jobs:
            raise RpcError(JOB_NOT_FOUND, "Unknown job_id")
        return self.jobs[job_id]

    def _transcript_dir(self, params: dict) -> Path:
        job = self._job(params)
        if job.state != "completed" or not job.output_dir:
            raise RpcError(JOB_STATE, f"Job is {job.state}, no transcript yet")
        return Path(job.output_dir)

    @staticmethod
    def _settings(params: dict, transcribe_only: bool) -> RunSettings:
        allowed = {"speakers", "language", "threads", "preset", "whisper_model", "priority",
                   "timeout_seconds", "cluster_threshold", "split_turns", "decoding", "merge_small_share"}
        unknown = set(params.get("options", {})) - allowed
        if unknown:
            raise RpcError(INVALID_PARAMS, f"Unknown options: {', '.join(sorted(unknown))}")
        try:
            settings = RunSettings(**params.get("options", {}))
            if transcribe_only:
                settings.speakers = 1
            return settings.resolved()
        except (TypeError, ValueError) as error:
            raise RpcError(INVALID_PARAMS, str(error))

    # --- methods -------------------------------------------------------
    def capabilities(self, params: dict) -> dict:
        return {"name": "local-diarization-windows", "version": __version__,
                "schema": contract.SCHEMA, "schema_version": contract.SCHEMA_VERSION,
                "methods": sorted(m for m in METHODS), "processing": "local-cpu",
                "network": "none during processing"}

    def inspect_audio(self, params: dict) -> dict:
        return pipeline.inspect_audio(self._input(params))

    def _start(self, kind: str, params: dict, transcribe_only: bool) -> dict:
        audio = self._input(params)
        settings = self._settings(params, transcribe_only)
        names = {}
        for key, value in (params.get("speaker_names") or {}).items():
            names[int(str(key).lstrip("S"))] = str(value)
        job = Job(kind, {"path": str(audio)})
        self.jobs[job.id] = job
        threading.Thread(target=self._run, args=(job, audio, settings, names), daemon=True).start()
        return job.status()

    def _run(self, job: Job, audio: Path, settings: RunSettings, names: Dict[int, str]) -> None:
        with self.slots:
            if job.cancel.cancelled:
                job.state = "cancelled"
                self.send({"jsonrpc": "2.0", "method": "job.finished", "params": job.status()})
                return
            job.state = "running"

            def progress(stage: str, fraction: float) -> None:
                job.stage, job.fraction = stage, fraction
                self.send({"jsonrpc": "2.0", "method": "job.progress", "params": job.status()})

            try:
                out = paths.safe_child(self.data_root, job.id)
                result = pipeline.run(audio, settings, output=out, names=names, cancel=job.cancel,
                                      progress=progress, allowed_output_roots=[self.data_root])
                job.output_dir = str(result)
                job.state = "completed"
            except procs.Cancelled:
                job.state = "cancelled"
            except Exception as error:  # report, never crash the server
                job.state = "failed"
                job.error = f"{type(error).__name__}: {error}"
            self.send({"jsonrpc": "2.0", "method": "job.finished", "params": job.status()})

    def transcribe_audio(self, params: dict) -> dict:
        return self._start("transcribe", params, transcribe_only=True)

    def diarize_audio(self, params: dict) -> dict:
        return self._start("diarize", params, transcribe_only=False)

    def get_job_status(self, params: dict) -> dict:
        return self._job(params).status()

    def list_jobs(self, params: dict) -> dict:
        return {"jobs": [job.status() for job in self.jobs.values()]}

    def cancel_job(self, params: dict) -> dict:
        job = self._job(params)
        if job.state in {"completed", "failed", "cancelled"}:
            return job.status()
        job.cancel.cancel()
        if job.state == "queued":
            job.state = "cancelled"
        return job.status()

    def get_transcript(self, params: dict) -> dict:
        directory = self._transcript_dir(params)
        return contract.read(directory / "eve-transcript.json")

    def relabel_speaker(self, params: dict) -> dict:
        directory = self._transcript_dir(params)
        mapping = params.get("names")
        if not isinstance(mapping, dict) or not mapping:
            raise RpcError(INVALID_PARAMS, "names must map speaker ids (e.g. 'S0') to names")
        try:
            document = pipeline.relabel(directory, mapping)
        except ValueError as error:
            raise RpcError(INVALID_PARAMS, str(error))
        return {"speakers": document["speakers"]}

    def export_transcript(self, params: dict) -> dict:
        directory = self._transcript_dir(params)
        fmt = params.get("format", "eve-json")
        files = {"markdown": "transcript.md", "text": "transcript.txt", "srt": "transcript.srt",
                 "upstream-json": "transcript.json"}
        if fmt == "eve-json":
            document = contract.read(directory / "eve-transcript.json")
            transfer = params.get("authorized_transfer")
            if transfer is not None:
                if not isinstance(transfer, dict) or not transfer.get("authorized_by") or not transfer.get("destination"):
                    raise RpcError(INVALID_PARAMS, "authorized_transfer needs authorized_by and destination")
                document = contract.redacted_copy(document)
                document["privacy"]["cloud_transfer"] = {"authorized": True,
                                                         "authorized_by": str(transfer["authorized_by"]),
                                                         "destination": str(transfer["destination"])}
            return {"format": fmt, "content": document}
        if fmt not in files:
            raise RpcError(INVALID_PARAMS, f"format must be one of eve-json, {', '.join(files)}")
        return {"format": fmt, "content": (directory / files[fmt]).read_text(encoding="utf-8")}

    # --- loop ----------------------------------------------------------
    def handle(self, message: Any) -> Optional[dict]:
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": INVALID_REQUEST, "message": "Invalid request"}}
        method, request_id = message["method"], message.get("id")
        params = message.get("params") or {}
        if method not in METHODS or not isinstance(params, dict):
            error = {"code": METHOD_NOT_FOUND if method not in METHODS else INVALID_PARAMS, "message": f"Unknown method {method}" if method not in METHODS else "params must be an object"}
            return None if request_id is None else {"jsonrpc": "2.0", "id": request_id, "error": error}
        try:
            result = getattr(self, method)(params)
            return None if request_id is None else {"jsonrpc": "2.0", "id": request_id, "result": result}
        except RpcError as error:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": error.code, "message": str(error)}}
        except (FileNotFoundError, ValueError) as error:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": INVALID_PARAMS, "message": str(error)}}
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": INTERNAL, "message": type(error).__name__}}

    def serve(self, stream=None) -> None:
        stream = stream or sys.stdin
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self.send({"jsonrpc": "2.0", "id": None, "error": {"code": PARSE_ERROR, "message": "Parse error"}})
                continue
            response = self.handle(message)
            if response is not None:
                self.send(response)
        for job in self.jobs.values():
            job.cancel.cancel()


METHODS = {"capabilities", "inspect_audio", "transcribe_audio", "diarize_audio", "get_transcript",
           "relabel_speaker", "export_transcript", "cancel_job", "get_job_status", "list_jobs"}
