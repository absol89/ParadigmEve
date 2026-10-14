"""Command-line entry point (``diarize.cmd`` on Windows, ``python -m ldw`` anywhere)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import signal
import sys
from typing import Optional, Sequence

from . import __version__, paths, procs
from .settings import PRESETS, RunSettings, default_threads

COMMANDS = {"run", "rediarize", "relabel", "doctor", "models", "record", "serve", "inspect", "export", "gpu-probe"}


def _speakers(value: str):
    if value == "auto":
        return value
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("--speakers must be >= 1 or 'auto'")
    return number


def _mapping(values: Sequence[str]) -> dict:
    upstream = paths.import_upstream()
    try:
        return upstream.parse_speaker_map(values)
    except argparse.ArgumentTypeError as error:
        raise SystemExit(str(error))


def build_parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(prog="diarize", description=(
        "Local transcription and speaker diarization (native Windows prototype of "
        "PatrikHolopainen/local-diarization). Audio never leaves this computer."))
    main.add_argument("--version", action="version", version=__version__)
    sub = main.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="Transcribe and diarize a recording")
    run.add_argument("audio", type=Path)
    run.add_argument("--speakers", type=_speakers, default="auto",
                     help="'auto' (default: infer the number of speakers) or a fixed count. Upstream defaulted to 2.")
    run.add_argument("--language", default="auto", help="Whisper language code, e.g. en, sv, fi (default auto)")
    run.add_argument("--threads", type=int, default=default_threads(), help=f"CPU threads (default {default_threads()})")
    run.add_argument("--preset", choices=sorted(PRESETS), default="balanced", help="Memory budget preset")
    run.add_argument("--whisper-model", help="Override the preset's Whisper model (e.g. small-q5_1)")
    run.add_argument("--memory-limit-gb", type=float, help="Per-process memory cap (Windows Job Object)")
    run.add_argument("--priority", choices=["normal", "below_normal", "idle"], default="below_normal")
    run.add_argument("--timeout", type=float, help="Per-stage timeout in seconds (default 6x audio length, min 10 min)")
    run.add_argument("--cluster-threshold", type=float, default=1.0,
                     help="Clustering threshold for --speakers auto (default 1.0; upstream 0.5 over-splits)")
    run.add_argument("--merge-small", type=float, default=0.02,
                     help="Fold auto-found clusters under this share of talk time into the most similar speaker (0 = off)")
    run.add_argument("--asr", choices=["local", "groq", "openai"], default="local",
                     help="Where words are transcribed. 'groq'/'openai' UPLOAD the audio (GROQ_API_KEY / OPENAI_API_KEY); "
                          "speaker separation always stays local.")
    run.add_argument("--cloud-model", default=None, help="Provider model (default whisper-large-v3-turbo / whisper-1)")
    run.add_argument("--decoding", choices=["beam", "greedy"], default="beam",
                     help="beam = whisper-cli default (upstream parity); greedy is ~10-15%% faster")
    run.add_argument("--max-context", type=int, help="whisper-cli -mc; 0 prevents repetition loops on long silence")
    run.add_argument("--split-turns", action="store_true", help="Split Whisper segments at speaker changes")
    run.add_argument("--temp-dir", type=Path, help="Where intermediate WAV files go (default .tmp)")
    run.add_argument("--keep-wav", action="store_true", help="Keep the 16 kHz mono WAV in the output folder")
    run.add_argument("--output", type=Path, help="Output directory")
    run.add_argument("--speaker", action="append", default=[], metavar="NUMBER=NAME", help="Name a speaker cluster")
    run.add_argument("--asr-device", choices=["cpu", "gpu"], default="cpu",
                     help="Local transcription device. gpu uses the Vulkan build when its probe passes; "
                          "the transcript records what actually ran")
    run.add_argument("--gpu-device", type=int, help="GPU index (default: first GPU that passed the probe)")
    run.add_argument("--no-gpu-fallback", action="store_true", help="Fail instead of falling back to CPU")
    run.add_argument("--cpu-only", action="store_true", help="Same as --asr-device cpu (upstream compatibility)")

    red = sub.add_parser("rediarize", help="Redo speaker separation only, reusing the saved transcription")
    red.add_argument("output_dir", type=Path)
    red.add_argument("--speakers", type=_speakers, required=True)
    red.add_argument("--cluster-threshold", type=float, default=1.0)
    red.add_argument("--merge-small", type=float, default=0.02)
    red.add_argument("--split-turns", action="store_true")
    red.add_argument("--output", type=Path, help="New folder (default: <output_dir>-rediarized)")

    rel = sub.add_parser("relabel", help="Rename speakers without rerunning models")
    rel.add_argument("output_dir", type=Path)
    rel.add_argument("--speaker", action="append", default=[], metavar="NUMBER=NAME")
    rel.add_argument("--role", action="append", default=[], metavar="NUMBER=ROLE",
                     help="human, assistant, playback or unknown. Only human speech can carry instructions.")

    sub.add_parser("gpu-probe", help="Report whether a GPU (Vulkan) backend is compiled in and usable (JSON)")

    doc = sub.add_parser("doctor", help="Check prerequisites (no downloads)")
    doc.add_argument("--whisper-model", default=None)
    doc.add_argument("--deep", action="store_true", help="Re-hash every model file")

    models = sub.add_parser("models", help="Plan, fetch or verify pinned downloads")
    models.add_argument("action", choices=["plan", "fetch", "verify", "list"])
    models.add_argument("--whisper-model", default=None)
    models.add_argument("--yes", action="store_true", help="Download without the interactive prompt")

    rec = sub.add_parser("record", help="Record microphone + PC audio output (WASAPI loopback)")
    rec.add_argument("--list-devices", action="store_true")
    rec.add_argument("--duration", type=float, help="Seconds; default until Ctrl+C")
    rec.add_argument("--mic", help="Microphone name or id (default: system default)")
    rec.add_argument("--system-device", help="Capture this input instead of loopback (e.g. 'Stereo Mix')")
    rec.add_argument("--mic-only", action="store_true")
    rec.add_argument("--consent", action="store_true", help="Confirm everyone recorded has agreed")
    rec.add_argument("--stop-file", type=Path, help="Stop when this file appears")
    rec.add_argument("--then-run", action="store_true", help="Diarize mix.wav when recording stops")
    rec.add_argument("--speakers", type=_speakers, default="auto")
    rec.add_argument("--language", default="auto")
    rec.add_argument("--decoding", choices=["beam", "greedy"], default="beam")
    rec.add_argument("--preset", choices=sorted(PRESETS), default="balanced")

    srv = sub.add_parser("serve", help="JSON-RPC 2.0 tool server on stdio")
    srv.add_argument("--data-root", type=Path, default=paths.OUTPUTS / "jobs")
    srv.add_argument("--allow-input", type=Path, action="append", default=[],
                     help="Folder the server may read recordings from (repeatable)")
    srv.add_argument("--max-concurrent-jobs", type=int, default=1)

    ins = sub.add_parser("inspect", help="Probe an audio file")
    ins.add_argument("audio", type=Path)

    exp = sub.add_parser("export", help="Print a transcript in another format")
    exp.add_argument("output_dir", type=Path)
    exp.add_argument("--format", choices=["eve-json", "markdown", "text", "srt"], default="eve-json")
    return main


def _install_interrupt(token: procs.CancelToken) -> None:
    def handler(signum, frame):
        print("\nCancelling...", file=sys.stderr, flush=True)
        token.cancel()

    signal.signal(signal.SIGINT, handler)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, handler)


def _console_progress():
    last = {"key": None}

    def progress(stage: str, fraction: float) -> None:
        key = (stage, int(fraction * 20))
        if key != last["key"]:
            last["key"] = key
            print(f"  {stage}: {fraction * 100:3.0f}%", file=sys.stderr, flush=True)

    return progress


def main(argv: Optional[Sequence[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] not in COMMANDS and not argv[0].startswith("-"):
        argv.insert(0, "run")  # upstream-compatible: `diarize file.m4a --speakers 2`
    if not argv:
        argv = ["--help"]
    args = build_parser().parse_args(argv)

    try:
        if args.command == "run":
            from . import pipeline

            settings = RunSettings(
                speakers=args.speakers, language=args.language, threads=args.threads, preset=args.preset,
                whisper_model=args.whisper_model,
                process_memory_limit=int(args.memory_limit_gb * 1024 ** 3) if args.memory_limit_gb else None,
                priority=args.priority, timeout_seconds=args.timeout, cluster_threshold=args.cluster_threshold,
                merge_small_share=args.merge_small,
                split_turns=args.split_turns, decoding=args.decoding, asr=args.asr, cloud_model=args.cloud_model,
                asr_device="cpu" if args.cpu_only else args.asr_device, gpu_device=args.gpu_device,
                gpu_fallback=not args.no_gpu_fallback, max_context=args.max_context, temp_dir=args.temp_dir, keep_intermediate_wav=args.keep_wav,
            )
            token = procs.CancelToken()
            _install_interrupt(token)
            out = pipeline.run(args.audio, settings, output=args.output, names=_mapping(args.speaker),
                               cancel=token, progress=_console_progress())
            print(out)
            return 0
        if args.command == "rediarize":
            from . import pipeline

            settings = RunSettings(speakers=args.speakers, cluster_threshold=args.cluster_threshold,
                                   merge_small_share=args.merge_small,
                                   split_turns=args.split_turns, priority="normal")
            token = procs.CancelToken()
            _install_interrupt(token)
            print(pipeline.rediarize(args.output_dir, settings, output=args.output, cancel=token,
                                     progress=_console_progress()))
            return 0
        if args.command == "relabel":
            from . import pipeline

            mapping = {str(k): v for k, v in _mapping(args.speaker).items()}
            roles = {str(k): v.strip().lower() for k, v in _mapping(args.role).items()}
            if not mapping and not roles:
                raise SystemExit("Give at least one --speaker or --role")
            pipeline.relabel(args.output_dir, mapping, roles)
            print(f"Updated speaker names in {args.output_dir.resolve()}", file=sys.stderr)
            return 0
        if args.command == "gpu-probe":
            from . import gpu

            print(json.dumps(gpu.probe()))
            return 0
        if args.command == "doctor":
            from . import doctor

            return doctor.report(args.whisper_model or paths.load_lock()["default_whisper_model"], args.deep)
        if args.command == "models":
            from . import downloads

            if args.action == "list":
                lock = paths.load_lock()
                for name, spec in lock["whisper_models"].items():
                    if not name.startswith("_"):
                        presets = [p for p, v in PRESETS.items() if v["whisper_model"] == name]
                        print(f"{name:22} {downloads.format_bytes(spec['size']):>9}  {'preset: ' + ', '.join(presets) if presets else ''}")
                return 0
            items = downloads.plan_items(args.whisper_model)
            if args.action == "plan":
                print(downloads.describe_plan(items))
                return 0
            if args.action == "verify":
                results = downloads.verify_all(items)
                for key, state in results.items():
                    print(f"{state:8} {key}")
                return 0 if all(v == "ok" for v in results.values()) else 1
            downloads.ensure(items, assume_yes=args.yes)
            return 0
        if args.command == "record":
            from . import capture

            if args.list_devices:
                print(json.dumps(capture.list_devices(), indent=2, ensure_ascii=False))
                return 0
            consent = args.consent
            if not consent:
                print(capture.CONSENT_TEXT, file=sys.stderr)
                if sys.stdin.isatty():
                    consent = input("Has everyone agreed to be recorded? [y/N] ").strip().lower() in {"y", "yes"}
            if not consent:
                print("Not recording.", file=sys.stderr)
                return 2
            folder = capture.record(duration=args.duration, mic_device=args.mic, system_device=args.system_device,
                                    consent_confirmed=True, stop_file=args.stop_file, mic_only=args.mic_only)
            print(folder)
            if args.then_run:
                from . import pipeline

                settings = RunSettings(speakers=args.speakers, language=args.language,
                                       decoding=args.decoding, preset=args.preset)
                out = pipeline.run(folder / "mix.wav", settings, output=folder / "transcript",
                                   source_extra={"capture": json.loads((folder / "capture.json").read_text(encoding="utf-8"))},
                                   progress=_console_progress())
                print(out)
            return 0
        if args.command == "serve":
            from . import rpc

            roots = args.allow_input or [paths.RECORDINGS, Path.home() / "Downloads"]
            rpc.Server(args.data_root, roots, args.max_concurrent_jobs).serve()
            return 0
        if args.command == "inspect":
            from . import pipeline

            print(json.dumps(pipeline.inspect_audio(args.audio), indent=2, ensure_ascii=False))
            return 0
        if args.command == "export":
            from . import contract

            directory = args.output_dir.resolve()
            if args.format == "eve-json":
                print(json.dumps(contract.read(directory / "eve-transcript.json"), indent=2, ensure_ascii=False))
            else:
                name = {"markdown": "transcript.md", "text": "transcript.txt", "srt": "transcript.srt"}[args.format]
                sys.stdout.reconfigure(encoding="utf-8")
                print((directory / name).read_text(encoding="utf-8"))
            return 0
    except procs.Cancelled:
        print("Cancelled. Partial outputs (if any) were left in place; the recording is untouched.", file=sys.stderr)
        return 130
    except (FileNotFoundError, RuntimeError, ValueError, PermissionError, TimeoutError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
