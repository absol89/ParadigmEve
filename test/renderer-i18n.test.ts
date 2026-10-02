import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import svSE from '../src/renderer/locales/sv-SE.json';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
});
afterEach(() => dom.window.close());

describe('localized app interface', () => {
  it('localizes the exact two-line Concepts description CTA', async () => {
    const { setLanguage, t } = await import('../src/renderer/i18n.js');
    expect(t('Create\ndescription')).toBe('Create\ndescription');
    setLanguage('sv-SE');
    expect(t('Create\ndescription')).toBe('Skapa\nbeskrivning');
  });

  it('ships only English (US) and Swedish with one current flag and one selector per surface', () => {
    expect(existsSync('src/renderer/locales/sv-SE.json')).toBe(true);
    expect(existsSync('src/renderer/locales/zh-CN.json')).toBe(false);
    expect(readFileSync('src/renderer/index.html', 'utf8')).not.toContain('zh-CN');
    expect(document.querySelectorAll('[data-language]').length).toBe(0);
    expect(document.querySelectorAll('[data-language-flag-art="zh-CN"]').length).toBe(0);
    const selectors = [...document.querySelectorAll<HTMLSelectElement>('[data-language-select]')];
    expect(selectors).toHaveLength(2);
    for (const select of selectors) {
      expect([...select.options].map(option => [option.value, option.textContent])).toEqual([
        ['en', 'English (US)'],
        ['sv-SE', 'Svenska'],
      ]);
    }
    const pickers = [...document.querySelectorAll<HTMLElement>('[data-language-picker]')];
    expect(pickers).toHaveLength(2);
    for (const picker of pickers) {
      expect(picker.querySelectorAll('[data-language-flag]')).toHaveLength(1);
      expect([...picker.querySelectorAll<SVGElement>('[data-language-flag-art]')].map(art => art.dataset.languageFlagArt)).toEqual(['en', 'sv-SE']);
      expect([...picker.querySelectorAll<SVGElement>('[data-language-flag-art]')].filter(art => !art.hasAttribute('hidden')).map(art => art.dataset.languageFlagArt)).toEqual(['en']);
    }
  });

  it('normalizes the retired stored locale to English and keeps both selectors and flags synchronized', async () => {
    window.localStorage.setItem('cos.ui.language', 'zh-CN');
    const { currentLanguage, initLanguage } = await import('../src/renderer/i18n.js');
    expect(currentLanguage()).toBe('en');
    expect(window.localStorage.getItem('cos.ui.language')).toBe('en');
    initLanguage();
    const setup = document.getElementById('setupLanguage') as HTMLSelectElement;
    const settings = document.getElementById('uiLanguage') as HTMLSelectElement;
    const visibleFlags = () => [...document.querySelectorAll<SVGElement>('[data-language-flag-art]')]
      .filter(art => !art.hasAttribute('hidden'))
      .map(art => art.dataset.languageFlagArt);
    expect([setup.value, settings.value]).toEqual(['en', 'en']);
    expect(visibleFlags()).toEqual(['en', 'en']);
    setup.value = 'sv-SE';
    setup.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(currentLanguage()).toBe('sv-SE');
    expect([setup.value, settings.value]).toEqual(['sv-SE', 'sv-SE']);
    expect(visibleFlags()).toEqual(['sv-SE', 'sv-SE']);
    expect(document.getElementById('plansDestination')?.textContent).toBe('Planer');
    expect(document.getElementById('eveBrowserTab')?.getAttribute('title')).toBe('Öppna en ny flik i Eve Browser');
    expect(document.getElementById('sidebarBrandLink')?.getAttribute('title')).toBe('Öppna ParadigmEve på GitHub');
    expect(document.getElementById('sidebarBrandLink')?.getAttribute('aria-label')).toBe('Öppna ParadigmEve på GitHub');
    expect(document.getElementById('openStaticArchiveMenu')?.textContent).toBe('Öppna kopia av chattarkiv');
    expect(document.querySelector('.sidebar-service-label')?.textContent?.trim()).toBe('Chatgpt.com');
    expect(document.getElementById('addProject')?.textContent?.trim()).toBe('Projekt');
    expect(document.getElementById('chatRefresh')?.textContent?.trim()).toBe('');
    expect(document.getElementById('chatRefresh')?.getAttribute('title')).toBe('Uppdatera konversationer');
    expect(document.getElementById('chatRefresh')?.getAttribute('aria-label')).toBe('Uppdatera konversationer');
    expect(document.getElementById('conceptsSettingsNav')?.textContent).toBe('# Koncept');
    expect(document.getElementById('conceptsSettingsNav')?.getAttribute('aria-label')).toBe('Inställningar för Koncept');
    expect(document.getElementById('conceptsSettingsTitle')?.textContent).toBe('# Koncept');
    expect(document.getElementById('threadSettingsToggle')?.textContent).toBe('% Trådar +');
    expect(document.getElementById('threadSettingsEntries')?.textContent).not.toContain('% How');
    expect(document.getElementById('threadSettingsEntries')?.textContent).not.toContain('% appdata');
    expect(document.getElementById('threadSettingsEntries')?.textContent).not.toContain('% organize');
    expect(document.getElementById('expensesFolderLabel')?.textContent).toBe('Min mapp');
    expect(document.querySelector('#timelineEmpty span')?.textContent).toBe('Vad kan jag göra åt dig idag?');
    expect(document.querySelector('.setup-heading h1')!.textContent).toBe(svSE.Setup);
    expect(document.querySelector('[data-panel="setup"] .lede > p')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'Sex steg, en konfiguration. ParadigmEve aktiverar sina vanliga lokala verktyg som standard, inklusive kommandokörning. ChatGPT styr fortfarande åtkomsten till anpassade appar och kan begära godkännande eller blockera åtgärder med högre risk.'
    );
    expect(window.localStorage.getItem('cos.ui.language')).toBe('sv-SE');
    settings.value = 'en';
    settings.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(currentLanguage()).toBe('en');
    expect([setup.value, settings.value]).toEqual(['en', 'en']);
    expect(visibleFlags()).toEqual(['en', 'en']);
  });

  it('switches both ways without replacing controls, icons, emphasis, drafts or authored content', async () => {
    const { currentLanguage, initLanguage, ui, t } = await import('../src/renderer/i18n.js');
    const { el } = await import('../src/renderer/dom.js');
    expect(currentLanguage()).toBe('en');
    initLanguage();
    const input = document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Eva Å\nDéjà vu <script>not markup</script> 🙂';
    input.setSelectionRange(2, 7);
    const automation = document.getElementById('chatAutomation') as HTMLSelectElement;
    automation.value = 'loop';
    const icons = [...document.querySelectorAll('svg')];
    const strong = document.querySelector('.plugin-refresh-guide strong');
    const savedHTML = strong!.outerHTML;
    const authored = el('div', 'msg', 'Eva Å — användartext');
    document.body.append(authored);
    const action = el('button', '', () => t('Remove {0}', ['Save <img src=x>']));
    ui(action, 'aria-label', () => t('Remove {0}', ['Save <img src=x>']));
    document.body.append(action);
    expect(t('Remove {0}', ['Eva Å'])).toContain('Eva Å');
    const snapshots = new Map<string, string>();
    for (const locale of ['sv-SE', 'en', 'sv-SE', 'en', 'sv-SE'] as const) {
      const language = document.getElementById('uiLanguage') as HTMLSelectElement;
      language.value = locale;
      language.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      expect(document.documentElement.lang).toBe(locale);
      expect(document.getElementById('chatInput')).toBe(input);
      expect(input.value).toBe('Eva Å\nDéjà vu <script>not markup</script> 🙂');
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
      expect(automation.value).toBe('loop');
      expect(authored.textContent).toBe('Eva Å — användartext');
      expect(action.querySelector('img')).toBeNull();
      expect(action.textContent).toBe(locale === 'sv-SE'
        ? svSE['Remove {0}'].replace('{0}', 'Save <img src=x>')
        : 'Remove Save <img src=x>');
      expect(action.getAttribute('aria-label')).toBe(action.textContent);
      expect([...document.querySelectorAll('svg')]).toEqual(icons);
      expect(strong!.outerHTML).toBe(savedHTML);
      const text = document.getElementById('newChat')!.textContent!.trim();
      expect(text).toBe(locale === 'sv-SE' ? svSE['New chat'] : 'New chat');
      const shell = document.querySelector('.plugin-refresh-guide')!.textContent!;
      if (snapshots.has(locale)) expect(shell).toBe(snapshots.get(locale));
      else snapshots.set(locale, shell);
    }
    expect(window.localStorage.getItem('cos.ui.language')).toBe('sv-SE');
  });

  it('retains a newer authored value and persists the explicit language across renderer reloads', async () => {
    const first = await import('../src/renderer/i18n.js');
    first.initLanguage();
    const node = document.createElement('div');
    first.ui(node, 'textContent', () => first.t('New chat'));
    node.textContent = 'User title — Eva Å';
    first.setLanguage('sv-SE');
    expect(node.textContent).toBe('User title — Eva Å');
    vi.resetModules();
    const next = await import('../src/renderer/i18n.js');
    expect(next.currentLanguage()).toBe('sv-SE');
    expect(next.t('Settings')).toBe(svSE.Settings);
    expect(next.t('not in the catalog')).toBe('not in the catalog');
    expect(next.t('__proto__')).toBe('__proto__');
    expect(next.t('toString')).toBe('toString');
  });

  it('translates dynamic Pins chrome and guided-setup status while preserving authored names', async () => {
    const { setLanguage, t } = await import('../src/renderer/i18n.js');
    setLanguage('sv-SE');
    const { createPinsCreateView, createPinsLibrary, createQuiltDetail } = await import('../src/renderer/pins-quilts.js');
    const root = createPinsLibrary({
      quilts: [{
        id: 'quilt-one',
        title: 'Eva Å notes',
        state: 'pinned',
        pins: [{ id: 'pin-one', kind: 'message', excerpt: 'Keep Save exactly as written.' }],
        collections: [],
        pinCount: 1,
        updatedLabel: t('{0}h ago', [15])
      }],
      collections: [],
      activeTab: 'pinned',
      activeCollectionId: null,
      onTabChange: () => undefined,
      onCollectionChange: () => undefined,
      onOpenQuilt: () => undefined,
      onStartChat: () => undefined,
      onArchiveQuilt: () => undefined,
      onRepinQuilt: () => undefined,
      onDeleteQuilt: () => undefined,
      onToggleMessagePreviews: () => undefined,
      onCreate: () => undefined
    });
    expect(root.querySelector('.pins-library-intro p')?.textContent)
      .toBe(svSE['Gather useful things into groups so they stay connected to what they came from.\n%Threads have message pins, %Hotlinks have no pins, #Concepts use no prompt.']);
    expect(root.querySelector('.pins-tab span')?.textContent).toBe(`%${svSE.Hotlinks}`);
    expect(root.querySelector('.quilt-card-action:not(.quilt-card-preview-privacy)')?.textContent).toBe(svSE.Archive);
    expect(root.querySelector('.quilt-chat-button')?.textContent).toBe(svSE['Start chat']);
    expect(root.querySelector('.quilt-chat-button')?.getAttribute('aria-label')).toBe('Starta en chatt om Eva Å notes');
    expect(root.querySelector('.quilt-card-preview-privacy')?.getAttribute('aria-label'))
      .toBe('Dölj textförhandsvisningar av fästa meddelanden för Thread Eva Å notes');
    expect(root.querySelector('.pins-library-create')?.textContent).toBe('Skapa');
    expect(t('Show pinned message text previews for Thread {0}', ['Eva Å notes']))
      .toBe('Visa textförhandsvisningar av fästa meddelanden för Thread Eva Å notes');
    expect(root.textContent).toContain('15h sedan');
    expect(root.textContent).toContain('Eva Å notes');
    expect(root.textContent).toContain('Keep Save exactly as written.');

    const detail = createQuiltDetail({
      quilt: {
        id: 'quilt-one', title: 'Eva Å notes', state: 'pinned', collections: [],
        pins: [{ id: 'pin-one', kind: 'message', excerpt: 'Keep Save exactly as written.', savedAt: 1_700_000_000_000 }]
      },
      sortKey: 'saved',
      sortDirection: 'desc',
      onBack: () => undefined,
      onStartChat: () => undefined,
      onArchiveQuilt: () => undefined,
      onSortChange: () => undefined,
      onSortDirectionChange: () => undefined
    });
    expect(detail.textContent).toContain(svSE['Source chat']);
    expect(detail.textContent).toContain('kl.');
    expect(detail.textContent).toContain('Eva Å notes');
    expect(detail.textContent).toContain('Keep Save exactly as written.');
    expect(detail.querySelector('.quilt-detail-chat-button')?.textContent).toBe(svSE['Chat about this']);
    expect(detail.querySelector('.quilt-detail-chat-button')?.getAttribute('aria-label')).toBe('Starta en chatt om Eva Å notes');
    expect(detail.querySelector('.quilt-archive-button')?.textContent).toBe(svSE['Archive']);
    expect(detail.querySelector('.quilt-archive-button')?.getAttribute('aria-label')).toBe('Arkivera Tråd Eva Å notes');

    const create = createPinsCreateView({ onBack: () => undefined, onSave: () => undefined });
    const createSave = create.querySelector<HTMLButtonElement>('.pins-create-save')!;
    expect(create.querySelector('h1')?.textContent).toBe('Skapa');
    expect(create.querySelector('.quilt-metadata-title > span')?.textContent).toBe('Namn');
    expect(create.querySelector('.quilt-metadata-description > span')?.textContent).toBe('Beskrivning');
    expect(create.querySelector('.thread-prompt-title .quilt-pin-kind')?.textContent).toBe('Prompt');
    expect(create.querySelector<HTMLTextAreaElement>('.thread-prompt-input')?.placeholder)
      .toBe('Vad ska Eve veta eller göra när du chattar om detta?');
    expect(createSave.textContent).toBe('Spara kräver namn');
    expect(createSave.disabled).toBe(true);
    const createTitle = create.querySelector<HTMLInputElement>('.quilt-metadata-title input')!;
    createTitle.value = 'Min länk';
    createTitle.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(createSave.textContent).toBe('Spara Koncept');
    expect(createSave.disabled).toBe(false);
    const createPrompt = create.querySelector<HTMLTextAreaElement>('.thread-prompt-input')!;
    createPrompt.value = 'Prompt';
    createPrompt.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(createSave.textContent).toBe('Spara Hotlink');

    const duplicateCreate = createPinsCreateView({
      existingThreadTitles: ['Upptaget'],
      onBack: () => undefined,
      onSave: () => undefined
    });
    const duplicateTitle = duplicateCreate.querySelector<HTMLInputElement>('.quilt-metadata-title input')!;
    const duplicateSave = duplicateCreate.querySelector<HTMLButtonElement>('.pins-create-save')!;
    duplicateTitle.value = '%UPPTAGET';
    duplicateTitle.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(duplicateSave.textContent).toBe('Kräver unikt namn');
    expect(duplicateSave.disabled).toBe(true);

    expect(t('ParadigmEve setup is not started.')).toBe(svSE['ParadigmEve setup is not started.']);
    expect(t('Hide tunnel details')).toBe('Dölj tunnel ID');
    expect(t('Show tunnel details')).toBe('Visa tunnel ID');
    expect(t('Hide API key details')).toBe('Dölj API-nyckel');
    expect(t('Show API key details')).toBe('Visa API-nyckel');
    const setupTemplate = 'Companion connected. Create the {0} tunnel in Eve Browser, then paste its Tunnel ID into the guide.';
    expect(t(setupTemplate, ['Eva Å']))
      .toBe(svSE[setupTemplate].replace('{0}', 'Eva Å'));

    const mainSource = readFileSync('src/renderer/main.ts', 'utf8');
    const directLookup = mainSource.indexOf('const direct = t(next.detail);');
    const interpolatedLookup = mainSource.indexOf("next.detail.split(connectorName).join('{0}')");
    expect(directLookup).toBeGreaterThan(-1);
    expect(interpolatedLookup).toBeGreaterThan(directLookup);
    expect(mainSource).toContain('return t(source, [connectorName]);');
  });

  it('uses natural Swedish for worker, plan and model-status chrome', async () => {
    const { setLanguage, t } = await import('../src/renderer/i18n.js');
    setLanguage('sv-SE');
    expect(t('No worker agent results yet. Completed audits and verifications will collect here.'))
      .toBe('Inga resultat från jobbagenter ännu. Slutförda granskningar och verifieringar samlas här.');
    expect(t('No live Eve activity. Worker activity plans appear here when they are active.'))
      .toBe('Ingen pågående Eve-aktivitet. Jobbagenternas aktivitetsplaner visas här när de är aktiva.');
    expect(t('No checklist items yet')).toBe('Inga punkter i checklistan ännu');
    expect(t('{0} of {1} complete', [2, 3])).toBe('2 av 3 klara');
    expect(t('Available in your ChatGPT account · checked {0}', ['nyss']))
      .toBe('Tillgänglig i ditt ChatGPT-konto · kontrollerat nyss');
    expect(t('Models unavailable · retry discovery'))
      .toBe('Modeller är inte tillgängliga · försök läsa in igen');
    expect(t('Goal model set to {0}', ['GPT-5.6 Sol'])).toBe('Goal-modellen är inställd på GPT-5.6 Sol');
    expect(t('Agent driver')).toBe('Agentdrivrutin');
    expect(t('Worker {0}', [5])).toBe('Underagent 5');
    expect(t('Helper')).toBe('Hjälpare');
  });

  it('pins the newly renamed English keys to their current Swedish clarity copy', async () => {
    const { setLanguage, t } = await import('../src/renderer/i18n.js');
    setLanguage('sv-SE');
    const cases: Record<string, string> = {
      'Browse the local chat traces Eve has retained. The static HTML browser is a recovery view, not the archive authority.': 'Öppna en browser med dina lokalt sparade chattar. Arkivbrowsern är för att läsa chattar lokalt, den ändrar inte auktoritära källor.',
      'The static archive browser is available through your local archive data.': 'Den statiska arkivbrowsern är tillgänglig genom din lokala arkivdata.',
      'The static archive browser will be available after it is done syncing.': 'Den statiska arkivbrowsern blir tillgänglig när arkivet har synkat klart.',
      'Archive browser': 'Arkivbrowser',
      'Archive browser opened.': 'Arkivbrowsern öppnades.',
      'Archive actions use ParadigmEve’s own archive runtime. This screen never asks for a filesystem path and never embeds local files.': 'Arkivåtgärder använder ParadigmEves egna arkivkörning. Den här skärmen frågar aldrig efter en filsökväg och bäddar aldrig in lokala filer.',
      "Edit Eve's routines": 'Ändra Eves rutiner',
      'View and edit your availability and Eve’s routines in one place, with the times you are both free presented.': 'Se och redigera din tillgänglighet och Eves rutiner på samma ställe, med tiderna när ni båda är lediga tydligt presenterade.',
      'Edit Eve schedule here': 'Ändra Eves schema här',
      'Let this same ParadigmEve app see supported windows, use the mouse and keyboard, and work with the clipboard.': 'Låt samma ParadigmEve-app se fönster som stöds, använda mus och tangentbord samt arbeta med det du kopierat.',
      'Open Chromium extensions': 'Öppna Chromium-tillägg',
      '#Quilt tag rows': '#Quilt tagg-rader',
      'Ask Eve to search account history and draft a concept description.': 'Be Eve söka i kontots historik och skriva ett utkast till konceptbeskrivning.',
      'Opens Thread edit view by default · add https://… or C:\\… to override': 'Öppnar Tråd-redigering som standard · lägg till https://… eller C:\\… för att ändra',
      'Pin a message, plan, or result and choose where it belongs.': 'Fäst ett meddelande, en plan, eller resultat och välj vilken Quilt det hör hemma i.',
      'Pin a message, plan, or result and choose the Thread where it belongs.': 'Fäst ett meddelande, en plan, eller resultat och välj vilken Tråd det hör hemma i.',
      'Use a different name, such as Eva, to separate different computers.': 'Använd ett annat namn, till exempel Eva, för att skilja på olika datorer.',
      'ParadigmEve setup is not started.': 'ParadigmEve-guiden är inte startad.',
      'View version': 'Visa versionen',
      'Models and the work recorded in this workspace. This is a comparison, not a bill.': 'Modeller och det arbete som registrerats i denna arbetsyta. Detta är en jämförelse, inte en faktura.',
      'Value estimate per day': 'Värdeuppskattning per dag',
      'Edit value formula': 'Redigera värdeformel',
      'Set per-model cached-input rates to compare value.': 'Ställ in cachelagrade indata per modell för att jämföra värde.',
      'Six steps, one configuration. ParadigmEve enables its ordinary local tools by default, including command execution. ChatGPT still controls custom-app access and may ask for approval or block higher-risk actions.': 'Sex steg, en konfiguration. ParadigmEve aktiverar sina vanliga lokala verktyg som standard, inklusive kommandokörning. ChatGPT styr fortfarande åtkomsten till anpassade appar och kan begära godkännande eller blockera åtgärder med högre risk.',
      'Preview step 1: Pick a folder to work in': 'Förhandsvisa steg 1: Välj en mapp att jobba i',
      'Preview step 2: Create a tunnel ID': 'Förhandsvisa steg 2: Skapa en tunnel ID',
      'Pick a folder to work in': 'Välj en mapp att jobba i',
      'Nothing outside the folders you approve is reachable. Do this first — the tunnel will not start with no folder set.': 'Ingenting utanför de mappar du godkänner går att nå utan kommandon. Gör detta först — tunneln startar inte om det inte finns någon mapp.',
      '. Leave everything else as': '. Lämna allt annat som',
      '. Copy it right away — the platform will not show it again.': '. Kopiera det med en gång – plattformen kommer inte att visa det igen.',
      "Your endpoint's model ID, typed exactly as it serves it.": 'Endpointens modell ID, skrivet exakt som servern anger det.',
      'Default lets the provider decide, which is right for nearly every model. The rest wear out more and take longer.': 'Som standard kan leverantören bestämma, vilket är rätt för nästan alla modeller. Resten tröttnar fortare och tar längre tid.',
      'Sub-agents/workers': 'Underagenter/jobb',
      'Finish signing in through Eve browser.': 'Slutför inloggningen via Eve Browser.',
      'Desktop Avatar': 'Skrivbordsavatar',
      'Avatar': 'Avatar',
      'Make an avatar with Eve': 'Gör en avatar med Eve',
      'Search avatar': 'Sök avatar',
      'Import a folder': 'Importera en mapp',
      'Avatar operation failed': 'Åtgärden för avatar misslyckades',
      'This removes the avatar from your local library. You can import it again later.': 'Det här tar bort avataren från ditt lokala bibliotek. Du kan importera den igen senare.',
      'Delete avatar': 'Ta bort avatar',
      'All matching avatars are in Favorites.': 'Alla matchande avatarer finns i Favoriter.',
      'No avatars match your search.': 'Inga avatarer matchar sökningen.',
      '{0} avatar': '{0} avatar',
      '{0} avatars': '{0} avatarer'
    };
    for (const [english, swedish] of Object.entries(cases)) {
      expect(t(english), english).toBe(swedish);
    }
  });

  it('keeps connector as kontakt and connection as anslutning in Swedish setup copy', async () => {
    const { setLanguage, t } = await import('../src/renderer/i18n.js');
    setLanguage('sv-SE');
    expect(t('2. Create connector')).toBe('2. Skapa kontakt');
    expect(t('Load the ParadigmEve Companion in this dedicated Eve Browser profile before creating the connector.'))
      .toContain('skapar kontakten');
    expect(t('Open {0} extensions', ['Microsoft Edge'])).toBe('Öppna tillägg i Microsoft Edge');
    expect(t('Name this connection')).toBe('Namnge den här kontakten');
    expect(t('Choose what ChatGPT can access and keep your connection healthy.'))
      .toContain('håll anslutningen fungerande');
  });

  it('keeps the Setup introduction readable instead of shrinking it to a word-wide column', () => {
    const css = readFileSync('src/renderer/styles.css', 'utf8');
    const lede = css.match(/\.lede\s*\{([^}]*)\}/)?.[1] ?? '';
    const ledeParagraph = css.match(/\.lede p\s*\{([^}]*)\}/)?.[1] ?? '';
    const expand = css.match(/\.lede > #wizExpand\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(lede).toContain('flex-wrap: wrap');
    expect(ledeParagraph).toContain('flex: 1 1 220px');
    expect(ledeParagraph).toContain('min-width: 180px');
    expect(expand).toContain('white-space: nowrap');
  });

  it('translates plan chrome while preserving model-authored headlines and details', async () => {
    const { setLanguage } = await import('../src/renderer/i18n.js');
    const { renderAgentPlan } = await import('../src/renderer/agent-plan.js');
    const host = document.createElement('div'); document.body.append(host);
    renderAgentPlan(host, 'session-one', { plan: [{ step: 'Plan', status: 'in_progress', details: 'Keep "Save" exactly as written.' }], explanation: 'Save', updatedAt: 1 } as any);
    const headline = host.querySelector('.agent-plan-step-title');
    setLanguage('sv-SE');
    expect(host.querySelector('.agent-plan-title')!.textContent).toBe(svSE.Plan);
    expect(host.querySelector('.agent-plan-marker')!.getAttribute('aria-label')).toBe(svSE['In progress']);
    expect(host.querySelector('.agent-plan-step-title')).toBe(headline);
    expect(headline!.textContent).toBe('Plan');
    expect(host.querySelector('.agent-plan-details')!.textContent).toBe('Keep "Save" exactly as written.');
    expect(host.querySelector('.agent-plan-explanation')!.textContent).toBe('Save');
  });

  it('keeps provider model/effort identities and recorded worker markers unchanged in Swedish', async () => {
    const { setLanguage } = await import('../src/renderer/i18n.js');
    setLanguage('sv-SE');
    let onModels: (value: any) => void = () => {};
    (window as any).api = { onChatModelsChanged: (callback: typeof onModels) => { onModels = callback; return () => {}; } };
    const { initChatModels, confirmedComposerModel } = await import('../src/renderer/chat-models.js');
    initChatModels();
    onModels({ state: 'ready', requestedAt: 1, observedAt: 2, models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['high', 'max'], aliases: [] }] });
    const effort = document.getElementById('composerReasoning') as HTMLSelectElement;
    const model = document.getElementById('composerModel') as HTMLSelectElement;
    expect([...model.options].map(option => option.value)).toContain('gpt-6-astra');
    model.value = 'gpt-6-astra';
    model.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect([...effort.options].map(option => option.value)).toEqual(['high', 'max']);
    expect([...effort.options].map(option => option.textContent)).toEqual([svSE.High, svSE.Max]);
    expect(model.value).toBe('gpt-6-astra');
    expect(confirmedComposerModel()).toEqual({ model: 'gpt-6-astra', reasoningEffort: 'high' });
    const { communicationTitle } = await import('../src/renderer/agent-communication.js');
    expect(communicationTitle({ from: 'worker-1', to: 'prime', message: { text: '[worker-1 is awake again] Save' } } as any))
      .toBe(svSE['{0} resumed work'].replace('{0}', 'worker-1'));
    const option = effort.options[0];
    setLanguage('en');
    expect(effort.options[0]).toBe(option);
    expect(option!.textContent).toBe('High');
    expect(confirmedComposerModel()).toEqual({ model: 'gpt-6-astra', reasoningEffort: 'high' });
  });

  it('covers every static app label and keeps interpolated content in translated messages', () => {
    const catalog: Record<string, string> = svSE;
    const walker = document.createTreeWalker(document.body, 4);
    const missing: string[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
      const text = node.textContent!.replace(/\s+/g, ' ').trim();
      if (/[a-zA-Z]{2}/.test(text) && !catalog[text]) missing.push(text);
    }
    for (const node of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
      for (const attr of ['title', 'placeholder', 'aria-label']) {
        const text = node.getAttribute(attr);
        if (text && /[a-zA-Z]{2}/.test(text) && !catalog[text]) missing.push(text);
      }
    }
    expect(missing).toEqual([]);
    for (const [key, translation] of Object.entries(catalog)) {
      expect(translation.trim(), key).not.toBe('');
      expect([...translation.matchAll(/\{\d+\}/g)].map(match => match[0]).sort(), key)
        .toEqual([...key.matchAll(/\{\d+\}/g)].map(match => match[0]).sort());
    }
  });

  it('keeps every literal renderer translation call in the Swedish catalog', () => {
    const catalog: Record<string, string> = svSE;
    const missing: string[] = [];
    const literalCall = /\bt\(\s*((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*'))/g;
    for (const name of readdirSync('src/renderer').filter(name => name.endsWith('.ts'))) {
      const file = join('src/renderer', name);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(literalCall)) {
        const key = runInNewContext(match[1]!) as string;
        if (!Object.hasOwn(catalog, key)) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps current user-facing copy on the #Quilt / %Thread design language', () => {
    const files = [
      'AGENTS.md',
      'src/main/mcp/instructions.ts',
      'src/main/pins-context.ts',
      'src/shared/default-threads.ts',
      'src/renderer/index.html',
      'src/renderer/pins-quilts.ts',
      'src/renderer/locales/sv-SE.json',
      'docs/vault/06-pins-quilts-and-plans.md',
      'docs/vault/glossary.md',
      'docs/vault/10-current-state-and-acceptance.md'
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toContain('#tag');
      expect(source, file).not.toContain('Quilts have no special keyboard sigil');
    }
    expect(readFileSync('src/main/mcp/instructions.ts', 'utf8')).toContain('`#` is the Quilt sigil');
  });
});
