"""Record the microphone and the PC's audio output at the same time.

Why loopback and not only "Stereo Mix": Stereo Mix is a driver feature that is
missing or disabled on many machines. WASAPI loopback captures whatever the
default output device plays (the remote side of a call), including when the user
wears headphones so the microphone never hears it. A Stereo Mix device can still
be chosen explicitly with ``--system-device``.

Output (all local):
  recordings/<timestamp>/mic.wav      microphone, mono
  recordings/<timestamp>/system.wav   output loopback, mono downmix
  recordings/<timestamp>/mix.wav      both, for the diarization pipeline
  recordings/<timestamp>/capture.json devices, timing, consent record

Nothing is uploaded. Recordings are never deleted by this tool.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import threading
import time
from typing import List, Optional

from . import paths, procs

RATE = 48000
BLOCK = RATE // 10  # 100 ms

CONSENT_TEXT = (
    "Recording captures your microphone AND everything your computer plays (the other "
    "people on a call). Make sure everyone being recorded has agreed. Audio stays on this "
    "computer; nothing is uploaded."
)


def _soundcard():
    try:
        import soundcard  # noqa: F401
    except Exception as error:  # pragma: no cover - depends on host audio stack
        raise RuntimeError(
            "Audio capture needs the 'soundcard' package in the local venv. Run setup-windows.ps1."
        ) from error
    import soundcard as sc

    return sc


def list_devices() -> dict:
    sc = _soundcard()
    microphones = [{"name": m.name, "id": str(m.id), "loopback": bool(getattr(m, "isloopback", False))}
                   for m in sc.all_microphones(include_loopback=True)]
    speakers = [{"name": s.name, "id": str(s.id)} for s in sc.all_speakers()]
    return {
        "default_microphone": sc.default_microphone().name,
        "default_speaker": sc.default_speaker().name,
        "microphones": microphones,
        "speakers": speakers,
        "stereo_mix_present": any("stereo mix" in m["name"].lower() for m in microphones),
    }


def _tolerant(recorder):
    """Stop soundcard from inventing silence when this thread is merely late.

    soundcard returns zeros once it has waited 4 device periods (~40 ms) without new
    frames, even if the wait was caused by CPU load and real audio is already buffered.
    Under load (e.g. a transcription running) that inserted ~15 s of fake silence per
    2 minutes and stretched the timeline. Raising the threshold to ~2 s keeps the
    real-silence behaviour for loopback while ignoring scheduling hiccups; remaining
    gaps are filled from the wall clock by the caller.
    """
    base = type(recorder)
    original = base.deviceperiod

    class Tolerant(base):
        @property
        def deviceperiod(self):
            default, minimum = original.fget(self)
            if os.environ.get("LDW_CAPTURE_LIBRARY_DEFAULT") == "1":
                return default, minimum  # test hook: reproduce the original 40 ms behaviour
            return 0.5, minimum

        def _record_chunk(self):
            # Instrument the library's own silence fill: a chunk of zeros returned while the
            # device had no frames available was invented by soundcard, not captured.
            idle = self._capture_available_frames() == 0
            chunk = base._record_chunk(self)
            if idle and len(chunk) and not chunk.any():
                channels = len(set(self.channelmap))
                self.ldw_synthetic_frames = getattr(self, "ldw_synthetic_frames", 0) + len(chunk) // channels
            return chunk

    recorder.__class__ = Tolerant
    recorder.ldw_synthetic_frames = 0
    return recorder


def _match(devices, query: Optional[str]):
    if query is None:
        return None
    query_lower = query.lower()
    for device in devices:
        if str(device.id) == query or query_lower in device.name.lower():
            return device
    raise ValueError(f"No audio device matches {query!r}")


class _Track(threading.Thread):
    def __init__(self, device, path: Path, clock: dict, ready: threading.Barrier, stop: threading.Event, label: str):
        super().__init__(daemon=True, name=f"capture-{label}")
        self.device, self.path, self.clock, self.ready, self.stop, self.label = device, path, clock, ready, stop, label
        self.frames = 0
        self.padded_frames = 0
        self.excess_frames = 0
        self.synthetic: List[dict] = []
        self.error: Optional[BaseException] = None

    def run(self) -> None:
        import numpy as np
        import soundfile as sf

        try:
            with sf.SoundFile(str(self.path), "w", samplerate=RATE, channels=1, subtype="PCM_16") as out, \
                    self.device.recorder(samplerate=RATE, blocksize=BLOCK) as recorder:
                _tolerant(recorder)
                # Both devices are open before the shared clock starts, so device start-up
                # latency does not become padding on one track only.
                self.ready.wait(timeout=10)
                start_at = self.clock["start"]
                seen_synthetic = 0
                while not self.stop.is_set():
                    data = recorder.record(numframes=BLOCK)
                    if data.ndim == 2:
                        data = data.mean(axis=1)
                    # Loopback delivers nothing while the PC is silent; pad with silence so
                    # both tracks stay on the same wall-clock timeline.
                    expected = int((time.monotonic() - start_at) * RATE)
                    gap = expected - (self.frames + len(data))
                    if gap > RATE // 20:
                        out.write(np.zeros(gap, dtype="float32"))
                        self.frames += gap
                        self.padded_frames += gap
                    synthetic = recorder.ldw_synthetic_frames - seen_synthetic
                    if synthetic > 0:
                        seen_synthetic = recorder.ldw_synthetic_frames
                        self.synthetic.append({"start": round(self.frames / RATE, 3),
                                               "seconds": round(synthetic / RATE, 3)})
                    out.write(data.astype("float32"))
                    self.frames += len(data)
                    self.excess_frames = max(self.excess_frames, self.frames - expected - BLOCK)
        except BaseException as error:  # pragma: no cover - hardware dependent
            self.error = error


def record(duration: Optional[float] = None, out_root: Optional[Path] = None,
           mic_device: Optional[str] = None, system_device: Optional[str] = None,
           consent_confirmed: bool = False, stop_file: Optional[Path] = None,
           cancel: Optional[procs.CancelToken] = None, mic_only: bool = False) -> Path:
    if not consent_confirmed:
        raise PermissionError("Recording requires confirmed consent. " + CONSENT_TEXT)
    sc = _soundcard()
    mic = _match(sc.all_microphones(), mic_device) or sc.default_microphone()
    system = None
    if not mic_only:
        if system_device:
            system = _match(sc.all_microphones(include_loopback=True), system_device)
        else:
            speaker = sc.default_speaker()
            system = sc.get_microphone(id=str(speaker.id), include_loopback=True)

    root = Path(out_root) if out_root else paths.RECORDINGS
    root.mkdir(parents=True, exist_ok=True)
    folder = paths.safe_child(root, datetime.now().strftime("%Y%m%d-%H%M%S"))
    folder.mkdir(parents=True, exist_ok=False)
    stop = threading.Event()
    clock = {"start": time.monotonic()}
    ready = threading.Barrier(3 if system is not None else 2,
                              action=lambda: clock.__setitem__("start", time.monotonic()))
    tracks: List[_Track] = [_Track(mic, folder / "mic.wav", clock, ready, stop, "mic")]
    if system is not None:
        tracks.append(_Track(system, folder / "system.wav", clock, ready, stop, "system"))
    started_utc = datetime.now(timezone.utc).isoformat()
    print(f"Recording to {folder}. Press Ctrl+C to stop.", file=sys.stderr, flush=True)
    for track in tracks:
        track.start()
    try:
        ready.wait(timeout=15)
    except threading.BrokenBarrierError:
        pass  # a device failed to open; its error is reported below
    start_at = clock["start"]
    try:
        while True:
            time.sleep(0.2)
            if duration is not None and time.monotonic() - start_at >= duration:
                break
            if stop_file is not None and Path(stop_file).exists():
                break
            if cancel is not None and cancel.cancelled:
                break
            if any(t.error for t in tracks):
                break
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        for track in tracks:
            track.join(timeout=5)
    errors = [f"{t.label}: {t.error}" for t in tracks if t.error]
    elapsed = time.monotonic() - start_at

    mixed = folder / "mix.wav"
    if len(tracks) == 2 and not errors:
        ffmpeg = paths.find_tool("ffmpeg")
        if ffmpeg is None:
            raise FileNotFoundError("FFmpeg is needed to mix the tracks")
        procs.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                   "-i", tracks[0].path, "-i", tracks[1].path,
                   "-filter_complex", "amix=inputs=2:duration=longest:normalize=0", "-ac", "1", mixed],
                  name="ffmpeg-mix", timeout=600)
    elif not errors:
        import shutil

        shutil.copyfile(tracks[0].path, mixed)

    (folder / "capture.json").write_text(json.dumps({
        "started_at": started_utc,
        "duration_seconds": round(elapsed, 2),
        "sample_rate": RATE,
        "tracks": [{"label": t.label, "file": t.path.name, "device": t.device.name,
                    "frames": t.frames, "padded_silence_seconds": round(t.padded_frames / RATE, 2),
                    "max_ahead_of_clock_seconds": round(max(0, t.excess_frames) / RATE, 2),
                    "requested_frames_at_wall_clock": int(elapsed * RATE),
                    "synthetic_silence_inserted_by_library": t.synthetic} for t in tracks],
        "mix": mixed.name if mixed.exists() else None,
        "method": "wasapi-loopback" if system is not None and not system_device else
                  ("device" if system_device else "microphone-only"),
        "consent": {"confirmed": True, "confirmed_at": started_utc, "text": CONSENT_TEXT},
        "errors": errors,
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    from . import integrity

    capture_file = folder / "capture.json"
    record_doc = json.loads(capture_file.read_text(encoding="utf-8"))
    record_doc["integrity"] = integrity.assess(folder, wall_seconds=elapsed)
    capture_file.write_text(json.dumps(record_doc, indent=2, ensure_ascii=False), encoding="utf-8")
    if record_doc["integrity"]["status"] != "ok":
        print("WARNING: capture integrity is " + record_doc["integrity"]["status"] + ". See capture.json.",
              file=sys.stderr)
    if errors:
        raise RuntimeError("Capture failed: " + "; ".join(errors))
    return folder
