import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = process.cwd();

describe('runtime multi-agent enable regression', () => {
  it('wires persistence before unconditional restore and preserves history while disabled', async () => {
    const source = await readFile(path.join(repo, 'src/main/index.ts'), 'utf8');
    const persistSink = source.indexOf('onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot))');
    const restoreRead = source.indexOf('const savedSwarm = await readDurable<SwarmSnapshot>(SWARM_STATE)');
    const shutdownFence = source.indexOf('if (windowActivation.isDisabled()) return;', restoreRead);
    const restore = source.indexOf('restoreSwarm(savedSwarm)', restoreRead);
    const disabledPause = source.indexOf("pauseSwarmForDisable('multi-agent mode is disabled')");

    expect(persistSink).toBeGreaterThanOrEqual(0);
    expect(restoreRead).toBeGreaterThanOrEqual(0);
    expect(shutdownFence).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(disabledPause).toBeGreaterThanOrEqual(0);
    expect(persistSink).toBeLessThan(restoreRead);
    expect(restoreRead).toBeLessThan(shutdownFence);
    expect(shutdownFence).toBeLessThan(restore);
    expect(restore).toBeLessThan(disabledPause);
    expect(source).not.toContain('await writeDurableNow(SWARM_STATE, null)');
  });
});

describe('companion extension setup contract', () => {
  it('recovers only from the extension bundled with this private app, never a public release URL', async () => {
    const [html, renderer, preload, ipc, version] = await Promise.all([
      readFile(path.join(repo, 'src/renderer/index.html'), 'utf8'),
      readFile(path.join(repo, 'src/renderer/main.ts'), 'utf8'),
      readFile(path.join(repo, 'src/preload/index.ts'), 'utf8'),
      readFile(path.join(repo, 'src/main/ipc.ts'), 'utf8'),
      readFile(path.join(repo, 'src/main/version.ts'), 'utf8')
    ]);

    expect(html).not.toContain('bridgeDownload');
    expect(html).not.toMatch(/Download extension ZIP/i);
    expect(html).toMatch(/Required for exact chat identity/i);
    expect(html).toMatch(/Requires the Companion extension to be loaded and connected/i);
    expect(renderer).not.toContain('api.downloadExtension()');
    expect(preload).not.toContain("bridge:downloadExtension");
    expect(ipc).not.toContain("bridge:downloadExtension");
    expect(version).not.toContain('github.com/totec448-spec/chat-on-steroids/releases');
  });
});

describe('private runtime update provenance', () => {
  it('contains no public GitHub runtime update authority', async () => {
    const files = await Promise.all([
      'src/main/update.ts',
      'src/main/version.ts',
      'src/main/ipc.ts',
      'src/renderer/main.ts',
      'src/shared/types.ts'
    ].map(file => readFile(path.join(repo, file), 'utf8')));
    const source = files.join('\n');
    expect(source).not.toContain('api.github.com/repos/totec448-spec/chat-on-steroids');
    expect(source).not.toContain('github.com/totec448-spec/chat-on-steroids/releases');
    expect(source).not.toContain('RELEASES_PAGE');
    expect(files[0]).not.toMatch(/\bfetch\s*\(/);
  });
});
