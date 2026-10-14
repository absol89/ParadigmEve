"""Audio evidence for transcript segments, hallucination detection and selective recovery.

Recognized words, speaker attribution and audio evidence are kept as three separate
things. A speaker label does not make a sentence real:

* ``measure()`` checks that there is actual sound under each Whisper segment (RMS level,
  share of active 30 ms frames) and how much of it the diarizer heard as speech.
* ``find_suspects()`` marks segments that look invented: repetition loops, text over
  near-silence, or text the diarizer heard no speech for at all.
* ``recover()`` re-transcribes only the suspect time spans, alone and without the
  previous-text context that drives Whisper loops. If the second pass gives plausible,
  non-repetitive text, it replaces the suspect segments (the original text is kept).
  Otherwise the segments are suppressed: their text is kept for inspection, but they are
  not rendered as speech and get no speaker.

Nothing is truncated wholesale. Real speech after a loop survives, because only the
suspect spans are touched.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import wave
from array import array
import math
from typing import Callable, Dict, List, Optional, Sequence, Tuple

FRAME_SECONDS = 0.03
ACTIVE_DBFS = -45.0
LOW_WORD_PROBABILITY = 0.5
SPECIAL = re.compile(r"^\s*\[_[A-Z0-9_]+_?\]\s*$|^\s*\[_TT_\d+\]\s*$")


class Audio:
    """16 kHz mono PCM WAV, analysed once into 30 ms frame levels.

    "Active" is relative to this recording, not an absolute level: quiet meeting
    microphones (AMI headset mix sits around -50 dBFS) must not look silent. A frame is
    active when it is at least 10 dB above the recording's noise floor (10th percentile)
    and no more than 30 dB below its loud speech (95th percentile).
    """

    def __init__(self, path: Path):
        with wave.open(str(path), "rb") as handle:
            if handle.getsampwidth() != 2 or handle.getnchannels() != 1:
                raise ValueError("expected 16-bit mono WAV")
            self.rate = handle.getframerate()
            raw = handle.readframes(handle.getnframes())
        self.frame = max(1, int(FRAME_SECONDS * self.rate))
        try:
            import numpy as np

            samples = np.frombuffer(raw, dtype="<i2").astype("float64")
            usable = len(samples) // self.frame * self.frame
            energy = (samples[:usable].reshape(-1, self.frame) ** 2).mean(axis=1)
            if len(samples) > usable:
                energy = np.append(energy, (samples[usable:] ** 2).mean())
            self.energy = energy.tolist()
        except ImportError:  # stdlib fallback (slow but correct)
            samples = array("h")
            samples.frombytes(raw)
            self.energy = [sum(v * v for v in samples[i:i + self.frame]) / len(samples[i:i + self.frame])
                           for i in range(0, len(samples), self.frame)]
        levels = sorted(10 * math.log10(e / 32768 ** 2) if e > 0 else -120.0 for e in self.energy)
        if levels:
            floor = levels[int(0.10 * (len(levels) - 1))]
            loud = levels[int(0.95 * (len(levels) - 1))]
            self.active_dbfs = min(max(floor + 10.0, loud - 30.0, -75.0), loud - 3.0)
        else:
            self.active_dbfs = ACTIVE_DBFS
        threshold = 32768 ** 2 * 10 ** (self.active_dbfs / 10)
        self.active = [e > threshold for e in self.energy]

    def stats(self, start: float, end: float) -> Tuple[Optional[float], float]:
        a = max(0, int(start * self.rate / self.frame))
        b = min(len(self.energy), max(a + 1, int(math.ceil(end * self.rate / self.frame))))
        if b <= a:
            return None, 0.0
        mean = sum(self.energy[a:b]) / (b - a)
        dbfs = round(10 * math.log10(mean / 32768 ** 2), 1) if mean > 0 else -120.0
        return dbfs, round(sum(self.active[a:b]) / (b - a), 3)


def _coverage(start: float, end: float, turns: Sequence[dict]) -> float:
    """Share of [start, end] during which the diarizer heard anyone speak."""
    spans = sorted((max(start, t["start"]), min(end, t["end"])) for t in turns if t["end"] > start and t["start"] < end)
    covered, cursor = 0.0, start
    for s, e in spans:
        s = max(s, cursor)
        if e > s:
            covered += e - s
            cursor = e
    return round(covered / max(0.001, end - start), 3)


def tokens(item: dict) -> List[dict]:
    out = []
    for token in item.get("tokens", []) or []:
        text = str(token.get("text", ""))
        offsets = token.get("offsets") or {}
        if SPECIAL.match(text) or "from" not in offsets:
            continue
        out.append({"text": text, "p": token.get("p"), "start": offsets["from"] / 1000, "end": offsets["to"] / 1000})
    return out


def low_confidence_words(item_tokens: Sequence[dict]) -> List[dict]:
    """Words whose (merged sub-word) token probability is below LOW_WORD_PROBABILITY."""
    words: List[dict] = []
    for token in item_tokens:
        text = token["text"]
        if words and text and not text.startswith(" ") and re.match(r"\w", text):
            words[-1]["text"] += text
            words[-1]["end"] = token["end"]
            if isinstance(token["p"], (int, float)):
                words[-1]["p"] = min(words[-1]["p"], token["p"]) if words[-1]["p"] is not None else token["p"]
        else:
            words.append(dict(token))
    return [{"word": w["text"].strip(), "probability": round(float(w["p"]), 3), "start": w["start"], "end": w["end"]}
            for w in words if isinstance(w.get("p"), (int, float)) and w["p"] < LOW_WORD_PROBABILITY
            and re.search(r"\w", w["text"])]


def _norm(text: str) -> str:
    return re.sub(r"\W+", " ", text.lower()).strip()


def _items(document: dict) -> List[dict]:
    return [i for i in document.get("transcription", [])
            if {"from", "to"} <= set(i.get("offsets") or {}) and str(i.get("text", "")).strip()]


def measure(document: dict, audio: Audio, turns: Sequence[dict]) -> None:
    """Attach ``_evidence`` to each usable Whisper item (in place)."""
    for item in _items(document):
        start, end = item["offsets"]["from"] / 1000, item["offsets"]["to"] / 1000
        dbfs, active = audio.stats(start, end)
        item_tokens = tokens(item)
        probabilities = [t["p"] for t in item_tokens if isinstance(t["p"], (int, float))]
        item["_evidence"] = {
            "audio_rms_dbfs": dbfs,
            "audio_active_ratio": active,
            "diarized_speech_coverage": _coverage(start, end, turns),
            "token_probability_mean": round(sum(probabilities) / len(probabilities), 4) if probabilities else None,
        }


def find_suspects(document: dict) -> List[int]:
    """Indices (into ``transcription``) of items that look invented."""
    items = document.get("transcription", [])
    usable = [i for i, item in enumerate(items) if "_evidence" in item]
    suspects = set()
    # 1. Repetition loops: 3+ consecutive identical segments, or one sentence repeated 3+ times.
    run = [usable[0]] if usable else []
    for index in usable[1:] + [None]:
        if index is not None and _norm(items[index]["text"]) == _norm(items[run[0]]["text"]):
            run.append(index)
            continue
        if len(run) >= 3:
            suspects.update(run)
        run = [index] if index is not None else []
    for index in usable:
        sentences = [s for s in re.split(r"(?<=[.!?])\s+", items[index]["text"].strip()) if s.strip()]
        if len(sentences) >= 3 and len({_norm(s) for s in sentences}) == 1:
            suspects.add(index)
    # 2. Text over silence, or text the diarizer heard no speech for and Whisper itself doubts.
    for index in usable:
        ev = items[index]["_evidence"]
        # Cloud transcripts carry no token probabilities; treat "unknown" as neutral, not as doubt.
        probability = ev["token_probability_mean"] if ev["token_probability_mean"] is not None else 0.6
        heard = ev["diarized_speech_coverage"] >= 0.5
        # Quiet audio alone is not enough: a soft-spoken line that the diarizer heard as
        # speech and Whisper is sure of stays. Silence plus any second doubt is suspect.
        silent = ev["audio_active_ratio"] < 0.1 and not (heard and probability >= 0.6)
        unheard = ev["diarized_speech_coverage"] == 0 and probability < 0.5
        if silent or unheard:
            suspects.add(index)
    return sorted(suspects)


def spans(document: dict, suspects: Sequence[int], pad: float = 0.5, gap: float = 1.0,
          duration: Optional[float] = None) -> List[Tuple[float, float, List[int]]]:
    items = document["transcription"]
    out: List[Tuple[float, float, List[int]]] = []
    for index in suspects:
        start = max(0.0, items[index]["offsets"]["from"] / 1000 - pad)
        end = items[index]["offsets"]["to"] / 1000 + pad
        if duration:
            end = min(end, duration)
        if out and start - out[-1][1] <= gap:
            out[-1] = (out[-1][0], max(out[-1][1], end), out[-1][2] + [index])
        else:
            out.append((start, end, [index]))
    return out


def recover(document: dict, transcribe_span: Callable[[float, float], dict], duration: Optional[float],
            audio: Audio, turns: Sequence[dict]) -> Dict:
    """Re-transcribe suspect spans and splice results into ``document`` (in place).

    ``transcribe_span(start, end)`` must return a whisper.cpp ``-ojf`` document whose
    offsets are absolute. Returns a log for recovery.json.
    """
    suspects = find_suspects(document)
    log = {"suspect_segments": len(suspects), "spans": []}
    if not suspects:
        return log
    items = document["transcription"]
    suspect_set = set(suspects)
    removed: set = set()
    added: List[dict] = []

    def span_of(item):
        return item["offsets"]["from"] / 1000, item["offsets"]["to"] / 1000

    def overlap(a, b):
        return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))

    for start, end, indices in spans(document, suspects, duration=duration):
        # Give the second pass whole neighbouring segments as acoustic context.
        covered = [i for i, item in enumerate(items) if "_evidence" in item
                   and span_of(item)[1] > start and span_of(item)[0] < end]
        span_start = min([start] + [span_of(items[i])[0] for i in covered])
        span_end = max([end] + [span_of(items[i])[1] for i in covered])
        original = [{"start": span_of(items[i])[0], "end": span_of(items[i])[1], "text": items[i]["text"].strip(),
                     "suspect": i in suspect_set,
                     "low_confidence_words": [] if i in suspect_set else low_confidence_words(tokens(items[i]))}
                    for i in covered]
        entry = {"start": round(span_start, 3), "end": round(span_end, 3), "original": original}
        try:
            second = transcribe_span(span_start, span_end)
        except Exception as error:  # recovery is best effort; suppression still applies
            second, entry["error"] = {"transcription": []}, f"{type(error).__name__}: {error}"
        new_items = [i for i in _items(second) if span_start - 0.05 <= i["offsets"]["from"] / 1000 < span_end + 0.05]
        measure({"transcription": new_items}, audio, turns)
        still_bad = set(find_suspects({"transcription": new_items})) if new_items else set()
        good = [item for k, item in enumerate(new_items) if k not in still_bad]
        if not good:
            for i in covered:
                if i in suspect_set:
                    items[i]["_suppressed"] = True
            entry["result"] = "suppressed"
            log["spans"].append(entry)
            continue

        # Non-suspect neighbours are only replaced when the second pass clearly re-covered
        # them (>= 80 % of their duration); otherwise the first-pass words are kept and any
        # second-pass text mostly inside them is dropped. Real speech is never lost to recovery.
        for i in covered:
            if i in suspect_set:
                removed.add(i)
                continue
            region = span_of(items[i])
            length = max(0.001, region[1] - region[0])
            if sum(overlap(region, span_of(g)) for g in good) / length >= 0.8:
                removed.add(i)
            else:
                good = [g for g in good
                        if overlap(region, span_of(g)) < 0.5 * max(0.001, span_of(g)[1] - span_of(g)[0])]
        for item in good:
            item["_recovered_from"] = original
        added.extend(good)
        entry["result"] = "recovered"
        entry["recovered"] = [{"start": span_of(i)[0], "end": span_of(i)[1], "text": i["text"].strip()} for i in good]
        entry["kept_first_pass"] = [o for o, i in zip(original, covered) if i not in removed]
        log["spans"].append(entry)

    rebuilt = [item for i, item in enumerate(items) if i not in removed] + added
    rebuilt.sort(key=lambda item: (item.get("offsets") or {}).get("from", 0))
    document["transcription"] = rebuilt
    return log


def clean_for_storage(document: dict) -> dict:
    """Copy without private underscore keys (for whisper.recovered.json)."""
    copy = json.loads(json.dumps(document))
    for item in copy.get("transcription", []):
        for key in [k for k in item if k.startswith("_")]:
            item.pop(key)
    return copy
