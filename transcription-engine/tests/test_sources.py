"""Source-aware merging of per-track transcripts (no audio or models needed).

Run from transcription-engine/:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ldw import contract, sources  # noqa: E402


def segment(start, end, text, speaker):
    return {
        "id": "", "start": start, "end": end, "text": text, "speaker_id": speaker, "speaker_name": None,
        "asr": {"calibrated": False, "low_confidence_words": []},
        "speaker_assignment": {"label": "high", "method": "overlap", "dominance": 1.0, "coverage": 1.0,
                               "candidates": [], "overlapping_speech_seconds": 0.0, "calibrated": False},
        "flags": [],
        "source_ref": {"recording_id": "sha256:track", "whisper_segment_index": 0, "split_part": None},
        "evidence": {"status": "recognized", "axes": {"capture_integrity": {"status": "ok"}}},
    }


def speaker(key, name=None):
    return {"id": key, "cluster": int(key[1:]), "name": name, "name_source": "human" if name else None,
            "role": "unknown", "role_source": None, "speech_seconds": 1.0}


def track_document(speakers, segments):
    return {"speakers": speakers, "segments": segments}


def full_document(merged):
    return {
        "schema": contract.SCHEMA, "schema_version": contract.SCHEMA_VERSION, "transcript_id": "t",
        "created_at": "2026-10-16T00:00:00+00:00", "source": {"recording_id": "sha256:mix"},
        "language": {}, "speakers": merged["speakers"], "segments": merged["segments"], "provenance": {},
        "privacy": {}, "evidence_policy": {"authorizes_actions": False}, "raw": {},
    }


# Synthetic three-speaker example: one microphone voice and two independent computer voices.
MIC = track_document([speaker("S0")], [
    segment(2.0, 3.5, "I am speaking from the microphone.", "S0"),
    segment(9.0, 10.0, "I like yellow.", "S0"),
])
SYSTEM = track_document([speaker("S0"), speaker("S1")], [
    segment(0.5, 1.8, "What is your name?", "S0"),
    segment(4.0, 6.0, "Make this space your own private sanctuary.", "S1"),
    segment(7.0, 8.5, "What is your favorite color?", "S0"),
])


class Merge(unittest.TestCase):
    def test_numbers_microphone_speakers_first_and_never_shares_a_speaker_across_tracks(self):
        merged = sources.merge({"mic": MIC, "system": SYSTEM}, "sha256:mix")
        self.assertEqual([(s["id"], s["name"], s["source_track"]) for s in merged["speakers"]],
                         [("S0", "Microphone 1", "mic"), ("S1", "PC audio 1", "system"), ("S2", "PC audio 2", "system")])
        self.assertEqual(merged["track_speakers"], {"mic": {"S0": "S0"}, "system": {"S0": "S1", "S1": "S2"}})
        by_text = {s["text"]: s for s in merged["segments"]}
        self.assertEqual(by_text["I am speaking from the microphone."]["speaker_id"], "S0")
        self.assertEqual(by_text["What is your name?"]["speaker_id"], "S1")
        self.assertEqual(by_text["Make this space your own private sanctuary."]["speaker_id"], "S2")
        self.assertEqual(by_text["Make this space your own private sanctuary."]["speaker_name"], "PC audio 2")

    def test_orders_the_timeline_renumbers_segments_and_passes_the_contract(self):
        merged = sources.merge({"mic": MIC, "system": SYSTEM}, "sha256:mix")
        self.assertEqual([s["start"] for s in merged["segments"]], [0.5, 2.0, 4.0, 7.0, 9.0])
        self.assertEqual([s["id"] for s in merged["segments"]], [f"seg-{n:05d}" for n in range(1, 6)])
        self.assertTrue(all(s["source_ref"]["recording_id"] == "sha256:mix" for s in merged["segments"]))
        self.assertEqual(contract.validate(full_document(merged)), [])

    def test_suppresses_microphone_echo_of_pc_audio_without_a_speaker(self):
        echo_mic = track_document([speaker("S0")], [
            segment(0.6, 1.7, "what is your name", "S0"),   # speakers playing into the microphone
            segment(2.0, 3.5, "I am speaking from the microphone.", "S0"),
        ])
        merged = sources.merge({"mic": echo_mic, "system": SYSTEM}, "sha256:mix")
        echo = next(s for s in merged["segments"] if s["source_track"] == "mic" and s["start"] == 0.6)
        self.assertEqual((echo["text"], echo["speaker_id"]), ("", None))
        self.assertEqual(echo["evidence"]["status"], "suppressed")
        self.assertEqual(echo["evidence"]["suppressed_reason"], "echo_of_pc_audio")
        self.assertIn("echo", echo["flags"])
        kept = next(s for s in merged["segments"] if s["text"] == "I am speaking from the microphone.")
        self.assertEqual(kept["speaker_id"], "S0")
        self.assertEqual(contract.validate(full_document(merged)), [])

    def test_flags_speech_on_both_tracks_at_once_instead_of_merging_it(self):
        talk_over = track_document([speaker("S0")], [segment(4.5, 5.5, "I like yellow.", "S0")])
        merged = sources.merge({"mic": talk_over, "system": SYSTEM}, "sha256:mix")
        mine = next(s for s in merged["segments"] if s["text"] == "I like yellow.")
        theirs = next(s for s in merged["segments"] if s["start"] == 4.0)
        self.assertIn("overlapping_speech", mine["flags"])
        self.assertIn("overlapping_speech", theirs["flags"])
        self.assertNotEqual(mine["speaker_id"], theirs["speaker_id"])

    def test_keeps_names_a_person_gave_and_handles_a_single_track(self):
        named = track_document([speaker("S0", "Participant One")], [segment(2.0, 3.5, "I am speaking from the microphone.", "S0")])
        merged = sources.merge({"mic": named}, "sha256:mix")
        self.assertEqual((merged["speakers"][0]["name"], merged["speakers"][0]["name_source"]), ("Participant One", "human"))
        self.assertEqual(merged["segments"][0]["speaker_name"], "Participant One")


class TextMatch(unittest.TestCase):
    def test_matches_repeats_and_containment_but_not_different_words(self):
        self.assertGreaterEqual(sources.text_match("what is your name", "What is your name?"), 0.6)
        self.assertGreaterEqual(sources.text_match("your favorite color", "What is your favorite color?"), 0.6)
        self.assertLess(sources.text_match("I like yellow", "What is your favorite color?"), 0.6)
        self.assertEqual(sources.text_match("", "anything"), 0.0)


if __name__ == "__main__":
    unittest.main()
