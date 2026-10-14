import { describe, expect, it } from 'vitest';
import { availableTranscriptionAvenues, cancelTranscriptionJob, getTranscriptionJob, publicTranscriptionDocument, startTranscriptionJob } from '../src/main/transcription-runner.js';
import { cloneTranscriptionSettings } from '../src/shared/transcription.js';

describe('main-process transcription jobs', () => {
  it('honors the chosen cloud recipient and falls back to local by priority', () => {
    const settings = cloneTranscriptionSettings();
    settings.cloud.enabled = true;
    settings.cloud.priority = 1;
    settings.local.priority = 2;
    settings.gpu.priority = 3;
    settings.cloud.provider = 'openai';
    expect(availableTranscriptionAvenues(settings, { groq: 'available', openai: null })).toEqual(['local']);
    expect(availableTranscriptionAvenues(settings, { groq: null, openai: 'available' })).toEqual(['cloud', 'local']);
    settings.cloud.provider = 'groq';
    expect(availableTranscriptionAvenues(settings, { groq: null, openai: 'available' })).toEqual(['local']);
    expect(availableTranscriptionAvenues(settings, { groq: 'available', openai: null })).toEqual(['cloud', 'local']);
  });
  it('does not issue a job or spawn a child for an absent audio source', async () => {
    await expect(startTranscriptionJob({
      audioPath: 'this-audio-file-does-not-exist-3bc07683.wav',
      engineRoot: '.',
      outputRoot: '.'
    })).rejects.toThrow('ENOENT');
  });

  it('cannot retrieve or cancel unknown job identities', () => {
    expect(getTranscriptionJob('unknown')).toBeNull();
    expect(cancelTranscriptionJob('unknown')).toBe(false);
  });

  it('keeps native recording paths out of IPC transcript snapshots while retaining cloud provenance', () => {
    const result = publicTranscriptionDocument({ schema: 'eve.local-transcript', segments: [],
      source: { path: 'C:\\private\\recording.wav', file_name: 'recording.wav' },
      privacy: { cloud_transfer: { destination: 'groq' } } }) as Record<string, any>;
    expect(result.source.path).toBeUndefined();
    expect(result.source.file_name).toBe('recording.wav');
    expect(result.privacy.cloud_transfer.destination).toBe('groq');
  });
});
