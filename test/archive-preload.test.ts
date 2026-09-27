import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

const { invoke, expose } = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ ok: true, data: null })),
  expose: vi.fn()
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn(() => '') }
}));

it('exposes the Archive surface through fixed no-payload IPC methods', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];

  await api.archiveStatus();
  await api.archiveRebuild();
  await api.archiveOpenStatic();

  expect(invoke.mock.calls.slice(-3)).toEqual([
    ['archive:status', undefined],
    ['archive:rebuild', undefined],
    ['archive:openStatic', undefined]
  ]);
});

it('types Archive IPC with the renderer-safe contract instead of main-process runtime DTOs', async () => {
  const source = await readFile(path.join(process.cwd(), 'src/preload/index.ts'), 'utf8');
  expect(source).toContain("from '../shared/archive-renderer.js'");
  expect(source).not.toContain("from '../main/archive/archive-runtime.js'");
});
