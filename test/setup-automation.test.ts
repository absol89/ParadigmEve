import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const computer = vi.hoisted(() => ({
  activeWindow: vi.fn(),
  act: vi.fn(),
  findUi: vi.fn(),
  listWindows: vi.fn(),
}));

vi.mock('../src/main/computer/index.js', () => computer);

import {
  cancelCompanionSetupStep,
  completeCompanionSetupStep,
  configureSetupAutomation,
  loadUnpackedCompanion,
  pendingCompanionSetupStep,
  requestCompanionSetupStep,
} from '../src/main/setup-automation.js';

beforeEach(() => {
  cancelCompanionSetupStep();
  vi.clearAllMocks();
});

afterEach(() => {
  cancelCompanionSetupStep();
});

describe('automatic setup request ownership', () => {
  it('offers exactly one wake-backed request and accepts only its exact result', async () => {
    const wake = vi.fn();
    configureSetupAutomation({ wake });
    const result = requestCompanionSetupStep('tunnel', { name: 'ParadigmEve' });
    const request = pendingCompanionSetupStep()!;
    expect(wake).toHaveBeenCalledTimes(1);
    expect(request.step).toBe('tunnel');
    expect(request.params).toEqual({ name: 'ParadigmEve' });
    await expect(requestCompanionSetupStep('api-key', {})).rejects.toThrow('still running');
    expect(completeCompanionSetupStep({ id: 'wrong-id', ok: true, result: { tunnelId: 'wrong' } })).toBe(false);
    expect(completeCompanionSetupStep({ id: request.id, ok: true, result: { tunnelId: 'correct' } })).toBe(true);
    await expect(result).resolves.toEqual({ tunnelId: 'correct' });
    expect(pendingCompanionSetupStep()).toBeNull();
    expect(completeCompanionSetupStep({ id: request.id, ok: true, result: {} })).toBe(false);
  });

  it('retires the request on Stop and rejects a late or replayed browser result', async () => {
    configureSetupAutomation({ wake: vi.fn() });
    const pending = requestCompanionSetupStep('api-key', { name: 'ParadigmEve' });
    const { id } = pendingCompanionSetupStep()!;
    cancelCompanionSetupStep('Stopped by user');
    await expect(pending).rejects.toThrow('Stopped by user');
    expect(pendingCompanionSetupStep()).toBeNull();
    expect(completeCompanionSetupStep({ id, ok: true, result: { apiKey: 'stale-secret' } })).toBe(false);
    const replacement = requestCompanionSetupStep('tunnel', {});
    const replacementId = pendingCompanionSetupStep()!.id;
    expect(replacementId).not.toBe(id);
    expect(completeCompanionSetupStep({ id, ok: true, result: {} })).toBe(false);
    expect(completeCompanionSetupStep({ id: replacementId, ok: true, result: { ok: true } })).toBe(true);
    await expect(replacement).resolves.toEqual({ ok: true });
  });

  it('times out and refuses a result that arrives after the request expired', async () => {
    configureSetupAutomation({ wake: vi.fn() });
    const pending = requestCompanionSetupStep('chatgpt-app', {}, 20);
    const { id } = pendingCompanionSetupStep()!;
    await expect(pending).rejects.toThrow('did not finish');
    expect(pendingCompanionSetupStep()).toBeNull();
    expect(completeCompanionSetupStep({ id, ok: true, result: { appId: 'stale' } })).toBe(false);
  });

  it('does not run a browser step when no exact dedicated extensions window is found', async () => {
    computer.listWindows.mockResolvedValue({ windows: [{ id: 9, app: 'another-browser' }] });
    computer.findUi.mockResolvedValue({ elements: [] });
    await expect(loadUnpackedCompanion({
      extensionPath: 'C:\\Program Files\\ParadigmEve\\extension',
      isEveBrowserWindow: window => window.id === 7,
      timeoutMs: 1,
    })).resolves.toBe(false);
    expect(computer.act).not.toHaveBeenCalled();
  });
});
