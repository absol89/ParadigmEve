"""Cloud ASR failure classification and redaction; network/audio stay mocked.

Run from transcription-engine/: python -m unittest discover -s tests -p test_cloud_asr_errors.py -v
"""

from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ldw import cloud_asr  # noqa: E402


KEY = "sk-sensitive-transcription-key-0123456789"
PATH = r"D:\Recordings\private meetings\audio.wav"
SECRET = "discussion from confidential recording"
URL = cloud_asr.PROVIDERS["openai"]["url"]


def http_error(status: int, code: str | None = None, *,
               message: str = SECRET) -> urllib.error.HTTPError:
    error = {"message": message, "type": "invalid_request_error", "param": PATH}
    if code is not None:
        error["code"] = code
    return urllib.error.HTTPError(URL, status, f"{KEY} {PATH}",
                                  {"authorization": "Bearer " + KEY},
                                  io.BytesIO(json.dumps({"error": error}).encode("utf-8")))


class CloudAsrErrors(unittest.TestCase):
    def request(self, failure: BaseException) -> tuple[cloud_asr.CloudError, mock.Mock]:
        with mock.patch.object(cloud_asr.urllib.request, "urlopen", side_effect=failure) as urlopen:
            with self.assertRaises(cloud_asr.CloudError) as raised:
                cloud_asr._post(b"sample encrypted recording bytes", "audio/ogg", KEY, 0.1,
                                provider="openai", model="whisper-1", url=URL)
        return raised.exception, urlopen

    def assert_clean(self, error: cloud_asr.CloudError) -> None:
        text = str(error)
        self.assertLess(len(text), 160)
        self.assertTrue(text.startswith("CLOUD_ASR_ERROR provider=openai status="))
        for sensitive in (KEY, PATH, SECRET, "Bearer ", "https://", "Authorization", "reason="):
            self.assertNotIn(sensitive, text)
            self.assertNotIn(sensitive, repr(error))
            self.assertNotIn(sensitive, json.dumps(error.as_dict()))
        self.assertEqual(error.provider, "openai")
        self.assertEqual(error.model, "whisper-1")

    def test_openai_http_401_key_rejected_is_typed_and_no_upload_retry(self):
        error, urlopen = self.request(http_error(401, "invalid_api_key"))
        self.assertEqual(error.as_dict(), {
            "provider": "openai", "model": "whisper-1", "http_status": 401,
            "category": "authentication", "retryable": False, "code": "invalid_api_key",
        })
        self.assertEqual(str(error), "CLOUD_ASR_ERROR provider=openai status=401 "
                         "category=authentication code=invalid_api_key retryable=false")
        self.assert_clean(error)
        urlopen.assert_called_once()

    def test_openai_http_403_permission_denied(self):
        error, urlopen = self.request(http_error(403))
        self.assertEqual((error.status, error.category, error.retryable), (403, "permission_denied", False))
        self.assert_clean(error)
        urlopen.assert_called_once()

    def test_openai_http_400_bad_request_is_not_retryable(self):
        error, urlopen = self.request(http_error(400, "unsupported_parameter"))
        self.assertEqual((error.status, error.category, error.retryable), (400, "invalid_request", False))
        self.assertEqual(error.code, "unsupported_parameter")
        self.assert_clean(error)
        urlopen.assert_called_once()

    def test_openai_http_429_rate_limit_reports_retryability_but_never_reposts(self):
        error, urlopen = self.request(http_error(429, "rate_limit_exceeded"))
        self.assertEqual((error.status, error.category, error.retryable), (429, "rate_limit", True))
        self.assert_clean(error)
        urlopen.assert_called_once()

    def test_openai_http_429_insufficient_quota_is_not_a_transient_rate_limit(self):
        error, urlopen = self.request(http_error(429, "insufficient_quota"))
        self.assertEqual((error.status, error.category, error.retryable), (429, "quota", False))
        self.assertEqual(error.code, "insufficient_quota")
        self.assert_clean(error)
        urlopen.assert_called_once()

    def test_http_500_has_no_automatic_repeated_upload(self):
        error, urlopen = self.request(http_error(500, "some secret remote code"))
        self.assertEqual((error.status, error.category, error.retryable, error.code),
                         (500, "server_error", True, None))
        self.assert_clean(error)
        urlopen.assert_called_once()

    def test_openai_network_timeout_does_not_expose_url_or_os_reason(self):
        error, urlopen = self.request(urllib.error.URLError(TimeoutError(f"{PATH} {KEY} timed out")))
        self.assertEqual((error.status, error.category, error.retryable), (None, "timeout", True))
        self.assertIn("status=none category=timeout retryable=true", str(error))
        self.assert_clean(error)
        urlopen.assert_called_once()

    def test_generic_network_error_never_surfaces_raw_reason(self):
        error, urlopen = self.request(urllib.error.URLError(f"server {SECRET}: {PATH}; {KEY}"))
        self.assertEqual((error.category, error.retryable), ("network", True))
        self.assert_clean(error)
        urlopen.assert_called_once()

    def test_direct_timeout_is_typed_and_not_replayed(self):
        error, urlopen = self.request(TimeoutError(f"Timeout uploading {PATH}; token={KEY}"))
        self.assertEqual((error.category, error.retryable), ("timeout", True))
        self.assert_clean(error)
        urlopen.assert_called_once()

    def test_invalid_json_response_is_safe_and_no_repost(self):
        response = mock.MagicMock()
        response.read.return_value = ("not JSON " + SECRET).encode("utf-8")
        response.__enter__.return_value = response
        with mock.patch.object(cloud_asr.urllib.request, "urlopen", return_value=response) as urlopen:
            with self.assertRaises(cloud_asr.CloudError) as raised:
                cloud_asr._post(b"audio", "audio/ogg", KEY, 1,
                                provider="openai", model="whisper-1", url=URL)
        self.assertEqual((raised.exception.category, raised.exception.retryable), ("response", False))
        self.assert_clean(raised.exception)
        urlopen.assert_called_once()

    def test_missing_openai_key_is_safe_and_provider_specific(self):
        with mock.patch.dict(cloud_asr.os.environ, {"OPENAI_API_KEY": "", "GROQ_API_KEY": KEY}):
            with self.assertRaises(cloud_asr.CloudError) as raised:
                cloud_asr.api_key("openai", "whisper-1")
        self.assertEqual((raised.exception.category, raised.exception.retryable),
                         ("configuration", False))
        self.assert_clean(raised.exception)

    def test_selected_openai_provider_never_switches_and_encoded_chunk_is_cleaned_on_failure(self):
        calls = []
        def fake_encode(_wav, out, _start, _duration, _cancel):
            out.write_bytes(b"fake-encoded-audio")

        def fake_post(body, content_type, key, timeout, *, provider, model, url):
            calls.append((provider, model, url, key, content_type))
            raise cloud_asr.CloudError(provider=provider, model=model, status=403,
                                       category="permission_denied")

        with tempfile.TemporaryDirectory(prefix="ldw-cloud-test-") as temp, \
                mock.patch.object(cloud_asr, "api_key", return_value=KEY), \
                mock.patch.object(cloud_asr, "_encode", side_effect=fake_encode), \
                mock.patch.object(cloud_asr, "_post", side_effect=fake_post):
            directory = Path(temp)
            with self.assertRaises(cloud_asr.CloudError):
                cloud_asr.transcribe(Path(PATH), 10, "sv", provider="openai", tmp=directory)
            self.assertEqual(calls, [("openai", "whisper-1", URL, KEY,
                                      mock.ANY)])
            self.assertEqual(list(directory.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
