import { describe, expect, it } from 'vitest';
import { asrDeviceArgs, availableTranscriptionAvenues, executedAsrBackend } from '../src/main/transcription-runner.js';
import {
  UNKNOWN_GPU_CAPABILITY,
  cloneTranscriptionSettings,
  parseGpuProbe,
  transcriptionSettingsIssue,
  type TranscriptionGpuCapability
} from '../src/shared/transcription.js';

const usable: TranscriptionGpuCapability = { status: 'usable', device: 'Quadro P600', reason: null };

function probeLine(status: string, selected: object | null, reason: string | null = null): string {
  return JSON.stringify({ schema: 'ldw.gpu-probe/1', status, reason, selected, devices: [] });
}

describe('GPU transcription capability', () => {
  it('trusts only a probe that proved a named device', () => {
    expect(parseGpuProbe(probeLine('usable', { description: 'Quadro P600', gpu_index: 0 })))
      .toEqual({ status: 'usable', device: 'Quadro P600', reason: null });
    // "usable" without a device is not proof.
    expect(parseGpuProbe(probeLine('usable', null)).status).toBe('unknown');
    expect(parseGpuProbe(probeLine('device-unavailable', null, 'no GPU passed'))).toEqual(
      { status: 'device-unavailable', device: null, reason: 'no GPU passed' });
    expect(parseGpuProbe(probeLine('cpu-only-build', null, 'no Vulkan build')).status).toBe('cpu-only-build');
    expect(parseGpuProbe('not json').status).toBe('unknown');
    expect(parseGpuProbe(JSON.stringify({ schema: 'other', status: 'usable' })).status).toBe('unknown');
  });

  it('offers the GPU avenue only when the probe proved it', () => {
    const settings = cloneTranscriptionSettings();
    settings.gpu.enabled = true;
    const keys = { groq: null, openai: null };
    expect(availableTranscriptionAvenues(settings, keys)).toEqual(['local']);
    expect(availableTranscriptionAvenues(settings, keys, UNKNOWN_GPU_CAPABILITY)).toEqual(['local']);
    expect(availableTranscriptionAvenues(settings, keys,
      { status: 'device-unavailable', device: null, reason: 'x' })).toEqual(['local']);
    expect(availableTranscriptionAvenues(settings, keys, usable)).toEqual(['gpu', 'local']);
  });

  it('Settings cannot enable GPU unless it is usable, and can always disable it', () => {
    const settings = cloneTranscriptionSettings();
    expect(settings.gpu.enabled).toBe(false);
    settings.gpu.enabled = true;
    expect(transcriptionSettingsIssue(settings, false, false, false)).toMatch(/not available/);
    expect(transcriptionSettingsIssue(settings, false, false, true)).toBeNull();
    settings.gpu.enabled = false;
    expect(transcriptionSettingsIssue(settings, false, false, false)).toBeNull();
  });

  it('builds engine arguments per avenue; GPU never falls back silently inside the engine', () => {
    expect(asrDeviceArgs('gpu')).toEqual(['--asr-device', 'gpu', '--no-gpu-fallback']);
    expect(asrDeviceArgs('local')).toEqual(['--asr-device', 'cpu']);
    expect(asrDeviceArgs('cloud')).toEqual([]);
  });

  it('reports what really ran and refuses a GPU result that was not a GPU run', () => {
    const doc = (execution: object) => ({ provenance: { asr_execution: execution } });
    expect(executedAsrBackend(doc({ backend: 'vulkan', device: 'Quadro P600' }), 'gpu'))
      .toEqual({ backend: 'vulkan', device: 'Quadro P600' });
    expect(executedAsrBackend(doc({ backend: 'cpu', fallback: { from: 'gpu' } }), 'gpu')).toBeNull();
    expect(executedAsrBackend(doc({ backend: 'vulkan' }), 'gpu')).toBeNull();
    expect(executedAsrBackend(doc({ backend: 'cpu' }), 'local')).toEqual({ backend: 'cpu' });
    expect(executedAsrBackend(doc({ backend: 'vulkan', device: 'x' }), 'local')).toBeNull();
    expect(executedAsrBackend(doc({ backend: 'groq' }), 'cloud')).toEqual({ backend: 'groq' });
    expect(executedAsrBackend({}, 'local')).toBeNull();
  });
});
