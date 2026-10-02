import svSE from '../renderer/locales/sv-SE.json';
import es419 from '../renderer/locales/es-419.json';
import { templateWithName } from '../shared/name-template.js';

export type GuideLanguage = 'en' | 'sv-SE' | 'es-419';
export type TranslatedGuideLanguage = Exclude<GuideLanguage, 'en'>;

export interface GuideTextValues {
  browserLabel: string;
  name: string;
  description: string;
}

const catalogs: Readonly<Record<TranslatedGuideLanguage, Readonly<Record<string, string>>>> = { 'sv-SE': svSE, 'es-419': es419 };
export const TRANSLATED_GUIDE_LANGUAGES: readonly TranslatedGuideLanguage[] = ['sv-SE', 'es-419'];

/**
 * English text the guide page shows or writes at runtime. Each one is looked up in the app's
 * Swedish catalog (`src/renderer/locales/sv-SE.json`), so the guide shares wording with the rest
 * of Eve. `{0}` stands for the browser label and `{1}` for the ParadigmEve app name, the same
 * numbered placeholders the catalog uses everywhere else. Third-party UI labels (OpenAI and
 * ChatGPT buttons the user has to find) are deliberately not listed and stay in English.
 */
const GUIDE_KEYS: readonly string[] = [
  'ParadigmEve · Guided setup',
  'API key',
  'Connection',
  'ChatGPT app',
  'You can click steps 1–6 at any time to preview what comes next or revisit an earlier step. Future-step controls stay locked until the required earlier actions are complete.',
  'Recording or livestreaming?',
  'Tunnel ID and API key stay masked by default and re-mask when you change steps. Reveal them only when you need to check them. This {0} guide collects setup values; the ParadigmEve app owns encrypted credential storage and local permission enforcement.',
  'Preview only — finish the earlier setup steps before using the controls on this page.',
  'Step 1 / 6 · ChatGPT',
  'Step 2 / 6 · Companion',
  'Step 3 / 6 · Tunnel',
  'Step 4 / 6 · API key',
  'Step 5 / 6 · Connection',
  'Step 6 / 6 · ChatGPT app',
  'Keep the conversation. Lose the busywork.',
  'ParadigmEve lets you keep using',
  'ChatGPT the way you already prefer',
  '— typing, dictating or speaking naturally — while giving that conversation a little more ability to help on this PC.',
  'Instead of constantly copying text between apps, switching windows, finding files or turning every request into computer instructions yourself, ChatGPT can take on more of those steps for you. Longer tasks can keep working while this PC is on, and the same approach can be especially helpful if typing or precise navigation is difficult.',
  'This setup uses a',
  'dedicated ParadigmEve {0} profile',
  '. Your normal {0} profile is not modified.',
  'No provider page opens until you choose YES.',
  'YES — Connect ChatGPT',
  'NO — Stop setup',
  'Sign in normally',
  'Complete ChatGPT sign-in in the other tab. When your account is fully loaded, return here.',
  'I’M SIGNED IN — Continue',
  'No browser automation is active.',
  'Add the ParadigmEve Companion',
  'The Companion is what gives stateful Computer use and agent/session features exact proof of',
  'which ChatGPT conversation made a request',
  '. Loading the extension card is not enough: ParadigmEve verifies a live authenticated check-in before setup can continue.',
  '1 / 4 · Open extensions',
  'Open the Extensions page in the',
  'same dedicated ParadigmEve {0} profile',
  'this setup is already using.',
  'OPEN EXTENSIONS PAGE',
  'Copy address instead',
  '2 / 4 · Load unpacked',
  'Turn on',
  ', choose',
  ', and select this exact folder:',
  'Copy folder',
  '3 / 4 · Open a fresh ChatGPT tab',
  'After the extension appears, open a',
  'fresh ChatGPT tab',
  'in this same profile so the Companion is injected into a page created after installation.',
  'OPEN FRESH CHATGPT TAB',
  '4 / 4 · Verify the live connection',
  'Wait for ChatGPT to finish loading, then verify. ParadigmEve will only continue after it has actually heard from the authenticated Companion.',
  'VERIFY COMPANION — Continue',
  'Create a tunnel',
  '1 / 3 · Create Tunnel',
  'Click the button below. On the OpenAI page that opens, click',
  'on the right side of the screen.',
  'OPEN OPENAI TUNNELS',
  '2 / 3 · Add the details',
  'Name it',
  ', choose the organization and ChatGPT workspace you want to use, then paste this description:',
  'Copy description',
  '3 / 3 · Copy Tunnel ID',
  'Click',
  '. When the tunnel has been created, copy its',
  'and paste it here.',
  'Copy',
  'Masked by default for screen recordings and livestreams. Use the eye only when you need to verify the value.',
  'SAVE TUNNEL ID — Continue',
  'Create an API key',
  '1 / 3 · Open',
  'Go to this API keys page and click',
  '. Choose any relevant or default project.',
  'OPEN OPENAI API KEYS',
  '2 / 3 · Restrict it',
  ', then allow only',
  'and',
  '. Leave unrelated permissions on',
  '. Computer use is part of this same ParadigmEve connection, so there is no second tunnel or API key.',
  '3 / 3 · Copy API key',
  'Create the key, copy it when OpenAI shows it, and paste it here immediately. OpenAI only shows this secret once. ParadigmEve keeps this field masked while you enter it, then clears the field after the app securely stores the key.',
  'Masked by default. Hide it again before recording, streaming, screen sharing, or handing the browser to someone else.',
  'SAVE API KEY — Continue',
  'Your connection is ready',
  'ParadigmEve has securely saved the Tunnel ID and API key in the app’s encrypted credential store. The API key field in this guide is now cleared; the stored key is never read back into the page. The Tunnel ID remains masked if you revisit its step.',
  'Next, create the {1} app on ChatGPT’s Plugins page.',
  'YES — Open ChatGPT Plugins',
  'Add {1} to ChatGPT',
  '1 / 6 · Developer mode (older ChatGPT versions only)',
  'Current ChatGPT has no Developer mode switch; skip this step. If your ChatGPT settings still show',
  ', turn it',
  '. It enables the custom {1} app; it does',
  'not',
  'grant unrestricted action access by itself.',
  'OPEN DEVELOPER MODE',
  '2 / 6 · Create the app',
  'Open ChatGPT’s Plugins page. If the New Plugin form does not open by itself, click',
  'at the top right and choose',
  '(older versions show a',
  'instead).',
  'OPEN CREATE CONNECTOR',
  '3 / 6 · Paste the details',
  'Use these exact values and keep the suggested name: ParadigmEve recognizes its own tool calls by this app name, and a renamed app’s calls land under unattributed activity.',
  'Copy app name',
  '4 / 6 · Upload the icon',
  'When ChatGPT asks for an app icon, open this folder and choose the included',
  'or another icon you placed there:',
  'Copy icon folder',
  '5 / 6 · No auth + Tunnel',
  'For authentication choose',
  '. For the connection choose',
  ', select the',
  'tunnel you created in Step 3, and save the connector.',
  '6 / 6 · Choose how much autonomy you want',
  'After saving, open',
  '. We recommend leaving',
  'selected. ChatGPT can automatically approve actions it considers low risk, while higher-risk actions such as commands, file changes, or computer-control actions may ask for your approval or be denied. Choose',
  'only if you intentionally want longer Goal, Loop, or agent tasks to keep working without those approval stops. ParadigmEve’s own folder and capability permissions still apply either way.',
  'APP SAVED — Continue',
  'App saved',
  'Verify one tool call',
  'The tunnel, API key, ChatGPT app and Companion are configured. Return to a fresh ChatGPT conversation and ask it to run one low-risk {1} tool. ParadigmEve marks first-run setup complete only after that recognized tool call reaches the required app.',
  'You do not need to enable Computer use or',
  'for this verification.',
  'You can return to the ParadigmEve app while you verify.',
  'Dedicated ParadigmEve {0} profile · provider pages remain ordinary {0} · local secrets are stored by the ParadigmEve app',
  'Setup steps',
  'Language',
  'Show ',
  'Hide ',
  'Show',
  'Hide',
  'Copied ✓',
  'Select and copy',
  'ParadigmEve could not continue this step.',
  'Opened the extensions page in the dedicated ParadigmEve browser profile.',
  'Fresh ChatGPT tab opened. Wait for it to finish loading, then verify.',
  'Checking for the authenticated Companion…',
  'Companion connected.',
  'Checking the Tunnel ID…',
  'Tunnel ID saved.',
  'Saving the key and starting ParadigmEve…',
];

export function normalizeGuideLanguage(value: unknown): GuideLanguage {
  return value === 'sv-SE' || value === 'es-419' ? value : 'en';
}

/** Collapse whitespace the same way the page script does when it looks a text node up. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const collapsedCatalogs = new Map<TranslatedGuideLanguage, Map<string, string>>();
function lookup(language: TranslatedGuideLanguage, key: string): string | undefined {
  const catalog = catalogs[language];
  if (Object.hasOwn(catalog, key)) return catalog[key];
  let collapsed = collapsedCatalogs.get(language);
  if (!collapsed) {
    collapsed = new Map(Object.entries(catalog).map(([english, translated]) => [collapse(english), translated]));
    collapsedCatalogs.set(language, collapsed);
  }
  return collapsed.get(collapse(key));
}

/** Translation tables with the page's interpolated values filled in, ready to embed in the guide. */
export function guideTranslationTables(values: GuideTextValues): Record<TranslatedGuideLanguage, Record<string, string>> {
  return { 'sv-SE': guideTable('sv-SE', values), 'es-419': guideTable('es-419', values) };
}

function guideTable(language: TranslatedGuideLanguage, values: GuideTextValues): Record<string, string> {
  const fill = (text: string): string => text
    .replaceAll('{0}', values.browserLabel)
    .replaceAll('{1}', values.name);
  const table: Record<string, string> = Object.create(null);
  for (const english of GUIDE_KEYS) {
    const translated = lookup(language, english);
    if (translated === undefined) continue;
    // Keys that end in a space (the runtime 'Show ' / 'Hide ' prefixes) keep it exactly.
    const key = /\s$/.test(english) ? fill(english) : collapse(fill(english));
    table[key] = fill(translated);
  }
  // The connector description the user pastes into ChatGPT is built in the main process with the
  // app name baked in; the catalog holds it with `{0}` in the name's place.
  const description = values.description;
  const template = templateWithName(description, values.name);
  const translatedDescription = lookup(language, template);
  if (translatedDescription !== undefined) table[collapse(description)] = translatedDescription.replaceAll('{0}', values.name);
  return table;
}

/** English guide text that has no entry in a translation catalog. Used by tests. */
export function guideKeysMissingFromCatalog(): string[] {
  return TRANSLATED_GUIDE_LANGUAGES.flatMap((language) =>
    GUIDE_KEYS.filter((key) => lookup(language, key) === undefined).map((key) => `${language}: ${key}`));
}

/** Serialize for an inline <script>: no raw `<` and no line separators that end a JS string. */
export function inlineScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}
