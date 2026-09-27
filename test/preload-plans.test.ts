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

it('exposes only the named Plans CRUD/lifecycle IPC calls', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  const id = '00000000-0000-4000-8000-000000000000';
  const create = { title: 'Plan', items: [{ text: 'Step', status: 'todo' }] };
  const patch = { title: 'Renamed' };

  await api.listPlans();
  await api.ensureSessionPlan('session-42');
  await api.createPlan(create);
  await api.updatePlan(id, patch, 42);
  await api.archivePlan(id);

  expect(invoke.mock.calls.slice(-5)).toEqual([
    ['plans:list', undefined],
    ['plans:ensureSession', { id: 'session-42' }],
    ['plans:create', create],
    ['plans:update', { id, patch, expectedUpdatedAt: 42 }],
    ['plans:archive', { id }]
  ]);
});
