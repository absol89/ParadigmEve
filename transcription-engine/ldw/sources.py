"""Source-aware transcription for ``diarize record`` captures.

A capture keeps the microphone (``mic.wav``) and everything the computer played (``system.wav``)
apart, and also writes ``mix.wav``. Diarizing only the mix asked speaker clustering to pull apart
voices the recorder had already separated: a three-voice microphone and system-audio recording
can produce two mixed clusters, even with automatic speaker count. Per-track analysis preserves
which recording source carried each voice.

So when both tracks exist, each track is transcribed and diarized on its own (automatic speaker
count) and the two results are merged on the shared timeline:

* speakers are numbered mic first, then PC audio, so a microphone voice and a PC voice are never
  one speaker, and are named by their track until a person names them;
* speech on both tracks at once stays as two segments, both flagged ``overlapping_speech``;
* a microphone segment that repeats what the PC was playing at the same moment (speakers playing
  into the microphone, no headphones) is suppressed as echo instead of being attributed to the
  person at the microphone.

Everything here works on finished transcript documents and needs no audio libraries.
"""

from __future__ import annotations

import difflib
import re
from typing import Dict, List, Optional, Sequence

from . import contract

TRACKS = ("mic", "system")
TRACK_NAMES = {"mic": "Microphone", "system": "PC audio"}
# A microphone segment is echo when this much of it overlaps one PC segment in time ...
ECHO_TIME_OVERLAP = 0.5
# ... and its words match that PC segment this closely (sequence ratio or word containment).
ECHO_TEXT_MATCH = 0.6
# Cross-track speech shorter than this is not reported as overlapping.
OVERLAP_SECONDS = 0.2


def _words(text: str) -> List[str]:
    return re.sub(r"\W+", " ", (text or "").lower()).split()


def text_match(a: str, b: str) -> float:
    """How closely ``a`` repeats ``b``: the better of sequence similarity and word containment."""
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return 0.0
    ratio = difflib.SequenceMatcher(None, wa, wb).ratio()
    pool = list(wb)
    contained = 0
    for word in wa:
        if word in pool:
            pool.remove(word)
            contained += 1
    return max(ratio, contained / len(wa))


def _overlap(a: dict, b: dict) -> float:
    return max(0.0, min(a["end"], b["end"]) - max(a["start"], b["start"]))


def _is_echo(mic: dict, system_segments: Sequence[dict]) -> Optional[dict]:
    """The PC segment this microphone segment repeats, or None."""
    if not mic.get("text"):
        return None
    duration = max(0.001, mic["end"] - mic["start"])
    for system in system_segments:
        if not system.get("text"):
            continue
        if _overlap(mic, system) / duration >= ECHO_TIME_OVERLAP and text_match(mic["text"], system["text"]) >= ECHO_TEXT_MATCH:
            return system
    return None


def _suppress_as_echo(segment: dict, system: dict) -> None:
    evidence = segment.setdefault("evidence", {})
    evidence["status"] = "suppressed"
    evidence["suppressed_text"] = segment["text"]
    evidence["suppressed_reason"] = "echo_of_pc_audio"
    evidence["echo_of"] = {"start": system["start"], "end": system["end"]}
    segment["text"] = ""
    segment["speaker_id"] = None
    segment["speaker_name"] = None
    segment["speaker_assignment"].update({"label": "low", "method": "withheld", "dominance": None, "coverage": None})
    segment["flags"] = [f for f in segment["flags"] if f not in ("unassigned", "overlapping_speech")] + ["suppressed", "echo"]


def merge(documents: Dict[str, dict], recording_id: str) -> dict:
    """Merge per-track transcript documents into one speaker space and timeline.

    ``documents`` maps a track ("mic", "system") to its finished ``eve-transcript.json``.
    Returns ``{"speakers": [...], "segments": [...], "track_speakers": {...}}``; segment ids,
    speaker ids and speaker clusters are renumbered, and every speaker and segment records its track.
    """
    speakers: List[dict] = []
    segments: List[dict] = []
    mapping: Dict[str, Dict[str, str]] = {}
    for track in TRACKS:
        document = documents.get(track)
        if not document:
            continue
        mapping[track] = {}
        ordinal = 0
        for speaker in document["speakers"]:
            ordinal += 1
            new_id = contract.speaker_key(len(speakers))
            mapping[track][speaker["id"]] = new_id
            human = speaker.get("name_source") == "human"
            speakers.append({
                **speaker,
                "id": new_id,
                "cluster": len(speakers),
                "name": speaker["name"] if human else f"{TRACK_NAMES[track]} {ordinal}",
                "name_source": "human" if human else "capture_track",
                "source_track": track,
            })
        for segment in document["segments"]:
            copy = {**segment, "flags": list(segment["flags"]),
                    "speaker_assignment": dict(segment["speaker_assignment"]),
                    "source_ref": {**segment["source_ref"], "track": track}}
            if copy.get("speaker_id"):
                copy["speaker_id"] = mapping[track].get(copy["speaker_id"])
            evidence = copy.setdefault("evidence", {})
            evidence = copy["evidence"] = {**evidence, "axes": dict(evidence.get("axes") or {})}
            evidence["axes"]["source_track"] = {"value": track, "note": "Transcribed from this recorded track on its own."}
            copy["source_track"] = track
            segments.append(copy)

    mic = [s for s in segments if s["source_track"] == "mic"]
    system = [s for s in segments if s["source_track"] == "system"]
    for segment in mic:
        repeated = _is_echo(segment, system)
        if repeated is not None:
            _suppress_as_echo(segment, repeated)
    for segment in mic:
        if not segment.get("text"):
            continue
        for other in system:
            if other.get("text") and _overlap(segment, other) >= OVERLAP_SECONDS:
                for flagged in (segment, other):
                    if "overlapping_speech" not in flagged["flags"]:
                        flagged["flags"].append("overlapping_speech")

    segments.sort(key=lambda s: (s["start"], 0 if s["source_track"] == "mic" else 1))
    for number, segment in enumerate(segments, start=1):
        segment["id"] = f"seg-{number:05d}"
        segment["source_ref"]["recording_id"] = recording_id
    lookup = {s["id"]: s for s in speakers}
    for segment in segments:
        speaker = lookup.get(segment["speaker_id"]) if segment["speaker_id"] else None
        segment["speaker_name"] = speaker["name"] if speaker else None
        segment["content_provenance"] = contract.content_provenance(segment, speaker)
    return {"speakers": speakers, "segments": segments, "track_speakers": mapping}
