/**
 * The user's own standing instructions, appended to what each connector says about itself.
 *
 * Issue #85: there was no persistent way to add anything, so the only route was patching
 * `app.asar` — which an update overwrites. This is a settings field instead.
 *
 * Two properties are worth defending in tests rather than in review. It goes **last**, because
 * everything above it is what the app can actually promise about its own tools and a preference
 * must not quietly redefine one. And it is **attributed**, so the model can tell a standing
 * instruction from this user apart from the connector's description of itself — those carry
 * different authority, and running them together hides that.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { MAX_MCP_INSTRUCTIONS_CHARS, defaultConfig, getConfig, initConfigPath, saveConfig } = await import(
  '../src/main/config.js'
);
const { serverInstructions } = await import('../src/main/mcp/instructions.js');
const { workContext } = await import('../src/main/mcp/work-context.js');
const { surfaceDefinition } = await import('../src/main/mcp/surfaces.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');
const { CAPABILITIES } = await import('../src/shared/types.js');
type Capabilities = import('../src/shared/types.js').Capabilities;

let dir: string;

const allCapabilities = (): Capabilities =>
  Object.fromEntries(CAPABILITIES.map((name) => [name, true])) as Capabilities;

const ctx = {
  roots: [],
  caps: allCapabilities(),
  readOnly: false,
  sessionTools: false,
  agentTools: false
};

const HEADING = "The user's own standing instructions for this connector:";

async function withInstructions(instructions: string): Promise<void> {
  const config = getConfig();
  await saveConfig({ ...config, mcp: { ...config.mcp, instructions } });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-mcp-instructions-');
  initConfigPath(dir);
  await saveConfig(defaultConfig());
});

afterAll(async () => {
  await removeTempDir(dir);
});

beforeEach(async () => {
  const config = getConfig();
  await saveConfig({ ...config, mcp: { ...config.mcp, connectorName: 'Eve', instructions: '' } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the user’s own connector instructions', () => {
  it('explains the transient ChatGPT safety refusal and offers session_finish to any model', () => {
    // Ported from Chat On Steroids 2.1.17 (#555, #556).
    const text = serverInstructions({ ...ctx, exposedFinishTool: true } as any, 'core', 'win32');
    expect(text).toContain('"This tool call was blocked by OpenAI because we couldn\'t determine the safety status of the request." comes from ChatGPT before Eve receives the call');
    expect(text).toContain('retry the identical call once');
    expect(text).toContain('Use session_finish only when the user prompt explicitly requests it, with any model.');
    expect(text).not.toMatch(/Astra only/);
  });

  it('projects a Unicode per-install name into Core guidance and work_context while keeping serverName stable', async () => {
    const config = getConfig();
    await saveConfig({ ...config, mcp: { ...config.mcp, connectorName: 'Eva Å' } });

    const workerCtx = { ...ctx, agentTools: true };
    const text = serverInstructions(workerCtx, 'core', 'win32');
    expect(text).toContain('Use the connected tools as needed: Eva Å for files');
    expect(text).toContain('Host: Windows. Instance: Eva Å. Roots:');
    expect(text).toContain('select or @mention Eva Å');
    expect(text).toContain('Workers communicate with Eva Å');
    expect(text).toContain('internal recipient id is "prime"');
    expect(text).not.toContain('communicate with the prime');
    expect(text).toContain('/paradigmeve-manual');
    expect(text).toContain('/appdata');

    const context = workContext(workerCtx, 'win32').structuredContent as Record<string, unknown>;
    expect(context.instance).toBe('Eva Å');
    expect(context.guidance).toContain('select or @mention Eva Å');
    expect(context.appNamespaces).toEqual({
      manual: '/paradigmeve-manual',
      appData: '/appdata',
      installation: '/paradigmeve'
    });
    expect(JSON.stringify(context.nextSteps)).toContain('Never adopt another Eva Å conversation by title or recency.');
    expect(JSON.stringify(context.nextSteps)).not.toContain('another Prime');

    expect(surfaceDefinition('core', 'Eva Å')).toMatchObject({
      connectorName: 'Eva Å',
      serverName: 'paradigmeve-core'
    });
  });

  it('starts with the coding guidance and explains the one ParadigmEve app once beside the local tools without a setup link', () => {
    const text = serverInstructions(ctx, 'core', 'win32');
    expect(text.startsWith('You are a coding agent working with the user through ParadigmEve.')).toBe(true);
    const intro = text.split('\n').find(line => line.startsWith('Use the connected tools as needed:'))!;
    expect(intro).toContain('Eve for files');
    expect(intro).toContain('its enabled Computer use tools for screen');
    expect(intro).toContain('ParadigmEve Plugins for enabled external apps');
    expect(text.indexOf(intro)).toBeGreaterThan(text.indexOf('# Local tools'));
    expect(text).not.toMatch(/This is ParadigmEve|https:\/\/chatgpt.com\/#settings\/Plugins/);
    expect(serverInstructions(ctx, 'core', 'linux')).not.toContain('Computer use tools for screen');
    expect(text).not.toContain('ParadigmEve Desktop');
  });
  it('adapts upstream instructions without unsupported facilities and projects live tools', () => {
    const text = serverInstructions(ctx, 'core', 'win32');
    expect(text).toContain('Do not settle for a partial or "helpful enough" solution');
    expect(text).toContain('look for AGENTS.md');
    expect(text).toContain('For releases, verify Git history/status');
    expect(text).toContain('Commit cumulative baselines on the target-version branch before packaging');
    expect(text).toContain('a dirty tree or version string is not ancestry proof');
    expect(text).not.toMatch(/SKILL\.md|functions\.|tool_search|approval auto-review|user-requested computer shutdown/);
    expect(text).not.toContain('Use update_plan');
    expect(serverInstructions({ ...ctx, sessionTools: true }, 'core', 'win32')).toContain('Use update_plan');
    const withoutCommands = serverInstructions({ ...ctx, caps: { ...ctx.caps, command: false } }, 'core', 'linux');
    expect(withoutCommands).toContain('find searches');
    expect(withoutCommands).not.toContain('exec_command runs');
  });

  it('teaches a fresh account to use Eve-native durable workflow instead of prose lookalikes', () => {
    const text = serverInstructions({ ...ctx, sessionTools: true, agentTools: true }, 'core', 'win32');
    expect(text).toContain('# Eve-native workflow');
    expect(text).toContain('real synced Plan with update_plan');
    expect(text).toContain('A Markdown checklist in chat is only prose');
    expect(text).toContain('Completing every item leaves a human Plan Live as Ready to archive');
    expect(text).toContain('that is not user signoff');
    expect(text).toContain('delegate them with agents');
    expect(text).toContain('Pins, Threads and Quilts are ParadigmEve\'s durable curation layer');
    expect(text).toContain('Pin is the save action');
    expect(text).toContain('Opening `%Thread` activates that Thread\'s standing prompt plus saved Pins');
    expect(text).toContain('`#Quilt` contributes member Threads\' saved Pins as broad context without activating their prompts');
    expect(text).toContain('`#` is the Quilt sigil');
    expect(text).toContain('Schedule is a first-class ParadigmEve workspace.');
    expect(text).toContain('use the `schedule` tool rather than leaving a prose promise');
    expect(text).toContain('Preserve the conversation-backed purpose');
    expect(text).toContain('the tool binds source chat identity itself, so never invent source ids');
    expect(text).toContain('`#expenses` alone never authorizes receipt filing or ledger writes');
    expect(text).toContain('“tomorrow instead”');
    expect(text).toContain('Treat one-time feedback as one-time unless the user clearly makes it a standing recurring preference.');
    expect(text).toContain('use the saved source references to check relevant newer user messages/current state before acting');
    expect(text).toContain('if a materially needed source is unavailable, explain that instead of inventing it');
    expect(text).toContain('`#schedule` (also spelled `#schedules`; the app also accepts Swedish and Spanish spellings), `#myweek`, and `#routines` are ordinary Quilt references');
    expect(text).toContain('user\'s availability (`%schedule`) and Eve\'s routines (`%evecron`)');
    expect(text).toContain('do not treat either Thread or any Quilt as authority over current durable schedule state');
    expect(text).toContain('require an explicit Eve task duration before claiming shared free time');
    expect(text).not.toContain('“tagging”');
    expect(text).not.toContain('Tag is not the operational product name');
    expect(text).toContain('If it points to a local Vault/manual');

    const withoutNativeFeatures = serverInstructions({ ...ctx, sessionTools: false, agentTools: false }, 'core', 'win32');
    expect(withoutNativeFeatures).not.toContain('# Eve-native workflow');
    expect(withoutNativeFeatures).not.toContain('real synced Plan with update_plan');
    expect(withoutNativeFeatures).not.toContain('Ready to archive');
    expect(withoutNativeFeatures).not.toContain('delegate them with agents');
  });

  it('adds nothing at all when empty, not even the heading', () => {
    expect(defaultConfig().mcp.instructions).toBe('');
    for (const surface of ['core', 'desktop'] as const) {
      const text = serverInstructions(ctx, surface, 'win32');
      expect(text, surface).not.toContain(HEADING);
    }
  });

  it.each(['core', 'desktop'] as const)('appends them last on the %s connector, attributed', async (surface) => {
    const mine = 'Always run the test suite before saying a change works.';
    await withInstructions(mine);

    const text = serverInstructions(ctx, surface, 'win32');
    expect(text).toContain(HEADING);
    expect(text).toContain(mine);
    // Last: nothing the app authored may follow, or a preference would be read as overriding
    // guidance that comes after it.
    expect(text.trimEnd().endsWith(mine)).toBe(true);
    // And the heading immediately precedes it, so the attribution cannot drift away.
    expect(text.indexOf(HEADING)).toBeLessThan(text.indexOf(mine));
  });

  it('leaves everything the app says about itself intact', async () => {
    const before = serverInstructions(ctx, 'core', 'win32');
    await withInstructions('Prefer pnpm.');
    const after = serverInstructions(ctx, 'core', 'win32');

    // Added to, never edited: the connector's own description is unchanged character for
    // character, and only the attributed block is new.
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain('Prefer pnpm.');
  });

  it('survives a reload, which is the whole point of it being a setting', async () => {
    await withInstructions('Never force-push.');
    initConfigPath(dir);
    expect(getConfig().mcp.instructions).toBe('Never force-push.');
    expect(serverInstructions(ctx, 'core', 'win32')).toContain('Never force-push.');
  });

  it('trims surrounding whitespace rather than emitting a blank block', async () => {
    await withInstructions('   \n  \t ');
    expect(getConfig().mcp.instructions).toBe('');
    expect(serverInstructions(ctx, 'core', 'win32')).not.toContain(HEADING);
  });

  it('caps an over-long value instead of rejecting the whole config', async () => {
    // Repaired, not rejected. This is free text a person typed, and one over-long field must
    // not send every root and every permission through conservative recovery.
    await withInstructions('x'.repeat(MAX_MCP_INSTRUCTIONS_CHARS + 500));
    const stored = getConfig().mcp.instructions;
    expect(stored.length).toBe(MAX_MCP_INSTRUCTIONS_CHARS);
    // And the rest of the config is still the real one, not the conservative fallback.
    expect(getConfig().readOnly).toBe(false);
    expect(serverInstructions(ctx, 'core', 'win32')).toContain(stored);
  });
});
