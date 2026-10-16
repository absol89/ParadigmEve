"""Run settings, memory-budget presets and validation."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import os
from pathlib import Path
from typing import Dict, Optional, Union

# Whisper language codes accepted by whisper.cpp (subset of its table that we validate
# against; "auto" means detect). Swedish = sv, Finnish = fi.
LANGUAGES = {
    "auto", "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv",
    "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th",
    "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl",
    "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa",
    "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz",
    "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln",
    "ha", "ba", "jw", "su", "yue",
}

GIB = 1024 ** 3

# Memory presets. Limits are per child process (whisper-cli, diarization worker) and are
# enforced on Windows by a Job Object. Values are starting points; see the benchmark report
# for measured peaks before relying on them.
PRESETS: Dict[str, dict] = {
    "low": {"whisper_model": "small-q5_1", "process_memory_limit": 2 * GIB, "max_concurrent_jobs": 1},
    "balanced": {"whisper_model": "large-v3-turbo-q5_0", "process_memory_limit": 4 * GIB, "max_concurrent_jobs": 1},
    "quality": {"whisper_model": "large-v3-turbo-q8_0", "process_memory_limit": 6 * GIB, "max_concurrent_jobs": 1},
}


def default_threads() -> int:
    # Measured on an i5-8300H (4C/8T): whisper.cpp encode was 35% faster with 8 threads than 4,
    # so use all logical CPUs, capped at 8.
    return max(1, min(8, os.cpu_count() or 2))


@dataclass
class RunSettings:
    speakers: Union[int, str] = "auto"       # "auto" (infer) or a fixed int; upstream defaulted to 2
    language: str = "auto"
    threads: int = field(default_factory=default_threads)
    preset: str = "balanced"
    whisper_model: Optional[str] = None      # overrides preset
    process_memory_limit: Optional[int] = None
    priority: str = "below_normal"
    timeout_seconds: Optional[float] = None  # whole job; None = derived from audio length
    cluster_threshold: float = 1.0           # only for speakers="auto"; see docs/11 (0.5 over-splits badly)
    merge_small_share: float = 0.02          # auto only: fold clusters under 2% of talk time into nearest speaker
    decoding: str = "beam"                   # "beam" (whisper-cli default, upstream parity) or "greedy" (faster)
    max_context: Optional[int] = None        # whisper-cli -mc; 0 stops repetition loops on long silence
    asr: str = "local"                       # "local" (whisper.cpp), or opt-in cloud upload: "groq" | "openai"
    cloud_model: Optional[str] = None        # provider default when None
    asr_device: str = "cpu"                  # local ASR only: "cpu" or "gpu" (Vulkan whisper.cpp build)
    gpu_device: Optional[int] = None         # GPU index for --device; None = first GPU that passed the probe
    gpu_fallback: bool = True                # if GPU ASR fails, rerun on CPU and record it in provenance
    recover: bool = True                     # re-transcribe suspected hallucinations, suppress if unrecoverable
    by_source: bool = True                   # a capture's mix.wav: transcribe mic.wav and system.wav apart (ldw/sources.py)
    split_turns: bool = False                # split Whisper segments at speaker changes
    temp_dir: Optional[Path] = None
    keep_intermediate_wav: bool = False
    verbose: bool = False

    def resolved(self) -> "RunSettings":
        if self.preset not in PRESETS:
            raise ValueError(f"preset must be one of {', '.join(PRESETS)}")
        preset = PRESETS[self.preset]
        if self.whisper_model is None:
            self.whisper_model = preset["whisper_model"]
        if self.process_memory_limit is None:
            self.process_memory_limit = preset["process_memory_limit"]
        if isinstance(self.speakers, str):
            if self.speakers != "auto":
                self.speakers = int(self.speakers)
        if self.speakers != "auto" and int(self.speakers) < 1:
            raise ValueError("speakers must be >= 1 or 'auto'")
        self.language = self.language.lower()
        if self.language not in LANGUAGES:
            raise ValueError(f"Unsupported language code {self.language!r}")
        if not 1 <= int(self.threads) <= 64:
            raise ValueError("threads must be between 1 and 64")
        if self.priority not in {"normal", "below_normal", "idle"}:
            raise ValueError("priority must be normal, below_normal or idle")
        if self.asr_device not in {"cpu", "gpu"}:
            raise ValueError("asr_device must be cpu or gpu")
        if self.gpu_device is not None and not 0 <= int(self.gpu_device) <= 15:
            raise ValueError("gpu_device must be between 0 and 15")
        if self.asr not in {"local", "groq", "openai"}:
            raise ValueError("asr must be local, groq or openai")
        if self.decoding not in {"beam", "greedy"}:
            raise ValueError("decoding must be beam or greedy")
        if not 0.0 <= float(self.merge_small_share) < 0.5:
            raise ValueError("merge_small_share must be between 0 and 0.5")
        if not 0.05 <= float(self.cluster_threshold) <= 2.0:
            raise ValueError("cluster_threshold must be between 0.05 and 2.0")
        return self

    def to_json(self) -> dict:
        data = asdict(self)
        data["temp_dir"] = str(self.temp_dir) if self.temp_dir else None
        return data
