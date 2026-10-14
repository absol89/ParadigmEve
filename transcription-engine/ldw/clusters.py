"""Post-processing for automatic speaker counting: fold tiny clusters into real speakers.

With an unknown speaker count the clustering threshold has to stay permissive enough
not to merge two real people, which leaves a few small "phantom" clusters (a cough, a
laugh, a speaker's raised voice). Each cluster's centroid embedding is computed from
its own speech; clusters holding less than ``min_share`` of the total talk time are
reassigned to the most similar remaining cluster, provided the cosine similarity is at
least ``min_similarity``. Otherwise the small cluster is kept, because a person who
only speaks briefly is still a person.
"""

from __future__ import annotations

from typing import Dict, List, Sequence, Tuple

MIN_SEGMENT_SECONDS = 0.5
MAX_SECONDS_PER_CLUSTER = 60.0


def _centroids(samples, rate: int, segments: Sequence[dict], extractor) -> Dict[int, "object"]:
    import numpy as np

    sums: Dict[int, object] = {}
    used: Dict[int, float] = {}
    for seg in sorted(segments, key=lambda s: -(s["end"] - s["start"])):
        speaker = int(seg["speaker"])
        if seg["end"] - seg["start"] < MIN_SEGMENT_SECONDS or used.get(speaker, 0) >= MAX_SECONDS_PER_CLUSTER:
            continue
        chunk = samples[int(seg["start"] * rate):int(seg["end"] * rate)]
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=rate, waveform=chunk)
        stream.input_finished()
        vector = np.asarray(extractor.compute(stream), dtype="float64")
        vector /= np.linalg.norm(vector) + 1e-9
        weight = seg["end"] - seg["start"]
        sums[speaker] = sums.get(speaker, 0) + vector * weight
        used[speaker] = used.get(speaker, 0.0) + weight
    return {k: v / (np.linalg.norm(v) + 1e-9) for k, v in sums.items()}


def merge_small(segments: List[dict], samples, rate: int, extractor, min_share: float = 0.02,
                min_similarity: float = 0.3) -> Tuple[List[dict], dict]:
    import numpy as np

    talk: Dict[int, float] = {}
    for seg in segments:
        talk[int(seg["speaker"])] = talk.get(int(seg["speaker"]), 0.0) + seg["end"] - seg["start"]
    total = sum(talk.values()) or 1.0
    small = [k for k, v in talk.items() if v / total < min_share]
    big = [k for k in talk if k not in small]
    info = {"clusters_before": len(talk), "small": len(small), "merged": {}, "kept_small": []}
    if not small or not big:
        info["clusters_after"] = len(talk)
        return segments, info
    centroids = _centroids(samples, rate, segments, extractor)
    mapping = {}
    for k in sorted(small, key=lambda k: talk[k]):
        if k not in centroids:
            # No segment long enough to embed: attach to the speaker it is most often adjacent to.
            mapping[k] = None
            continue
        sims = {b: float(np.dot(centroids[k], centroids[b])) for b in big if b in centroids}
        if not sims:
            continue
        best = max(sims, key=sims.get)
        if sims[best] >= min_similarity:
            mapping[k] = best
            info["merged"][str(k)] = {"into": best, "similarity": round(sims[best], 3),
                                      "seconds": round(talk[k], 2)}
        else:
            info["kept_small"].append({"cluster": k, "best_similarity": round(sims[best], 3),
                                       "seconds": round(talk[k], 2)})
    ordered = sorted(segments, key=lambda s: s["start"])
    for k, target in list(mapping.items()):
        if target is None:
            neighbours: Dict[int, int] = {}
            for i, seg in enumerate(ordered):
                if int(seg["speaker"]) == k:
                    for j in (i - 1, i + 1):
                        if 0 <= j < len(ordered) and int(ordered[j]["speaker"]) in big:
                            n = int(ordered[j]["speaker"])
                            neighbours[n] = neighbours.get(n, 0) + 1
            if neighbours:
                mapping[k] = max(neighbours, key=neighbours.get)
                info["merged"][str(k)] = {"into": mapping[k], "similarity": None, "seconds": round(talk[k], 2),
                                          "reason": "too short to embed; adjacent speaker"}
            else:
                del mapping[k]
    merged = [{**seg, "speaker": mapping.get(int(seg["speaker"]), int(seg["speaker"]))} for seg in segments]
    info["clusters_after"] = len({int(s["speaker"]) for s in merged})
    return merged, info


def make_extractor(model_path: str, threads: int):
    import sherpa_onnx

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model_path, num_threads=threads, provider="cpu")
    if not config.validate():
        raise RuntimeError("Invalid speaker embedding configuration")
    return sherpa_onnx.SpeakerEmbeddingExtractor(config)
