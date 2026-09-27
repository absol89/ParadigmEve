import { expect, it, vi } from 'vitest';

const { invoke, expose, getPath } = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ ok: true, data: [] })), expose: vi.fn(), getPath: vi.fn((file: any) => file.path ?? '')
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke },
  webUtils: { getPathForFile: getPath }
}));

it('transports pathless clipboard bytes and disk paths through one bounded image import', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  const bytes = new Uint8Array([1, 2, 3]);
  const arrayBuffer = vi.fn(async () => bytes.buffer);
  await api.dropFiles([{ name: 'clipboard.png', size: 3, arrayBuffer }, { name: 'disk.png', size: 3, path: '/disk.png' }]);
  expect(invoke).toHaveBeenCalledWith('sessions:dropFiles', { files: [{ name: 'clipboard.png', bytes }, '/disk.png'] });
  expect(arrayBuffer).toHaveBeenCalledOnce();
  invoke.mockClear(); arrayBuffer.mockClear();
  expect(await api.dropFiles([{ name: 'huge.png', size: 12 * 1024 * 1024 + 1, arrayBuffer }])).toMatchObject({ ok: false });
  expect(await api.dropFiles(Array(21).fill({ name: 'clipboard.png', size: 3, arrayBuffer }))).toMatchObject({ ok: false });
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it('exposes Pins through fixed chooser-shaped IPC methods', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  invoke.mockClear();
  const request = {
    kind: 'message',
    target: { mode: 'existing', quiltId: '11111111-1111-4111-8111-111111111111' },
    provenance: { sessionId: 'session-preload', conversationId: null, eventSeq: 7 }
  };
  await api.createPin(request);
  expect(invoke).toHaveBeenLastCalledWith('pins:create', request);
  const pinId = '33333333-3333-4333-8333-333333333333';
  await api.removePin(pinId);
  expect(invoke).toHaveBeenLastCalledWith('pins:remove', { pinId });
  await api.setPinSticky(pinId, true);
  expect(invoke).toHaveBeenLastCalledWith('pins:setSticky', { pinId, sticky: true });
  await api.setQuiltState(request.target.quiltId, 'archived');
  expect(invoke).toHaveBeenLastCalledWith('pins:setQuiltState', { quiltId: request.target.quiltId, state: 'archived' });
  await api.createQuilt('New Quilt', ['22222222-2222-4222-8222-222222222222']);
  expect(invoke).toHaveBeenLastCalledWith('pins:createQuilt', {
    title: 'New Quilt', collectionIds: ['22222222-2222-4222-8222-222222222222']
  });
  await api.createThread({
    title: 'New Concept',
    prompt: 'Standing guidance',
    collectionNames: ['Eve']
  });
  expect(invoke).toHaveBeenLastCalledWith('pins:createThread', {
    title: 'New Concept',
    prompt: 'Standing guidance',
    collectionNames: ['Eve']
  });
  await api.getStarterThread('plans');
  expect(invoke).toHaveBeenLastCalledWith('pins:starterThread', { starterId: 'plans' });
  await api.updateQuilt(request.target.quiltId, 'Docs', 'Project docs', [], 'https://example.com/docs');
  expect(invoke).toHaveBeenLastCalledWith('pins:updateQuilt', {
    quiltId: request.target.quiltId,
    title: 'Docs',
    description: 'Project docs',
    collectionNames: [],
    link: 'https://example.com/docs'
  });
  await api.deleteQuilt(request.target.quiltId);
  expect(invoke).toHaveBeenLastCalledWith('pins:deleteQuilt', { quiltId: request.target.quiltId });
});
