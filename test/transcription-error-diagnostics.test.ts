import { describe, expect, it } from 'vitest';
import { safeTranscriptionChildError } from '../src/main/transcription-runner.js';

describe('cloud transcription error capture', () => {
  it('classifies safe OpenAI HTTP failures and provides a corrective action', () => {
    const value = safeTranscriptionChildError(
      'Error: CLOUD_ASR_ERROR provider=openai status=403 category=permission code=insufficient_permissions retryable=false\n', 'openai');
    expect(value).toMatchObject({ provider: 'openai', status: 403, category: 'permission',
      code: 'insufficient_permissions', retryable: false });
    expect(value.message).toContain('Model capabilities');
    expect(JSON.stringify(value)).not.toContain('sk-');
  });
  it('gives actionable advice for 401, 429, bad audio, and network timeouts', () => {
    const cases = [
      ['401', 'authentication', 'API key'],
      ['429', 'quota', 'billing'],
      ['400', 'invalid_audio', 'recording'],
      ['none', 'timeout', 'connectivity']
    ] as const;
    for (const [status, category, advice] of cases) {
      const value = safeTranscriptionChildError(
        `Error: CLOUD_ASR_ERROR provider=openai status=${status} category=${category} retryable=false\n`, 'openai');
      expect(value.category).toBe(category);
      expect(value.message.toLowerCase()).toContain(advice.toLowerCase());
    }
  });
  it('rejects provider spoofing and unknown category rather than logging untrusted details', () => {
    for (const input of [
      'Error: CLOUD_ASR_ERROR provider=groq status=401 category=authentication retryable=false',
      'Error: CLOUD_ASR_ERROR provider=openai status=401 category=secret_path retryable=false',
      'Error: HTTP 401 Bearer sk-very-secret with D:\\Recordings\\private\\audio.wav',
      'Error: CLOUD_ASR_ERROR provider=openai status=401 category=authentication retryable=false more=secrets'
    ]) {
      const safe = safeTranscriptionChildError(input, 'openai');
      expect(safe.category).toBe('unknown');
      expect(JSON.stringify(safe)).not.toMatch(/sk-very-secret|Recordings|Bearer|secret_path/);
    }
  });
  it('reads only an exact bounded marker even amid noisy stderr containing secrets', () => {
    const safe = safeTranscriptionChildError(
      'Traceback with Authorization: Bearer sk-supersecret\nError: CLOUD_ASR_ERROR provider=openai status=429 category=rate_limit retryable=true\n', 'openai');
    expect(safe.status).toBe(429);
    expect(safe.retryable).toBe(true);
    expect(JSON.stringify(safe)).not.toContain('supersecret');
  });
});
