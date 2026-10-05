import { ui, t } from './i18n.js';
import type { ChatModelCatalog } from '../shared/chat-models.js';
import { CHATGPT_DEFAULT_MODEL_ID, CHATGPT_SETTINGS_MODELS, CHATGPT_SOL_MODEL_ID, chatModelDisplayLabel, configuredChatModelRequest, configuredChatSettingsModel } from '../shared/chat-models.js';
import type { Config } from '../shared/types.js';
import type { ReasoningEffort } from '../shared/session.js';
import { $, el, run, toast } from './dom.js';

let catalog: ChatModelCatalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
let generation = 0;
let onComposerPaint: (() => void) | undefined;
const catalogWaiters = new Set<() => void>();
let discovery: Promise<void> | null = null;
let catalogSubscribed = false;
type ObservedSelection = { model: string; reasoningEffort?: ReasoningEffort; observedAt: number };
let composerContext: { scope: string | null; observation: ObservedSelection | null; nativeDefault: boolean; edited: boolean } | null = null;
type ComposerChoice = { model: string; reasoningEffort: ReasoningEffort | null; editedAt: number };
const composerChoices = new Map<string, ComposerChoice>();
let defaultComposerChoice: ComposerChoice | null = null;
let composerPreferenceLoaded = false;
const MAX_COMPOSER_CHOICES = 128;
const pairs = [['composerModel', 'composerReasoning'], ['workerModel', 'workerReasoning'], ['helperModel', 'helperReasoning']] as const;
const effortNames: Record<string, string> = { none: "Instant", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "xhigh", max: "Max", ultra: "Ultra", pro: 'Pro' } satisfies Record<ReasoningEffort, string>;
const composerEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro'] as const;
const effortLabel = (effort: string): string => effortNames[effort] ? t(effortNames[effort]) : effort;
function observedModel(value: string) {
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9.]/g, '');
  const requested = configuredChatModelRequest(value);
  const matches = catalog.models.filter(choice => choice.id === value || choice.aliases?.includes(value) ||
    (requested === CHATGPT_SOL_MODEL_ID && (choice.id === '5.6' || choice.id === CHATGPT_SOL_MODEL_ID || choice.aliases?.includes(CHATGPT_SOL_MODEL_ID))) ||
    normalize(choice.label) === normalize(value));
  return matches.length === 1 ? matches[0] : undefined;
}

function stableSolModel() {
  const template = CHATGPT_SETTINGS_MODELS.find(model => model.id === CHATGPT_SOL_MODEL_ID)!;
  const stable = { ...template, efforts: [...template.efforts], aliases: [...(template.aliases ?? [])] };
  const observed = catalog.models.find(choice => choice.id === CHATGPT_SOL_MODEL_ID || choice.id === '5.6' ||
    choice.aliases?.includes(CHATGPT_SOL_MODEL_ID) || configuredChatSettingsModel(choice.label) === CHATGPT_SOL_MODEL_ID);
  if (!observed) return stable;
  const efforts = [...stable.efforts];
  // Pro is a separate provider execution lane even when discovery groups it under the same 5.6
  // family. Never manufacture a thinking-model + Pro pair; the browser cannot confirm it.
  // Other observed thinking efforts may still enrich the stable Sol choice.
  for (const effort of observed.efforts) if (effort !== 'pro' && !efforts.includes(effort)) efforts.push(effort);
  return {
    ...stable,
    efforts,
    aliases: [...new Set([...(stable.aliases ?? []), observed.id, ...(observed.aliases ?? [])])]
  };
}

function isRetiring55(model: { id: string; label: string; aliases?: string[] }): boolean {
  const is55 = (value: string | undefined) => /^gpt[ ._-]?5[ ._-]?5(?:$|[ ._-])/i.test((value ?? '').trim());
  return is55(model.id) || is55(model.label) || model.aliases?.some(is55) === true;
}

function settingsModels() {
  const defaultModel = CHATGPT_SETTINGS_MODELS.find(model => model.id === CHATGPT_DEFAULT_MODEL_ID)!;
  const extras = catalog.models.filter(model => !isRetiring55(model) &&
    configuredChatSettingsModel(model.id) !== CHATGPT_SOL_MODEL_ID &&
    configuredChatSettingsModel(model.label) !== CHATGPT_SOL_MODEL_ID &&
    !model.aliases?.some(alias => configuredChatSettingsModel(alias) === CHATGPT_SOL_MODEL_ID));
  return [
    { ...defaultModel, efforts: [...defaultModel.efforts] },
    stableSolModel(),
    ...extras.map(model => ({ ...model, efforts: [...model.efforts], ...(model.aliases ? { aliases: [...model.aliases] } : {}) }))
  ];
}

function paintComposerContext(): void {
  if (!composerContext || composerContext.edited) return;
  const observed = composerContext.observation;
  if (composerContext.scope === null) return;
  const match = observed && observedModel(observed.model);
  // An unknown session model must not inherit the previous chat's valid Send choice.
  paintPair('composerModel', 'composerReasoning', match?.id ?? observed?.model ?? 'not-observed', observed?.reasoningEffort ?? 'not-observed');
}

function rememberedComposerChoice(scope: string | null): ComposerChoice | undefined {
  return scope ? composerChoices.get(scope) : undefined;
}

function rememberComposerChoice(): void {
  const scope = composerContext?.scope;
  if (composerContext) composerContext.edited = true;
  const selected = confirmedComposerModel();
  if (!selected) return;
  const model = selected.model ?? CHATGPT_DEFAULT_MODEL_ID;
  if (model !== CHATGPT_DEFAULT_MODEL_ID && !selected.reasoningEffort) return;
  composerPreferenceLoaded = true;
  defaultComposerChoice = model === CHATGPT_DEFAULT_MODEL_ID
    ? null
    : { model, reasoningEffort: selected.reasoningEffort, editedAt: Date.now() };
  const save = window.api.setChatModelPreference?.(
    model === CHATGPT_DEFAULT_MODEL_ID ? null : model,
    model === CHATGPT_DEFAULT_MODEL_ID ? null : selected.reasoningEffort
  );
  if (save) void run(save).catch(error => {
    // Keep the current draft choice, but make a failed durable save visible.
    toast(String(error));
  });
  if (!scope) return;
  composerChoices.delete(scope);
  composerChoices.set(scope, {
    model,
    reasoningEffort: model === CHATGPT_DEFAULT_MODEL_ID ? null : selected.reasoningEffort,
    editedAt: Date.now()
  });
  while (composerChoices.size > MAX_COMPOSER_CHOICES) composerChoices.delete(composerChoices.keys().next().value!);
}

/** Existing chats use their durable session identity; null retains New Chat's native/default semantics. */
export function applyComposerSessionModel(scope: string | null, observation: ObservedSelection | null, nativeDefault = false): void {
  let remembered = rememberedComposerChoice(scope);
  const observationConfirmsRemembered = !!remembered && !!observation &&
    configuredChatSettingsModel(observation.model) === configuredChatSettingsModel(remembered.model) &&
    observation.reasoningEffort === remembered.reasoningEffort;
  if (scope && remembered && remembered.model !== CHATGPT_DEFAULT_MODEL_ID &&
      observation && observation.observedAt >= remembered.editedAt && observationConfirmsRemembered) {
    composerChoices.delete(scope);
    remembered = undefined;
  }
  if (!composerContext || composerContext.scope !== scope) {
    // The persisted app picker is explicit user intent, not inferred provider state. Use it as
    // the provisional choice for any chat that has no exact per-conversation observation yet.
    // A proven native-default session keeps provider-native semantics, and a later exact browser
    // observation supersedes this provisional value below.
    const useDefault = !observation && !nativeDefault && defaultComposerChoice;
    composerContext = { scope, observation, nativeDefault, edited: !!remembered || !!useDefault };
    if (useDefault) paintPair('composerModel', 'composerReasoning', useDefault.model, useDefault.reasoningEffort ?? '');
    else if (scope === null) paintPair('composerModel', 'composerReasoning', '', '');
  } else if (observation && (!composerContext.observation || observation.observedAt >= composerContext.observation.observedAt)) {
    composerContext.observation = observation;
    composerContext.edited = !!remembered;
  }
  if (composerContext && composerContext.scope === scope) {
    composerContext.nativeDefault = nativeDefault;
  }
  if (remembered) paintPair('composerModel', 'composerReasoning', remembered.model, remembered.reasoningEffort ?? '');
  else paintComposerContext();
  paintStatus();
}

/** Provider order and available efforts define the slider, including newly released models. */
function composerModels() {
  const sol = stableSolModel();
  const extras = catalog.models.filter(model => !isRetiring55(model) &&
    configuredChatSettingsModel(model.id) !== CHATGPT_SOL_MODEL_ID &&
    configuredChatSettingsModel(model.label) !== CHATGPT_SOL_MODEL_ID &&
    !model.aliases?.some(alias => configuredChatSettingsModel(alias) === CHATGPT_SOL_MODEL_ID));
  return [sol, ...extras]
    .map(model => ({ ...model, efforts: composerEfforts.filter(effort => model.efforts.includes(effort)) }))
    .filter(model => model.efforts.length > 0);
}

function composerPickerModels() {
  return catalog.state === 'ready' && catalog.nativeDefault === true
    ? [CHATGPT_SETTINGS_MODELS[0]!]
    : [CHATGPT_SETTINGS_MODELS[0]!, ...composerModels()];
}

type ComposerSliderStep = {
  model: string;
  modelLabel: string;
  effort: ReasoningEffort;
  displayEffort: string;
  available: boolean;
};

/** Keep the everyday paid picker stable: Sol Medium, High and xhigh. Discovery
 * can prove xhigh unavailable for this account, but it must not reorder the
 * control or append unrelated/retiring model families to the right. */
function composerSliderSteps(): ComposerSliderStep[] {
  const sol = stableSolModel();
  const has = (effort: ReasoningEffort) => sol.efforts.includes(effort);
  return [
    { model: sol.id, modelLabel: sol.label, effort: 'medium', displayEffort: 'Medium', available: has('medium') },
    { model: sol.id, modelLabel: sol.label, effort: 'high', displayEffort: 'High', available: has('high') },
    { model: sol.id, modelLabel: sol.label, effort: 'xhigh', displayEffort: 'xhigh', available: has('xhigh') }
  ];
}

function options(select: HTMLSelectElement, choices: Array<{ id: string; label: string | (() => string) }>, value: string): void {
  const option = (label: string | (() => string), id: string) => {
    const node = el('option', '', label) as HTMLOptionElement; node.value = id; return node;
  };
  const desired = choices.map(choice => option(choice.label, choice.id));
  if (!desired.length && !value) {
    const unavailable = option(() => t("No observed choices"), ''); unavailable.disabled = true; desired.push(unavailable);
  }
  if (value && !choices.some(choice => choice.id === value)) {
    const unverified = option(() => t("{0} · not verified", [value]), value);
    unverified.disabled = true;
    desired.push(unverified);
  }
  // State pushes must not close a native picker or replace nodes while its choices are unchanged.
  if (select.options.length !== desired.length || desired.some((node, index) => {
    const current = select.options[index];
    return !current || current.value !== node.value || current.text !== node.text || current.disabled !== node.disabled;
  })) select.replaceChildren(...desired);
  select.value = value;
}

function paintPair(modelId: string, effortId: string, modelValue?: string, effortValue?: string): void {
  const model = document.getElementById(modelId) as HTMLSelectElement | null;
  const effort = document.getElementById(effortId) as HTMLSelectElement | null;
  if (!model || !effort) return;
  const models = modelId === 'composerModel' ? composerPickerModels() : settingsModels();
  let nextModel = modelValue ?? model.value;
  let nextEffort = effortValue ?? effort.value;
  if (modelId === 'composerModel') {
    if (catalog.state === 'ready' && catalog.nativeDefault) {
      nextModel = CHATGPT_DEFAULT_MODEL_ID;
      nextEffort = '';
    } else if (!nextModel && composerContext && (composerContext.scope === null || composerContext.nativeDefault)) {
      nextModel = CHATGPT_DEFAULT_MODEL_ID;
    } else if (configuredChatSettingsModel(nextModel) === CHATGPT_SOL_MODEL_ID) {
      nextModel = CHATGPT_SOL_MODEL_ID;
    } else {
      nextModel = observedModel(nextModel)?.id ?? nextModel;
    }
  }
  else {
    const configured = configuredChatSettingsModel(nextModel);
    if (configured === CHATGPT_DEFAULT_MODEL_ID || configured === CHATGPT_SOL_MODEL_ID) {
      nextModel = configured;
    } else {
      const observed = observedModel(nextModel);
      nextModel = observed
        ? configuredChatSettingsModel(observed.id) === CHATGPT_SOL_MODEL_ID ||
          configuredChatSettingsModel(observed.label) === CHATGPT_SOL_MODEL_ID
          ? CHATGPT_SOL_MODEL_ID
          : observed.id
        : configured;
    }
  }
  if (nextModel === CHATGPT_DEFAULT_MODEL_ID) nextEffort = '';
  if (modelId !== 'composerModel' && models.length && !nextModel) {
    // The fresh in-app composer has an explicit 2.2.1 product preference, but it can
    // choose only a family/effort actually observed in this account. Worker/helper
    // settings keep their existing fallback because their configured defaults own them.
    const preferred = models.find(item => /^gpt[ -]?6$/i.test(item.label) && item.efforts.includes('high'));
    nextModel = (preferred ?? models[0]!).id;
    nextEffort = '';
  }
  const supported = models.find(item => item.id === nextModel)?.efforts;
  if (supported && !nextEffort) {
    nextEffort = supported.includes('high') ? 'high' : supported[0] ?? '';
  }
  options(model, models, nextModel);
  const effortChoices = model.value === CHATGPT_DEFAULT_MODEL_ID
    ? [{ id: '', label: () => t('ChatGPT default') }]
    : (models.find(item => item.id === model.value)?.efforts ?? []).map(id => ({ id, label: () => effortLabel(id) }));
  options(effort, effortChoices, nextEffort);
}

function paintComposerChoices(): void {
  const models = document.getElementById('composerModelChoices');
  const powers = document.getElementById('composerPowerChoices');
  if (!models || !powers) return;
  const selected = $<HTMLSelectElement>('composerModel');
  const effort = $<HTMLSelectElement>('composerReasoning');
  const choices = composerModels();
  const signature = JSON.stringify([catalog.state, catalog.nativeDefault, choices, selected.value, effort.value, confirmedComposerModel()]);
  if (models.dataset.signature === signature) return;
  models.dataset.signature = signature;
  models.replaceChildren();
  powers.replaceChildren();
  {
    const useDefault = el('button', 'btn model-choice', () => t('ChatGPT default')) as HTMLButtonElement;
    useDefault.type = 'button';
    useDefault.setAttribute('aria-pressed', confirmedComposerModel()?.model === null ? 'true' : 'false');
    useDefault.onclick = () => {
      paintPair('composerModel', 'composerReasoning', CHATGPT_DEFAULT_MODEL_ID, '');
      rememberComposerChoice();
      paintComposerChoices();
      paintComposerLabel();
    };
    models.append(useDefault);
  }
  const steps = composerSliderSteps();
  const title = document.getElementById('composerPowerTitle');
  const subtitle = document.getElementById('composerPowerModel');
  const nativeDefaultOnly = catalog.state === 'ready' && catalog.nativeDefault === true;
  powers.hidden = nativeDefaultOnly;
  if (nativeDefaultOnly) {
    if (title) ui(title, 'textContent', () => t("ChatGPT default"));
    if (subtitle) ui(subtitle, 'textContent', () => t("Model choice stays in ChatGPT"));
    return;
  }
  if (!steps.length) {
    if (title) ui(title, 'textContent', () => confirmedComposerModel() ? t("ChatGPT default") : catalog.state === 'pending' ? t("Loading models…") : t("Models unavailable"));
    if (subtitle) ui(subtitle, 'textContent', () => confirmedComposerModel() ? t("Model choice stays in ChatGPT") : catalog.state === 'pending' ? t("Reading your ChatGPT account") : t("Reload models"));
    return;
  }
  const current = steps.findIndex(step => step.model === selected.value && step.effort === effort.value);
  const track = el('div', 'power-track');
  const dots = el('div', 'power-dots'); dots.setAttribute('aria-hidden', 'true');
  dots.append(...steps.map(step => {
    const dot = el('span', `power-dot${step.available ? '' : ' locked'}`);
    if (!step.available) {
      dot.setAttribute('title', `${step.displayEffort} · Pro`);
      dot.setAttribute('aria-label', `${step.displayEffort} · Pro`);
    }
    return dot;
  }));
  const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = String(steps.length - 1); slider.step = '1';
  slider.value = String(Math.max(0, current));
  ui(slider, 'aria-label', () => t("Model and thinking effort"));
  const show = () => {
    const step = steps[Number(slider.value)]!;
    if (title) ui(title, 'textContent', () => t(step.displayEffort));
    if (subtitle) subtitle.textContent = step.modelLabel;
    ui(slider, 'aria-valuetext', () => step.available
      ? `${step.modelLabel} · ${t(step.displayEffort)}`
      : `${step.modelLabel} · ${t(step.displayEffort)} · ${t('Pro')}`);
    track.style.setProperty('--power-position', `${steps.length > 1 ? Number(slider.value) / (steps.length - 1) * 100 : 100}%`);
    return step;
  };
  if (current >= 0) show();
  else if (confirmedComposerModel()?.model === null) {
    if (title) ui(title, 'textContent', () => t('ChatGPT default'));
    if (subtitle) ui(subtitle, 'textContent', () => t('Model choice stays in ChatGPT'));
    ui(slider, 'aria-valuetext', () => t('ChatGPT default'));
  }
  else {
    if (title) ui(title, 'textContent', () => t("Choose a level"));
    if (subtitle) ui(subtitle, 'textContent', () => t("Previous selection unavailable"));
    ui(slider, 'aria-valuetext', () => t('Choose an available model and effort'));
  }
  const choose = () => {
    const step = show();
    if (!step.available) {
      const fallback = steps.findIndex(candidate => candidate.model === selected.value && candidate.effort === effort.value);
      const available = fallback >= 0 ? fallback : steps.findIndex(candidate => candidate.available);
      slider.value = String(Math.max(0, available));
      show();
      return;
    }
    paintPair('composerModel', 'composerReasoning', step.model, step.effort);
    rememberComposerChoice();
    paintComposerLabel();
    models.dataset.signature = JSON.stringify([catalog.state, catalog.nativeDefault, choices, selected.value, effort.value, confirmedComposerModel()]);
  };
  slider.oninput = choose;
  slider.onclick = () => { if (current < 0) choose(); };
  // Keep the range node alive through pointer/keyboard adjustment; hidden selects remain
  // the existing send authority, and no separate model selection state is introduced.
  track.append(dots, slider); powers.append(track);
}

/** Native-default openings need no catalog: null asks the browser to leave its model alone.
 * Explicit or existing-session selections still require their observed model/effort. */
export function confirmedComposerModel(): { model: string | null; reasoningEffort: ReasoningEffort | null } | null {
  // A current Free/Go native-default surface has no Eve-selectable paid model or
  // reasoning tier. Old saved/session observations cannot manufacture entitlement.
  if (catalog.state === 'ready' && catalog.nativeDefault) {
    return { model: null, reasoningEffort: null };
  }
  if (composerContext?.nativeDefault && !composerContext.edited) {
    return { model: null, reasoningEffort: null };
  }
  const model = $<HTMLSelectElement>('composerModel').value;
  const reasoningEffort = $<HTMLSelectElement>('composerReasoning').value;
  if (model && model !== CHATGPT_DEFAULT_MODEL_ID) {
    const confirmed = composerModels().find(choice => choice.id === model)?.efforts.find(effort => effort === reasoningEffort);
    if (confirmed) return { model, reasoningEffort: confirmed };
  }
  if (model === CHATGPT_DEFAULT_MODEL_ID) {
    return { model: null, reasoningEffort: null };
  }
  if ((composerContext === null || composerContext.scope === null) && !composerContext?.observation && !composerContext?.edited) {
    return { model: null, reasoningEffort: null };
  }
  return null;
}

let composerLabelOverride: (() => string | null) | null = null;
/** Another provider (Ollama) may own the composer label while it is selected. */
export function setComposerLabelOverride(override: () => string | null): void { composerLabelOverride = override; }
export function repaintComposerLabel(): void { paintComposerLabel(); }

function paintComposerLabel(): void {
  const override = composerLabelOverride?.();
  if (override) {
    const node = $('composerModelLabel');
    ui(node, 'textContent', () => override);
    ui(node, 'title', () => override);
    onComposerPaint?.();
    return;
  }
  // Display the same admission decision as Send, including discovery and removed efforts.
  const confirmed = confirmedComposerModel();
  const modelLabel = confirmed?.model ? composerModels().find(model => model.id === confirmed.model)?.label ?? confirmed.model : '';
  const label = () => confirmed
    ? confirmed.model && confirmed.reasoningEffort
      ? chatModelDisplayLabel(modelLabel, confirmed.reasoningEffort, effortLabel(confirmed.reasoningEffort))
      : t("ChatGPT default")
    : catalog.state === 'pending' ? t("Loading models…") : t("Select model");
  const node = $('composerModelLabel');
  ui(node, 'textContent', label);
  ui(node, 'title', label);
  onComposerPaint?.();
}

function paintStatus(): void {
  paintComposerChoices();
  const message = () => catalog.state === 'pending' ? t("Reading your account’s model choices…")
    : catalog.state === 'ready' ? t("Available in your ChatGPT account · checked {0}", [new Date(catalog.observedAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })])
    : catalog.error ?? t("Connect to ChatGPT to load your models.");
  for (const id of ['chatModelStatus', 'composerModelStatus']) {
    const node = document.getElementById(id);
    if (node) {
      ui(node, 'textContent', () => id === 'composerModelStatus' ? (catalog.state === 'pending' ? t("Loading models…") : catalog.error ?? t("Models unavailable · retry discovery")) : message());
      if (id === 'composerModelStatus') node.hidden = catalog.state === 'ready';
    }
  }
  for (const id of ['refreshChatModels', 'refreshComposerModels']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) {
      // Refresh can promote passive discovery; main coalesces repeated explicit clicks.
      button.disabled = false;
      if (id === 'refreshComposerModels') {
        button.hidden = false;
        ui(button, 'title', () => catalog.state === 'pending' ? t("Reading ChatGPT models") : t("Reload ChatGPT models"));
        ui(button, 'aria-label', () => catalog.state === 'pending' ? t('Reading ChatGPT models') : t('Reload ChatGPT models'));
      }
    }
  }
  paintComposerLabel();
  for (const waiter of catalogWaiters) waiter();
}

/** Refresh and Send share one request; state pushes complete waiting sends without polling. */
function discoverModels(): Promise<void> {
  if (discovery) return discovery;
  const requested = ++generation;
  catalog = { ...catalog, state: 'pending', requestedAt: Date.now(), error: undefined };
  paintStatus();
  const work = (async () => {
    const result = await run(window.api.requestChatModels()).catch(() => null);
    if (requested !== generation) return;
    catalog = result ?? { ...catalog, state: 'unavailable', error: t("Model discovery could not start.") };
    for (const [modelId, effortId] of pairs) paintPair(modelId, effortId);
    paintComposerContext(); paintStatus();
  })();
  discovery = work.finally(() => { discovery = null; });
  return discovery;
}

export async function ensureComposerModel(refresh = false): Promise<ReturnType<typeof confirmedComposerModel>> {
  if (!refresh) {
    const selected = confirmedComposerModel();
    if (selected) return selected;
  }
  if (!refresh && (catalog.models.length || catalog.nativeDefault) && catalog.state !== 'pending') return confirmedComposerModel();
  const ready = new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); catalogWaiters.delete(check); resolve(); };
    const check = () => { if (catalog.state === 'ready' || catalog.state === 'unavailable') finish(); };
    const timer = setTimeout(finish, 125000);
    catalogWaiters.add(check);
  });
  await discoverModels();
  await ready;
  const selected = confirmedComposerModel();
  // Discovery enriches account choices, but it is not admission authority for the two shipped
  // core intents. Native/default remains a null transport and the exact Sol provider handle is
  // browser-confirmed at Send. A failed refresh may still block arbitrary observed extras.
  if (selected && (selected.model === null || selected.model === CHATGPT_SOL_MODEL_ID)) return selected;
  return catalog.state === 'ready' && !catalog.error ? selected : null;
}

export function applyChatModels(config: Config, previous?: Config): void {
  // Preserve configured values even before an observation arrives; unrelated saves must not erase them.
  const chosen = (id: string, value: string, prior?: string) => {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    return select && document.activeElement === select && previous && select.value !== (prior ?? '') ? select.value : value;
  };
  const preferenceChanged = previous && (config.ui?.chatModel !== previous.ui?.chatModel || config.ui?.chatReasoning !== previous.ui?.chatReasoning);
  if (!composerPreferenceLoaded || preferenceChanged) {
    composerPreferenceLoaded = true;
    defaultComposerChoice = config.ui?.chatModel && config.ui?.chatReasoning
      ? { model: configuredChatSettingsModel(config.ui.chatModel), reasoningEffort: config.ui.chatReasoning, editedAt: 0 }
      : null;
  }
  if (!composerContext) applyComposerSessionModel(null, null);
  // Any chat without exact provider state (fresh or established) shows the saved current-chat pair
  // until the page reports what it is really using; an explicit native default is left alone.
  if (composerContext && !composerContext.observation && !composerContext.nativeDefault && !composerContext.edited && defaultComposerChoice) {
    composerContext.edited = true;
    paintPair('composerModel', 'composerReasoning', defaultComposerChoice.model, defaultComposerChoice.reasoningEffort ?? '');
    paintStatus();
  }
  paintPair('workerModel', 'workerReasoning', chosen('workerModel', config.multiAgent.defaultModel ?? CHATGPT_DEFAULT_MODEL_ID, previous?.multiAgent.defaultModel), chosen('workerReasoning', config.multiAgent.defaultReasoning ?? '', previous?.multiAgent.defaultReasoning));
  paintPair('helperModel', 'helperReasoning', chosen('helperModel', config.goal.helperModel ?? CHATGPT_DEFAULT_MODEL_ID, previous?.goal.helperModel ?? CHATGPT_DEFAULT_MODEL_ID), chosen('helperReasoning', config.goal.helperReasoning ?? 'high', previous?.goal.helperReasoning ?? 'high'));
  if (catalogSubscribed && catalog.state !== 'unknown') return;
  const requested = ++generation;
  void window.api.getChatModels().then(result => {
    if (requested !== generation || !result?.ok || !result.data) return;
    catalog = result.data;
    for (const [modelId, effortId] of pairs) paintPair(modelId, effortId);
    paintComposerContext();
    paintStatus();
  });
}

export function initChatModels(onPaint?: () => void): void {
  onComposerPaint = onPaint;
  if (window.api.onChatModelsChanged) {
    catalogSubscribed = true;
    window.api.onChatModelsChanged(value => {
      // A current push supersedes every older startup/read/refresh response.
      ++generation; catalog = value;
      for (const [modelId, effortId] of pairs) paintPair(modelId, effortId);
      paintComposerContext(); paintStatus();
    });
  }
  document.getElementById('modelMenu')?.addEventListener('toggle', () => {
    if (($('modelMenu') as HTMLDetailsElement).open && !catalog.models.length) $('refreshComposerModels').click();
  });
  for (const [modelId, effortId] of pairs) {
    document.getElementById(modelId)?.addEventListener('change', () => {
      const model = $<HTMLSelectElement>(modelId);
      const source = modelId === 'composerModel' ? composerPickerModels() : settingsModels();
      const supported = source.find(item => item.id === model.value)?.efforts ?? [];
      paintPair(modelId, effortId, model.value, supported.includes('high') ? 'high' : supported[0] ?? '');
      if (modelId === 'composerModel') rememberComposerChoice();
      paintStatus();
    });
    document.getElementById(effortId)?.addEventListener('change', () => {
      if (effortId === 'composerReasoning') rememberComposerChoice();
      paintStatus();
    });
  }
  for (const id of ['refreshChatModels', 'refreshComposerModels']) document.getElementById(id)?.addEventListener('click', () => { void discoverModels(); });
  for (const [modelId, effortId] of pairs) paintPair(modelId, effortId);
  paintStatus();
}
