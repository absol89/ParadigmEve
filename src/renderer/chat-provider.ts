/**
 * Composer provider choice. The chat owns its history; this only picks who answers the next turn.
 *
 * ChatGPT keeps its own picker (chat-models.ts). Ollama shows the provider's live model list,
 * labelled honestly: "On this computer" only for a loopback daemon serving a non-cloud model.
 * A switch that hands earlier turns to a different provider asks first, showing exactly what it
 * would receive; main refuses the send without that confirmation.
 */

import { t, ui } from './i18n.js';
import { $, el, run, toast } from './dom.js';
import { repaintComposerLabel, setComposerLabelOverride } from './chat-models.js';
import type { ChatProvider, SessionSummary } from '../shared/session.js';

type Route = 'chatgpt' | 'ollama-local' | 'ollama-cloud';
interface OllamaChoice { id: string; route: Route; cloud?: boolean; installed?: boolean; vision?: boolean }
export interface ProviderConsent { to: Route; messages: number; images: number; files: number }

let models: OllamaChoice[] = [];
let modelsState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let modelsError = '';
let scope: string | null = null;
/** Per chat (null = New chat): the provider picked for the next turn. */
const choices = new Map<string | null, ChatProvider | null>();
let lastOllamaModel: string | null = null;
/** Local only for the chat being composed: the selected chat's lock, or the choice for a new chat. */
let newChatLocalOnly = false;
let selectedLocalOnly = false;
let modelSearch = '';
const localOnlyNow = () => scope === null ? newChatLocalOnly : selectedLocalOnly;

/** For a new chat started on Ollama with Local only ticked: the lock goes with its first message. */
export function composerLocalOnlyForNewChat(): boolean {
  return scope === null && newChatLocalOnly;
}

function current(): ChatProvider | null {
  return choices.has(scope) ? choices.get(scope)! : null;
}

function routeOf(model: string): Route | null {
  return models.find((choice) => choice.id === model)?.route ?? null;
}

const routeLabel = (route: Route | null): string =>
  route === 'ollama-local' ? t("On this computer") : route === 'ollama-cloud' ? t("Ollama Cloud") : '';

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
  if (provider) lastOllamaModel = provider.model;
  paint();
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

function paint(): void {
  const provider = current();
  for (const button of $('composerProvider').querySelectorAll<HTMLButtonElement>('[data-provider]')) {
    const on = (button.dataset.provider === 'ollama') === !!provider;
    button.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  $('ollamaModelPanel').hidden = !provider;
  $('chatgptModelPanel').hidden = !!provider;
  const status = $('ollamaModelStatus');
  ui(status, 'textContent', () => modelsState === 'loading' ? t("Loading models…")
    : modelsState === 'error' ? modelsError || t("Ollama is not reachable")
    : modelsState === 'ready' ? (models.length ? t("{0} models", [String(models.length)]) : t("No models installed"))
    : t("Not loaded yet"));
  const localOnly = localOnlyNow();
  $<HTMLInputElement>('ollamaLocalOnly').checked = localOnly;
  const search = $<HTMLInputElement>('ollamaModelSearch');
  search.hidden = models.length <= 10;
  const query = modelSearch.trim().toLowerCase();
  const visible = models.filter((choice) => (!localOnly || choice.route === 'ollama-local') && (!query || choice.id.toLowerCase().includes(query)));
  const button = (choice: OllamaChoice): HTMLButtonElement => {
    const node = el('button', `btn model-choice${choice.installed === false ? ' is-not-installed' : ''}`) as HTMLButtonElement;
    node.type = 'button';
    node.dataset.keepMenu = 'true';
    node.setAttribute('aria-pressed', provider?.model === choice.id ? 'true' : 'false');
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
  $('ollamaModelChoices').replaceChildren(...groups);
  repaintComposerLabel();
}

/** Whether this turn might hand history to a provider other than the chat's newest turn's. */
export function providerSwitchPossible(session: SessionSummary | null | undefined, provider: ChatProvider | null): boolean {
  if (!session) return false;
  const from = session.provider ? routeOf(session.provider.model) : 'chatgpt';
  const to = provider ? routeOf(provider.model) : 'chatgpt';
  // Consent is about crossing a privacy/provider route, not about changing model ids inside the
  // same route. Main remains the final authority and re-checks the exact archive scope on send.
  return from !== null && to !== null && from !== to;
}

/**
 * Asks before a turn would hand this chat's earlier history to a different provider.
 * Returns the confirmed scope, undefined when no confirmation is needed, or false to cancel.
 */
export async function confirmProviderSwitch(sessionId: string, provider: ChatProvider | null): Promise<ProviderConsent | undefined | false> {
  // Main enforces the same rule on send; without a preview, let it decide and explain.
  const reply = await window.api.providerPreview?.(sessionId, provider).catch(() => null);
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
    const finish = (value: ProviderConsent | false) => {
      $('providerSwitchConfirm').onclick = null;
      $('providerSwitchCancel').onclick = null;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    $('providerSwitchConfirm').onclick = () => finish({ to: preview.to, messages: preview.messages, images: preview.images, files: preview.files });
    $('providerSwitchCancel').onclick = () => finish(false);
    dialog.onclose = () => finish(false);
    dialog.showModal();
  });
}

export function initChatProvider(): void {
  setComposerLabelOverride(() => {
    const provider = current();
    if (!provider) return null;
    const route = routeLabel(routeOf(provider.model));
    return route ? `${provider.model} · ${route}` : provider.model;
  });
  for (const button of $('composerProvider').querySelectorAll<HTMLButtonElement>('[data-provider]')) {
    button.addEventListener('click', () => {
      if (button.dataset.provider === 'ollama') {
        choose({ id: 'ollama', model: current()?.model ?? lastOllamaModel ?? '' });
        if (modelsState !== 'ready') void loadModels();
      } else choose(null);
    });
  }
  $('refreshOllamaModels').addEventListener('click', () => void loadModels());
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
    if (box.checked && current && routeOf(current.model) === 'ollama-cloud') choices.set(scope, { id: 'ollama', model: '' });
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
