"""doctor must not send the shipped runtime to a developer setup or treat first-use downloads as failures."""

import unittest
from unittest import mock

from ldw import doctor, gpu


UNAVAILABLE = {"status": gpu.CPU_ONLY, "compiled_backend": None, "reason": "no GPU build", "selected": None}


class DoctorTests(unittest.TestCase):
    def run_checks(self, embedded):
        with mock.patch.object(doctor, "embedded_runtime", return_value=embedded), \
                mock.patch.object(doctor.paths, "find_tool", return_value=None), \
                mock.patch.object(doctor.downloads, "is_installed", return_value=False), \
                mock.patch.object(doctor.gpu, "probe", return_value=UNAVAILABLE):
            return {name: (status, detail) for name, status, detail in doctor.checks("large-v3-turbo-q5_0")}

    def test_embedded_runtime_needs_no_venv_and_downloads_on_first_use(self):
        result = self.run_checks(embedded=True)
        self.assertNotIn("venv", result)
        self.assertEqual(result["runtime"][0], doctor.OK)
        self.assertEqual(result["ffmpeg"], (doctor.WARN, "downloaded on first use"))
        models = [value for key, value in result.items() if key.startswith("model:")]
        self.assertTrue(models)
        self.assertTrue(all(status == doctor.WARN for status, _ in models if "missing" in _))

    def test_developer_checkout_still_fails_on_missing_prerequisites(self):
        result = self.run_checks(embedded=False)
        self.assertIn("venv", result)
        self.assertEqual(result["ffmpeg"][0], doctor.FAIL)

    def test_gpu_line_reports_cpu_only_as_warning(self):
        result = self.run_checks(embedded=True)
        self.assertEqual(result["gpu"][0], doctor.WARN)
        self.assertIn(gpu.CPU_ONLY, result["gpu"][1])


if __name__ == "__main__":
    unittest.main()
