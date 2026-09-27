/** Codex Window2 vocabulary backed by this app's existing native Desktop owner. */
import { z } from 'zod';
import { act, getWindowState, ComputerError, type WindowInfo } from '../computer/index.js';
import { createWindowsComputerApi, WINDOWS_API_METHODS, WINDOWS_API_SCHEMAS, type WindowsComputerApi, type WindowsMutationEvidence } from '../computer/windows-api.js';
import { getConfig } from '../config.js';
import { browserPrivateChord, browserPrivateUiLabel, browserTabChord, isBrowserProcess } from '../computer/browser-chords.js';
import { currentCall, noteCount } from './call-context.js';
import { fail, type SurfaceRegistrar, type ToolContent, type ToolResult } from './kernel.js';
import { WINDOWS_COMPUTER_READ_METHODS, WINDOWS_COMPUTER_STATE_INPUT_METHODS } from '../../shared/windows-computer.js';
import { toolDeclaration } from './tool-declarations.js';
import { sharedEveOwnerForCurrentCall } from '../eve-access.js';

const READ_METHODS = new Set<string>(WINDOWS_COMPUTER_READ_METHODS);
const STATE_INPUT_METHODS = new Set<string>(WINDOWS_COMPUTER_STATE_INPUT_METHODS);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024 - 64 * 1024;
// Only disposable observation indexes/geometry live here; the native frame/ref owner still
// validates generation, identity and current geometry. A missing caller cannot borrow a
// different conversation's latest element indexes. No images or userData are persisted.
const contexts = new Map<string, WindowsComputerApi>();
const MAX_CONTEXTS = 32;

/**
 * Retire disposable model-facing Window2 observations at the authoritative settings boundary.
 * This is intentionally separate from MCP exposure: stale provider schemas still reach live
 * permission guards, but no coordinate/index authority survives a screen/control transition.
 */
export function retireWindowsComputerContexts(): void {
  contexts.clear();
}

function modelMutationPolicy(target: WindowInfo, _action: unknown, evidence: WindowsMutationEvidence): void {
  if (target.processId === process.pid) {
    const config = getConfig() as ReturnType<typeof getConfig> & {
      eveAuthority?: { controlParadigmEve?: boolean };
    };
    if (config.eveAuthority?.controlParadigmEve !== true) {
      throw new ComputerError(
        'TOOL_DISABLED: controlling the ParadigmEve window is disabled by the current Eve authority settings. ' +
          'Ask the user to enable "Allow Eve to control ParadigmEve" in Advanced settings, then retry.'
      );
    }
  }
  if (!isBrowserProcess(target.process)) return;
  for (const element of evidence.elements) {
    const label = browserPrivateUiLabel(element);
    if (!label) continue;
    throw new ComputerError(
      `BROWSER_PRIVATE_UI: ${label} is private browser chrome and is off-limits to Eve/Eva. ` +
        'Do not open or use browser History, password/password-manager, Bookmarks/Favorites menus, or the bookmarks/favorites bar.'
    );
  }
}

function createModelWindowsApi(): WindowsComputerApi {
  return createWindowsComputerApi(undefined, modelMutationPolicy);
}

function apiForCaller(method: string): WindowsComputerApi {
  const caller = currentCall()?.caller;
  const principal = caller?.sessionId ? `session:${caller.sessionId}`
    : caller?.conversationId ? `chat:${caller.conversationId}`
    : sharedEveOwnerForCurrentCall() ? `shared-eve:${sharedEveOwnerForCurrentCall()}` : null;
  if (!principal) {
    if (STATE_INPUT_METHODS.has(method)) {
      throw new ComputerError('CALLER_IDENTITY_REQUIRED: indexed and coordinate input requires this conversation’s exact companion identity; no input ran.');
    }
    // Unattributed reads/simple exact-window operations remain useful, but never publish
    // an implicit latest-observation authority that another anonymous call could consume.
    return createModelWindowsApi();
  }
  let api = contexts.get(principal);
  if (!api) api = createModelWindowsApi();
  contexts.delete(principal);
  contexts.set(principal, api);
  while (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value!);
  return api;
}

const DESCRIPTIONS: Record<string, string> = {
  list_windows: 'List open Windows app/window objects. Choose one returned window before input.',
  get_window: 'Resolve a returned window by id and optional app identity.',
  list_apps: 'List installed and running Windows apps with their exact owned windows.',
  launch_app: 'Launch an observed app id or explicit .exe path/name, without command arguments. Observe its window afterward.',
  get_window_state: 'Observe a window without activation, even when covered. Returns focus, bounded indexed accessibility and native images. Browser document_text uses the visible viewport when possible; document_text_scope/truncated describe fallback or clipping. Observation reacquires transient movement; input still rejects stale frames/refs. Coordinates use image pixels. Screenshots default on, text off.',
  click: 'Click image-pixel x/y in the selected screenshot or current element_index; supports mouse_button and click_count. Omit screenshotId for the main image. Refresh state after input.',
  press_key: 'Press a keysym-style key or chord (Control_L+s) in the exact window. Automatically activates its target.',
  type_text: 'Type literal text in the exact window. Multiline text uses clipboard paste and the existing clipboard-write permission.',
  scroll: 'Scroll by horizontal/vertical wheel deltas at image-pixel x/y in the selected screenshot; positive Y scrolls down.',
  set_value: 'Replace the value of an indexed editable control from the latest accessibility state.',
  drag: 'Drag smoothly between two image-pixel coordinates in the selected screenshot, then release.',
  perform_secondary_action: 'Perform an advertised accessibility action on an element_index; action labels are case-insensitive.',
  activate_window: 'Activate an exact returned window. Input methods already activate their target automatically. This consumes prior observation indexes and coordinates; get_window_state again before using them.'
};

function desktopResult(method: string, value: unknown): ToolResult {
  const content: ToolContent[] = [];
  let metadata = value;
  if (method === 'get_window_state' && value && typeof value === 'object' && 'screenshots' in value) {
    const state = value as { screenshots: Array<{ url: string; [key: string]: unknown }> };
    metadata = { ...state, screenshots: state.screenshots.map(({ url: _url, ...shot }) => shot) };
    for (const shot of state.screenshots) {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(shot.url);
      if (!match) throw new ComputerError('IMAGE_INVALID: native screenshot was not a PNG data URL.');
      content.push({ type: 'image', mimeType: 'image/png', data: match[1]! });
    }
  }
  // Pixels have one transport owner: native MCP image blocks. Returning the same
  // data URLs in value made text(state) overflow code mode's text budget and
  // discarded an otherwise successful observation, including its emitted images.
  const normalized = metadata ?? null;
  content.unshift({ type: 'text', text: metadata === undefined ? `${method}: input accepted; observe to verify the result.` : JSON.stringify(metadata) });
  const result: ToolResult = { content, structuredContent: { value: normalized } };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ComputerError('DESKTOP_RESULT_TOO_LARGE: this observation exceeds the combined image/metadata limit. Reobserve without text or screenshot.');
  }
  return result;
}

async function refuseBrowserChord(key: string, window: { id: number }): Promise<string | null> {
  const keys = key.split('+').map(name => name.trim());
  const chord = browserTabChord(keys);
  const privateChord = browserPrivateChord(keys);
  if (!chord && !privateChord) return null;
  // Popup HWNDs may be absent from the ordinary top-level window list.
  const target = (await getWindowState({ window: window.id, includeScreenshot: false, includeUi: false })).window;
  if (!isBrowserProcess(target.process)) return null;
  if (privateChord) {
    return `BROWSER_PRIVATE_UI: ${privateChord} would open private browser chrome in ${JSON.stringify(target.title)} (${target.process}). Browser History, passwords/password manager, Bookmarks/Favorites menus, and the bookmarks/favorites bar are off-limits.`;
  }
  return `BROWSER_TAB_CHORD: ${chord} would manage tabs/windows or browser history in ${JSON.stringify(target.title)} (${target.process}). Use the page in its own browser window and native controls instead.`;
}

export function registerWindowsDesktopTools(reg: SurfaceRegistrar): void {
  for (const method of WINDOWS_API_METHODS) {
    const read = READ_METHODS.has(method);
    const capability = read ? 'screen' : 'control';
    if (!reg.exposedCaps[capability]) continue;
    reg.register(method, toolDeclaration(method, () => ({
      description: DESCRIPTIONS[method]!,
      inputSchema: WINDOWS_API_SCHEMAS[method],
      annotations: { readOnlyHint: read, destructiveHint: !read, idempotentHint: read, openWorldHint: true }
    }), 'windows'), input => reg.guarded(capability, method, async () => {
      // The schema is checked by the same registrar for direct calls and code-mode children.
      if (method === 'type_text' && 'text' in input && /[\r\n]/.test(String(input.text)) && !reg.caps.clipboardWrite) {
        return fail('TOOL_DISABLED: multiline text needs the existing Replace clipboard text permission. No input ran.');
      }
      if (method === 'press_key') {
        const keys = input as { key: string; window: { id: number } };
        const refusal = await refuseBrowserChord(keys.key, keys.window);
        if (refusal) return fail(refusal);
      }
      const api = apiForCaller(method);
      const invoke = api[method] as (args: unknown) => Promise<unknown>;
      const value = await invoke(input);
      if (Array.isArray(value)) noteCount(value.length);
      return desktopResult(method, value);
    }));
  }

  if (reg.exposedCaps.clipboardRead) reg.register('read_clipboard', toolDeclaration('read_clipboard', () => ({
    description: 'Read this computer’s clipboard text.', inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  })), () => reg.guarded('clipboardRead', 'read_clipboard', async () => {
    const value = (await act([{ type: 'read_clipboard' }])).clipboard[0] ?? '';
    if (value.length > 64_000) throw new ComputerError('CLIPBOARD_TOO_LARGE: clipboard text exceeds the response limit.');
    return desktopResult('read_clipboard', value);
  }));
  if (reg.exposedCaps.clipboardWrite) reg.register('write_clipboard', toolDeclaration('write_clipboard', () => ({
    description: 'Replace this computer’s clipboard text.', inputSchema: z.object({ text: z.string().max(100_000) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  })), input => reg.guarded('clipboardWrite', 'write_clipboard', async () => {
    await act([{ type: 'write_clipboard', text: input.text }]);
    return { content: [{ type: 'text', text: 'Clipboard text replaced.' }], structuredContent: { value: null } };
  }));
}
