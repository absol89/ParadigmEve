import { beforeEach, expect, it, vi } from 'vitest';

// Ported from Chat On Steroids 2.1.34 (27e5d1f0, #1287): a script that calls another connector's
// tool used to fail with a bare "not a function".
const tunnel = vi.hoisted(() => ({ tunnelId: 'core-id', desktopTunnelId: 'desktop-id', pluginsTunnelId: 'plugins-id' }));
vi.mock('../src/main/config.js', async original => {
  const real = await original<typeof import('../src/main/config.js')>();
  return { ...real, getConfig: () => ({ ...real.defaultConfig(), tunnel: { ...real.defaultConfig().tunnel, ...tunnel } }) };
});
const { unknownToolNote, unknownToolReferences } = await import('../src/main/mcp/code-mode-tool.js');
const { CORE_CONNECTOR_NAME, CONNECTOR_BRAND } = await import('../src/main/mcp/surfaces.js');

beforeEach(() => { Object.assign(tunnel, { tunnelId: 'core-id', desktopTunnelId: 'desktop-id', pluginsTunnelId: 'plugins-id' }); });

it('finds the tools a script uses that this connector lacks, dotted, optional or quoted', () => {
  const code = 'await tools.exec_command({cmd:"ls"}); await tools["view_image"]({}); await tools.update_plan?.({}); await tools.memory_read({}); text(ALL_TOOLS)';
  expect(unknownToolReferences(code, ['memory_read'])).toEqual(['exec_command', 'view_image', 'update_plan']);
  expect(unknownToolReferences('await tools.memory_read({})', ['memory_read'])).toEqual([]);
  // Checking for a tool is not calling it.
  expect(unknownToolReferences('text(typeof tools.exec_command); if (tools["view_image"]) {}', [])).toEqual([]);
});

it('names the connector a Core tool belongs to', () => {
  const note = unknownToolNote('plugins', ['exec_command', 'made_up']);
  expect(note).toContain(`tools.exec_command (a ${CORE_CONNECTOR_NAME} tool), tools.made_up`);
  expect(note).toContain(`which ${CONNECTOR_BRAND} Plugins does not offer`);
  expect(note).toContain('"not a function"');
  expect(note).not.toContain('Secure Tunnel ID');
});

it('says a declared Core tool is not enabled instead of sending the model to another connector', () => {
  const note = unknownToolNote('core', ['read_clipboard']);
  expect(note).toContain(`tools.read_clipboard (not enabled on ${CORE_CONNECTOR_NAME} right now)`);
  expect(note).not.toContain('Desktop tool');
});

it('says when the connector shares its Secure Tunnel ID with another', () => {
  tunnel.pluginsTunnelId = 'core-id';
  const note = unknownToolNote('plugins', ['exec_command']);
  expect(note).toContain(`${CONNECTOR_BRAND} Plugins shares its Secure Tunnel ID with ${CORE_CONNECTOR_NAME}`);
  expect(note).toContain('Give each connector its own tunnel ID in Setup.');
  tunnel.pluginsTunnelId = '';
  expect(unknownToolNote('plugins', ['exec_command'])).not.toContain('Secure Tunnel ID');
});
