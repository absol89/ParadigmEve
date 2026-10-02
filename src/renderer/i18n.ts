import svSE from './locales/sv-SE.json';
import es419 from './locales/es-419.json';
import { templateWithName } from '../shared/name-template.js';

export type Language = 'en' | 'sv-SE' | 'es-419';
const STORAGE_KEY = 'cos.ui.language';
const catalog: Readonly<Record<string, string>> = svSE;
const catalogs: Readonly<Record<Exclude<Language, 'en'>, Readonly<Record<string, string>>>> = { 'sv-SE': svSE, 'es-419': es419 };
const asLanguage = (value: string | null): Language => value === 'sv-SE' || value === 'es-419' ? value : 'en';
let language: Language = 'en';
try {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'en' || stored === 'sv-SE' || stored === 'es-419') language = stored;
  else if (stored === 'zh-CN') window.localStorage.setItem(STORAGE_KEY, 'en');
} catch { /* Storage may be unavailable in a restricted renderer. */ }

export function currentLanguage(): Language { return language; }

/** The name of the agent the app talks about. Catalog text is written for the default, "Eve". */
const DEFAULT_AGENT_NAME = 'Eve';
let agentName = DEFAULT_AGENT_NAME;

/**
 * Swap the default agent name in catalog text for the installation's own name, including the
 * possessive: English adds 's (or just the apostrophe after an s), Swedish adds s (not after
 * s, x or z) and Spanish uses "de" in the sentence itself. "Eve Browser" and "Eve Plugins" are
 * product names and never change. Runs on the template, before `{n}` arguments go in, so authored
 * content passed as an argument is never touched.
 */
function withAgent(text: string): string {
  if (agentName === DEFAULT_AGENT_NAME || !text.includes('Eve')) return text;
  const name = agentName;
  return text
    .replace(/\bEve([’'])s\b/g, (_match, mark: string) => /s$/i.test(name) ? `${name}${mark}` : `${name}${mark}s`)
    .replace(/\bEves\b/g, () => /[sxz]$/i.test(name) ? name : `${name}s`)
    .replace(/\bEve\b(?![ ]?(?:Browser|browser|Plugins)\b)/g, () => name);
}

export function currentAgentName(): string { return agentName; }

const languageListeners = new Set<() => void>();
/** Runs after the app language changes, for UI that is rebuilt rather than bound. */
export function onLanguageChange(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => languageListeners.delete(listener);
}

/** Translate only app-authored copy at explicit call sites. Arguments remain verbatim. */
export function t(source: string, args: readonly unknown[] = []): string {
  const key = Object.hasOwn(catalog, source) ? source : source.replace(/\s+/g, ' ').trim();
  const active = language === 'en' ? null : catalogs[language];
  const translated = withAgent(active && Object.hasOwn(active, key) ? active[key]! : source);
  return translated.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
}

/**
 * Translate a sentence that has a name baked into it by the main process (for example the
 * connector's per-install name). The catalog holds the sentence with `{0}` in the name's place.
 */
export function tNamed(source: string, name: string): string {
  const template = templateWithName(source, name);
  return template === source ? t(source) : t(template, [name]);
}

type Property = 'textContent' | 'title' | 'placeholder' | 'aria-label' | 'aria-valuetext' | 'data-usage-hint';
type Binding = { read: () => string; last: string };
const bindings = new WeakMap<Node, Map<Property, Binding>>();
const nodes = new Set<WeakRef<Node>>();
let registrations = 0;

function read(node: Node, property: Property): string | null {
  return property === 'textContent' ? node.textContent : (node as Element).getAttribute(property);
}
function write(node: Node, property: Property, value: string): void {
  if (property === 'textContent') node.textContent = value;
  else (node as Element).setAttribute(property, value);
}

/** Bind the existing node, never reconstruct controls, drafts, icons or chat history. */
export function ui<T extends Node>(node: T, property: Property, value: () => string): T {
  let properties = bindings.get(node);
  if (!properties) {
    bindings.set(node, properties = new Map());
    nodes.add(new WeakRef(node));
    // Dead DOM nodes must not accumulate during long recorded conversations.
    if (++registrations % 256 === 0) for (const ref of nodes) if (!ref.deref()) nodes.delete(ref);
  }
  const last = value();
  properties.set(property, { read: value, last });
  write(node, property, last);
  return node;
}

export function uiText(value: () => string): Text {
  return ui(document.createTextNode(''), 'textContent', value);
}

function refreshBindings(): void {
  for (const ref of nodes) {
    const node = ref.deref();
    if (!node) { nodes.delete(ref); continue; }
    for (const [property, binding] of bindings.get(node) ?? []) {
      // A renderer may replace a placeholder with an authored title or an error.
      // That newer value owns the node; a language change cannot overwrite it.
      if (read(node, property) !== binding.last) { bindings.get(node)?.delete(property); continue; }
      binding.last = binding.read();
      write(node, property, binding.last);
    }
  }
}

export function setLanguage(next: Language): void {
  language = next;
  try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* The current window can still change language. */ }
  document.documentElement.lang = next;
  syncLanguageControls();
  refreshBindings();
  for (const listener of languageListeners) listener();
}

/** Point every "Eve" in the interface at this installation's agent name. */
export function setAgentName(next: string): void {
  const name = next.trim() || DEFAULT_AGENT_NAME;
  if (name === agentName) return;
  agentName = name;
  refreshBindings();
}

/** Setup and settings project the same saved preference. */
function syncLanguageControls(): void {
  for (const select of document.querySelectorAll<HTMLSelectElement>('[data-language-select]')) {
    select.value = language;
  }
  for (const picker of document.querySelectorAll<HTMLElement>('[data-language-picker]')) {
    picker.dataset.languageCurrent = language;
    for (const artwork of picker.querySelectorAll<SVGElement>('[data-language-flag-art]')) {
      artwork.toggleAttribute('hidden', artwork.dataset.languageFlagArt !== language);
    }
  }
}

/** Run once on the static shell, before any user/provider content is inserted. */
export function initLanguage(): void {
  const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
    const source = node.data;
    const key = source.replace(/\s+/g, ' ').trim();
    if (Object.hasOwn(catalog, key)) ui(node, 'textContent', () => source.replace(/\S[\s\S]*\S|\S/, t(key)));
  }
  for (const node of document.querySelectorAll<HTMLElement>('[title], [placeholder], [aria-label]')) {
    for (const property of ['title', 'placeholder', 'aria-label'] as const) {
      const source = node.getAttribute(property);
      if (source && Object.hasOwn(catalog, source)) ui(node, property, () => t(source));
    }
  }
  document.documentElement.lang = language;
  syncLanguageControls();
  for (const select of document.querySelectorAll<HTMLSelectElement>('[data-language-select]')) {
    select.addEventListener('change', () => setLanguage(asLanguage(select.value)));
  }
}
