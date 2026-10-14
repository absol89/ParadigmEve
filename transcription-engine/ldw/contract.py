"""Versioned transcript contract for Eve: ``eve.local-transcript`` 1.0.0.

Design rules (from the spec):
* Every segment carries start/end, text, a stable recording-local speaker id,
  an optional human name, ASR uncertainty (only what the model really provides),
  speaker-assignment uncertainty, a source reference and provenance.
* Numbers that are not calibrated probabilities say so (``calibrated: false``).
  Nothing is invented when a model gives no value: the field is ``null``.
* Ambiguity is preserved: overlapping speech and short interjections are flagged,
  never silently forced onto one speaker.
* Raw model outputs are kept next to the contract so problems can be debugged
  without re-running transcription.
* The transcript is evidence, not authorization (``evidence_policy``).

Markdown/TXT/SRT/``transcript.json`` are rendered by the *upstream* renderer from the
same segment list, so every export agrees with the contract.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Dict, List, Optional, Sequence, Tuple
import uuid

SCHEMA = "eve.local-transcript"
SCHEMA_VERSION = "1.1.0"

SPLIT_MIN_SECONDS = 0.8  # each side of an in-segment split must be at least this long
INTERJECTION_SECONDS = 1.2
BOUNDARY_SECONDS = 1.5  # split parts shorter than this get boundary_uncertain
SPECIAL_TOKEN = re.compile(r"^\s*\[_[A-Z0-9_]+_?\]\s*$|^\s*\[_TT_\d+\]\s*$|^<\|.*\|>$")


def speaker_key(cluster: Optional[int]) -> Optional[str]:
    return None if cluster is None else f"S{int(cluster)}"


def _overlaps(start: float, end: float, turns: Sequence[dict]) -> Dict[int, float]:
    totals: Dict[int, float] = {}
    for turn in turns:
        amount = max(0.0, min(end, turn["end"]) - max(start, turn["start"]))
        if amount > 0:
            totals[int(turn["speaker"])] = totals.get(int(turn["speaker"]), 0.0) + amount
    return totals


def _overlapping_speech(start: float, end: float, turns: Sequence[dict]) -> float:
    """Seconds inside [start, end] where two or more diarized speakers are active."""
    events: List[Tuple[float, int]] = []
    for turn in turns:
        s, e = max(start, turn["start"]), min(end, turn["end"])
        if e > s:
            events.append((s, 1))
            events.append((e, -1))
    events.sort()
    active, last, total = 0, None, 0.0
    for time_point, delta in events:
        if last is not None and active >= 2:
            total += time_point - last
        active += delta
        last = time_point
    return round(total, 3)


def _tokens(whisper_item: dict) -> List[dict]:
    result = []
    for token in whisper_item.get("tokens", []) or []:
        text = str(token.get("text", ""))
        offsets = token.get("offsets") or {}
        if SPECIAL_TOKEN.match(text) or "from" not in offsets or "to" not in offsets:
            continue
        result.append({
            "text": text,
            "start": offsets["from"] / 1000,
            "end": offsets["to"] / 1000,
            "p": token.get("p"),
        })
    return result


def _asr_stats(tokens: Sequence[dict]) -> dict:
    probabilities = [float(t["p"]) for t in tokens if isinstance(t.get("p"), (int, float))]
    if not probabilities:
        return {"token_probability_mean": None, "token_probability_min": None,
                "tokens": len(tokens), "calibrated": False, "source": None}
    return {
        "token_probability_mean": round(sum(probabilities) / len(probabilities), 4),
        "token_probability_min": round(min(probabilities), 4),
        "tokens": len(probabilities),
        "calibrated": False,
        "source": "whisper.cpp per-token probability (softmax), not a calibrated accuracy",
    }


def _split_by_tokens(tokens: List[dict], turns: Sequence[dict]) -> List[List[dict]]:
    """Group tokens into runs with one dominant speaker; only keep splits that are long enough."""
    if len(tokens) < 2:
        return [tokens]
    labelled = []
    for token in tokens:
        mid_start = token["start"]
        mid_end = max(token["end"], token["start"] + 0.01)
        overlap = _overlaps(mid_start, mid_end, turns)
        labelled.append((max(overlap, key=overlap.get) if overlap else None, token))
    runs: List[Tuple[Optional[int], List[dict]]] = []
    for speaker, token in labelled:
        if runs and (speaker == runs[-1][0] or speaker is None):
            runs[-1][1].append(token)
        else:
            runs.append((speaker, [token]))
    # Merge runs that are too short to be a reliable split into their neighbour.
    merged: List[Tuple[Optional[int], List[dict]]] = []
    for speaker, group in runs:
        duration = group[-1]["end"] - group[0]["start"]
        if merged and duration < SPLIT_MIN_SECONDS:
            merged[-1][1].extend(group)
        else:
            merged.append((speaker, group))
    if len(merged) > 1:
        first_duration = merged[0][1][-1]["end"] - merged[0][1][0]["start"]
        if first_duration < SPLIT_MIN_SECONDS:
            merged[1] = (merged[1][0], merged[0][1] + merged[1][1])
            merged.pop(0)
    return [group for _, group in merged]


def build_segments(upstream, whisper_document: dict, diarization_segments: Sequence[dict],
                   recording_id: str, split_turns: bool) -> List[dict]:
    """Create contract segments. ``upstream`` is the imported upstream cli module."""
    raw_items = [item for item in whisper_document.get("transcription", [])
                 if {"from", "to"} <= set(item.get("offsets") or {}) and str(item.get("text", "")).strip()]
    transcript = upstream.whisper_segments(whisper_document)
    aligned = upstream.align_segments(transcript, diarization_segments)

    segments: List[dict] = []
    for index, (raw, base) in enumerate(zip(raw_items, aligned)):
        tokens = _tokens(raw)
        parts = [tokens]
        if split_turns and tokens:
            parts = _split_by_tokens(tokens, diarization_segments)
        if raw.get("_suppressed"):
            parts = [tokens]  # never split invented text into several attributed pieces
        if len(parts) <= 1:
            segment = _segment(base, tokens, diarization_segments, recording_id, index, None, False)
            segments.append(_attach_evidence(segment, raw, tokens))
            continue
        for part_index, part in enumerate(parts):
            text = "".join(t["text"] for t in part).strip()
            if not text:
                continue
            sub = {"from": int(round(part[0]["start"] * 1000)), "to": int(round(part[-1]["end"] * 1000)), "text": text}
            sub_aligned = upstream.align_segments([sub], diarization_segments)[0]
            sub_aligned["method"] = "token-split"
            segment = _segment(sub_aligned, part, diarization_segments, recording_id, index, part_index, True)
            if segment["end"] - segment["start"] < BOUNDARY_SECONDS:
                # A short piece cut off at a speaker change is where the diarizer's boundary
                # error lands (e.g. the first words of the next speaker). Keep it, but say so.
                segment["flags"].append("boundary_uncertain")
                segment["speaker_assignment"]["label"] = "low"
            segments.append(_attach_evidence(segment, raw, part))

    _flag_repetitions(segments)
    for number, segment in enumerate(segments, start=1):
        segment["id"] = f"seg-{number:05d}"
    return segments


def _attach_evidence(segment: dict, raw: dict, tokens: Sequence[dict]) -> dict:
    """Record the audio evidence behind a segment, separately from its words and speaker.

    status:
      recognized          words over real sound, no warning signs
      low_asr_confidence  real sound but Whisper doubts the words (mean token p < 0.6)
      recovered           first pass looked invented; this text comes from a second,
                          context-free pass over that span (original kept)
      suppressed          looked invented and could not be recovered: no text, no speaker
      unmeasured          no audio measurement available (e.g. built from saved results)
    """
    from .evidence import low_confidence_words

    measured = raw.get("_evidence")
    segment["asr"]["low_confidence_words"] = low_confidence_words(
        [{"text": t["text"], "p": t.get("p"), "start": t["start"], "end": t["end"]} for t in tokens])
    status = "unmeasured" if measured is None else "recognized"
    mean = segment["asr"].get("token_probability_mean")
    if measured is not None and mean is not None and mean < 0.6:
        status = "low_asr_confidence"
    evidence = {"status": status, "verified_by_human": False}
    if measured:
        evidence.update({k: measured[k] for k in ("audio_rms_dbfs", "audio_active_ratio", "diarized_speech_coverage")})
    if raw.get("_recovered_from") is not None:
        evidence["status"] = "recovered"
        evidence["replaced_first_pass"] = raw["_recovered_from"]
        segment["flags"].append("recovered")
    if raw.get("_suppressed"):
        evidence["status"] = "suppressed"
        evidence["suppressed_text"] = segment["text"]
        segment["text"] = ""
        segment["speaker_id"] = None
        segment["speaker_assignment"].update({"label": "low", "method": "withheld", "dominance": None,
                                              "coverage": None})
        segment["flags"] = [f for f in segment["flags"] if f != "unassigned"] + ["suppressed"]
    evidence["axes"] = {
        "asr_confidence": {"value": mean, "measure": "mean whisper token probability", "calibrated": False}
        if mean is not None else {"value": None, "unavailable_reason": "no scored tokens"},
        "alignment_confidence": {"value": segment["speaker_assignment"]["label"],
                                 "measure": "timestamp overlap between words and diarized speech"},
        "speaker_confidence": {"value": None, "unavailable_reason":
                               "sherpa-onnx clustering exposes no per-segment speaker similarity"},
        "acoustic_speech_detected": None if measured is None else bool(
            measured["audio_active_ratio"] >= 0.2 and measured["diarized_speech_coverage"] > 0),
        "capture_integrity": {"status": "not_a_capture"},
        "source_track": None,
    }
    segment["evidence"] = evidence
    return segment


def apply_capture(segments: Sequence[dict], anomalies: Sequence[dict], levels) -> None:
    """Add capture-integrity and source-track evidence from a ``diarize record`` folder.

    ``levels(start, end)`` returns {"mic": dBFS, "system": dBFS} for the span.
    """
    for segment in segments:
        axes = segment.setdefault("evidence", {}).setdefault("axes", {})
        start, end = segment["start"], segment["end"]
        overlap = sum(max(0.0, min(end, a["end"]) - max(start, a["start"])) for a in anomalies)
        axes["capture_integrity"] = {"status": "anomaly" if overlap > 0 else "ok",
                                     "anomaly_seconds": round(overlap, 3)}
        if overlap > 0 and "capture_anomaly" not in segment["flags"]:
            segment["flags"].append("capture_anomaly")
        db = levels(start, end) if levels else {}
        mic, system = db.get("mic"), db.get("system")
        if mic is None and system is None:
            track = None
        elif max(v for v in (mic, system) if v is not None) < -50:
            track = "none"
        elif system is None or (mic is not None and mic > system + 6):
            track = "mic"
        elif mic is None or system > mic + 6:
            track = "system"
        else:
            track = "both"
        axes["source_track"] = {"value": track, "mic_dbfs": mic, "system_dbfs": system,
                                "note": "Which recorded track carried the sound. Speakers playing into "
                                        "the microphone make computer audio appear on 'mic'."}


def _norm(text: str) -> str:
    return re.sub(r"\W+", " ", text.lower()).strip()


def _flag_repetitions(segments: List[dict]) -> None:
    """Whisper can loop on silence or noise and repeat one sentence many times. Flag runs of
    3+ identical segments (or a segment repeating one sentence 3+ times) instead of deleting
    them, so a reader can see the likely hallucination."""
    run_start = 0
    for i in range(1, len(segments) + 1):
        if i < len(segments) and _norm(segments[i]["text"]) == _norm(segments[run_start]["text"]):
            continue
        if i - run_start >= 3:
            for seg in segments[run_start:i]:
                seg["flags"].append("repetition_suspected")
        run_start = i
    for seg in segments:
        sentences = [s for s in re.split(r"(?<=[.!?])\s+", seg["text"]) if s.strip()]
        if len(sentences) >= 3 and len({_norm(s) for s in sentences}) == 1 and "repetition_suspected" not in seg["flags"]:
            seg["flags"].append("repetition_suspected")


def _segment(base: dict, tokens: Sequence[dict], turns: Sequence[dict], recording_id: str,
             whisper_index: int, part: Optional[int], was_split: bool) -> dict:
    start, end = float(base["start"]), float(base["end"])
    duration = max(0.001, end - start)
    overlaps = {int(k): float(v) for k, v in base["speaker_overlap_seconds"].items()}
    total = sum(overlaps.values())
    best = base["speaker_id"]
    best_overlap = overlaps.get(best, 0.0) if best is not None else 0.0
    overlap_speech = _overlapping_speech(start, end, turns)
    candidates = sorted(
        ({"speaker_id": speaker_key(k), "overlap_seconds": round(v, 3)} for k, v in overlaps.items() if v > 0),
        key=lambda c: -c["overlap_seconds"],
    )
    flags = []
    if overlap_speech > 0.2:
        flags.append("overlapping_speech")
    if duration <= INTERJECTION_SECONDS:
        flags.append("short_interjection")
    if was_split:
        flags.append("speaker_change_within_segment")
    if len(candidates) > 1 and not was_split:
        flags.append("multiple_speakers_in_segment")
    if best is None:
        flags.append("unassigned")
    return {
        "id": "",
        "start": round(start, 3),
        "end": round(end, 3),
        "text": base["text"],
        "speaker_id": speaker_key(best),
        "speaker_name": None,
        "asr": _asr_stats(tokens),
        "speaker_assignment": {
            "label": base["confidence"],
            "method": base["method"],
            "dominance": round(best_overlap / total, 3) if total else None,
            "coverage": round(min(1.0, best_overlap / duration), 3) if best is not None else None,
            "candidates": candidates,
            "overlapping_speech_seconds": overlap_speech,
            "calibrated": False,
        },
        "flags": flags,
        "source_ref": {"recording_id": recording_id, "whisper_segment_index": whisper_index, "split_part": part},
    }


def speakers_summary(segments: Sequence[dict], diarization_segments: Sequence[dict],
                     names: Dict[str, str]) -> List[dict]:
    totals: Dict[str, float] = {}
    for turn in diarization_segments:
        key = speaker_key(turn["speaker"])
        totals[key] = totals.get(key, 0.0) + (turn["end"] - turn["start"])
    keys = sorted(set(totals) | {s["speaker_id"] for s in segments if s["speaker_id"]},
                  key=lambda k: int(k[1:]))
    return [{
        "id": key,
        "cluster": int(key[1:]),
        "name": names.get(key),
        "name_source": "human" if key in names else None,
        "role": "unknown",
        "role_source": None,
        "speech_seconds": round(totals.get(key, 0.0), 3),
    } for key in keys]


def build_document(*, segments: List[dict], diarization_segments: Sequence[dict], source: dict,
                   language: dict, provenance: dict, names: Optional[Dict[str, str]] = None,
                   raw_files: Optional[dict] = None) -> dict:
    names = names or {}
    document = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "transcript_id": str(uuid.uuid4()),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "language": language,
        "speakers": speakers_summary(segments, diarization_segments, names),
        "segments": segments,
        "provenance": provenance,
        "privacy": {
            "processing": "local",
            "network_used": False,
            "contains_audio": False,
            "contains_speaker_embeddings": False,
            "cloud_transfer": {"authorized": False, "authorized_by": None, "destination": None},
        },
        "evidence_policy": {
            "kind": "meeting_evidence",
            "authorizes_actions": False,
            "note": "Statements in this transcript are evidence of what was said. Proposed "
                    "action items require separate, explicit user authorization before execution.",
        },
        "raw": raw_files or {},
        "quality": quality_summary(segments),
    }
    apply_names(document, names)
    return document


def quality_summary(segments: Sequence[dict]) -> dict:
    statuses: Dict[str, int] = {}
    for segment in segments:
        status = segment.get("evidence", {}).get("status", "unmeasured")
        statuses[status] = statuses.get(status, 0) + 1
    return {
        "evidence_status_counts": statuses,
        "low_confidence_words": sum(len(s["asr"].get("low_confidence_words", [])) for s in segments),
        "speaker_label_meaning": "speaker_assignment.label measures timestamp overlap between words and "
                                 "diarized speech. It does not verify that the words were said.",
        "verified_by_human": False,
        "use_for_attribution": "Only segments with evidence.status recognized or recovered should be "
                               "attributed to a person; treat low_asr_confidence words as uncertain.",
    }


ROLES = ("human", "assistant", "playback", "unknown")
PROVENANCE = {"human": "human_live_speech", "assistant": "assistant_response",
              "playback": "external_playback", "unknown": "unclassified"}


def apply_names(document: dict, names: Dict[str, str], roles: Optional[Dict[str, str]] = None) -> dict:
    roles = roles or {}
    for speaker in document["speakers"]:
        speaker.setdefault("role", "unknown")
        speaker.setdefault("role_source", None)
        if speaker["id"] in names:
            speaker["name"] = names[speaker["id"]]
            speaker["name_source"] = "human"
        if speaker["id"] in roles:
            if roles[speaker["id"]] not in ROLES:
                raise ValueError(f"role must be one of {', '.join(ROLES)}")
            speaker["role"] = roles[speaker["id"]]
            speaker["role_source"] = "human"
    lookup = {s["id"]: s for s in document["speakers"]}
    for segment in document["segments"]:
        speaker = lookup.get(segment["speaker_id"]) if segment["speaker_id"] else None
        segment["speaker_name"] = speaker["name"] if speaker else None
        segment["content_provenance"] = content_provenance(segment, speaker)
    document["quality"] = quality_summary(document["segments"])
    return document


def content_provenance(segment: dict, speaker: Optional[dict]) -> dict:
    """Who/what produced this text, and whether it can carry an instruction for Eve.

    Roles come only from a person (relabel --role). Without them everything stays
    'unclassified', and nothing is ever eligible as an instruction automatically.
    """
    evidence = segment.get("evidence", {})
    axes = evidence.get("axes", {})
    reasons = []
    if evidence.get("status") in ("suppressed",):
        reasons.append("suppressed")
    if axes.get("acoustic_speech_detected") is False:
        reasons.append("no acoustic speech under these words")
    if axes.get("capture_integrity", {}).get("status") == "anomaly":
        reasons.append("capture anomaly overlaps this segment")
    if reasons:
        kind = "unverified_speech"
    else:
        kind = PROVENANCE[(speaker or {}).get("role", "unknown")] if speaker else "unclassified"
    eligible = (kind == "human_live_speech" and evidence.get("status") in ("recognized", "recovered")
                and not segment["asr"].get("low_confidence_words"))
    return {"kind": kind, "reasons": reasons, "may_contain_user_instruction": eligible,
            "note": "Even when true, this is evidence of what was said, not authorization to act."}


def names_from_mapping(mapping: Dict[int, str]) -> Dict[str, str]:
    return {speaker_key(k): v for k, v in mapping.items()}


SUPPRESSED_PLACEHOLDER = "[suppressed: no verified speech here, see eve-transcript.json]"


def to_upstream_aligned(segments: Sequence[dict]) -> List[dict]:
    """Convert contract segments to the dicts the upstream renderer expects."""
    aligned = []
    for segment in segments:
        if segment.get("evidence", {}).get("status") == "suppressed":
            aligned.append({"from": int(round(segment["start"] * 1000)), "to": int(round(segment["end"] * 1000)),
                            "start": segment["start"], "end": segment["end"], "speaker_id": None,
                            "confidence": "low", "method": "withheld", "speaker_overlap_seconds": {},
                            "text": SUPPRESSED_PLACEHOLDER})
            continue
        speaker = segment["speaker_id"]
        overlaps = {c["speaker_id"][1:]: c["overlap_seconds"] for c in segment["speaker_assignment"]["candidates"]}
        aligned.append({
            "from": int(round(segment["start"] * 1000)),
            "to": int(round(segment["end"] * 1000)),
            "start": segment["start"],
            "end": segment["end"],
            "speaker_id": int(speaker[1:]) if speaker else None,
            "confidence": segment["speaker_assignment"]["label"],
            "method": segment["speaker_assignment"]["method"],
            "speaker_overlap_seconds": overlaps,
            "text": segment["text"],
        })
    return aligned


def upstream_names(document: dict) -> Dict[int, str]:
    return {s["cluster"]: s["name"] for s in document["speakers"] if s.get("name")}


def redacted_copy(document: dict) -> dict:
    """Copy safe to hand to a reasoning provider after the user authorizes it:
    drops local filesystem paths and raw-file locations, keeps text and timing."""
    copy = deepcopy(document)
    copy["source"].pop("path", None)
    copy["raw"] = {}
    copy.get("provenance", {}).pop("host", None)
    return copy


# --- validation (stdlib only, mirrors schemas/eve-local-transcript-1.0.0.schema.json) ---

def validate(document: dict) -> List[str]:
    errors: List[str] = []

    def need(obj, key, kinds, where):
        if not isinstance(obj, dict) or key not in obj:
            errors.append(f"{where}.{key} is missing")
            return None
        if not isinstance(obj[key], kinds):
            errors.append(f"{where}.{key} has wrong type {type(obj[key]).__name__}")
            return None
        return obj[key]

    privacy = document.get("privacy") or {}
    if privacy.get("processing") == "cloud_asr" and not (privacy.get("cloud_transfer") or {}).get("authorized"):
        errors.append("cloud processing without a recorded authorization")
    if document.get("schema") != SCHEMA:
        errors.append("schema must be " + SCHEMA)
    version = str(document.get("schema_version", ""))
    if not version.startswith("1."):
        errors.append(f"unsupported schema_version {version!r}")
    for key, kinds in (("transcript_id", str), ("created_at", str), ("source", dict), ("language", dict),
                       ("speakers", list), ("segments", list), ("provenance", dict), ("privacy", dict),
                       ("evidence_policy", dict), ("raw", dict)):
        need(document, key, kinds, "$")
    if errors:
        return errors
    need(document["source"], "recording_id", str, "$.source")
    if document["evidence_policy"].get("authorizes_actions") is not False:
        errors.append("$.evidence_policy.authorizes_actions must be false")
    speaker_ids = {s.get("id") for s in document["speakers"]}
    last_start = -1.0
    seen = set()
    for i, seg in enumerate(document["segments"]):
        where = f"$.segments[{i}]"
        for key, kinds in (("id", str), ("start", (int, float)), ("end", (int, float)), ("text", str),
                           ("asr", dict), ("speaker_assignment", dict), ("flags", list), ("source_ref", dict)):
            need(seg, key, kinds, where)
        if "speaker_id" not in seg:
            errors.append(f"{where}.speaker_id is missing")
        elif seg["speaker_id"] is not None and seg["speaker_id"] not in speaker_ids:
            errors.append(f"{where}.speaker_id {seg['speaker_id']!r} not in speakers")
        if isinstance(seg.get("start"), (int, float)) and isinstance(seg.get("end"), (int, float)):
            if seg["end"] < seg["start"]:
                errors.append(f"{where} ends before it starts")
            if seg["start"] < last_start - 30:
                errors.append(f"{where} is far out of order")
            last_start = max(last_start, seg["start"])
        if seg.get("id") in seen:
            errors.append(f"{where}.id duplicated")
        seen.add(seg.get("id"))
        sa = seg.get("speaker_assignment") or {}
        if sa.get("label") not in {"high", "medium", "low"}:
            errors.append(f"{where}.speaker_assignment.label invalid")
        if sa.get("calibrated") is not False:
            errors.append(f"{where}.speaker_assignment.calibrated must be false")
        asr = seg.get("asr") or {}
        if asr.get("calibrated") is not False:
            errors.append(f"{where}.asr.calibrated must be false")
        ev = seg.get("evidence")
        if ev is not None and ev.get("status") == "suppressed" and (seg.get("speaker_id") is not None or seg.get("text")):
            errors.append(f"{where}: suppressed segments must have no text and no speaker")
        for key in ("token_probability_mean", "token_probability_min"):
            value = asr.get(key)
            if value is not None and not (0.0 <= float(value) <= 1.0):
                errors.append(f"{where}.asr.{key} out of range")
    return errors


def read(path: Path) -> dict:
    document = json.loads(path.read_text(encoding="utf-8"))
    problems = validate(document)
    if problems:
        raise ValueError("Invalid transcript contract: " + "; ".join(problems[:5]))
    return document


def write(path: Path, document: dict) -> None:
    problems = validate(document)
    if problems:
        raise ValueError("Refusing to write invalid transcript: " + "; ".join(problems[:5]))
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
