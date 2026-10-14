"""Child process for sherpa-onnx diarization.

Running diarization in its own process lets the parent cancel it (kill the job),
cap its memory and measure its peak RAM. For a fixed speaker count it calls the
unmodified upstream ``diarize()``; for automatic discovery it uses the same
configuration with ``num_clusters=-1`` and a distance threshold.

Usage: python -m ldw.diarize_worker <request.json> <result.json>
"""

from __future__ import annotations

import json
from pathlib import Path
import sys
import time


def _auto(audio: Path, segmentation: Path, embedding: Path, threads: int, threshold: float) -> dict:
    import sherpa_onnx
    import soundfile as sf

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(segmentation), window_shift_ratio=0.1),
            num_threads=threads, provider="cpu"),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(embedding), num_threads=threads, provider="cpu"),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=threshold),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("Invalid diarization configuration")
    processor = sherpa_onnx.OfflineSpeakerDiarization(config)
    samples, rate = sf.read(str(audio), dtype="float32", always_2d=True)
    samples = samples[:, 0]
    if rate != processor.sample_rate:
        raise RuntimeError(f"Expected {processor.sample_rate} Hz audio, received {rate} Hz")
    last = [-5]

    def progress(done: int, total: int) -> int:
        percent = int(done / total * 100) if total else 100
        if percent >= last[0] + 5:
            last[0] = percent
            print(f"Diarization: {percent}%", file=sys.stderr, flush=True)
        return 0

    started = time.perf_counter()
    result = processor.process(samples, callback=progress).sort_by_start_time()
    segments = [{"start": round(s.start, 3), "end": round(s.end, 3), "speaker": s.speaker} for s in result]
    return {
        "sample_rate": rate,
        "duration_seconds": round(len(samples) / rate, 3),
        "num_speakers": "auto",
        "detected_speakers": len({s["speaker"] for s in segments}),
        "threshold": threshold,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "segments": segments,
    }


def main(argv) -> int:
    request = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    sys.path.insert(0, request["upstream_src"])
    audio = Path(request["audio"])
    segmentation = Path(request["segmentation_model"])
    embedding = Path(request["embedding_model"])
    threads = int(request["threads"])
    if request["speakers"] == "auto":
        result = _auto(audio, segmentation, embedding, threads, float(request.get("threshold", 1.0)))
        share = float(request.get("merge_small_share", 0) or 0)
        if share > 0:
            import soundfile as sf
            from ldw import clusters

            samples, rate = sf.read(str(audio), dtype="float32")
            extractor = clusters.make_extractor(str(embedding), threads)
            result["segments_before_merge"] = result["segments"]
            result["segments"], result["merge"] = clusters.merge_small(result["segments"], samples, rate,
                                                                       extractor, min_share=share)
            result["merge"]["min_share"] = share
            result["detected_speakers"] = len({s["speaker"] for s in result["segments"]})
    else:
        from local_diarization.cli import diarize  # unmodified upstream

        result = diarize(audio, segmentation, embedding, int(request["speakers"]), threads)
    Path(argv[2]).write_text(json.dumps(result), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
