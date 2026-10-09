/**
 * Composer provider choice. The chat owns its history; this only picks who answers the next turn.
 *
 * ChatGPT keeps its own picker (chat-models.ts). Ollama shows the provider's live model list,
 * labelled honestly: "On this computer" only for a loopback daemon serving a non-cloud model.
 * OpenRouter shows its public catalog; it is always a remote service and uses the key stored in
 * Settings for Goal. A switch that hands earlier turns to a different provider asks first, showing
 * exactly what it would receive; main refuses the send without that confirmation.
 */

import { t, ui } from './i18n.js';
import { $, el, run, toast } from './dom.js';
import { repaintComposerLabel, setComposerLabelOverride } from './chat-models.js';
import type { ChatProvider, ChatProviderRoute, SessionSummary } from '../shared/session.js';

type Route = ChatProviderRoute;
interface OllamaChoice { id: string; route: Route; cloud?: boolean; installed?: boolean; vision?: boolean }
interface RouterChoice { id: string; name: string; vision: boolean; tools: boolean; contextLength: number | null; free: boolean }
export interface ProviderConsent { to: Route; messages: number; images: number; files: number }

let models: OllamaChoice[] = [];
let modelsState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let modelsError = '';
let routerModels: RouterChoice[] = [];
let routerState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let routerError = '';
let routerHasKey = false;
let scope: string | null = null;
/** Per chat (null = New chat): the provider picked for the next turn. */
const choices = new Map<string | null, ChatProvider | null>();
/** Chats whose next send follows an explicit provider/model picker change. */
const explicitSwitchIntent = new Set<string | null>();
let lastOllamaModel: string | null = null;
let lastRouterModel: string | null = null;
/** Local only for the chat being composed: the selected chat's lock, or the choice for a new chat. */
let newChatLocalOnly = false;
let selectedLocalOnly = false;
let modelSearch = '';
/** The OpenRouter catalog is long; render a bounded slice of the filtered list. */
const ROUTER_VISIBLE = 150;
const localOnlyNow = () => scope === null ? newChatLocalOnly : selectedLocalOnly;

/** For a new chat started on Ollama with Local only ticked: the lock goes with its first message. */
export function composerLocalOnlyForNewChat(): boolean {
  return scope === null && newChatLocalOnly;
}

function current(): ChatProvider | null {
  return choices.has(scope) ? choices.get(scope)! : null;
}

function routeOfProvider(provider: ChatProvider | null | undefined): Route | null {
  if (!provider) return 'chatgpt';
  if (provider.id === 'openrouter') return 'openrouter';
  return models.find((choice) => choice.id === provider.model)?.route ?? null;
}

const routeLabel = (route: Route | null): string =>
  route === 'ollama-local' ? t("On this computer") : route === 'ollama-cloud' ? t("Ollama Cloud") : route === 'openrouter' ? t("OpenRouter") : '';

/** The provider the composer will send the next turn to (null = ChatGPT). */
export function composerProvider(): ChatProvider | null {
  return current();
}

/** Called whenever the selected chat changes. Defaults to the provider of the chat's newest turn. */
export function applyComposerProvider(nextScope: string | null, session: SessionSummary | null): void {
  scope = nextScope;
  if (!choices.has(scope)) choices.set(scope, session?.provider ? { ...session.provider } : null);
  const localOnly = session?.localOnly === true;
  selectedLocalOnly = localOnly;
  const row = $('localOnlyRow');
  row.hidden = !session;
  $<HTMLInputElement>('chatLocalOnly').checked = localOnly;
  paint();
}

function choose(provider: ChatProvider | null): void {
  choices.set(scope, provider);
  // `choose()` is only called by an explicit provider/model picker action. Do not infer whether
  // that action "really changed" the provider from the renderer's cached choice: while another
  // provider is answering, that cache can lag main. Main's authoritative preview decides whether
  // consent is actually necessary; the user's picker action decides whether to ask it.
  explicitSwitchIntent.add(scope);
  if (provider?.id === 'ollama') lastOllamaModel = provider.model;
  if (provider?.id === 'openrouter') lastRouterModel = provider.model;
  paint();
}

/**
 * An explicit picker change must be previewed against main's authoritative session state even if
 * the renderer's cached SessionSummary is stale while another provider is still answering.
 */
export function providerSwitchExplicitlyRequested(sessionId: string | null): boolean {
  return explicitSwitchIntent.has(sessionId);
}

/** Clear only after main accepted the authored send; a failed/cancelled attempt remains explicit. */
export function markProviderSwitchAccepted(sessionId: string | null): void {
  explicitSwitchIntent.delete(sessionId);
}

async function loadModels(): Promise<void> {
  if (modelsState === 'loading') return;
  modelsState = 'loading';
  paint();
  const reply = await window.api.listOllamaModels().catch((error: Error) => ({ ok: false as const, error: error.message }));
  if (reply.ok) {
    models = reply.data;
    modelsState = 'ready';
    modelsError = '';
  } else {
    modelsState = 'error';
    modelsError = reply.error;
  }
  paint();
}

async function loadRouterModels(): Promise<void> {
  if (routerState === 'loading') return;
  routerState = 'loading';
  paint();
  const reply = await window.api.listOpenRouterModels().catch((error: Error) => ({ ok: false as const, error: error.message }));
  if (reply.ok) {
    routerModels = reply.data.models;
    routerHasKey = reply.data.hasKey;
    routerState = 'ready';
    routerError = '';
  } else {
    routerState = 'error';
    routerError = reply.error;
  }
  paint();
}

function paintOllama(provider: ChatProvider | null): HTMLElement[] {
  const status = $('ollamaModelStatus');
  ui(status, 'textContent', () => modelsState === 'loading' ? t("Loading models…")
    : modelsState === 'error' ? modelsError || t("Ollama is not reachable")
    : modelsState === 'ready' ? (models.length ? t("{0} models", [String(models.length)]) : t("No models installed"))
    : t("Not loaded yet"));
  const localOnly = localOnlyNow();
  $<HTMLInputElement>('ollamaLocalOnly').checked = localOnly;
  $<HTMLInputElement>('ollamaModelSearch').hidden = models.length <= 10;
  const query = modelSearch.trim().toLowerCase();
  const visible = models.filter((choice) => (!localOnly || choice.route === 'ollama-local') && (!query || choice.id.toLowerCase().includes(query)));
  const button = (choice: OllamaChoice): HTMLButtonElement => {
    const node = el('button', `btn model-choice${choice.installed === false ? ' is-not-installed' : ''}`) as HTMLButtonElement;
    node.type = 'button';
    node.dataset.keepMenu = 'true';
    node.setAttribute('aria-pressed', provider?.id === 'ollama' && provider.model === choice.id ? 'true' : 'false');
    node.append(el('span', '', choice.id), el('span', `route-badge${choice.route === 'ollama-local' ? ' is-local' : ''}`,
      () => choice.installed === false ? t("Cloud · not added yet") : routeLabel(choice.route)));
    if (choice.vision) node.title = t("Can read images");
    node.onclick = () => choose({ id: 'ollama', model: choice.id });
    return node;
  };
  const local = visible.filter((choice) => choice.route === 'ollama-local');
  const cloud = visible.filter((choice) => choice.route !== 'ollama-local');
  const groups: HTMLElement[] = [];
  if (local.length) groups.push(el('div', 'ollama-group-title', () => t("On this computer")), ...local.map(button));
  if (cloud.length) groups.push(el('div', 'ollama-group-title', () => t("Ollama Cloud")), ...cloud.map(button));
  if (!groups.length && modelsState === 'ready') groups.push(el('p', 'muted', () => localOnly ? t("No models on this computer. Pull one with ollama pull, or turn Local only off.") : t("No models match.")));
  return groups;
}

function paintRouter(provider: ChatProvider | null): HTMLElement[] {
  const status = $('ollamaModelStatus');
  ui(status, 'textContent', () => routerState === 'loading' ? t("Loading models…")
    : routerState === 'error' ? routerError || t("OpenRouter is not reachable")
    : routerState === 'ready' ? t("{0} models", [String(routerModels.length)])
    : t("Not loaded yet"));
  $<HTMLInputElement>('ollamaModelSearch').hidden = false;
  const query = modelSearch.trim().toLowerCase();
  const matching = routerModels.filter((choice) => !query || choice.id.toLowerCase().includes(query) || choice.name.toLowerCase().includes(query));
  const button = (choice: RouterChoice): HTMLButtonElement => {
    const node = el('button', 'btn model-choice') as HTMLButtonElement;
    node.type = 'button';
    node.dataset.keepMenu = 'true';
    node.setAttribute('aria-pressed', provider?.id === 'openrouter' && provider.model === choice.id ? 'true' : 'false');
    const badges = [choice.free ? t("Free") : '', choice.vision ? t("Images") : '', choice.tools ? '' : t("No tools")].filter(Boolean).join(' · ');
    node.append(el('span', '', choice.id), el('span', 'route-badge', () => badges || t("OpenRouter")));
    node.title = choice.name + (choice.contextLength ? ` · ${choice.contextLength.toLocaleString()} ${t("tokens context")}` : '');
    node.onclick = () => choose({ id: 'openrouter', model: choice.id });
    return node;
  };
  const groups: HTMLElement[] = [];
  if (routerState === 'ready' && !routerHasKey) {
    groups.push(el('p', 'muted', () => t("Add your OpenRouter key in Settings → Agents & automation → API provider to send.")));
  }
  const free = matching.filter((choice) => choice.free);
  const paid = matching.filter((choice) => !choice.free);
  if (free.length) groups.push(el('div', 'ollama-group-title', () => t("Free")), ...free.slice(0, ROUTER_VISIBLE).map(button));
  if (paid.length) groups.push(el('div', 'ollama-group-title', () => t("All models")), ...paid.slice(0, Math.max(0, ROUTER_VISIBLE - free.length)).map(button));
  if (matching.length > ROUTER_VISIBLE) groups.push(el('p', 'muted', () => t("Search to see more of {0} models.", [String(matching.length)])));
  if (!matching.length && routerState === 'ready') groups.push(el('p', 'muted', () => t("No models match.")));
  return groups;
}

function paint(): void {
  const provider = current();
  const selectedId = provider?.id ?? 'chatgpt';
  for (const button of $('composerProvider').querySelectorAll<HTMLButtonElement>('[data-provider]')) {
    button.setAttribute('aria-checked', button.dataset.provider === selectedId ? 'true' : 'false');
  }
  $('ollamaModelPanel').hidden = !provider;
  $('chatgptModelPanel').hidden = !!provider;
  const router = provider?.id === 'openrouter';
  const title = $('ollamaModelPanel').querySelector('.power-caption strong');
  if (title) ui(title as HTMLElement, 'textContent', () => router ? t("OpenRouter model") : t("Ollama model"));
  ($('ollamaLocalOnly').closest('label') as HTMLElement | null)?.toggleAttribute('hidden', router);
  $('ollamaModelChoices').replaceChildren(...(router ? paintRouter(provider) : paintOllama(provider)));
  repaintComposerLabel();
}

/** Whether this turn might hand history to a provider other than the chat's newest turn's. */
export function providerSwitchPossible(session: SessionSummary | null | undefined, provider: ChatProvider | null): boolean {
  if (!session) return false;
  const from = routeOfProvider(session.provider);
  const to = routeOfProvider(provider);
  // Consent is about crossing a privacy/provider route, not about changing model ids inside the
  // same route. Main remains the final authority and re-checks the exact archive scope on send.
  return from !== null && to !== null && from !== to && !session.providerAuthorizations?.includes(to);
}

/** Logs one renderer-side step of a provider-switch trace into app.log. Never awaited, never throws. */
export function markProviderSwitch(traceId: string | undefined, step: string, startedAt: number): void {
  if (!traceId) return;
  try { void window.api.providerSwitchMark?.(traceId, step, performance.now() - startedAt)?.catch(() => undefined); } catch { /* diagnostics only */ }
}

/**
 * Asks before a turn would hand this chat's earlier history to a different provider.
 * Returns the confirmed scope, undefined when no confirmation is needed, or false to cancel.
 */
export async function confirmProviderSwitch(sessionId: string, provider: ChatProvider | null, traceId?: string): Promise<ProviderConsent | undefined | false> {
  // Main enforces the same rule on send; without a preview, let it decide and explain.
  const previewStartedAt = performance.now();
  const reply = await window.api.providerPreview?.(sessionId, provider, traceId).catch(() => null);
  markProviderSwitch(traceId, 'preview-ipc', previewStartedAt);
  if (!reply?.ok) return undefined;
  const preview = reply.data;
  if (preview.blockedByLocalOnly) {
    toast(t("This chat is local only. {0} cannot read it; pick a model on this computer or turn local only off.", [t(preview.toLabel)]));
    return false;
  }
  if (!preview.switching) return undefined;
  const dialog = $<HTMLDialogElement>('providerSwitchDialog');
  ui($('providerSwitchText'), 'textContent', () => t(
    "This chat last used {0}. Sending to {1} gives it {2} earlier message(s), {3} image(s) and {4} file(s) it has not seen, so it can follow the conversation.",
    [t(preview.fromLabel ?? 'ChatGPT (OpenAI)'), t(preview.toLabel), String(preview.messages), String(preview.images), String(preview.files)]
  ));
  return new Promise((resolve) => {
    const consentStartedAt = performance.now();
    const finish = (value: ProviderConsent | false) => {
      $('providerSwitchConfirm').onclick = null;
      $('providerSwitchCancel').onclick = null;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      markProviderSwitch(traceId, value === false ? 'consent-declined' : 'consent-given', consentStartedAt);
      resolve(value);
    };
    $('providerSwitchConfirm').onclick = () => finish({ to: preview.to, messages: preview.messages, images: preview.images, files: preview.files });
    $('providerSwitchCancel').onclick = () => finish(false);
    dialog.onclose = () => finish(false);
    // Never open it inside an inactive (display:none) panel: the dialog would be invisible while
    // still making the window modal, which looks exactly like a frozen app.
    if (dialog.closest('.panel')) document.body.append(dialog);
    dialog.showModal();
  });
}

export function initChatProvider(): void {
  setComposerLabelOverride(() => {
    const provider = current();
    if (!provider) return null;
    const route = routeLabel(routeOfProvider(provider));
    return route ? `${provider.model} · ${route}` : provider.model;
  });
  for (const button of $('composerProvider').querySelectorAll<HTMLButtonElement>('[data-provider]')) {
    button.addEventListener('click', () => {
      if (button.dataset.provider === 'ollama') {
        const model = current()?.id === 'ollama' ? current()!.model : lastOllamaModel ?? '';
        choose({ id: 'ollama', model });
        if (modelsState !== 'ready') void loadModels();
      } else if (button.dataset.provider === 'openrouter') {
        // OpenRouter is never on this computer; a chat locked to it cannot use it.
        if (localOnlyNow()) {
          toast(t("This chat is local only. {0} cannot read it; pick a model on this computer or turn local only off.", [t("OpenRouter")]));
          return;
        }
        const model = current()?.id === 'openrouter' ? current()!.model : lastRouterModel ?? '';
        choose({ id: 'openrouter', model });
        if (routerState !== 'ready') void loadRouterModels();
      } else choose(null);
    });
  }
  $('refreshOllamaModels').addEventListener('click', () => {
    if (current()?.id === 'openrouter') void loadRouterModels();
    else void loadModels();
  });
  $<HTMLInputElement>('ollamaModelSearch').addEventListener('input', () => {
    modelSearch = $<HTMLInputElement>('ollamaModelSearch').value;
    paint();
  });
  $<HTMLInputElement>('ollamaLocalOnly').addEventListener('change', async () => {
    const box = $<HTMLInputElement>('ollamaLocalOnly');
    if (scope === null) {
      newChatLocalOnly = box.checked;
    } else {
      const updated = await run(window.api.setSessionLocalOnly(scope, box.checked));
      if (!updated) { box.checked = !box.checked; return; }
      selectedLocalOnly = box.checked;
      $<HTMLInputElement>('chatLocalOnly').checked = box.checked;
    }
    // A cloud model cannot stay selected in a local-only chat.
    const current = choices.get(scope);
    if (box.checked && current && routeOfProvider(current) !== 'ollama-local') choices.set(scope, { id: 'ollama', model: '' });
    paint();
  });
  $<HTMLInputElement>('chatLocalOnly').addEventListener('change', async () => {
    const box = $<HTMLInputElement>('chatLocalOnly');
    if (!scope) { box.checked = false; return; }
    const updated = await run(window.api.setSessionLocalOnly(scope, box.checked));
    if (!updated) box.checked = !box.checked;
    else selectedLocalOnly = box.checked;
    if (updated) paint();
    if (updated) toast(box.checked ? t("This chat is now local only") : t("Local only is off for this chat"));
  });
  paint();
}
