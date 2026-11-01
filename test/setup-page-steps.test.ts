import { describe, expect, it } from 'vitest';
import {
  MOCK_API_KEY,
  MOCK_TUNNEL as NEW_TUNNEL,
  OLD_MOCK_TUNNEL as OLD_TUNNEL,
  apiKeysPage,
  pluginsPage,
  tunnelsPage,
} from './setup-provider-fixtures.js';

/**
 * The Companion's automatic Guided setup page scripts (background.js setupPageStep), run against
 * deterministic provider-shaped frontends shared with the joined starter-guide smoke.
 */
describe('automatic Guided setup page steps', () => {
  it('creates the tunnel on the only ChatGPT workspace and returns its new Tunnel ID', async () => {
    const p = tunnelsPage();
    const answer = await p.run('tunnel', { name: 'ParadigmEve', description: 'Eve on this PC' });
    expect(answer).toEqual({ ok: true, result: { tunnelId: NEW_TUNNEL, reused: false } });
    expect(p.created).toMatchObject({ name: 'ParadigmEve', description: 'Eve on this PC', workspace: 'select-option-a8c5a66d-8700-469c-81ce-961da00432d4' });
  });

  it('reuses a tunnel this setup already created instead of making a second one', async () => {
    const p = tunnelsPage(undefined, 'ParadigmEve');
    expect(await p.run('tunnel', { name: 'ParadigmEve', description: 'x' })).toEqual({ ok: true, result: { tunnelId: OLD_TUNNEL, reused: true } });
    expect(p.doc.querySelector('[role="dialog"]')).toBeNull();
  });

  it('leaves the workspace choice to the person when the account has more than one', async () => {
    const p = tunnelsPage(['one', 'two']);
    const answer = await p.run('tunnel', { name: 'ParadigmEve', description: 'x' });
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/Choose the ChatGPT workspace/);
    expect(p.doc.querySelector('tbody tr')).toBeNull();
  });

  it('creates a Restricted key with exactly the two Tunnels permissions and returns it once', async () => {
    const p = apiKeysPage();
    const answer = await p.run('api-key', { name: 'ParadigmEve' });
    expect(answer.ok).toBe(true);
    expect(String(answer.result?.apiKey)).toBe(MOCK_API_KEY);
    expect(p.made).toMatchObject({ name: 'ParadigmEve', permissions: 'Restricted', submitted: 'yes' });
    expect(p.made.grants).toEqual(['Tunnels.Read', 'Tunnels.Use']);
  });

  it.each([
    ['wider Tunnels permissions', { selected: 5 }],
    ['a project the person has to choose', { project: 'Select project...' }]
  ])('never creates a key with %s', async (_why, options) => {
    const p = apiKeysPage(options);
    const answer = await p.run('api-key', { name: 'ParadigmEve' });
    expect(answer.ok).toBe(false);
    expect(p.made.submitted).toBeUndefined();
  });

  it('adds the custom MCP server on the Tunnel with no authentication, ticking the confirmation before Create as a plugin', async () => {
    const p = pluginsPage();
    const answer = await p.run('chatgpt-app', { name: 'ParadigmEve', description: 'Eve on this PC', tunnelId: NEW_TUNNEL, iconBase64: null });
    expect(answer).toEqual({ ok: true, result: { appId: null } });
    expect(p.app).toEqual({ name: 'ParadigmEve', description: 'Eve on this PC', connection: 'Tunnel', tunnelId: NEW_TUNNEL,
      auth: 'NONE', consent: 'checked', order: 'consent-then-create' });
    expect(p.persisted).toEqual([p.app]);
  });

  it('stops without saving when the confirmation checkbox is not where it should be', async () => {
    const p = pluginsPage({ checkbox: false });
    const answer = await p.run('chatgpt-app', { name: 'ParadigmEve', description: 'x', tunnelId: NEW_TUNNEL, iconBase64: null });
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/confirmation checkbox/);
    expect(p.app.order).toBeUndefined();
  });

  it('runs the deterministic provider smoke through current mock frontends', async () => {
    const tunnelPage = tunnelsPage();
    const tunnel = await tunnelPage.run('tunnel', { name: 'ParadigmEve', description: 'Eve on this PC' });
    expect(tunnel).toEqual({ ok: true, result: { tunnelId: NEW_TUNNEL, reused: false } });
    expect(tunnelPage.created).toMatchObject({
      name: 'ParadigmEve',
      description: 'Eve on this PC',
      workspace: expect.stringMatching(/^select-option-/),
    });

    const keyPage = apiKeysPage();
    const key = await keyPage.run('api-key', { name: 'ParadigmEve' });
    expect(key.ok).toBe(true);
    expect(String(key.result?.apiKey)).toBe(MOCK_API_KEY);
    expect(keyPage.made).toMatchObject({
      name: 'ParadigmEve',
      permissions: 'Restricted',
      submitted: 'yes',
    });
    expect(keyPage.made.grants).toEqual(['Tunnels.Read', 'Tunnels.Use']);

    const pluginPage = pluginsPage();
    const plugin = await pluginPage.run('chatgpt-app', {
      name: 'ParadigmEve',
      description: 'Eve on this PC',
      tunnelId: NEW_TUNNEL,
      iconBase64: null,
    });
    expect(plugin).toEqual({ ok: true, result: { appId: null } });
    expect(pluginPage.app).toEqual({
      name: 'ParadigmEve',
      description: 'Eve on this PC',
      connection: 'Tunnel',
      tunnelId: NEW_TUNNEL,
      auth: 'NONE',
      consent: 'checked',
      order: 'consent-then-create',
    });
    expect(pluginPage.persisted).toEqual([pluginPage.app]);
  });
});
