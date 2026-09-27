import { REASONING_EFFORTS } from '../src/shared/session.js';
import { DEFAULT_AGENT_EXECUTION_SETTINGS } from '../src/shared/agent-backends.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_GOAL_MODEL,
  defaultContextWindowForBuild,
  defaultConfig,
  initConfigPath,
  loadConfig,
  saveConfig,
  updateConfig
} from '../src/main/config.js';
import { DESKTOP_CAPABILITIES, type Capability } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-config-');
  initConfigPath(dir);
});

afterAll(async () => {
  await removeTempDir(dir);
});

describe('settings migration', () => {
  it('restores the composer pair independently of worker defaults and preserves explicit native default', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, ui: { ...config.ui, chatModel: '5.6', chatReasoning: 'high' },
      multiAgent: { ...config.multiAgent, defaultModel: '5.6', defaultReasoning: 'medium' } });
    const restored = await loadConfig();
    expect(restored.ui).toMatchObject({ chatModel: '5.6', chatReasoning: 'high' });
    expect(restored.multiAgent.defaultReasoning).toBe('medium');
    await saveConfig({ ...restored, ui: { ...restored.ui, chatModel: null, chatReasoning: null } });
    expect((await loadConfig()).ui).toMatchObject({ chatModel: null, chatReasoning: null });
    await saveConfig(config);
    expect((await loadConfig()).ui.chatModel).toBeUndefined();
  });

  it('defaults fresh and legacy agent execution to GPT Chat for orchestrator and worker', async () => {
    expect(defaultConfig().execution).toEqual(DEFAULT_AGENT_EXECUTION_SETTINGS);

    const legacy = defaultConfig() as unknown as Record<string, unknown>;
    delete legacy.execution;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).execution).toEqual(DEFAULT_AGENT_EXECUTION_SETTINGS);
  });

  it('round-trips valid unavailable agent backends without silently changing them', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      execution: { orchestrator: 'custom', worker: 'ollama' }
    });
    expect((await loadConfig()).execution).toEqual({ orchestrator: 'custom', worker: 'ollama' });
  });

  it('repairs only invalid agent backend ids and preserves the other saved choice', async () => {
    const config = defaultConfig() as unknown as Record<string, unknown>;
    config.execution = { orchestrator: 'future-backend', worker: 'ollama' };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
    expect((await loadConfig()).execution).toEqual({ orchestrator: 'gpt-chat', worker: 'ollama' });
  });

  it('defaults old installs to Eve and preserves a Unicode per-install connector name', async () => {
    expect(defaultConfig().mcp.connectorName).toBe('Eve');

    const legacy = defaultConfig();
    delete (legacy.mcp as { connectorName?: string }).connectorName;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).mcp.connectorName).toBe('Eve');

    await saveConfig({
      ...defaultConfig(),
      mcp: { ...defaultConfig().mcp, connectorName: 'Eva Å' }
    });
    expect((await loadConfig()).mcp.connectorName).toBe('Eva Å');
  });

  it('marks fresh installs incomplete without turning legacy upgrades back into first-run setup', async () => {
    expect(defaultConfig().onboarding).toEqual({ complete: false });
    const legacy = defaultConfig();
    delete legacy.onboarding;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).onboarding).toBeUndefined();
    await saveConfig({ ...defaultConfig(), onboarding: { complete: true } });
    expect((await loadConfig()).onboarding).toEqual({ complete: true });
  });

  it('defaults background chats on for fresh and omitted settings while preserving saved choices', async () => {
    expect(defaultConfig().ui.backgroundChats).toBe(true);
    expect((await loadConfig()).ui.backgroundChats).toBe(true);
    const legacy = defaultConfig(); delete legacy.ui.backgroundChats;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).ui.backgroundChats).toBe(true);
    for (const backgroundChats of [false, true]) {
      await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, backgroundChats } });
      expect((await loadConfig()).ui.backgroundChats).toBe(backgroundChats);
    }
  });
  it('defaults login startup and auto-connect off while preserving every explicit saved combination', async () => {
    expect(defaultConfig().ui.autoConnect).toBe(false);
    expect(defaultConfig().ui.startAtLogin).toBe(false);
    const legacy = defaultConfig();
    delete legacy.ui.startAtLogin;
    legacy.ui.autoConnect = true;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).ui).toMatchObject({ startAtLogin: false, autoConnect: true });
    for (const [autoConnect, startAtLogin] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoConnect, startAtLogin } });
      expect((await loadConfig()).ui).toMatchObject({ autoConnect, startAtLogin });
    }
  });
  it('defaults automatic plugin refresh on for fresh and omitted settings while preserving saved choices', async () => {
    expect(defaultConfig().ui.autoRefreshPlugins).toBe(true);
    expect((await loadConfig()).ui.autoRefreshPlugins).toBe(true);
    const legacy = defaultConfig(); delete legacy.ui.autoRefreshPlugins;
    await saveConfig(legacy);
    expect((await loadConfig()).ui.autoRefreshPlugins).toBe(true);
    for (const autoRefreshPlugins of [false, true]) {
      await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoRefreshPlugins } });
      expect((await loadConfig()).ui.autoRefreshPlugins).toBe(autoRefreshPlugins);
    }
  });
  it('defaults privacy screenshots on for fresh and omitted settings while preserving saved choices', async () => {
    expect(defaultConfig().ui.privacyScreenshots).toBe(true);
    const legacy = defaultConfig() as unknown as Record<string, any>;
    delete legacy.ui.privacyScreenshots;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).ui.privacyScreenshots).toBe(true);
    for (const privacyScreenshots of [false, true]) {
      await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, privacyScreenshots } });
      expect((await loadConfig()).ui.privacyScreenshots).toBe(privacyScreenshots);
    }
  });
  it('defaults, repairs, and persists Concepts presentation preferences without invalidating the config', async () => {
    expect(defaultConfig().ui).toMatchObject({
      conceptQuiltRows: 2,
      conceptPinPreviewDensity: 2,
      conceptDescriptionTextSize: 'medium',
      conceptDescriptionRows: 2,
      conceptPromptTextSize: 'medium',
      conceptPromptRows: 2
    });

    const legacy = defaultConfig() as any;
    delete legacy.ui.conceptQuiltRows;
    delete legacy.ui.conceptPinPreviewDensity;
    delete legacy.ui.conceptDescriptionTextSize;
    delete legacy.ui.conceptDescriptionRows;
    delete legacy.ui.conceptPromptTextSize;
    delete legacy.ui.conceptPromptRows;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).ui).toMatchObject({
      conceptQuiltRows: 2,
      conceptPinPreviewDensity: 2,
      conceptDescriptionTextSize: 'medium',
      conceptDescriptionRows: 2,
      conceptPromptTextSize: 'medium',
      conceptPromptRows: 2
    });

    legacy.ui = {
      ...legacy.ui,
      conceptQuiltRows: 99,
      conceptPinPreviewDensity: 9,
      conceptDescriptionTextSize: 'huge',
      conceptDescriptionRows: 0,
      conceptPromptTextSize: 'tiny',
      conceptPromptRows: -1
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    expect((await loadConfig()).ui).toMatchObject({
      conceptQuiltRows: 2,
      conceptPinPreviewDensity: 2,
      conceptDescriptionTextSize: 'medium',
      conceptDescriptionRows: 2,
      conceptPromptTextSize: 'medium',
      conceptPromptRows: 2
    });

    const configured = defaultConfig();
    configured.ui = {
      ...configured.ui,
      conceptQuiltRows: 4,
      conceptPinPreviewDensity: 4,
      conceptDescriptionTextSize: 'large',
      conceptDescriptionRows: 6,
      conceptPromptTextSize: 'small',
      conceptPromptRows: 3
    };
    await saveConfig(configured);
    expect((await loadConfig()).ui).toMatchObject({
      conceptQuiltRows: 4,
      conceptPinPreviewDensity: 4,
      conceptDescriptionTextSize: 'large',
      conceptDescriptionRows: 6,
      conceptPromptTextSize: 'small',
      conceptPromptRows: 3
    });
  });
  it('defaults browser-only off for fresh and omitted settings while preserving saved choices', async () => {
    expect(defaultConfig().ui.browserOnly).toBe(false);
    const legacy = defaultConfig(); delete legacy.ui.browserOnly;
    await saveConfig(legacy);
    expect((await loadConfig()).ui.browserOnly).toBe(false);
    for (const browserOnly of [false, true]) {
      await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, browserOnly } });
      expect((await loadConfig()).ui.browserOnly).toBe(browserOnly);
    }
  });
  it('defaults Goal and Loop to ChatGPT while preserving explicit backend choices', async () => {
    expect(defaultConfig().goal).toMatchObject({ backend: 'chatgpt', loopBackend: 'chatgpt' });
    for (const backend of ['api', 'templates', 'chatgpt'] as const) {
      await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend, loopBackend: 'api' } });
      expect((await loadConfig()).goal).toMatchObject({ backend, loopBackend: 'api' });
    }
  });
  it('never leaves Goal enabled while session recording is off', async () => {
    const impossible = {
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: false },
      goal: { ...defaultConfig().goal, enabled: true }
    };

    // Every writer goes through saveConfig/updateConfig, including the renderer and extension.
    const saved = await saveConfig(impossible);
    expect(saved.sessions.record).toBe(false);
    expect(saved.goal.enabled).toBe(false);

    // Hand-edited or older persisted state gets the same privacy-preserving repair on load:
    // Goal turns off rather than silently turning recording back on.
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(impossible), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.sessions.record).toBe(false);
    expect(loaded.goal.enabled).toBe(false);
  });

  it('preserves old settings when new safe-default capabilities and UI prefs are added', async () => {
    const oldConfig = {
      roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }],
      capabilities: {
        browse: true,
        search: true,
        read: true,
        metadata: true,
        create: true,
        edit: true,
        move: false,
        deleteFile: false,
        powershell: true,
        command: true,
        screen: true,
        control: true
      },
      readOnly: false,
      tunnel: {
        kind: 'openai',
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        binaryPath: ''
      },
      ui: { minimizeToTray: true, autoConnect: true }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(oldConfig), 'utf8');

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual(oldConfig.roots);
    expect(loaded.capabilities.create).toBe(true);
    expect(loaded.capabilities.clipboardRead).toBe(false);
    expect(loaded.capabilities.clipboardWrite).toBe(false);
    expect(loaded.capabilities.saveArtifact).toBe(false);
    expect(loaded.artifacts.maxFileBytes).toBe(defaultConfig().artifacts.maxFileBytes);
    // A config written before custom providers existed keeps OpenRouter with no URL:
    // an upgrade never moves a running Goal loop onto an endpoint nobody chose.
    expect(loaded.goal.provider).toEqual({ kind: 'openrouter', baseUrl: '' });
    expect(loaded.ui.autoConnect).toBe(true);
    expect(loaded.ui.privacyScreenshots).toBe(true);
    // The one tunnel id a pre-split config had is Core's, because Core is the connector
    // the app cannot work without. Desktop is a second, optional tunnel that starts empty
    // rather than inheriting Core's id — publishing Core twice would be worse than not
    // publishing Desktop at all.
    expect(loaded.tunnel.tunnelId).toBe(oldConfig.tunnel.tunnelId);
    expect(loaded.tunnel.desktopTunnelId).toBe('');
  });

  it('folds a PowerShell-only permission into the single command permission', async () => {
    // `powershell` and `command` were one tool each and are now the single exec_command.
    // A user who had granted only PowerShell keeps the ability they chose; the dead key
    // does not survive into the saved config.
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...defaultConfig(),
        capabilities: {
          ...defaultConfig().capabilities,
          command: false,
          deleteFile: false,
          powershell: true,
          deleteFolder: true
        }
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.capabilities.command).toBe(true);
    expect(Object.keys(loaded.capabilities)).not.toContain('powershell');
    // `deleteFolder` is dropped rather than folded into deleteFile: they were never the
    // same permission, and turning one into the other would widen what the user approved.
    expect(Object.keys(loaded.capabilities)).not.toContain('deleteFolder');
    expect(loaded.capabilities.deleteFile).toBe(false);
  });

  it('renames a saved root that claims a reserved virtual namespace', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...defaultConfig(), roots: [{ name: 'skills', path: 'C:\\Users\\example\\skills' }] }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.roots[0]?.name).toBe('skills-folder');
    expect(loaded.roots[0]?.path).toBe('C:\\Users\\example\\skills');
  });

  it('keeps reserved-name migration from creating duplicate virtual roots', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...defaultConfig(),
        roots: [
          { name: 'skills-folder', path: 'C:\\Users\\example\\already-there' },
          { name: 'skills', path: 'C:\\Users\\example\\legacy-skills' },
          { name: 'skills-folder', path: 'C:\\Users\\example\\duplicate' }
        ]
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.roots.map((root) => root.name)).toEqual(['skills-folder', 'skills-folder-2', 'skills-folder-3']);
    expect(new Set(loaded.roots.map((root) => root.name)).size).toBe(loaded.roots.length);
  });

  it('round-trips a second tunnel id for the Desktop connector', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      tunnel: {
        ...config.tunnel,
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        desktopTunnelId: 'tunnel_fedcba9876543210fedcba9876543210'
      }
    });
    const loaded = await loadConfig();
    expect(loaded.tunnel.tunnelId).toBe('tunnel_0123456789abcdef0123456789abcdef');
    expect(loaded.tunnel.desktopTunnelId).toBe('tunnel_fedcba9876543210fedcba9876543210');
  });

  /**
   * Automatic compaction ends the chat the user is working in and opens a fresh one, and it
   * used to start off on the grounds that this is not something to do to somebody who never
   * asked for it. In use that reasoning turned out to be backwards: the alternative to
   * compacting is hitting the ceiling mid-thought and losing the thread entirely, which is
   * the worse thing to have happen to somebody who never asked for it. Since 1.8 the trigger
   * is edge-based rather than "currently above the line", so the advisory line is safe as
   * the default and still leaves room to finish the crossing turn and write the handoff.
   */
  it('starts with automatic compaction on at the advisory line', async () => {
    await saveConfig(defaultConfig());
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(loaded.sessions.advisoryTokens);
    expect(loaded.compaction.autoTokens).toBe(300_000);
    expect(loaded.sessions.limitTokens).toBe(400_000);
  });

  it('lowers only the debug dogfood window while retaining the normal calibration for other builds', () => {
    expect(defaultContextWindowForBuild('debug')).toBe(300_000);
    expect(defaultContextWindowForBuild('dev')).toBe(369_000);
    expect(defaultContextWindowForBuild('shipping')).toBe(369_000);
  });

  /**
   * The Chat panel offers one number and derives the red line from it, `limit = threshold ×
   * 4/3`. A shipped default that does not already satisfy that relation is a state the UI
   * cannot produce, and it would not survive contact with it: the first save of anything at
   * all in that panel would silently move the red line. So the defaults have to agree with
   * the arithmetic the panel does, which is what this pins.
   */
  it('ships a red line the settings panel would have derived itself', async () => {
    const config = defaultConfig();
    expect(config.sessions.advisoryTokens).toBe(config.compaction.autoTokens);
    expect(config.sessions.limitTokens).toBe(Math.round((config.compaction.autoTokens * 4) / 3));
  });

  /**
   * The migration, and the line it must not cross. A config still carrying both old
   * defaults never had a decision made about it, so it moves to the new one. A config
   * carrying anything else is somebody's own setting and is left exactly as it is.
   */
  it('moves an untouched old default onto the new one', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 300_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(300_000);
  });

  /**
   * The number that has to follow the window is the one the app wrote for itself. Since 1.8
   * that included `auto: true` at 300k — the shipped default in installs that never opened
   * the panel. Changing the source default alone would reach a fresh install and nothing else,
   * which is the whole reason this file has migrations at all.
   */
  it('moves the untouched 1.8 automatic default onto the current window', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 300_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 300_000 });
  });

  it('moves an untouched 2.1.7 debug window down for 2.1.8 dogfood', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      sessions: { ...config.sessions, advisoryTokens: 369_000, limitTokens: 492_000 },
      compaction: { ...config.compaction, auto: true, autoTokens: 369_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.sessions).toMatchObject({ advisoryTokens: 300_000, limitTokens: 400_000 });
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 300_000 });
  });

  it('preserves a user-tuned 2.1.7-era threshold when the full untouched tuple does not match', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      sessions: { ...config.sessions, advisoryTokens: 369_000, limitTokens: 492_000 },
      compaction: { ...config.compaction, auto: true, autoTokens: 250_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.sessions).toMatchObject({ advisoryTokens: 369_000, limitTokens: 492_000 });
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 250_000 });
  });

  /** The exact complete 400k tuple is the previous shipped default and moves down together. */
  it('moves the previous untouched 400k window onto the debug dogfood window', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      sessions: { ...config.sessions, advisoryTokens: 400_000, limitTokens: Math.round((400_000 * 4) / 3) },
      compaction: { ...config.compaction, auto: true, autoTokens: 400_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.sessions).toMatchObject({ advisoryTokens: 300_000, limitTokens: 400_000 });
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 300_000 });
  });

  /** A 400k compaction threshold without the old shipped meter tuple is treated as explicit. */
  it('preserves an explicit 400k automatic threshold', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 400_000 } });
    const loaded = await loadConfig();
    expect(loaded.sessions).toMatchObject({ advisoryTokens: 300_000, limitTokens: 400_000 });
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 400_000 });
  });

  /**
   * The meter's own pair, migrated on the same rule. 300k/400k is what 1.8 wrote for itself,
   * so it follows the window; anything else in either slot was typed and stays.
   */
  it('recalibrates untouched meter pairs and leaves a chosen one', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, advisoryTokens: 300_000, limitTokens: 400_000 } });
    const moved = await loadConfig();
    expect(moved.sessions.advisoryTokens).toBe(300_000);
    expect(moved.sessions.limitTokens).toBe(400_000);

    await saveConfig({
      ...config,
      sessions: { ...config.sessions, advisoryTokens: 400_000, limitTokens: Math.round((400_000 * 4) / 3) },
      compaction: { ...config.compaction, auto: true, autoTokens: 150_000 }
    });
    const movedPreviousMeter = await loadConfig();
    expect(movedPreviousMeter.sessions).toMatchObject({ advisoryTokens: 300_000, limitTokens: 400_000 });
    expect(movedPreviousMeter.compaction.autoTokens).toBe(150_000);

    await saveConfig({ ...config, sessions: { ...config.sessions, advisoryTokens: 300_000, limitTokens: 350_000 } });
    const kept = await loadConfig();
    expect(kept.sessions).toMatchObject({ advisoryTokens: 300_000, limitTokens: 350_000 });
  });

  it('leaves a user who turned automatic compaction off turned off', async () => {
    const config = defaultConfig();
    // Off, but at a threshold they chose: that is a decision, not an untouched default.
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 250_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(false);
    expect(loaded.compaction.autoTokens).toBe(250_000);
  });

  it('keeps an automatic compaction the user configured', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      compaction: { ...config.compaction, auto: true, autoTokens: 150_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 150_000 });
  });

  it('keeps the meter threshold aligned with a high automatic-compaction threshold', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      sessions: { ...config.sessions, advisoryTokens: 3_000_000, limitTokens: 4_000_000 },
      compaction: { ...config.compaction, auto: true, autoTokens: 3_000_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.compaction.autoTokens).toBe(3_000_000);
    expect(loaded.sessions.advisoryTokens).toBe(3_000_000);
    expect(loaded.sessions.limitTokens).toBe(4_000_000);
  });

  /**
   * A config written before these fields existed gets the current defaults, like any other
   * absent field: absent is not a decision, so it reads as whatever the app decides now.
   */
  it('reads a config from before the setting existed as the current default', async () => {
    const config = defaultConfig();
    const older = { ...config, compaction: { ...config.compaction } } as Record<string, any>;
    delete older.compaction.auto;
    delete older.compaction.autoTokens;
    await saveConfig(older as ReturnType<typeof defaultConfig>);
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(300_000);
  });

  it('serializes concurrent read-modify-write changes instead of losing one', async () => {
    await saveConfig(defaultConfig());
    const first = updateConfig(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...config, roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }] };
    });
    const second = updateConfig((config) => ({
      ...config,
      ui: { ...config.ui, theme: 'dark' as const }
    }));
    await Promise.all([first, second]);

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual([{ name: 'project', path: 'C:\\Users\\example\\project' }]);
    expect(loaded.ui.theme).toBe('dark');
  });
});

/** Fresh-install defaults, while migrations above prove existing choices stay narrow. */
describe('shipped defaults', () => {
  // Core work stays available, with ChatGPT app permissions providing contextual action approval.
  // Computer Use remains a separate explicit onboarding choice.
  const expectedFreshCapability = (capability: Capability, _platform: NodeJS.Platform): boolean =>
    !DESKTOP_CAPABILITIES.includes(capability);

  it('records sessions from first launch', () => {
    expect(defaultConfig().sessions.record).toBe(true);
  });

  it('loads a genuinely missing config with normal Core work available and Computer use off', async () => {
    await fs.rm(path.join(dir, 'config.json'), { force: true });
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(false);
    for (const [capability, enabled] of Object.entries(loaded.capabilities) as Array<[Capability, boolean]>) {
      expect(enabled, capability).toBe(expectedFreshCapability(capability, process.platform));
    }
    expect(loaded.multiAgent.enabled).toBe(true);
    expect(loaded.multiAgent.allowUnattributedCalls).toBe(false);
    expect(loaded.multiAgent.recoverAgentTabs).toBe(false);
    expect(loaded.ui).toMatchObject({ minimizeToTray: false, autoRefreshPlugins: true, privacyScreenshots: true });
    expect(loaded.eveAuthority).toEqual({
      allowOtherChats: true,
      changeSettings: false,
      archiveCompletedWork: false,
      controlParadigmEve: false
    });
  });

  it.each(['win32', 'darwin', 'linux'] as const)(
    'starts Core work on and Computer use off on %s',
    (platform) => {
      const config = defaultConfig(platform);
      expect(config.readOnly).toBe(false);
      for (const [capability, enabled] of Object.entries(config.capabilities) as Array<[Capability, boolean]>) {
        expect(enabled, `${platform}:${capability}`).toBe(expectedFreshCapability(capability, platform));
      }
      expect(config.multiAgent.enabled).toBe(true);
      expect(config.multiAgent.maxWorkers).toBe(2);
      expect(config.multiAgent.allowUnattributedCalls).toBe(false);
      expect(config.multiAgent.recoverAgentTabs).toBe(false);
    }
  );

  it('keeps Eve housekeeping authority opt-in and fails closed on an impossible self-control combination', async () => {
    expect(defaultConfig().eveAuthority).toEqual({
      allowOtherChats: true,
      changeSettings: false,
      archiveCompletedWork: false,
      controlParadigmEve: false
    });
    const legacy = defaultConfig();
    delete legacy.eveAuthority;
    await saveConfig(legacy);
    expect((await loadConfig()).eveAuthority).toEqual({
      allowOtherChats: true,
      changeSettings: false,
      archiveCompletedWork: false,
      controlParadigmEve: false
    });

    await saveConfig({
      ...defaultConfig(),
      eveAuthority: { allowOtherChats: true, changeSettings: true, archiveCompletedWork: true, controlParadigmEve: true }
    });
    expect((await loadConfig()).eveAuthority).toEqual({
      allowOtherChats: true,
      changeSettings: true,
      archiveCompletedWork: true,
      controlParadigmEve: true
    });

    await saveConfig({
      ...defaultConfig(),
      eveAuthority: { allowOtherChats: true, changeSettings: false, archiveCompletedWork: false, controlParadigmEve: true }
    });
    expect((await loadConfig()).eveAuthority).toEqual({
      allowOtherChats: true,
      changeSettings: false,
      archiveCompletedWork: false,
      controlParadigmEve: false
    });
  });

  it('does not widen omitted permissions or agents exposure in an existing legacy config', async () => {
    const legacy = {
      roots: [],
      capabilities: { browse: true, search: true, read: true, metadata: true },
      readOnly: true,
      tunnel: { kind: 'openai', tunnelId: '', binaryPath: '' },
      ui: { minimizeToTray: true, autoConnect: false }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.capabilities.command).toBe(false);
    expect(loaded.capabilities.control).toBe(false);
    expect(loaded.multiAgent.enabled).toBe(false);
    expect(loaded.multiAgent.allowUnattributedCalls).toBe(false);
    expect(loaded.multiAgent.recoverAgentTabs).toBe(false);
    expect(loaded.readOnly).toBe(true);
  });

  it('does not turn config corruption into permission consent', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), '{ definitely-not-json', 'utf8');
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(true);
    expect(loaded.capabilities.command).toBe(false);
    expect(loaded.capabilities.control).toBe(false);
    expect(loaded.multiAgent.enabled).toBe(false);
    expect(loaded.eveAuthority?.allowOtherChats).toBe(false);
  });

  /**
   * The default moved after this app had already shipped with recording off. Turning it on
   * underneath somebody who switched it off would be changing a privacy setting on their
   * behalf, so the new default is for configs that do not have the key at all.
   */
  it('leaves an existing choice to record alone', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: false } });
    expect((await loadConfig()).sessions.record).toBe(false);
  });

  it('applies the new default to a config written before the setting existed', async () => {
    const before = defaultConfig() as unknown as Record<string, unknown>;
    const { sessions: _dropped, ...withoutSessions } = before;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(withoutSessions), 'utf8');
    expect((await loadConfig()).sessions.record).toBe(true);
  });

  /**
   * Save, close, reopen. Fresh installs now require exact caller attribution, but either explicit
   * choice remains a durable user setting once saved.
   */
  it('keeps either unattributed choice across a save and reload', async () => {
    const config = defaultConfig();
    expect(config.multiAgent.allowUnattributedCalls).toBe(false);

    await saveConfig({
      ...config,
      multiAgent: { ...config.multiAgent, allowUnattributedCalls: false }
    });
    expect((await loadConfig()).multiAgent.allowUnattributedCalls).toBe(false);

    await saveConfig({
      ...config,
      multiAgent: { ...config.multiAgent, allowUnattributedCalls: true }
    });
    expect((await loadConfig()).multiAgent.allowUnattributedCalls).toBe(true);
  });
});

/**
 * The goal loop's settings.
 *
 * This is the one feature in this app that types into somebody's chat without being asked
 * each time, so what it defaults to — and what a damaged config falls back to — is a
 * consent question rather than a convenience one.
 */
describe('the goal loop settings', () => {
  it('keeps helper settings independent from the API and preserves a chosen idle tab budget', async () => {
    const config = defaultConfig();
    expect(config.goal).toMatchObject({ helperModel: null, helperReasoning: 'high', models: { openrouter: [DEFAULT_GOAL_MODEL], custom: [] } });
    await saveConfig({ ...config, ui: { ...config.ui, tabsToKeepOpen: 7 }, goal: {
      ...config.goal,
      models: { ...config.goal.models, openrouter: ['provider/api-model', 'provider/fallback-model'] },
      reasoning: 'low', helperModel: 'account-browser-model', helperReasoning: 'medium'
    } });
    const loaded = await loadConfig();
    expect(loaded.goal).toMatchObject({
      models: { openrouter: ['provider/api-model', 'provider/fallback-model'], custom: [] },
      reasoning: 'low', helperModel: 'account-browser-model', helperReasoning: 'medium'
    });
    expect(loaded.ui.tabsToKeepOpen).toBe(7);
  });
  it.each([
    ['gpt-5.6-sol', '5.6'],
    ['gpt-5-6-thinking', '5.6'],
    ['5.6', '5.6'],
    ['GPT-5.6 Sol', '5.6'],
    ['ChatGPT 5.6 Sol', '5.6'],
    ['chatgpt-default', null]
  ] as const)('migrates saved helper model %s to the stable request identity', async (saved, expected) => {
    const config = defaultConfig();
    await saveConfig({ ...config, goal: { ...config.goal, helperModel: saved } });
    expect((await loadConfig()).goal.helperModel).toBe(expected);
  });
  it('is off out of the box', () => {
    const config = defaultConfig();
    expect(config.goal.enabled).toBe(false);
    expect(config.goal.models).toEqual({ openrouter: ['z-ai/glm-5.3'], custom: [] });
    expect(config.goal.reasoning).toBe('default');
    expect(config.goal.prompt).toContain('Your job is to prompt ChatGPT');
    expect(config.goal.prompt).toContain('Nobody handed you a separate goal');
    // The driver ships beside the gate rather than staying hardcoded, so a fresh install has
    // both editable instructions on disk and the settings screen has something to paint.
    expect(config.goal.objectivePrompt).toContain('Your job is to prompt ChatGPT');
    expect(config.goal.objectivePrompt).toContain('they have handed you the wheel');
  });

  it.each([
    ['openrouter', 'openai/gpt-5.2-mini:nitro', { openrouter: ['openai/gpt-5.2-mini:nitro'], custom: [] }],
    ['custom', 'llama3.1', { openrouter: [DEFAULT_GOAL_MODEL], custom: ['llama3.1'] }]
  ] as const)('migrates the legacy active %s model into that provider list only', async (kind, model, expected) => {
    const config = defaultConfig();
    const { models: _models, ...legacyGoal } = config.goal;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({
      ...config,
      goal: {
        ...legacyGoal,
        provider: { kind, baseUrl: kind === 'custom' ? 'http://localhost:11434/v1' : '' },
        model
      }
    }), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.goal.models).toEqual(expected);
    expect(loaded.goal).not.toHaveProperty('model');

    // Migration has one durable owner on the next ordinary settings write.
    await saveConfig(loaded);
    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(persisted.goal.models).toEqual(expected);
    expect(persisted.goal).not.toHaveProperty('model');
  });

  it('keeps each provider model list, reasoning level and system prompt that were chosen', async () => {
    const prompt = 'Custom continuation gate. Reply NO_REPLY when finished.';
    const objectivePrompt = 'Custom goal driver. Reply NO_REPLY once the goal is reached.';
    const loopPrompt = 'Custom loop. Always write the next message.';
    await saveConfig({
      ...defaultConfig(),
      goal: {
        ...defaultConfig().goal,
        enabled: true,
        mode: 'loop',
        models: {
          openrouter: ['openai/gpt-5.2-mini:nitro', 'z-ai/glm-5.3'],
          custom: ['llama3.1', 'qwen3:8b']
        },
        reasoning: 'high',
        prompt,
        objectivePrompt,
        loopPrompt
      }
    });
    expect((await loadConfig()).goal).toEqual({
      backend: 'chatgpt',
      loopBackend: 'chatgpt',
      includeToolCalls: false,
      impulseMinutes: 0,
      helperModel: null,
      helperReasoning: 'high',
      enabled: true,
      mode: 'loop',
      provider: { kind: 'openrouter', baseUrl: '' },
      models: {
        openrouter: ['openai/gpt-5.2-mini:nitro', 'z-ai/glm-5.3'],
        custom: ['llama3.1', 'qwen3:8b']
      },
      reasoning: 'high',
      prompt,
      objectivePrompt,
      loopPrompt
    });
  });

  it('upgrades only the exact previous shipped prompt and preserves customized prompts', async () => {
    const { PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT } = await import('../src/shared/goal.js');
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT } }),
      'utf8'
    );
    expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);

    const customized = `${PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT}\ncustom sentence`;
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: customized } }),
      'utf8'
    );
    expect((await loadConfig()).goal.prompt).toBe(customized);
  });

  /**
   * Migration compares against every default ever shipped, not just the one before this.
   *
   * The single-predecessor check this replaced stranded anyone who had skipped a release:
   * their untouched prompt matched neither the current default nor its immediate predecessor,
   * so it was mistaken for a customization and kept forever.
   */
  it('upgrades an untouched default from any earlier version, not just the last one', async () => {
    const { SUPERSEDED_GOAL_SYSTEM_PROMPTS } = await import('../src/shared/goal.js');
    const config = defaultConfig();
    for (const superseded of SUPERSEDED_GOAL_SYSTEM_PROMPTS) {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ ...config, goal: { ...config.goal, prompt: superseded } }),
        'utf8'
      );
      expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);
    }
  });

  /**
   * The driver and the loop are persisted and editable exactly as the gate is.
   *
   * They were migrated by nothing at all until the requirements rewrite, so an install holding
   * either one verbatim would have kept a superseded instruction forever while the shipped
   * constant moved on — the same stranding the gate's list exists to prevent.
   */
  it('upgrades an untouched driver and loop prompt too, not only the gate', async () => {
    const { SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS, SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS } =
      await import('../src/shared/goal.js');
    const config = defaultConfig();

    for (const superseded of SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS) {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ ...config, goal: { ...config.goal, objectivePrompt: superseded } }),
        'utf8'
      );
      expect((await loadConfig()).goal.objectivePrompt).toBe(defaultConfig().goal.objectivePrompt);
    }

    for (const superseded of SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS) {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ ...config, goal: { ...config.goal, loopPrompt: superseded } }),
        'utf8'
      );
      expect((await loadConfig()).goal.loopPrompt).toBe(defaultConfig().goal.loopPrompt);
    }
  });

  it('keeps a customized driver or loop prompt that merely starts like a shipped one', async () => {
    const { SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS, SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS } =
      await import('../src/shared/goal.js');
    const config = defaultConfig();
    const objectivePrompt = `${SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS[0]}\ncustom sentence`;
    const loopPrompt = `${SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS[0]}\ncustom sentence`;
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, objectivePrompt, loopPrompt } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.objectivePrompt).toBe(objectivePrompt);
    expect(loaded.goal.loopPrompt).toBe(loopPrompt);
  });

  it('repairs a blank goal driver prompt to its shipped default', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, objectivePrompt: '   ' } }),
      'utf8'
    );
    expect((await loadConfig()).goal.objectivePrompt).toBe(defaultConfig().goal.objectivePrompt);
  });

  /**
   * The id is free text from a provider listing that changes weekly. A config that lost it
   * still has every root and permission in it, and losing those to a blank string would be
   * a far worse failure than starting the picker back at its default.
   */
  it('repairs a blank legacy OpenRouter model id rather than refusing the whole config', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { enabled: true, model: '   ', reasoning: 'low' } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.models).toEqual({ openrouter: [DEFAULT_GOAL_MODEL], custom: [] });
    expect(loaded.goal.prompt).toBe(defaultConfig().goal.prompt);
    expect(loaded.goal.enabled).toBe(true);
    expect(loaded.roots).toEqual(config.roots);
  });

  it('defaults Goal tool context off for old configs and preserves an explicit opt-in', async () => {
    const config = defaultConfig();
    expect(config.goal.includeToolCalls).toBe(false);
    const { includeToolCalls: omitted, ...oldGoal } = config.goal;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...config, goal: oldGoal }), 'utf8');
    expect((await loadConfig()).goal.includeToolCalls).toBe(false);
    await saveConfig({ ...config, goal: { ...config.goal, includeToolCalls: true } });
    expect((await loadConfig()).goal.includeToolCalls).toBe(true);
  });

  it('adds the section to a config written before the loop existed', async () => {
    const before = defaultConfig() as unknown as Record<string, unknown>;
    const { goal: _dropped, ...withoutGoal } = before;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(withoutGoal), 'utf8');
    expect((await loadConfig()).goal).toEqual({
      backend: 'chatgpt',
      loopBackend: 'chatgpt',
      includeToolCalls: false,
      impulseMinutes: 0,
      helperModel: null,
      helperReasoning: 'high',
      enabled: false,
      mode: 'goal',
      provider: { kind: 'openrouter', baseUrl: '' },
      models: { openrouter: [DEFAULT_GOAL_MODEL], custom: [] },
      reasoning: 'default',
      prompt: defaultConfig().goal.prompt,
      objectivePrompt: defaultConfig().goal.objectivePrompt,
      loopPrompt: defaultConfig().goal.loopPrompt
    });
  });

  /**
   * Loop is the mode that cannot stop on its own, so a blank instruction here would be an
   * unconstrained model typing into somebody's chat for ever. Repaired like the other two.
   */
  it('repairs a blank loop prompt rather than running the loop with no instruction', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopPrompt: '   ' } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.loopPrompt).toBe(defaultConfig().goal.loopPrompt);
    expect(loaded.goal.mode).toBe('loop');
  });

  /**
   * The mode is one word out of a file holding every root and permission this app has. A
   * version that knows a third mode must not cost the rest of it a trip through recovery.
   */
  it('repairs an unknown mode without discarding the config around it', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...config,
        roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }],
        goal: { ...config.goal, enabled: true, mode: 'swarm' }
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.mode).toBe('goal');
    expect(loaded.goal.enabled).toBe(true);
    expect(loaded.roots).toEqual([{ name: 'project', path: 'C:\\Users\\example\\project' }]);
  });

  it('repairs a blank prompt to the safe continuation-gate default', async () => {
    const config = defaultConfig();
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...config, goal: { ...config.goal, prompt: '   ' } }), 'utf8');
    expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);
  });

  it('repairs an invalid prompt without discarding unrelated settings', async () => {
    const config = {
      ...defaultConfig(),
      roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }]
    };
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: 'x'.repeat(20_001) } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.prompt).toBe(defaultConfig().goal.prompt);
    expect(loaded.roots).toEqual(config.roots);
  });

  /** Corruption is not consent here either: a broken file must not switch the loop on. */
  it('leaves the loop off when the config cannot be read', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), '{ definitely-not-json', 'utf8');
    expect((await loadConfig()).goal.enabled).toBe(false);
  });

  /** An unknown reasoning level is somebody else's vocabulary, not a level to guess at. */
  it('falls back rather than passing an unknown reasoning level to OpenRouter', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { enabled: true, model: 'x/y', reasoning: 'extreme' } }),
      'utf8'
    );
    expect((await loadConfig()).goal.reasoning).toBe('default');
  });
});


it.each(REASONING_EFFORTS)('retains canonical worker/helper effort %s across settings save and reload', async effort => {
  const config = defaultConfig();
  config.multiAgent.defaultReasoning = effort;
  config.goal.helperReasoning = effort;
  await saveConfig(config);
  const loaded = await loadConfig();
  expect(loaded.multiAgent.defaultReasoning).toBe(effort);
  expect(loaded.goal.helperReasoning).toBe(effort);
});
