"""Command-line pipeline for local transcription and speaker diarization."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Dict, Iterable, List, Optional, Sequence

from . import __version__


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODELS = ROOT / ".models"
DEFAULT_WHISPER_MODEL = DEFAULT_MODELS / "ggml-large-v3-turbo-q5_0.bin"
DEFAULT_SEGMENTATION_MODEL = (
    DEFAULT_MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
)
DEFAULT_EMBEDDING_MODEL = DEFAULT_MODELS / "nemo_en_titanet_small.onnx"


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_speaker_map(values: Sequence[str]) -> Dict[int, str]:
    mapping: Dict[int, str] = {}
    for value in values:
        if "=" not in value:
            raise argparse.ArgumentTypeError(
                f"Invalid speaker mapping {value!r}; expected NUMBER=NAME"
            )
        raw_id, name = value.split("=", 1)
        try:
            speaker_id = int(raw_id)
        except ValueError as error:
            raise argparse.ArgumentTypeError(
                f"Invalid speaker number {raw_id!r}"
            ) from error
        name = name.strip()
        if speaker_id < 0 or not name:
            raise argparse.ArgumentTypeError(
                f"Invalid speaker mapping {value!r}; expected NUMBER=NAME"
            )
        mapping[speaker_id] = name
    return mapping


def run_command(command: Sequence[str]) -> None:
    log("$ " + " ".join(str(part) for part in command))
    subprocess.run(list(command), check=True)


def find_whisper_cli() -> Path:
    candidates = [
        ROOT / ".vendor/whisper.cpp/build/bin/whisper-cli",
        ROOT / ".vendor/whisper.cpp/build/bin/Release/whisper-cli",
        ROOT / ".vendor/whisper.cpp/build/bin/Release/whisper-cli.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("whisper-cli was not found. Run ./setup.sh first.")


def require_file(path: Path, description: str) -> Path:
    if not path.is_file():
        raise FileNotFoundError(f"{description} was not found at {path}. Run ./setup.sh.")
    return path


def unique_output_directory(audio: Path, requested: Optional[Path]) -> Path:
    if requested is not None:
        requested.mkdir(parents=True, exist_ok=True)
        return requested.resolve()

    base = (ROOT / "outputs" / audio.stem).resolve()
    if not base.exists():
        base.mkdir(parents=True)
        return base
    index = 2
    while True:
        candidate = base.with_name(f"{base.name}-{index}")
        if not candidate.exists():
            candidate.mkdir(parents=True)
            return candidate
        index += 1


def convert_audio(source: Path, destination: Path) -> None:
    if shutil.which("ffmpeg") is None:
        raise FileNotFoundError("FFmpeg was not found. Install it and try again.")
    run_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(destination),
        ]
    )


def transcribe(
    audio: Path,
    output_prefix: Path,
    model: Path,
    language: str,
    threads: int,
    cpu_only: bool,
) -> dict:
    whisper_cli = find_whisper_cli()
    command = [
        str(whisper_cli),
        "-m",
        str(model),
        "-f",
        str(audio),
        "-l",
        language,
        "-t",
        str(threads),
        "-ojf",
        "-of",
        str(output_prefix),
    ]
    if cpu_only:
        command.append("-ng")
    try:
        run_command(command)
    except subprocess.CalledProcessError:
        if cpu_only:
            raise
        log("GPU transcription failed; retrying on CPU...")
        run_command([*command, "-ng"])
    result_path = output_prefix.with_suffix(".json")
    if not result_path.is_file():
        raise RuntimeError(f"Whisper did not create {result_path}")
    return json.loads(result_path.read_text(encoding="utf-8"))


def diarize(
    audio: Path,
    segmentation_model: Path,
    embedding_model: Path,
    speakers: int,
    threads: int,
) -> dict:
    import soundfile as sf
    import sherpa_onnx

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(segmentation_model), window_shift_ratio=0.1
            ),
            num_threads=threads,
            provider="cpu",
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(embedding_model),
            num_threads=threads,
            provider="cpu",
        ),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=speakers,
            threshold=0.5,
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("Invalid diarization configuration")

    processor = sherpa_onnx.OfflineSpeakerDiarization(config)
    samples, sample_rate = sf.read(audio, dtype="float32", always_2d=True)
    samples = samples[:, 0]
    if sample_rate != processor.sample_rate:
        raise RuntimeError(
            f"Expected {processor.sample_rate} Hz audio, received {sample_rate} Hz"
        )

    last_reported = -5

    def progress(processed: int, total: int) -> int:
        nonlocal last_reported
        percent = int(processed / total * 100) if total else 100
        if percent >= last_reported + 5:
            last_reported = percent
            log(f"Diarization: {percent}%")
        return 0

    started = time.perf_counter()
    result = processor.process(samples, callback=progress).sort_by_start_time()
    elapsed = time.perf_counter() - started
    segments = [
        {"start": round(item.start, 3), "end": round(item.end, 3), "speaker": item.speaker}
        for item in result
    ]
    return {
        "sample_rate": sample_rate,
        "duration_seconds": round(len(samples) / sample_rate, 3),
        "num_speakers": speakers,
        "elapsed_seconds": round(elapsed, 3),
        "segments": segments,
    }


def whisper_segments(document: dict) -> List[dict]:
    segments = []
    for item in document.get("transcription", []):
        offsets = item.get("offsets", {})
        if "from" not in offsets or "to" not in offsets:
            continue
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        segments.append(
            {"from": int(offsets["from"]), "to": int(offsets["to"]), "text": text}
        )
    if not segments:
        raise RuntimeError("No timestamped segments were found in the Whisper JSON")
    return segments


def interval_overlap(start: float, end: float, other_start: float, other_end: float) -> float:
    return max(0.0, min(end, other_end) - max(start, other_start))


def align_segments(transcript: Sequence[dict], diarized: Sequence[dict]) -> List[dict]:
    speaker_ids = sorted({int(item["speaker"]) for item in diarized})
    if not speaker_ids:
        raise RuntimeError("Diarization produced no speaker segments")
    aligned: List[dict] = []

    for item in transcript:
        start = item["from"] / 1000
        end = item["to"] / 1000
        duration = max(0.001, end - start)
        overlaps = {speaker_id: 0.0 for speaker_id in speaker_ids}
        for turn in diarized:
            amount = interval_overlap(start, end, turn["start"], turn["end"])
            if amount:
                overlaps[int(turn["speaker"])] += amount

        speaker_id = max(overlaps, key=overlaps.get)
        best_overlap = overlaps[speaker_id]
        overlap_sum = sum(overlaps.values())
        method = "overlap"

        if best_overlap == 0:
            midpoint = (start + end) / 2
            nearest = min(
                diarized,
                key=lambda turn: min(
                    abs(midpoint - turn["start"]), abs(midpoint - turn["end"])
                ),
            )
            distance = min(
                abs(midpoint - nearest["start"]), abs(midpoint - nearest["end"])
            )
            if distance <= 1.5:
                speaker_id = int(nearest["speaker"])
                method = "nearest"
            else:
                speaker_id = None
                method = "unassigned"
            confidence = "low"
        else:
            dominance = best_overlap / overlap_sum if overlap_sum else 0
            coverage = min(1.0, best_overlap / duration)
            if dominance >= 0.75 and coverage >= 0.55:
                confidence = "high"
            elif dominance >= 0.60 and coverage >= 0.30:
                confidence = "medium"
            else:
                confidence = "low"

        aligned.append(
            {
                "from": item["from"],
                "to": item["to"],
                "start": start,
                "end": end,
                "speaker_id": speaker_id,
                "confidence": confidence,
                "method": method,
                "speaker_overlap_seconds": {
                    str(key): round(value, 3) for key, value in overlaps.items()
                },
                "text": item["text"],
            }
        )
    return aligned


def display_name(speaker_id: Optional[int], names: Dict[int, str]) -> str:
    if speaker_id is None:
        return "Uncertain speaker"
    return names.get(speaker_id, f"Speaker {speaker_id}")


def readable_timestamp(seconds: float) -> str:
    total = max(0, round(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def group_segments(aligned: Sequence[dict], names: Dict[int, str]) -> List[dict]:
    groups: List[dict] = []
    for item in aligned:
        speaker = display_name(item["speaker_id"], names)
        can_extend = (
            bool(groups)
            and groups[-1]["speaker"] == speaker
            and groups[-1]["confidence"] == item["confidence"]
            and item["end"] - groups[-1]["start"] <= 30
            and item["start"] - groups[-1]["end"] <= 2.5
        )
        if can_extend:
            groups[-1]["end"] = item["end"]
            groups[-1]["texts"].append(item["text"])
        else:
            groups.append(
                {
                    "start": item["start"],
                    "end": item["end"],
                    "speaker": speaker,
                    "confidence": item["confidence"],
                    "texts": [item["text"]],
                }
            )
    return groups


def render_outputs(output_dir: Path, aligned: List[dict], names: Dict[int, str], metadata: dict) -> None:
    groups = group_segments(aligned, names)
    counts = Counter(item["confidence"] for item in aligned)

    markdown = [
        f"# {metadata.get('title', 'Diarized transcript')}",
        "",
        "Low-confidence speaker assignments are marked with ⚠️.",
        "",
    ]
    text_lines: List[str] = []
    for group in groups:
        warning = " ⚠️" if group["confidence"] == "low" else ""
        body = " ".join(group["texts"]).strip()
        interval = f"{readable_timestamp(group['start'])}–{readable_timestamp(group['end'])}"
        markdown.extend([f"**[{interval}] {group['speaker']}{warning}:** {body}", ""])
        text_warning = " [uncertain]" if group["confidence"] == "low" else ""
        text_lines.extend([f"[{interval}] {group['speaker']}{text_warning}: {body}", ""])

    markdown.extend(
        [
            "## Processing details",
            "",
            f"- Segments: {len(aligned)}",
            f"- Confidence: {counts['high']} high, {counts['medium']} medium, {counts['low']} low",
            "- Confidence measures timestamp overlap, not independently verified accuracy.",
            "",
        ]
    )
    (output_dir / "transcript.md").write_text("\n".join(markdown), encoding="utf-8")
    (output_dir / "transcript.txt").write_text("\n".join(text_lines), encoding="utf-8")

    srt: List[str] = []
    for index, item in enumerate(aligned, start=1):
        speaker = display_name(item["speaker_id"], names)
        warning = " [uncertain]" if item["confidence"] == "low" else ""
        srt.extend(
            [
                str(index),
                f"{srt_timestamp(item['start'])} --> {srt_timestamp(item['end'])}",
                f"{speaker}{warning}: {item['text']}",
                "",
            ]
        )
    (output_dir / "transcript.srt").write_text("\n".join(srt), encoding="utf-8")

    transcript_document = {
        "metadata": metadata,
        "speaker_names": {str(key): value for key, value in names.items()},
        "statistics": {
            "segments": len(aligned),
            "confidence": dict(counts),
        },
        "segments": aligned,
    }
    (output_dir / "transcript.json").write_text(
        json.dumps(transcript_document, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def run_pipeline(args: argparse.Namespace) -> int:
    audio = args.audio.expanduser().resolve()
    require_file(audio, "Input recording")
    whisper_model = require_file(args.whisper_model.expanduser().resolve(), "Whisper model")
    segmentation_model = require_file(
        args.segmentation_model.expanduser().resolve(), "Segmentation model"
    )
    embedding_model = require_file(
        args.embedding_model.expanduser().resolve(), "Speaker embedding model"
    )
    names = parse_speaker_map(args.speaker)
    output_dir = unique_output_directory(audio, args.output)

    run_started = time.perf_counter()
    log(f"Input: {audio}")
    log(f"Output: {output_dir}")

    with tempfile.TemporaryDirectory(prefix="local-diarization-") as temporary:
        wav = Path(temporary) / "audio.wav"
        log("Converting audio...")
        convert_audio(audio, wav)

        log("Transcribing with Whisper...")
        whisper_started = time.perf_counter()
        whisper_prefix = output_dir / "whisper"
        whisper_document = transcribe(
            wav,
            whisper_prefix,
            whisper_model,
            args.language,
            args.threads,
            args.cpu_only,
        )
        whisper_elapsed = time.perf_counter() - whisper_started

        log("Separating speakers...")
        diarization_document = diarize(
            wav,
            segmentation_model,
            embedding_model,
            args.speakers,
            args.threads,
        )

    transcript = whisper_segments(whisper_document)
    aligned = align_segments(transcript, diarization_document["segments"])
    detected_language = whisper_document.get("result", {}).get("language", args.language)
    metadata = {
        "title": audio.stem,
        "source": str(audio),
        "language": detected_language,
        "requested_speakers": args.speakers,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "tool_version": __version__,
    }
    render_outputs(output_dir, aligned, names, metadata)

    (output_dir / "diarization.json").write_text(
        json.dumps(diarization_document, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    total_elapsed = time.perf_counter() - run_started
    run_document = {
        **metadata,
        "runtime_seconds": {
            "transcription": round(whisper_elapsed, 3),
            "diarization": diarization_document["elapsed_seconds"],
            "total": round(total_elapsed, 3),
        },
        "models": {
            "whisper": whisper_model.name,
            "segmentation": segmentation_model.parent.name,
            "embedding": embedding_model.name,
        },
    }
    (output_dir / "run.json").write_text(
        json.dumps(run_document, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    log(f"Finished in {total_elapsed:.1f} seconds")
    print(output_dir)
    return 0


def relabel(args: argparse.Namespace) -> int:
    output_dir = args.output_dir.expanduser().resolve()
    transcript_path = require_file(output_dir / "transcript.json", "Transcript JSON")
    document = json.loads(transcript_path.read_text(encoding="utf-8"))
    names = {
        int(key): value for key, value in document.get("speaker_names", {}).items()
    }
    names.update(parse_speaker_map(args.speaker))
    render_outputs(output_dir, document["segments"], names, document.get("metadata", {}))
    log(f"Updated speaker names in {output_dir}")
    return 0


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(
        prog="diarize",
        description="Local transcription and speaker diarization.",
    )
    main.add_argument("--version", action="version", version=__version__)
    subparsers = main.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("run", help="Transcribe and diarize a recording")
    run.add_argument("audio", type=Path)
    run.add_argument("--speakers", type=int, default=2, help="Known speaker count (default: 2)")
    run.add_argument("--language", default="auto", help="Whisper language code (default: auto)")
    run.add_argument("--threads", type=int, default=4, help="CPU threads (default: 4)")
    run.add_argument(
        "--cpu-only",
        action="store_true",
        help="Disable GPU/Metal for Whisper transcription",
    )
    run.add_argument("--output", type=Path, help="Output directory")
    run.add_argument(
        "--speaker",
        action="append",
        default=[],
        metavar="NUMBER=NAME",
        help="Name a speaker cluster; may be repeated",
    )
    run.add_argument("--whisper-model", type=Path, default=DEFAULT_WHISPER_MODEL)
    run.add_argument("--segmentation-model", type=Path, default=DEFAULT_SEGMENTATION_MODEL)
    run.add_argument("--embedding-model", type=Path, default=DEFAULT_EMBEDDING_MODEL)
    run.set_defaults(handler=run_pipeline)

    rename = subparsers.add_parser("relabel", help="Rename speakers without rerunning models")
    rename.add_argument("output_dir", type=Path)
    rename.add_argument(
        "--speaker",
        action="append",
        required=True,
        metavar="NUMBER=NAME",
        help="Name a speaker cluster; may be repeated",
    )
    rename.set_defaults(handler=relabel)
    return main


def main(argv: Optional[Sequence[str]] = None) -> int:
    arguments = parser().parse_args(argv)
    if getattr(arguments, "speakers", 1) < 1:
        raise SystemExit("--speakers must be at least 1")
    if getattr(arguments, "threads", 1) < 1:
        raise SystemExit("--threads must be at least 1")
    try:
        return int(arguments.handler(arguments))
    except (FileNotFoundError, RuntimeError, subprocess.CalledProcessError) as error:
        log(f"Error: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
