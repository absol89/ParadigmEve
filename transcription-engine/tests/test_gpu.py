"""GPU capability detection, backend selection and truthful provenance (no GPU needed).

Run from transcription-engine/:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ldw import gpu, pipeline  # noqa: E402
from ldw.settings import RunSettings  # noqa: E402


def probe_json(backends, devices):
    return json.dumps({"probe": "ggml-probe/1", "backends": backends, "devices": devices})


P600 = {"name": "Vulkan0", "description": "Quadro P600", "backend": "Vulkan", "type": "gpu",
        "memory_total": 4294967296, "memory_free": 4000000000, "gpu_index": 0, "usable": True, "error": None}
CPU = {"name": "CPU", "description": "Intel CPU", "backend": "CPU", "type": "cpu", "memory_total": 0, "memory_free": 0}


class ProbeParsing(unittest.TestCase):
    def test_usable_vulkan_device(self):
        result = gpu.parse_probe_output(probe_json(["Vulkan", "CPU"], [P600, CPU]))
        self.assertEqual(result["status"], gpu.USABLE)
        self.assertEqual(result["compiled_backend"], "vulkan")
        self.assertEqual(result["selected"]["description"], "Quadro P600")

    def test_compiled_but_device_failed_compute_check(self):
        broken = dict(P600, usable=False, error="wrong result")
        result = gpu.parse_probe_output(probe_json(["Vulkan", "CPU"], [broken, CPU]))
        self.assertEqual(result["status"], gpu.UNAVAILABLE)
        self.assertIsNone(result["selected"])
        self.assertIn("wrong result", result["reason"])

    def test_compiled_but_no_device(self):
        result = gpu.parse_probe_output(probe_json(["Vulkan", "CPU"], [CPU]))
        self.assertEqual(result["status"], gpu.UNAVAILABLE)

    def test_cpu_only_build(self):
        result = gpu.parse_probe_output(probe_json(["CPU"], [CPU]))
        self.assertEqual(result["status"], gpu.CPU_ONLY)
        self.assertIsNone(result["compiled_backend"])

    def test_missing_binaries_are_cpu_only(self):
        with mock.patch.object(gpu, "find_probe", return_value=None):
            self.assertEqual(gpu.probe()["status"], gpu.CPU_ONLY)

    def test_missing_vulkan_loader_is_unavailable(self):
        completed = mock.Mock(returncode=-1073741515, stdout="")  # 0xC0000135 STATUS_DLL_NOT_FOUND
        with mock.patch.object(gpu, "find_probe", return_value=Path("p.exe")), \
                mock.patch.object(gpu, "find_gpu_whisper_cli", return_value=Path("w.exe")), \
                mock.patch.object(gpu.subprocess, "run", return_value=completed):
            result = gpu.probe()
        self.assertEqual(result["status"], gpu.UNAVAILABLE)
        self.assertIn("vulkan-1.dll", result["reason"])


class LogEvidence(unittest.TestCase):
    def test_gpu_only_when_whisper_says_so(self):
        lines = ["ggml_vulkan: 0 = Quadro P600 (NVIDIA) | uma: 0 | fp16: 0 | bf16: 0",
                 "whisper_backend_init_gpu: using Vulkan0 backend"]
        self.assertEqual(gpu.backend_from_log(lines), {"backend": "vulkan", "device": "Quadro P600"})

    def test_silence_or_no_gpu_is_cpu(self):
        self.assertEqual(gpu.backend_from_log([])["backend"], "cpu")
        self.assertEqual(gpu.backend_from_log(["whisper_backend_init_gpu: no GPU found"])["backend"], "cpu")


class Planning(unittest.TestCase):
    def usable(self):
        return gpu.parse_probe_output(probe_json(["Vulkan", "CPU"], [P600, CPU]))

    def test_cpu_request_never_uses_gpu(self):
        plan = pipeline.plan_asr_execution(RunSettings(asr_device="cpu").resolved(), self.usable())
        self.assertEqual((plan["requested"], plan["backend"]), ("cpu", "cpu"))
        self.assertEqual(pipeline.device_args("cpu", None), ["-ng"])

    def test_gpu_request_with_usable_probe(self):
        with mock.patch.object(gpu, "find_gpu_whisper_cli", return_value=Path("vk/whisper-cli.exe")):
            plan = pipeline.plan_asr_execution(RunSettings(asr_device="gpu").resolved(), self.usable())
        self.assertEqual((plan["backend"], plan["gpu_index"], plan["device"]), ("vulkan", 0, "Quadro P600"))
        self.assertEqual(pipeline.device_args("vulkan", 0), ["-dev", "0"])
        self.assertNotIn("-ng", pipeline.device_args("vulkan", 0))

    def test_gpu_request_without_capability_falls_back_with_reason(self):
        cpu_only = gpu.parse_probe_output(probe_json(["CPU"], [CPU]))
        plan = pipeline.plan_asr_execution(RunSettings(asr_device="gpu").resolved(), cpu_only)
        self.assertEqual(plan["backend"], "cpu")
        self.assertIn("cpu-only-build", plan["fallback_reason"])

    def test_unknown_gpu_index_falls_back(self):
        plan = pipeline.plan_asr_execution(RunSettings(asr_device="gpu", gpu_device=3).resolved(), self.usable())
        self.assertEqual(plan["backend"], "cpu")


class Execution(unittest.TestCase):
    """_transcribe_local: GPU proven by log, otherwise explicit CPU fallback (or failure)."""

    def run_local(self, settings, gpu_log, gpu_raises=False):
        calls = []

        def fake_transcribe(cli, model, wav, tmp, s, timeout, cancel, progress, timings, peaks,
                            backend="cpu", gpu_index=None, log=None):
            calls.append(backend)
            if backend == "vulkan":
                if gpu_raises:
                    raise RuntimeError("vk device lost")
                log.extend(gpu_log)
            timings["transcription"] = 1.0
            return {"transcription": []}

        usable = gpu.parse_probe_output(probe_json(["Vulkan", "CPU"], [P600, CPU]))
        with mock.patch.object(gpu, "probe", return_value=usable), \
                mock.patch.object(gpu, "find_gpu_whisper_cli", return_value=Path("vk.exe")), \
                mock.patch.object(pipeline.paths, "find_whisper_cli", return_value=Path("cpu.exe")), \
                mock.patch.object(pipeline, "_require", side_effect=lambda path, what: path), \
                mock.patch.object(pipeline, "_transcribe", side_effect=fake_transcribe):
            _, execution = pipeline._transcribe_local(Path("m.bin"), Path("a.wav"), Path("."), settings, 60,
                                                      None, lambda *a: None, {}, {})
        return calls, execution

    def test_real_gpu_run_is_recorded_as_vulkan(self):
        calls, execution = self.run_local(RunSettings(asr_device="gpu").resolved(),
                                          ["whisper_backend_init_gpu: using Vulkan0 backend"])
        self.assertEqual(calls, ["vulkan"])
        self.assertEqual((execution["backend"], execution["fallback"]), ("vulkan", None))

    def test_gpu_that_silently_ran_on_cpu_is_rerun_and_labelled_cpu(self):
        calls, execution = self.run_local(RunSettings(asr_device="gpu").resolved(), [])
        self.assertEqual(calls, ["vulkan", "cpu"])
        self.assertEqual(execution["backend"], "cpu")
        self.assertEqual(execution["fallback"]["from"], "gpu")

    def test_gpu_crash_falls_back_to_cpu_with_reason(self):
        calls, execution = self.run_local(RunSettings(asr_device="gpu").resolved(), [], gpu_raises=True)
        self.assertEqual(calls, ["vulkan", "cpu"])
        self.assertIn("vk device lost", execution["fallback"]["reason"])

    def test_no_fallback_fails_instead_of_mislabelling(self):
        with self.assertRaises(RuntimeError):
            self.run_local(RunSettings(asr_device="gpu", gpu_fallback=False).resolved(), [], gpu_raises=True)

    def test_cpu_route_unchanged(self):
        calls, execution = self.run_local(RunSettings(asr_device="cpu").resolved(), [])
        self.assertEqual(calls, ["cpu"])
        self.assertEqual((execution["requested"], execution["backend"]), ("cpu", "cpu"))


if __name__ == "__main__":
    unittest.main()
