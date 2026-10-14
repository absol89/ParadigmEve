"""Capture integrity: find audio that was not really captured.

The failure seen on 2026-10-12: under CPU load, the capture library returned blocks of
exact digital zeros (~44 ms each, hundreds of them) whenever the reader thread was late,
while the real audio was still delivered afterwards. That stretched a 120 s recording to
137.6 s and chopped speech, which Whisper then filled with invented text.

Real microphones essentially never produce >= 35 ms of *exact* zero samples, so such runs
are reported as ``digital_silence`` anomalies. On a loopback/system track exact zeros are
normal (nothing was playing), so there they are reported as ``no_playback`` information,
not as anomalies.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

MIN_RUN_SECONDS = 0.035


def zero_runs(path: Path, min_seconds: float = MIN_RUN_SECONDS) -> Dict:
    import numpy as np
    import soundfile as sf

    data, rate = sf.read(str(path), dtype="int16", always_2d=True)
    mono = (data == 0).all(axis=1).astype("int8")
    edges = np.diff(np.concatenate([[0], mono, [0]]))
    starts, ends = np.where(edges == 1)[0], np.where(edges == -1)[0]
    runs = [(int(a), int(b)) for a, b in zip(starts, ends) if b - a >= rate * min_seconds]
    return {
        "rate": int(rate),
        "frames": int(len(data)),
        "seconds": round(len(data) / rate, 3),
        "runs": [{"start": round(a / rate, 3), "end": round(b / rate, 3)} for a, b in runs],
        "total_seconds": round(sum(b - a for a, b in runs) / rate, 3),
    }


def assess(folder: Path, wall_seconds: Optional[float] = None) -> dict:
    """Integrity report for a ``diarize record`` folder (mic.wav, optional system.wav)."""
    folder = Path(folder)
    capture_file = folder / "capture.json"
    capture = json.loads(capture_file.read_text(encoding="utf-8")) if capture_file.is_file() else {}
    wall = wall_seconds if wall_seconds is not None else capture.get("duration_seconds")
    report: dict = {"wall_clock_seconds": wall, "tracks": {}, "anomalies": [], "status": "ok"}
    for label in ("mic", "system"):
        path = folder / f"{label}.wav"
        if not path.is_file():
            continue
        runs = zero_runs(path)
        kind = "digital_silence" if label == "mic" else "no_playback"
        drift = round(runs["seconds"] - wall, 3) if wall else None
        report["tracks"][label] = {
            "received_seconds": runs["seconds"],
            "drift_vs_wall_clock_seconds": drift,
            "exact_zero_runs": len(runs["runs"]),
            "exact_zero_seconds": runs["total_seconds"],
            "interpretation": kind,
        }
        track_info = next((t for t in capture.get("tracks", []) if t.get("label") == label), {})
        instrumented = track_info.get("synthetic_silence_inserted_by_library")
        if instrumented is not None:
            # Recorded with instrumentation: we know exactly which silence was invented.
            report["tracks"][label]["synthetic_silence_seconds"] = round(sum(x["seconds"] for x in instrumented), 3)
            report["anomalies"] += [{"track": label, "kind": "synthetic_silence", "start": x["start"],
                                     "end": round(x["start"] + x["seconds"], 3)} for x in instrumented]
            if instrumented:
                report["status"] = "degraded"
        elif label == "mic":
            # Older recording without instrumentation: fall back to the exact-zero heuristic.
            # Device noise gating can also produce exact zeros, so this is "suspect", not proof.
            report["tracks"][label]["evidence"] = "heuristic (exact-zero runs); cause not recorded"
            report["anomalies"] += [{"track": label, "kind": "exact_zero_audio", **r} for r in runs["runs"]]
            share = runs["total_seconds"] / max(0.001, runs["seconds"])
            if share > 0.05 and report["status"] == "ok":
                report["status"] = "suspect"
        if drift is not None and abs(drift) > 0.5:
            report["status"] = "degraded"
            report.setdefault("notes", []).append(
                f"{label} track holds {runs['seconds']:.1f} s of audio for {wall:.1f} s of wall-clock time")
    if report["status"] != "ok":
        report["meaning"] = ("Parts of this recording were not really captured (synthetic silence and/or "
                             "timeline drift). Words transcribed near anomaly spans may be invented, and "
                             "timestamps drift from real time.")
    return report


def anomaly_seconds(anomalies: List[dict], start: float, end: float) -> float:
    return round(sum(max(0.0, min(end, a["end"]) - max(start, a["start"])) for a in anomalies), 3)
