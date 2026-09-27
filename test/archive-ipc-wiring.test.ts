import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = await readFile(path.join(process.cwd(), 'src/main/ipc.ts'), 'utf8');

function handlerBlock(channel: string, nextChannel: string): string {
  const start = source.indexOf(`handle('${channel}'`);
  const end = source.indexOf(`handle('${nextChannel}'`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Archive IPC wiring', () => {
  it('keeps all archive actions fixed and payload-free', () => {
    const status = handlerBlock('archive:status', 'archive:rebuild');
    const rebuild = handlerBlock('archive:rebuild', 'archive:openStatic');
    const open = handlerBlock('archive:openStatic', 'plans:ensureSession');

    for (const block of [status, rebuild, open]) {
      expect(block).toContain('z.undefined().parse(payload)');
      expect(block).not.toMatch(/payload\.(?:path|file|index|root)/u);
    }
    expect(status).toContain('archiveStatusForRenderer(requireArchiveRuntime().status())');
    expect(rebuild).toContain('archiveRebuildForRenderer(await requireArchiveRuntime().rebuildDerived())');
    expect(status).toContain("sanitizeArchiveRendererError(error, 'Archive status is unavailable.')");
    expect(rebuild).toContain("sanitizeArchiveRendererError(error, 'Archive rebuild failed.')");
  });

  it('rebuilds, verifies the runtime-owned index, then opens exactly the verified file', () => {
    const open = handlerBlock('archive:openStatic', 'plans:ensureSession');
    const rebuildAt = open.indexOf('await runtime.rebuildDerived()');
    const targetAt = open.indexOf('runtime.staticSiteTarget()');
    const verifyAt = open.indexOf('await verifiedArchiveStaticIndex');
    const shellAt = open.indexOf('await shell.openPath(indexPath)');

    expect(rebuildAt).toBeGreaterThanOrEqual(0);
    expect(targetAt).toBeGreaterThan(rebuildAt);
    expect(verifyAt).toBeGreaterThan(rebuildAt);
    expect(shellAt).toBeGreaterThan(verifyAt);
    expect(open).not.toContain('shell.openPath(payload');
    expect(open).toContain("sanitizeArchiveRendererError(error, 'Static archive could not be opened.')");
  });

  it('retires archive evidence only after the explicit live session delete lands', () => {
    const remove = handlerBlock('sessions:delete', 'handoff:get');
    const liveDeleteAt = remove.indexOf('await deleteSession(id)');
    const archiveRetireAt = remove.indexOf('await archiveRuntime.retireSession(id)');
    expect(liveDeleteAt).toBeGreaterThanOrEqual(0);
    expect(archiveRetireAt).toBeGreaterThan(liveDeleteAt);
  });

});
