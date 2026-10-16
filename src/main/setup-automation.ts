/**
 * Automatic Guided setup: the steps ParadigmEve performs for a user who opted in.
 *
 * Nothing here is a model deciding what to click. Each step is a fixed script for one known page:
 * the Companion (an ordinary installed extension, so the browser stays a normal browser that
 * Google and OpenAI let people sign in to) runs the platform.openai.com and chatgpt.com steps, and
 * the desktop helper loads the Companion itself on the browser's own extensions page. Sign-in
 * always stays with the person. Any step that does not complete hands back to that step's manual
 * instructions in the guide.
 */
import { randomUUID } from 'node:crypto';
import { activeWindow, act, findUi, listWindows, type UiElementInfo, type WindowInfo } from './computer/index.js';

export type CompanionSetupStep = 'tunnel' | 'api-key' | 'chatgpt-app';

export interface CompanionSetupRequest {
  id: string;
  step: CompanionSetupStep;
  params: Record<string, unknown>;
}

type Pending = CompanionSetupRequest & {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

let pending: Pending | null = null;
let wake: () => void = () => {};

/** The bridge wakes the Companion so a requested step is picked up at once, not on its next poll. */
export function configureSetupAutomation(options: { wake: () => void }): void {
  wake = options.wake;
}

/**
 * Asks the Companion to run one setup step and waits for its result. One step at a time: the steps
 * depend on each other (the app needs the tunnel the API key is for, and both before the ChatGPT app).
 */
export function requestCompanionSetupStep(step: CompanionSetupStep, params: Record<string, unknown>, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  if (pending) return Promise.reject(new Error('Another automatic setup step is still running.'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (pending?.id !== id) return;
      pending = null;
      reject(new Error('The Companion did not finish this step in time.'));
    }, timeoutMs);
    timer.unref?.();
    pending = { id, step, params, resolve, reject, timer };
    wake();
  });
}

/** The step the Companion should run now, published on its status poll. Never includes results. */
export function pendingCompanionSetupStep(): CompanionSetupRequest | null {
  return pending ? { id: pending.id, step: pending.step, params: pending.params } : null;
}

/** Stops waiting for a step, e.g. when the person stops setup. */
export function cancelCompanionSetupStep(reason = 'Automatic setup was stopped.'): void {
  const current = pending;
  if (!current) return;
  pending = null;
  clearTimeout(current.timer);
  current.reject(new Error(reason));
}

/** The Companion's answer for the exact pending step. A stale or unknown id is refused. */
export function completeCompanionSetupStep(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const { id, ok, error, result } = body as { id?: unknown; ok?: unknown; error?: unknown; result?: unknown };
  const current = pending;
  if (!current || typeof id !== 'string' || id !== current.id) return false;
  pending = null;
  clearTimeout(current.timer);
  if (ok === true && result && typeof result === 'object') current.resolve(result as Record<string, unknown>);
  else current.reject(new Error(typeof error === 'string' && error ? error.slice(0, 300) : 'The Companion could not finish this step.'));
  return true;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs: number, stepMs = 500): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await delay(stepMs);
  }
}

/** An element by its exact automation id. Chrome exposes a page element's HTML id there, and the
 * Windows folder picker uses fixed control ids, so neither depends on the interface language. */
async function elementById(window: number, automationId: string, role?: string): Promise<UiElementInfo | null> {
  const found = await findUi({ window, query: automationId, maxResults: 25 });
  return found.elements.find(element => element.automationId === automationId &&
    (!role || element.role.toLowerCase().includes(role))) ?? null;
}

async function elementByName(window: number, name: string, role?: string): Promise<UiElementInfo | null> {
  const found = await findUi({ window, query: name, ...(role ? { role } : {}), maxResults: 25 });
  const expected = name.trim().toLowerCase();
  return found.elements.find(element => element.enabled && element.name.trim().toLowerCase() === expected &&
    (!role || element.role.toLowerCase().includes(role))) ?? null;
}

/** Chrome WebUI normally exposes these DOM ids through UIA, but current Chromium builds can
 * publish only the accessible control name. Keep the id as the language-neutral first choice and
 * fall back to the exact visible name instead of treating that UIA projection difference as a
 * missing Extensions page. */
async function extensionControl(window: number, automationId: string, name: string, role?: string): Promise<UiElementInfo | null> {
  return await elementById(window, automationId, role) ?? await elementByName(window, name, role);
}

/**
 * Loads the unpacked Companion on the extensions page of the dedicated browser, with the desktop
 * helper: Developer mode on (`#devMode`), Load unpacked (`#loadUnpacked`), then the folder in the
 * Windows folder picker (path box 1152, Select Folder 1). Windows only; the guide's manual step
 * covers every other case. Resolves true once the folder was chosen; the caller verifies check-in.
 */
export async function loadUnpackedCompanion(options: {
  extensionPath: string;
  isEveBrowserWindow: (window: WindowInfo) => boolean;
  timeoutMs?: number;
}): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const timeoutMs = options.timeoutMs ?? 20_000;
  // The extensions page is the dedicated browser window that exposes either of its setup controls.
  // Developer mode may already be enabled, and Chrome does not consistently project WebUI DOM ids
  // into Windows UIA, so Load unpacked by itself is sufficient evidence of the right page.
  const page = await waitFor(async () => {
    const { windows } = await listWindows();
    for (const window of windows.filter(options.isEveBrowserWindow)) {
      const load = await extensionControl(window.id, 'loadUnpacked', 'Load unpacked', 'button');
      if (load) return { window: window.id, load, toggle: null };
      const toggle = await extensionControl(window.id, 'devMode', 'Developer mode');
      if (toggle) return { window: window.id, load: null, toggle };
    }
    return null;
  }, timeoutMs);
  if (!page) return false;
  let load = page.load;
  if (!load) {
    if (!page.toggle) return false;
    await act([{ type: 'focus', window: page.window }, { type: 'click_ref', ref: page.toggle.ref }], { window: page.window });
    load = await waitFor(() => extensionControl(page.window, 'loadUnpacked', 'Load unpacked', 'button'), 8_000);
    if (!load) return false;
  }
  await act([{ type: 'focus', window: page.window }, { type: 'click_ref', ref: load.ref }], { window: page.window });
  // The folder picker opens as the new foreground window, owned by the browser.
  const dialog = await waitFor(async () => {
    const { window } = await activeWindow();
    if (!window || window.id === page.window) return null;
    const box = await elementById(window.id, '1152');
    return box ? { window: window.id, box } : null;
  }, 10_000);
  if (!dialog) return false;
  // The Windows folder picker exposes control 1152 as the keyboard-editable folder field, but
  // some current builds do not expose UIA ValuePattern on that wrapper. `set_value` therefore
  // fails before changing anything with UI_VALUE_UNSUPPORTED. Focus the exact observed control,
  // then replace its text through the normal keyboard path instead of requiring ValuePattern.
  await act([
    { type: 'ui_action', ref: dialog.box.ref, action: 'focus' },
    { type: 'keypress', keys: ['ctrl', 'a'] },
    { type: 'type', text: options.extensionPath },
  ], { window: dialog.window });
  const select = await elementById(dialog.window, '1', 'button');
  if (!select) return false;
  await act([{ type: 'click_ref', ref: select.ref }], { window: dialog.window });
  // The picker closes once the folder was accepted.
  return !!(await waitFor(async () => {
    const { window } = await activeWindow();
    return window?.id === dialog.window ? null : true;
  }, 8_000));
}
