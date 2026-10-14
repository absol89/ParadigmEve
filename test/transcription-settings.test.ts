import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  cloneTranscriptionSettings,
  transcriptionCloudKeyRemoved,
  transcriptionOrder,
  transcriptionSettingsIssue
} from '../src/shared/transcription.js';

const allAvailable = { gpu: true, local: true, cloud: true };

describe('transcription avenues', () => {
  it('defaults to GPU first, Local second, Cloud last and Cloud off', () => {
    expect(DEFAULT_TRANSCRIPTION_SETTINGS.gpu).toEqual({ enabled: false, priority: 1 });
    expect(DEFAULT_TRANSCRIPTION_SETTINGS.local).toEqual({ enabled: true, priority: 2 });
    expect(DEFAULT_TRANSCRIPTION_SETTINGS.cloud).toMatchObject({ enabled: false, priority: 3 });
    expect(transcriptionOrder(DEFAULT_TRANSCRIPTION_SETTINGS, allAvailable)).toEqual(['local']);
  });

  it('runs the lowest enabled priority first and skips unavailable avenues', () => {
    const settings = cloneTranscriptionSettings();
    settings.cloud.enabled = true;
    settings.cloud.priority = 1;
    settings.gpu.priority = 5;
    settings.gpu.enabled = true;
    expect(transcriptionOrder(settings, allAvailable)).toEqual(['cloud', 'local', 'gpu']);
    expect(transcriptionOrder(settings, { gpu: false, local: true, cloud: false })).toEqual(['local']);
  });

  it('accepts only whole-number priorities', () => {
    for (const priority of [0, 100, 1.5, Number.NaN, -1]) {
      const settings = cloneTranscriptionSettings();
      settings.local.priority = priority;
      expect(transcriptionSettingsIssue(settings, false)).toMatch(/whole numbers/);
    }
  });

  it('rejects duplicate priorities among enabled avenues only', () => {
    const settings = cloneTranscriptionSettings();
    settings.gpu.enabled = true;
    settings.local.priority = 1;
    expect(transcriptionSettingsIssue(settings, false)).toMatch(/different priority/);
    settings.gpu.enabled = false;
    expect(transcriptionSettingsIssue(settings, false)).toBeNull();
  });

  it('requires at least one enabled avenue', () => {
    const settings = cloneTranscriptionSettings();
    settings.gpu.enabled = false;
    settings.local.enabled = false;
    expect(transcriptionSettingsIssue(settings, true)).toMatch(/at least one/);
  });

  it('cannot enable Cloud without a stored key', () => {
    const settings = cloneTranscriptionSettings();
    settings.cloud.enabled = true;
    expect(transcriptionSettingsIssue(settings, false)).toMatch(/API key/);
    expect(transcriptionSettingsIssue(settings, true)).toBeNull();
    settings.cloud.provider = 'openai';
    expect(transcriptionSettingsIssue(settings, true, false)).toMatch(/API key/);
    expect(transcriptionSettingsIssue(settings, false, true)).toBeNull();
  });

  it('cloning never shares objects with the defaults', () => {
    const settings = cloneTranscriptionSettings();
    settings.cloud.enabled = true;
    expect(DEFAULT_TRANSCRIPTION_SETTINGS.cloud.enabled).toBe(false);
  });
  it('removing only the selected cloud provider key disables cloud', () => {
    const settings = cloneTranscriptionSettings();
    settings.cloud.enabled = true;
    expect(transcriptionCloudKeyRemoved(settings, 'transcriptionGroqApiKey')).toBe(true);
    expect(transcriptionCloudKeyRemoved(settings, 'openaiApiKey')).toBe(false);
    settings.cloud.provider = 'openai';
    expect(transcriptionCloudKeyRemoved(settings, 'transcriptionGroqApiKey')).toBe(false);
    expect(transcriptionCloudKeyRemoved(settings, 'openaiApiKey')).toBe(true);
    settings.cloud.enabled = false;
    expect(transcriptionCloudKeyRemoved(settings, 'openaiApiKey')).toBe(false);
  });
});
