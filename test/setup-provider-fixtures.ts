import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

export type SetupProviderStep = 'tunnel' | 'api-key' | 'chatgpt-app';

const background = readFileSync(path.join(process.cwd(), 'extension', 'background.js'), 'utf8');
const start = background.indexOf('async function setupPageStep(step, params) {');
const end = background.indexOf('\nfunction runSetupAutomation(', start);
const pageStepSource = background.slice(start, end);

export const MOCK_TUNNEL = 'tunnel_0123456789abcdef0123456789abcdef';
export const OLD_MOCK_TUNNEL = 'tunnel_6aa4efcfc4548191bce28dd49531af37';
export const MOCK_API_KEY = ['s', 'k', '-', 'proj-', 'AbCdEfGhIjKlMnOpQrStUvWx_yz0123'].join('');

function page(body: string, url: string) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, any>;
  Object.defineProperty(win.Element.prototype, 'getClientRects', { value(this: Element) { return this.closest('[hidden]') ? [] : [{}]; } });
  win.PointerEvent ??= win.MouseEvent as unknown as typeof PointerEvent;
  win.eval(pageStepSource);
  const doc = win.document;
  const run = (step: SetupProviderStep, params: Record<string, unknown>) =>
    win.eval(`setupPageStep(${JSON.stringify(step)}, ${JSON.stringify(params)})`) as Promise<{ ok: boolean; result?: any; error?: string }>;
  const el = (html: string) => { const box = doc.createElement('div'); box.innerHTML = html; return box.firstElementChild as HTMLElement; };
  return { win, doc, run, el };
}

export function tunnelsPage(workspaces = ['a8c5a66d-8700-469c-81ce-961da00432d4'], existing: string | null = null) {
  const p = page(`<main><button>Create tunnel</button><table><tbody>${existing
    ? `<tr><td><span>${existing}</span><span>Combined tunnel</span></td><td>${OLD_MOCK_TUNNEL}</td></tr>` : ''}</tbody></table></main>`,
  'https://platform.openai.com/settings/organization/tunnels');
  const created: Record<string, string> = {};
  p.doc.querySelector('main button')!.addEventListener('click', () => {
    const dialog = p.el(`<div role="dialog"><h2>Create tunnel</h2><label>Name *</label><input type="text" placeholder="e.g. West Coast MCP tunnel">
      <label>Description *</label><textarea placeholder="Add a short description to help your team."></textarea>
      <label>ChatGPT workspaces</label><input role="combobox" placeholder="Search workspaces by name or ID">
      <button type="button">Cancel</button><button type="button">Create</button></div>`);
    p.doc.body.append(dialog);
    const [name, description] = [dialog.querySelector('input')!, dialog.querySelector('textarea')!];
    name.addEventListener('input', () => { created.name = name.value; });
    description.addEventListener('input', () => { created.description = description.value; });
    dialog.querySelector('[role="combobox"]')!.addEventListener('click', () => {
      const list = p.el(`<div role="listbox">${workspaces.map(id => `<div role="option" id="select-option-${id}">${id}</div>`).join('')}</div>`);
      p.doc.body.append(list);
      for (const option of list.querySelectorAll('[role="option"]')) option.addEventListener('click', () => { created.workspace = option.id; list.remove(); });
    });
    [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Create')!.addEventListener('click', () => {
      if (!created.workspace) return;
      dialog.remove();
      setTimeout(() => p.doc.querySelector('tbody')!.append(p.el(`<table><tr><td><span>${created.name}</span><span>${created.description}</span></td><td>${MOCK_TUNNEL}</td></tr></table>`).querySelector('tr')!), 50);
    });
  });
  return { ...p, created };
}

export function apiKeysPage(options: { tunnels?: string; selected?: number; project?: string; grants?: string[] } = {}) {
  const p = page('<main><h2>API keys</h2><button>Create new secret key</button></main>', 'https://platform.openai.com/settings/organization/api-keys');
  const made: { name?: string; permissions?: string; submitted?: string; grants: string[] } = { grants: [] };
  const grants = options.grants ?? ['Tunnels.Read', 'Tunnels.Use'];
  p.doc.addEventListener('click', (event) => {
    const target = event.target as HTMLButtonElement | null;
    if (target?.getAttribute('type') !== 'submit') return;
    setTimeout(() => {
      const generated = p.doc.querySelector<HTMLInputElement>('[role="dialog"] input[readonly]');
      if (generated) generated.value = MOCK_API_KEY;
    }, 0);
  }, true);
  p.doc.querySelector('main button')!.addEventListener('click', () => {
    const dialog = p.el(`<div role="dialog"><h2>Create new secret key</h2>
      <div role="radiogroup"><button role="radio" aria-checked="true">You</button><button role="radio" aria-checked="false">Service account</button></div>
      <input type="text" placeholder="My Test Key"><span role="button">${options.project ?? 'Default project'}</span>
      <div role="group" aria-label="Permissions"><button role="radio" aria-checked="true">All</button><button role="radio" aria-checked="false">Restricted</button><button role="radio" aria-checked="false">Read only</button></div>
      <div id="rows"></div><button type="button">Cancel</button><button type="submit">Create secret key</button></div>`);
    p.doc.body.append(dialog);
    const name = dialog.querySelector('input')!;
    name.addEventListener('input', () => { made.name = name.value; });
    const restricted = [...dialog.querySelectorAll('[role="radio"]')].find(radio => radio.textContent === 'Restricted')!;
    restricted.addEventListener('click', () => {
      made.permissions = 'Restricted';
      made.grants = [...grants];
      dialog.querySelector('#rows')!.innerHTML = `<div>Agents</div><div>None</div><div>Tunnels</div><div>${options.tunnels ?? 'All selected'}</div><div>${options.selected ?? grants.length} selected permissions</div>`;
    });
    dialog.querySelector('button[type="submit"]')!.addEventListener('click', () => {
      made.submitted = 'yes';
      dialog.innerHTML = '<h2>Save your key</h2><input readonly value="[redacted]"><button>Done</button>';
    });
  });
  return { ...p, made };
}

export function pluginsPage(options: { checkbox?: boolean } = {}) {
  const p = page('<header><button aria-label="Add" aria-haspopup="menu">Add</button></header><main>Plugins</main>', 'https://chatgpt.com/plugins');
  const app: Record<string, string> = {};
  const persisted: Array<Record<string, string>> = [];
  const add = p.doc.querySelector('button[aria-label="Add"]')!;
  add.addEventListener('keydown', (event: any) => {
    if (event.key !== 'Enter' || p.doc.querySelector('[role="menu"]')) return;
    const menu = p.el('<div role="menu"><div role="menuitem">Create plugin</div><div role="menuitem">Upload plugin archive</div><div role="menuitem">Add custom MCP server</div></div>');
    p.doc.body.append(menu);
    menu.querySelectorAll('[role="menuitem"]')[2]!.addEventListener('click', () => {
      menu.remove();
      const dialog = p.el(`<div role="dialog"><h2>Add custom MCP server</h2><input type="file" name="app-icon">
        <input placeholder="Custom Tool"><textarea placeholder="Explain what it does in a few words"></textarea>
        <div role="group" aria-label="Connection"><button type="button" aria-pressed="true">Server URL</button><button type="button" aria-pressed="false">Tunnel</button></div>
        <div id="target"><input type="url" aria-label="Server URL" placeholder="https://example.com/mcp"></div>
        <select><option value="OAUTH">OAuth</option><option value="NONE">No authentication</option><option value="MIXED">OAuth or no authentication</option></select>
        ${options.checkbox === false ? '' : '<label>I understand and want to continue<button type="button" role="checkbox" aria-checked="false">on</button></label>'}
        <button type="button">Cancel</button><button type="submit">Create as a plugin</button></div>`);
      p.doc.body.append(dialog);
      const [name, description] = [dialog.querySelector<HTMLInputElement>('input[placeholder="Custom Tool"]')!, dialog.querySelector('textarea')!];
      name.addEventListener('input', () => { app.name = name.value; });
      description.addEventListener('input', () => { app.description = description.value; });
      const tunnel = [...dialog.querySelectorAll('[aria-label="Connection"] button')][1]!;
      tunnel.addEventListener('click', () => {
        app.connection = 'Tunnel';
        dialog.querySelector('#target')!.innerHTML = '<input aria-label="Tunnel ID" placeholder="tunnel_...">';
        const id = dialog.querySelector<HTMLInputElement>('input[aria-label="Tunnel ID"]')!;
        id.addEventListener('input', () => { app.tunnelId = id.value; });
      });
      const auth = dialog.querySelector('select')!;
      auth.addEventListener('change', () => { app.auth = auth.value; });
      const consent = dialog.querySelector('[role="checkbox"]');
      consent?.addEventListener('click', () => { consent.setAttribute('aria-checked', 'true'); app.consent = 'checked'; });
      dialog.querySelector('button[type="submit"]')!.addEventListener('click', () => {
        app.order = app.consent ? 'consent-then-create' : 'create-without-consent';
        persisted.push({ ...app });
        dialog.remove();
      });
    });
  });
  return { ...p, app, persisted };
}
