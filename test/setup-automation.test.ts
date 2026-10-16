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

  it('loads the Companion when Chrome omits WebUI ids and the folder field has no ValuePattern', async () => {
    const screen = { x: 0, y: 0, width: 1920, height: 1080 };
    const browserWindow = { id: 7, app: 'Chrome.setupbrowserprofile.Default', process: 'chrome' };
    const pickerWindow = { id: 19, app: 'chrome-folder-picker', process: 'chrome' };
    let pickerOpen = false;

    computer.listWindows.mockResolvedValue({ windows: [browserWindow], screen });
    computer.activeWindow.mockImplementation(async () => ({
      window: pickerOpen ? pickerWindow : browserWindow,
      screen,
    }));
    computer.findUi.mockImplementation(async ({ window, query }: { window?: number; query?: string }) => ({
      window: window ?? 7,
      snapshotId: 1,
      elements: window === 7 && query === 'Load unpacked'
        ? [{ ref: 'load-ref', name: 'Load unpacked', role: 'Button', automationId: '', enabled: true }]
        : window === 19 && query === '1152'
          ? [{ ref: 'path-ref', name: 'Folder:', role: 'Edit', automationId: '1152', enabled: true }]
          : window === 19 && query === '1'
            ? [{ ref: 'select-ref', name: 'Select Folder', role: 'Button', automationId: '1', enabled: true }]
            : [],
    }));
    computer.act.mockImplementation(async (steps: Array<{ type?: string; ref?: string }>) => {
      if (steps.some(step => step.type === 'set_value')) {
        throw new Error('PARTIAL_BATCH: completed_count=0 failed_index=0 routes=none. UI_VALUE_UNSUPPORTED: the referenced element does not expose ValuePattern');
      }
      if (steps.some(step => step.ref === 'load-ref')) pickerOpen = true;
      if (steps.some(step => step.ref === 'select-ref')) pickerOpen = false;
      return { cursor: null, clipboard: [], completedCount: steps.length, routes: [] };
    });

    await expect(loadUnpackedCompanion({
      extensionPath: 'C:\\Program Files\\ParadigmEve\\extension',
      isEveBrowserWindow: window => window.id === 7,
      timeoutMs: 1,
    })).resolves.toBe(true);
    expect(computer.act).toHaveBeenCalledWith([
      { type: 'focus', window: 7 },
      { type: 'click_ref', ref: 'load-ref' },
    ], { window: 7 });
    expect(computer.act).toHaveBeenCalledWith([{ type: 'ui_action', ref: 'path-ref', action: 'focus' }], { window: 19 });
    expect(computer.act).toHaveBeenCalledWith([
      { type: 'keypress', keys: ['ctrl', 'a'] },
      { type: 'type', text: 'C:\\Program Files\\ParadigmEve\\extension' },
    ], { window: 19 });
    expect(computer.act).toHaveBeenCalledWith([{ type: 'click_ref', ref: 'select-ref' }], { window: 19 });
  });

  // The picker as the live Windows build exposes it: control 1152 is a pattern-less Pane.
  function folderPicker(options: { focus?: 'fails'; type?: 'fails'; selectButton?: boolean } = {}) {
    const screen = { x: 0, y: 0, width: 1920, height: 1080 };
    const browserWindow = { id: 7, app: 'Chrome.setupbrowserprofile.Default', process: 'chrome' };
    const pickerWindow = { id: 19, app: 'chrome-folder-picker', process: 'chrome' };
    let pickerOpen = false;
    computer.listWindows.mockResolvedValue({ windows: [browserWindow], screen });
    computer.activeWindow.mockImplementation(async () => ({ window: pickerOpen ? pickerWindow : browserWindow, screen }));
    computer.findUi.mockImplementation(async ({ window, query }: { window?: number; query?: string }) => ({
      window: window ?? 7,
      snapshotId: 1,
      elements: window === 7 && query === 'Load unpacked'
        ? [{ ref: 'load-ref', name: 'Load unpacked', role: 'Button', automationId: '', enabled: true }]
        : window === 19 && query === '1152'
          ? [{ ref: 'path-ref', name: 'Folder:', role: 'Pane', automationId: '1152', enabled: true }]
          : window === 19 && query === '1' && options.selectButton !== false
            ? [{ ref: 'select-ref', name: 'Select Folder', role: 'Button', automationId: '1', enabled: true }]
            : [],
    }));
    computer.act.mockImplementation(async (steps: Array<{ type?: string; ref?: string; keys?: string[] }>) => {
      if (options.focus === 'fails' && steps.some(step => step.type === 'ui_action')) throw new Error('UI_ACTION_UNSUPPORTED');
      if (options.type === 'fails' && steps.some(step => step.type === 'type')) throw new Error('INPUT_REJECTED');
      if (steps.some(step => step.ref === 'load-ref')) pickerOpen = true;
      if (steps.some(step => step.ref === 'select-ref' || step.keys?.[0] === 'enter')) pickerOpen = false;
      return { cursor: null, clipboard: [], completedCount: steps.length, routes: [] };
    });
    return () => loadUnpackedCompanion({
      extensionPath: 'D:\\Data\\paradigmeve\\extension',
      isEveBrowserWindow: window => window.id === 7,
      timeoutMs: 1,
    });
  }

  it('still types the folder when focusing the pattern-less field fails, since it already has focus', async () => {
    await expect(folderPicker({ focus: 'fails' })()).resolves.toBe(true);
    expect(computer.act).toHaveBeenCalledWith([
      { type: 'keypress', keys: ['ctrl', 'a'] },
      { type: 'type', text: expect.stringContaining('paradigmeve') },
    ], { window: 19 });
  });

  it('pastes the folder when typing is rejected', async () => {
    await expect(folderPicker({ type: 'fails' })()).resolves.toBe(true);
    expect(computer.act).toHaveBeenCalledWith([
      { type: 'keypress', keys: ['ctrl', 'a'] },
      { type: 'paste', text: expect.stringContaining('paradigmeve') },
    ], { window: 19 });
  });

  it('accepts with Enter, the default button, when Select Folder is not exposed', async () => {
    await expect(folderPicker({ selectButton: false })()).resolves.toBe(true);
    expect(computer.act).toHaveBeenCalledWith([{ type: 'keypress', keys: ['enter'] }], { window: 19 });
  });
});
