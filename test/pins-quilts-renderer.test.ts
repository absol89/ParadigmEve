import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  QUILT_PIN_PREVIEW_DENSITIES,
  createPinChooserDialog,
  createPinsCreateView,
  createPinsLibrary,
  createQuiltDetail,
  pinsObjectKind,
  sortQuiltPins,
  type QuiltPinDetailViewModel,
  type QuiltPinPreviewViewModel
} from '../src/renderer/pins-quilts.js';

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLDialogElement: w.HTMLDialogElement
  });
});

afterEach(() => dom.window.close());

it('uses the saved message excerpt as the meaningful Thread mosaic preview', () => {
  let opened: string | null = null;
  let started: string | null = null;
  let archived: string | null = null;
  const root = createPinsLibrary({
    quilts: [{
      id: 'quilt-a',
      title: 'Workshop',
      prompt: 'Start by checking what changed since the last visit.',
      state: 'pinned',
      pins: [{
        id: 'pin-a',
        kind: 'message',
        title: 'ChatGPT reply',
        excerpt: 'Keep every completed checklist live until I explicitly archive it.',
        sourceLabel: 'Pins + Plans workshop'
      }],
      collections: []
    }],
    collections: [],
    activeTab: 'pinned',
    activeCollectionId: null,
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: id => { opened = id; },
    onStartChat: id => { started = id; },
    onArchiveQuilt: id => { archived = id; },
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined
  });

  const tile = root.querySelector<HTMLElement>('.quilt-preview-tile[data-kind="message"]')!;
  expect(root.querySelector('.pins-library-intro p')?.textContent).toBe(
    'Gather useful things into groups so they stay connected to what they came from.\n' +
    '%Threads have message pins, %Hotlinks have no pins, #Concepts use no prompt.'
  );
  const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'pins-quilts.css'), 'utf8');
  expect(css).toMatch(/\.pins-library-intro p\s*\{[^}]*white-space:\s*pre-line;/s);
  expect(tile.querySelector('.quilt-preview-kind')?.textContent).toBe('Message');
  expect(tile.querySelector('.quilt-preview-text')?.textContent)
    .toBe('Keep every completed checklist live until I explicitly archive it.');
  expect(tile.textContent).not.toContain('ChatGPT reply');
  expect(tile.textContent).not.toContain('Start by checking what changed since the last visit.');
  expect(root.querySelector<HTMLButtonElement>('.quilt-title-button')?.title)
    .toBe('Start by checking what changed since the last visit.');
  const emptyTags = root.querySelector<HTMLElement>('.quilt-card-tags')!;
  expect(emptyTags.children).toHaveLength(1);
  expect(emptyTags.querySelector<HTMLButtonElement>('.quilt-card-add-quilt')?.textContent).toBe('Add to #Quilt');
  root.querySelector<HTMLButtonElement>('.quilt-cover')?.click();
  expect(opened).toBe('quilt-a');
  const start = root.querySelector<HTMLButtonElement>('.quilt-chat-button')!;
  expect(start.textContent).toBe('Start chat');
  expect(start.getAttribute('aria-label')).toBe('Start a chat about Workshop');
  start.click();
  expect(started).toBe('quilt-a');
  const archive = root.querySelector<HTMLButtonElement>('.quilt-card-action')!;
  expect(archive.textContent).toBe('Archive');
  expect(archive.getAttribute('aria-label')).toBe('Archive Thread Workshop');
  expect(root.querySelector('.quilt-card-delete-action')).toBeNull();
  archive.click();
  expect(archived).toBe('quilt-a');
});

it('separates zero-Pin active Threads into Hotlink cards and moves them to Threads when a Pin appears', () => {
  const empty = {
    id: 'quilt-hotlink',
    title: 'handoff',
    description: 'C:\\Projects\\Very\\Long\\Path\\handoff.md is the shared agent handoff artifact.',
    prompt: 'Check that handoff before editing related files.',
    state: 'pinned' as const,
    pins: [],
    collections: []
  };
  const pinned = {
    id: 'quilt-pinned',
    title: 'release',
    state: 'pinned' as const,
    pins: [{ id: 'pin-a', kind: 'message' as const, excerpt: 'Release evidence' }],
    collections: []
  };
  const archived = {
    id: 'quilt-archived',
    title: 'old',
    state: 'archived' as const,
    pins: [],
    collections: []
  };
  const concept = {
    id: 'quilt-concept',
    title: 'concept',
    description: 'A description-only durable idea.',
    state: 'pinned' as const,
    pins: [],
    collections: []
  };
  const shared = {
    collections: [],
    activeCollectionId: null,
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined
  };

  const hotlinks = createPinsLibrary({ ...shared, quilts: [empty, pinned, concept, archived], activeTab: 'hotlink' });
  expect([...hotlinks.querySelectorAll('.pins-tab')].map(node => node.textContent))
    .toEqual(['%Hotlinks1', '%Threads1', '#Concepts1', 'Archived1']);
  const card = hotlinks.querySelector<HTMLElement>('[data-quilt-id="quilt-hotlink"]')!;
  expect(card.dataset.libraryTab).toBe('hotlink');
  expect(card.querySelector('.quilt-cover')).toBeNull();
  expect(card.querySelector('.quilt-preview-tile')).toBeNull();
  expect(card.querySelector('.quilt-hotlink-description')?.textContent).toContain('handoff.md');
  expect(card.querySelector('.quilt-hotlink-prompt')?.textContent).toBe('Check that handoff before editing related files.');
  expect(card.textContent).not.toContain('0 Pins');
  expect(hotlinks.querySelector('[data-quilt-id="quilt-pinned"]')).toBeNull();
  expect(hotlinks.querySelector('[data-quilt-id="quilt-concept"]')).toBeNull();

  const concepts = createPinsLibrary({ ...shared, quilts: [empty, pinned, concept, archived], activeTab: 'concept' });
  const conceptCard = concepts.querySelector<HTMLElement>('[data-quilt-id="quilt-concept"]')!;
  expect(conceptCard.dataset.libraryTab).toBe('concept');
  expect(conceptCard.querySelector('.quilt-title-button')?.textContent).toBe('#concept');
  expect(conceptCard.querySelector('.quilt-cover')).toBeNull();
  expect(conceptCard.querySelector('.quilt-hotlink-description')?.textContent).toBe('A description-only durable idea.');
  expect(conceptCard.querySelector('.quilt-hotlink-prompt')).toBeNull();

  const moved = createPinsLibrary({
    ...shared,
    quilts: [{ ...empty, pins: [{ id: 'first-pin', kind: 'message' as const, excerpt: 'First saved source' }] }],
    activeTab: 'pinned'
  });
  expect(moved.querySelector<HTMLElement>('[data-quilt-id="quilt-hotlink"]')?.dataset.libraryTab).toBe('pinned');
  expect(moved.querySelector('.quilt-cover')).not.toBeNull();
});

it('uses the empty Quilt-pill row as an Add to #Quilt action', () => {
  let opened = '';
  const root = createPinsLibrary({
    quilts: [{
      id: 'thread-without-quilt',
      title: 'Unsorted',
      state: 'pinned',
      pins: [{ id: 'pin-a', kind: 'message', excerpt: 'Keep card height aligned.' }],
      collections: []
    }],
    collections: [],
    activeTab: 'pinned',
    activeCollectionId: null,
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: id => { opened = id; },
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined
  });

  const tags = root.querySelector<HTMLElement>('.quilt-card-tags')!;
  const add = tags.querySelector<HTMLButtonElement>('.quilt-card-add-quilt')!;
  expect(add.textContent).toBe('Add to #Quilt');
  add.click();
  expect(opened).toBe('thread-without-quilt');
  const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'pins-quilts.css'), 'utf8');
  expect(css).toMatch(/\.quilt-card-add-quilt\s*\{[^}]*cursor:\s*pointer;/s);
});

it('offers one Pins header Create action without a Concept-only chat affordance', () => {
  let requested = 0;
  const root = createPinsLibrary({
    quilts: [],
    collections: [],
    activeTab: 'concept',
    activeCollectionId: null,
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined,
    onCreate: () => { requested += 1; }
  });

  const button = root.querySelector<HTMLButtonElement>('.pins-library-create')!;
  expect(root.querySelector('.pins-library-icon use')?.getAttribute('href')).toBe('#i-pins-heart-memo');
  const indexHtml = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  expect(indexHtml).toContain('id="i-pins-heart-memo"');
  expect(indexHtml).toContain('fill="#ff8fba"');
  expect(indexHtml).toContain('M7.1 11.4h9.6M6.8 14.4h10.2M8 17.4h7.6');
  expect(indexHtml).not.toContain('id="i-pins-workspace"');
  expect(button.textContent).toBe('Create');
  expect(root.querySelector('.pins-concept-chat')).toBeNull();
  button.click();
  expect(requested).toBe(1);
});

it('keeps a new Pins item local until Save and changes Save Concept to Save Hotlink when a prompt appears', async () => {
  const saves: unknown[] = [];
  const root = createPinsCreateView({
    existingThreadTitles: ['Existing', '%Duplicate'],
    onBack: () => undefined,
    onSave: draft => { saves.push(draft); }
  });
  document.body.append(root);
  const save = root.querySelector<HTMLButtonElement>('.pins-create-save')!;
  const fields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  const title = fields[0] as HTMLInputElement;
  const description = fields[1] as HTMLTextAreaElement;
  const link = fields[2] as HTMLInputElement;
  const collections = fields[3] as HTMLTextAreaElement;
  const prompt = root.querySelector<HTMLTextAreaElement>('.thread-prompt-input')!;
  expect(root.querySelector('.quilt-metadata-title > span')?.textContent).toBe('Name');
  expect(root.querySelector('.quilt-metadata-description > span')?.textContent).toBe('Description');
  expect(root.querySelector('.thread-prompt-title .quilt-pin-kind')?.textContent).toBe('Prompt');
  expect(prompt.placeholder).toBe('What should Eve know or do when chatting about this?');
  expect(save.textContent).toBe('Save requires name');
  expect(save.disabled).toBe(true);
  expect(saves).toEqual([]);

  prompt.value = 'Keep this guidance active.';
  prompt.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(save.textContent).toBe('Save requires name');
  expect(save.disabled).toBe(true);
  title.value = ' duplicate ';
  title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(save.textContent).toBe('Requires unique name');
  expect(save.disabled).toBe(true);
  title.value = '%DUPLICATE';
  title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(save.textContent).toBe('Requires unique name');
  expect(save.disabled).toBe(true);
  title.value = 'handoff';
  title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(save.textContent).toBe('Save Hotlink');
  expect(save.disabled).toBe(false);
  description.value = 'Useful handoff context.';
  link.value = 'https://example.com/handoff';
  collections.value = '#Eve\n#Research';
  root.querySelector<HTMLFormElement>('.pins-create-form')!
    .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  expect(saves).toEqual([{
    title: 'handoff',
    description: 'Useful handoff context.',
    link: 'https://example.com/handoff',
    collectionNames: ['#Eve', '#Research'],
    prompt: 'Keep this guidance active.'
  }]);
  title.value = '   ';
  title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(save.textContent).toBe('Save requires name');
  expect(save.disabled).toBe(true);
  expect(pinsObjectKind(0, '')).toBe('concept');
  expect(pinsObjectKind(0, 'Prompt')).toBe('hotlink');
  expect(pinsObjectKind(1, '')).toBe('thread');
});

it('uses # for Concepts, % for Hotlinks, generic editor copy, and no empty Pins divider', () => {
  const common = {
    sortKey: 'saved' as const,
    sortDirection: 'desc' as const,
    onBack: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onSortChange: () => undefined,
    onSortDirectionChange: () => undefined,
    onSaveMetadata: () => undefined,
    onSavePrompt: () => undefined
  };
  const concept = createQuiltDetail({
    ...common,
    quilt: { id: 'concept', title: 'Concept', state: 'pinned', collections: [], pins: [] }
  });
  expect(concept.querySelector('h1')?.textContent).toBe('#Concept');
  expect(concept.querySelector('.quilt-back-button')?.textContent).toBe('← Back to overview');
  expect(concept.querySelector('.quilt-detail-chat-button')?.textContent).toBe('Chat about this');
  expect(concept.querySelector('.quilt-metadata-title > span')?.textContent).toBe('Name');
  expect(concept.querySelector('.quilt-metadata-description > span')?.textContent).toBe('Description');
  expect(concept.querySelector('.thread-prompt-title .quilt-pin-kind')?.textContent).toBe('Prompt');
  const prompt = concept.querySelector<HTMLTextAreaElement>('.thread-prompt-input')!;
  const savePrompt = concept.querySelector<HTMLButtonElement>('.thread-prompt-save')!;
  expect(prompt.placeholder).toBe('What should Eve know or do when chatting about this?');
  expect(savePrompt.textContent).toBe('Save Concept');
  prompt.value = 'Use this context when chatting.';
  prompt.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(savePrompt.textContent).toBe('Save Hotlink');
  expect(concept.querySelector('.quilt-detail-summary')?.classList.contains('is-empty')).toBe(true);

  const hotlink = createQuiltDetail({
    ...common,
    quilt: { id: 'hotlink', title: '#Docs', prompt: 'Open the docs first.', state: 'pinned', collections: [], pins: [] }
  });
  expect(hotlink.querySelector('h1')?.textContent).toBe('%Docs');

  const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'pins-quilts.css'), 'utf8');
  expect(css).toMatch(/\.quilt-detail-summary\.is-empty\s*\{[^}]*border-bottom:\s*0;/s);
  expect(css).toMatch(/\.quilt-sort-select,\s*\.quilt-sort-direction\s*\{[^}]*min-height:\s*36px;/s);
  expect(css).toMatch(/\.quilt-archive-button,\s*\.quilt-delete-button\s*\{[^}]*min-height:\s*36px;/s);
});

it('uses additive Concept + Quilt pills as a many-to-many zoomout in the Concepts overview', () => {
  const research = { id: 'collection-research', label: 'Research' };
  const eve = { id: 'collection-eve', label: 'Eve' };
  const concepts = [
    {
      id: 'concept-a',
      title: 'Architecture',
      description: 'Architecture concept.',
      state: 'pinned' as const,
      pins: [],
      collections: [eve]
    },
    {
      id: 'concept-b',
      title: 'Evidence',
      description: 'Evidence concept.',
      state: 'pinned' as const,
      pins: [],
      collections: [research]
    },
    {
      id: 'concept-c',
      title: 'Unrelated',
      description: 'Unrelated concept.',
      state: 'pinned' as const,
      pins: [],
      collections: []
    },
    {
      id: 'thread-draft',
      title: 'Draft',
      state: 'pinned' as const,
      pins: [],
      collections: [research]
    }
  ];
  const changed: Array<string | null> = [];
  const generated: string[] = [];
  const root = createPinsLibrary({
    quilts: concepts,
    collections: [
      { ...research, count: 2 },
      { ...eve, count: 1 }
    ],
    activeTab: 'concept',
    activeConceptId: 'concept-a',
    activeCollectionIds: ['collection-research'],
    activeCollectionId: null,
    onTabChange: () => undefined,
    onCollectionChange: id => changed.push(id),
    onConceptChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined,
    onGenerateDescription: id => generated.push(id)
  });

  const chips = [...root.querySelectorAll<HTMLButtonElement>('.collection-chip')];
  expect(chips.map(button => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
    ['#Architecture', 'true'],
    ['All Quilts', 'false'],
    ['#Research2', 'true'],
    ['#Eve1', 'false']
  ]);
  expect([...root.querySelectorAll<HTMLElement>('.quilt-card')].map(card => card.dataset.quiltId))
    .toEqual(['concept-a', 'concept-b', 'thread-draft']);
  const draftCard = root.querySelector<HTMLElement>('[data-quilt-id="thread-draft"]')!;
  expect(draftCard.dataset.libraryTab).toBe('concept');
  expect(draftCard.querySelector('.quilt-cover')).toBeNull();
  expect(draftCard.querySelector('.quilt-title-button')?.textContent).toBe('#Draft');
  const generate = draftCard.querySelector<HTMLButtonElement>('.quilt-concept-description-cta')!;
  expect(generate.textContent).toBe('Create\ndescription');
  generate.click();
  expect(generated).toEqual(['thread-draft']);
  chips[3]!.click();
  expect(changed).toEqual(['collection-eve']);
});

it('keeps the empty Concept description CTA exactly the same height as configured description slots', () => {
  const root = createPinsLibrary({
    quilts: [
      { id: 'described', title: 'Described', description: 'Three rows please.', state: 'pinned', pins: [], collections: [{ id: 'research', label: 'Research' }] },
      { id: 'empty', title: 'Empty', state: 'pinned', pins: [], collections: [{ id: 'research', label: 'Research' }] }
    ],
    collections: [{ id: 'research', label: 'Research' }],
    activeTab: 'concept',
    activeCollectionIds: ['research'],
    activeCollectionId: null,
    conceptPreviewSettings: {
      quiltRows: 2,
      pinPreviewDensity: 2,
      descriptionTextSize: 'large',
      descriptionRows: 3,
      promptTextSize: 'medium',
      promptRows: 2
    },
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined,
    onGenerateDescription: () => undefined
  });
  const slots = [...root.querySelectorAll<HTMLElement>('.quilt-hotlink-description-slot')];
  expect(slots).toHaveLength(2);
  expect(slots.map(slot => [slot.style.height, slot.style.fontSize])).toEqual([
    ['4.35em', '13px'],
    ['4.35em', '13px']
  ]);
  const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'pins-quilts.css'), 'utf8');
  expect(css).toMatch(/\.quilt-hotlink-description-slot \.quilt-hotlink-description,\s*\.quilt-concept-description-cta\s*\{[^}]*height:\s*100%;/s);
});

it('offers Create description on a normal pinned Thread with Pins when its description is empty', () => {
  const generated: string[] = [];
  const root = createPinsLibrary({
    quilts: [{
      id: 'thread-images',
      title: 'Images',
      state: 'pinned',
      pins: [
        { id: 'image-a', kind: 'message', excerpt: 'First image' },
        { id: 'image-b', kind: 'message', excerpt: 'Second image' }
      ],
      collections: []
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
    onGenerateDescription: id => generated.push(id)
  });
  const card = root.querySelector<HTMLElement>('[data-quilt-id="thread-images"]')!;
  expect(card.querySelector('.quilt-title-button')?.textContent).toBe('%Images');
  const createDescription = card.querySelector<HTMLButtonElement>('.quilt-concept-description-cta')!;
  expect(createDescription.textContent).toBe('Create\ndescription');
  createDescription.click();
  expect(generated).toEqual(['thread-images']);
});

it('keeps Add to #Quilt button metrics aligned with ordinary Quilt chips', () => {
  const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'pins-quilts.css'), 'utf8');
  expect(css).toMatch(/\.collection-tag\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-height:\s*19px;[^}]*font-family:\s*inherit;[^}]*font-size:\s*9\.5px;[^}]*line-height:\s*1\.2;/s);
  expect(css).toMatch(/\.quilt-card-add-quilt\s*\{[^}]*appearance:\s*none;[^}]*margin:\s*0;[^}]*cursor:\s*pointer;/s);
  expect(css).not.toMatch(/\.quilt-card-add-quilt\s*\{[^}]*font-size:\s*inherit;/s);
});

it('shows configured sticky Pin preview density on Concept-overview cards that have Pins', () => {
  const root = createPinsLibrary({
    quilts: [{
      id: 'concept-with-pins',
      title: 'Visual evidence',
      description: 'A Concept that also keeps source evidence.',
      state: 'pinned',
      pins: [
        { id: 'sticky-message', kind: 'message', sticky: true, excerpt: 'Keep this one prominent.' },
        { id: 'prompt', kind: 'prompt', excerpt: 'Original authored prompt.' },
        { id: 'reply', kind: 'message', excerpt: 'Supporting reply.' }
      ],
      collections: [{ id: 'research', label: 'Research' }]
    }],
    collections: [{ id: 'research', label: 'Research' }],
    activeTab: 'concept',
    activeCollectionIds: ['research'],
    activeCollectionId: null,
    conceptPreviewSettings: {
      quiltRows: 2,
      pinPreviewDensity: 3,
      descriptionTextSize: 'medium',
      descriptionRows: 2,
      promptTextSize: 'medium',
      promptRows: 2
    },
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined
  });

  const card = root.querySelector<HTMLElement>('[data-quilt-id="concept-with-pins"]')!;
  const cover = card.querySelector<HTMLElement>('.quilt-cover')!;
  expect(cover).not.toBeNull();
  expect(cover.dataset.previewDensity).toBe('3');
  expect(cover.querySelectorAll('.quilt-preview-tile')).toHaveLength(9);
  expect(cover.querySelector<HTMLElement>('.quilt-preview-tile:not(.is-placeholder)')?.dataset.sticky).toBe('true');
  expect(card.querySelector('.quilt-hotlink-description')?.textContent)
    .toBe('A Concept that also keeps source evidence.');
});

it('applies durable Concepts preview rows and text sizes without changing authored text', () => {
  const research = { id: 'collection-research', label: 'Research', count: 4 };
  const root = createPinsLibrary({
    quilts: [{
      id: 'thread-a',
      title: 'Long notes',
      description: 'Description stays authored exactly as written.',
      prompt: 'Prompt stays authored exactly as written.',
      state: 'pinned',
      pins: [],
      collections: [research]
    }],
    collections: [research, { id: 'collection-eve', label: 'Eve', count: 2 }],
    activeTab: 'concept',
    activeCollectionIds: ['collection-research'],
    activeCollectionId: null,
    conceptPreviewSettings: {
      quiltRows: 3,
      pinPreviewDensity: 2,
      descriptionTextSize: 'large',
      descriptionRows: 4,
      promptTextSize: 'small',
      promptRows: 1
    },
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined
  });

  const filters = root.querySelector<HTMLElement>('.concept-collection-filter')!;
  expect(filters.dataset.maxRows).toBe('3');
  expect(filters.style.maxHeight).toBe('101px');
  expect(filters.style.overflowY).toBe('auto');
  const description = root.querySelector<HTMLElement>('.quilt-hotlink-description')!;
  const prompt = root.querySelector<HTMLElement>('.quilt-hotlink-prompt')!;
  expect(description.textContent).toBe('Description stays authored exactly as written.');
  expect(description.style.fontSize).toBe('13px');
  expect(description.style.getPropertyValue('-webkit-line-clamp')).toBe('4');
  expect(prompt.textContent).toBe('Prompt stays authored exactly as written.');
  expect(prompt.style.fontSize).toBe('10.5px');
  expect(prompt.style.getPropertyValue('-webkit-line-clamp')).toBe('1');
});

it('keeps the Thread-owned prompt above Pins, editable, and available from title hover', async () => {
  let savedPrompt: string | null = null;
  const root = createQuiltDetail({
    quilt: {
      id: 'quilt-thread-prompt',
      title: 'Release work',
      prompt: 'Check the blocker first, then summarize the release state.',
      state: 'pinned',
      pins: [{ id: 'pin-a', kind: 'message', excerpt: 'A saved message', savedAt: 1 }],
      collections: []
    },
    sortKey: 'saved',
    sortDirection: 'desc',
    onBack: () => undefined,
    onStartChat: () => undefined,
    onSortChange: () => undefined,
    onSortDirectionChange: () => undefined,
    onSavePrompt: prompt => { savedPrompt = prompt; }
  });

  expect(root.querySelector('h1')?.getAttribute('title'))
    .toBe('Check the blocker first, then summarize the release state.');
  const promptCard = root.querySelector<HTMLElement>('.thread-prompt-card')!;
  const pinList = root.querySelector<HTMLElement>('.quilt-pin-list')!;
  const startChat = root.querySelector<HTMLButtonElement>('.quilt-detail-chat-button')!;
  expect(promptCard.compareDocumentPosition(pinList) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(promptCard.textContent).toContain('Prompt');
  expect(promptCard.textContent).toContain(
    'What should Eve know or do when chatting about this? Filling this in will turn the save button to Save Hotlink.'
  );
  const input = promptCard.querySelector<HTMLTextAreaElement>('.thread-prompt-input')!;
  const savePrompt = promptCard.querySelector<HTMLButtonElement>('.thread-prompt-save')!;
  expect(input.value).toBe('Check the blocker first, then summarize the release state.');
  expect(startChat.disabled).toBe(false);
  input.value = 'Start from the latest blocker and keep the answer short.';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(startChat.disabled).toBe(true);
  input.value = 'Check the blocker first, then summarize the release state.';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(startChat.disabled).toBe(false);
  input.value = 'Start from the latest blocker and keep the answer short.';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  savePrompt.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(savedPrompt).toBe('Start from the latest blocker and keep the answer short.');
  expect(startChat.disabled).toBe(false);
});

it('keeps a Prompt in the first Thread square and labels it distinctly from assistant Messages', () => {
  const root = createPinsLibrary({
    quilts: [{
      id: 'quilt-prompt',
      title: 'Prompt first',
      state: 'pinned',
      pins: [
        { id: 'reply-newer', kind: 'message', excerpt: 'The assistant answer that was pinned later.' },
        { id: 'prompt-older', kind: 'prompt', excerpt: 'Can you make the Thread always show my prompt first?' },
        { id: 'plan', kind: 'plan', title: 'Follow-up plan' }
      ],
      collections: []
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
    onDeleteQuilt: () => undefined
  });

  const tiles = [...root.querySelectorAll<HTMLElement>('.quilt-preview-tile')];
  expect(tiles[0]?.dataset.kind).toBe('prompt');
  expect(tiles[0]?.querySelector('.quilt-preview-kind')?.textContent).toBe('Prompt');
  expect(tiles[0]?.querySelector('.quilt-preview-text')?.textContent)
    .toBe('Can you make the Thread always show my prompt first?');
  expect(tiles[1]?.dataset.kind).toBe('message');
  expect(tiles[1]?.querySelector('.quilt-preview-kind')?.textContent).toBe('Message');
});

it('supports 1, 2x2, 3x3, and 4x4 sticky Pin preview densities while keeping Prompt first', () => {
  const pins: QuiltPinPreviewViewModel[] = Array.from({ length: 18 }, (_, index) => ({
    id: `pin-${index}`,
    kind: 'message' as const,
    excerpt: `Saved message ${index}`
  }));
  pins.splice(8, 0, {
    id: 'prompt',
    kind: 'prompt' as const,
    excerpt: 'Always keep my authored prompt first.'
  });

  for (const density of QUILT_PIN_PREVIEW_DENSITIES) {
    const root = createPinsLibrary({
      quilts: [{ id: 'quilt-density', title: 'Density', state: 'pinned', pins, collections: [] }],
      collections: [],
      activeTab: 'pinned',
      activeCollectionId: null,
      previewDensity: density,
      onTabChange: () => undefined,
      onCollectionChange: () => undefined,
      onOpenQuilt: () => undefined,
      onStartChat: () => undefined,
      onArchiveQuilt: () => undefined,
      onRepinQuilt: () => undefined,
      onDeleteQuilt: () => undefined
    });

    const cover = root.querySelector<HTMLElement>('.quilt-cover')!;
    const tiles = [...cover.querySelectorAll<HTMLElement>('.quilt-preview-tile')];
    expect(cover.dataset.previewDensity).toBe(String(density));
    expect(cover.style.getPropertyValue('--quilt-preview-density')).toBe(String(density));
    expect(tiles).toHaveLength(density * density);
    expect(tiles[0]?.dataset.kind).toBe('prompt');
    expect(tiles[0]?.querySelector('.quilt-preview-text')?.textContent)
      .toBe('Always keep my authored prompt first.');
  }
});

it('uses an image as the ordinary same-send thumbnail and spans sticky image/text across the emphasized 2x2 card', () => {
  const image = { src: 'data:image/png;base64,YQ==', alt: 'receipt.png', state: 'ready' as const };
  const quilt = {
    id: 'quilt-image-message',
    title: 'Visual message',
    state: 'pinned' as const,
    pins: [{
      id: 'pin-image-message',
      kind: 'prompt' as const,
      sticky: true,
      excerpt: 'Remember that the top-left corner is the damaged part.',
      sourceLabel: 'Exact source chat',
      image
    }],
    collections: []
  };
  const shared = {
    quilts: [quilt],
    collections: [],
    activeTab: 'pinned' as const,
    activeCollectionId: null,
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined
  };

  const ordinary = createPinsLibrary({
    ...shared,
    quilts: [{ ...quilt, pins: quilt.pins.map(pin => ({ ...pin, sticky: false })) }],
    previewDensity: 2
  });
  const thumbnail = ordinary.querySelector<HTMLElement>('[data-kind="prompt"]')!;
  expect(thumbnail.classList.contains('is-image-thumbnail')).toBe(true);
  expect(thumbnail.querySelector<HTMLImageElement>('.quilt-preview-image')?.src).toBe(image.src);
  expect(thumbnail.querySelector('.quilt-preview-text')).toBeNull();
  expect(thumbnail.title).toContain('Remember that the top-left corner is the damaged part.');
  expect(thumbnail.title).toContain('Exact source chat');

  const emphasized2x2 = createPinsLibrary({ ...shared, previewDensity: 2 });
  const cover2x2 = emphasized2x2.querySelector<HTMLElement>('.quilt-cover')!;
  const split2x2 = cover2x2.querySelector<HTMLElement>('[data-kind="prompt"]')!;
  expect(cover2x2.querySelectorAll('.quilt-preview-tile')).toHaveLength(1);
  expect(split2x2.classList.contains('is-split-preview')).toBe(true);
  expect(split2x2.classList.contains('is-2x2-emphasis')).toBe(true);
  expect(split2x2.style.gridColumn).toBe('1 / -1');
  expect(split2x2.style.gridRow).toBe('1 / -1');
  expect(split2x2.querySelector<HTMLImageElement>('.quilt-preview-image')?.src).toBe(image.src);
  expect(split2x2.querySelector('.quilt-preview-text')?.textContent)
    .toBe('Remember that the top-left corner is the damaged part.');

  const emphasized1 = createPinsLibrary({ ...shared, previewDensity: 1 });
  const split1 = emphasized1.querySelector<HTMLElement>('[data-kind="prompt"]')!;
  expect(split1.classList.contains('is-split-preview')).toBe(true);
  expect(split1.querySelector<HTMLImageElement>('.quilt-preview-image')?.src).toBe(image.src);
  expect(split1.querySelector('.quilt-preview-text')?.textContent)
    .toBe('Remember that the top-left corner is the damaged part.');
});

it('prioritizes heart-sticky Pins ahead of the ordinary Prompt-first preview order', () => {
  const root = createPinsLibrary({
    quilts: [{
      id: 'quilt-sticky-order',
      title: 'Sticky order',
      state: 'pinned',
      pins: [
        { id: 'prompt', kind: 'prompt', excerpt: 'Ordinary prompt' },
        { id: 'later', kind: 'message', excerpt: 'Ordinary message' },
        { id: 'sticky', kind: 'message', sticky: true, excerpt: 'Heart-selected message' }
      ],
      collections: []
    }],
    collections: [],
    activeTab: 'pinned',
    activeCollectionId: null,
    previewDensity: 2,
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined
  });
  const tiles = [...root.querySelectorAll<HTMLElement>('.quilt-preview-tile:not(.is-placeholder)')];
  expect(tiles.map(tile => tile.querySelector('.quilt-preview-text')?.textContent)).toEqual([
    'Heart-selected message',
    'Ordinary prompt',
    'Ordinary message'
  ]);
  expect(tiles[0]?.dataset.sticky).toBe('true');
});

it('toggles per-Thread sticky emphasis with a heart on Message and Plan Pins', () => {
  const calls: Array<[string, boolean]> = [];
  const detail = createQuiltDetail({
    quilt: {
      id: 'thread-heart',
      title: 'Heart',
      state: 'pinned',
      collections: [],
      pins: [
        { id: 'message', kind: 'message', excerpt: 'Keep me visible.', savedAt: 10 },
        {
          id: 'plan', kind: 'plan', title: 'Plan', excerpt: '1 / 3 complete', savedAt: 11,
          plan: {
            items: [
              { id: 'a', title: 'First step', status: 'done' },
              { id: 'b', title: 'Second step', status: 'in_progress', relation: 'current', priority: 'high' },
              { id: 'c', title: 'Third step', status: 'todo', relation: 'next' }
            ]
          }
        }
      ]
    },
    sortKey: 'saved',
    sortDirection: 'asc',
    onBack: () => undefined,
    onStartChat: () => undefined,
    onSortChange: () => undefined,
    onSortDirectionChange: () => undefined,
    onRemovePin: () => undefined,
    onSetPinSticky(pin, sticky) { calls.push([pin.id, sticky]); }
  });

  const messageHeart = detail.querySelector<HTMLButtonElement>('[data-pin-id="message"] .quilt-pin-sticky')!;
  const planHeart = detail.querySelector<HTMLButtonElement>('[data-pin-id="plan"] .quilt-pin-sticky')!;
  expect(messageHeart.textContent).toBe('♡');
  expect(messageHeart.getAttribute('aria-pressed')).toBe('false');
  expect(messageHeart.parentElement?.lastElementChild).toBe(messageHeart);
  expect(planHeart.textContent).toBe('♡');
  expect(detail.querySelectorAll('[data-pin-id="plan"] .quilt-pin-plan-item')).toHaveLength(3);
  expect(detail.querySelector('[data-pin-id="plan"] .quilt-pin-plan-item[data-relation="current"]')?.textContent)
    .toContain('Second step');
  expect(detail.querySelector('[data-pin-id="plan"] .quilt-pin-plan-item[data-relation="next"]')?.textContent)
    .toContain('Third step');
  messageHeart.click();
  planHeart.click();
  expect(calls).toEqual([['message', true], ['plan', true]]);
});

it('renders the complete Plan in both its pinned row and its promoted sticky copy', () => {
  const detail = createQuiltDetail({
    quilt: {
      id: 'thread-plan-sticky',
      title: 'Plan sticky',
      state: 'pinned',
      collections: [],
      pins: [{
        id: 'plan',
        kind: 'plan',
        title: 'Ship the fix',
        excerpt: '1 / 3 complete',
        savedAt: 10,
        sticky: true,
        plan: {
          items: [
            { id: 'one', title: 'Trace it', status: 'done' },
            { id: 'two', title: 'Fix it', status: 'in_progress', relation: 'current' },
            { id: 'three', title: 'Verify it', status: 'todo', relation: 'next' }
          ]
        }
      }]
    },
    sortKey: 'saved',
    sortDirection: 'desc',
    onBack: () => undefined,
    onStartChat: () => undefined,
    onSortChange: () => undefined,
    onSortDirectionChange: () => undefined,
    onRemovePin: () => undefined,
    onSetPinSticky: () => undefined
  });

  const rows = [...detail.querySelectorAll<HTMLElement>('[data-pin-id="plan"]')];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.dataset.stickyCopy).toBe('true');
  for (const row of rows) {
    expect([...row.querySelectorAll('.quilt-pin-plan-title')].map(item => item.textContent))
      .toEqual(['Trace it', 'Fix it', 'Verify it']);
  }
});

it('keeps chronology sorting intact while showing a hearted message copy immediately after the Prompt', () => {
  const pins: QuiltPinDetailViewModel[] = [
    { id: 'old', kind: 'message', excerpt: 'Old', savedAt: 10, sentAt: 10, contextAt: 10 },
    { id: 'prompt', kind: 'prompt', excerpt: 'Prompt', savedAt: 100, sentAt: 100, contextAt: 100 },
    { id: 'sticky', kind: 'message', excerpt: 'Sticky', savedAt: 5, sentAt: 5, contextAt: 5, sticky: true },
    { id: 'new', kind: 'message', excerpt: 'New', savedAt: 20, sentAt: 20, contextAt: 20 }
  ];

  expect(sortQuiltPins(pins, 'saved', 'asc').map(pin => pin.id))
    .toEqual(['prompt', 'sticky', 'old', 'new']);
  expect(sortQuiltPins(pins, 'saved', 'desc').map(pin => pin.id))
    .toEqual(['prompt', 'new', 'old', 'sticky']);

  const detail = createQuiltDetail({
    quilt: { id: 'thread-sticky-copy', title: 'Sticky copy', state: 'pinned', collections: [], pins },
    sortKey: 'saved',
    sortDirection: 'desc',
    onBack: () => undefined,
    onStartChat: () => undefined,
    onSortChange: () => undefined,
    onSortDirectionChange: () => undefined,
    onRemovePin: () => undefined,
    onSetPinSticky: () => undefined
  });

  const rows = [...detail.querySelectorAll<HTMLElement>('.quilt-pin-row')];
  expect(rows.map(row => row.dataset.pinId))
    .toEqual(['prompt', 'sticky', 'new', 'old', 'sticky']);
  expect(rows[1]?.dataset.stickyCopy).toBe('true');
  expect(rows.at(-1)?.dataset.stickyCopy).toBeUndefined();
});

it('uses a per-card eye to hide Prompt/Message text and tooltips while preserving allowed image previews', () => {
  const image = { src: 'data:image/png;base64,YQ==', alt: 'receipt.png', state: 'ready' as const };
  const toggles: Array<[string, boolean]> = [];
  const quilt = {
    id: 'quilt-private-preview',
    title: 'Private notes',
    state: 'pinned' as const,
    pins: [
      { id: 'prompt', kind: 'prompt' as const, excerpt: 'Private authored message.' },
      { id: 'reply', kind: 'message' as const, excerpt: 'Private assistant reply.' },
      {
        id: 'image-reply', kind: 'message' as const,
        excerpt: 'Private image caption.', sourceLabel: 'Exact source chat', image
      },
      { id: 'plan', kind: 'plan' as const, title: 'Visible plan title' }
    ],
    collections: []
  };
  const shared = {
    collections: [],
    activeTab: 'pinned' as const,
    activeCollectionId: null,
    previewDensity: 2 as const,
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined,
    onToggleMessagePreviews: (quiltId: string, visible: boolean) => { toggles.push([quiltId, visible]); }
  };

  const visible = createPinsLibrary({ ...shared, quilts: [{ ...quilt, messagePreviewsVisible: true }] });
  const visibleEye = visible.querySelector<HTMLButtonElement>('.quilt-card-preview-privacy')!;
  expect(visibleEye.getAttribute('aria-pressed')).toBe('true');
  expect(visibleEye.getAttribute('aria-label')).toBe('Hide pinned message text previews for Thread Private notes');
  expect(visibleEye.querySelector('use')?.getAttribute('href')).toBe('#i-eye');
  expect(visible.textContent).toContain('Private authored message.');
  expect(visible.textContent).toContain('Private assistant reply.');
  expect(visible.textContent).toContain('Visible plan title');
  expect(visible.querySelector<HTMLImageElement>('.quilt-preview-image')?.src).toBe(image.src);
  visibleEye.click();
  expect(toggles).toEqual([['quilt-private-preview', false]]);

  const hidden = createPinsLibrary({ ...shared, quilts: [{ ...quilt, messagePreviewsVisible: false }] });
  const hiddenEye = hidden.querySelector<HTMLButtonElement>('.quilt-card-preview-privacy')!;
  expect(hiddenEye.getAttribute('aria-pressed')).toBe('false');
  expect(hiddenEye.getAttribute('aria-label')).toBe('Show pinned message text previews for Thread Private notes');
  expect(hiddenEye.querySelector('use')?.getAttribute('href')).toBe('#i-eye-off');
  expect(hidden.textContent).not.toContain('Private authored message.');
  expect(hidden.textContent).not.toContain('Private assistant reply.');
  expect(hidden.textContent).not.toContain('Private image caption.');
  expect(hidden.textContent).toContain('Visible plan title');
  expect(hidden.querySelector<HTMLImageElement>('.quilt-preview-image')?.src).toBe(image.src);
  for (const tile of hidden.querySelectorAll<HTMLElement>('[data-kind="prompt"], [data-kind="message"]')) {
    expect(tile.title).not.toContain('Private authored message.');
    expect(tile.title).not.toContain('Private assistant reply.');
    expect(tile.title).not.toContain('Private image caption.');
  }
  expect(hidden.querySelector<HTMLElement>('[data-kind="message"].has-image')?.title).toContain('Exact source chat');
  hiddenEye.click();
  expect(toggles).toEqual([
    ['quilt-private-preview', false],
    ['quilt-private-preview', true]
  ]);
});

it('formats Quilt pills with one # prefix across the Pins library and chooser', () => {
  const collections = [
    { id: 'collection-eve', label: 'Eve' },
    { id: 'collection-project', label: '#Project' }
  ];
  const quilt = {
    id: 'quilt-a',
    title: 'Architecture',
    prompt: 'Open this shortcut with its standing guidance.',
    state: 'pinned' as const,
    pins: [],
    collections
  };
  const library = createPinsLibrary({
    quilts: [quilt],
    collections,
    activeTab: 'hotlink',
    activeCollectionId: null,
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined
  });
  expect([...library.querySelectorAll('.collection-filter .collection-chip')].map(node => node.textContent))
    .toEqual(['All Quilts', '#Eve', '#Project']);
  expect([...library.querySelectorAll('.quilt-card-tags .collection-tag')].map(node => node.textContent))
    .toEqual(['#Eve', '#Project']);
  expect(library.querySelector('.quilt-title-button')?.textContent).toBe('%Architecture');
  expect(library.querySelectorAll('.collection-chip')[1]?.getAttribute('aria-label')).toBe('Filter by Quilt #Eve');

  const detail = createQuiltDetail({
    quilt,
    sortKey: 'saved',
    sortDirection: 'desc',
    onBack: () => undefined,
    onStartChat: () => undefined,
    onSortChange: () => undefined,
    onSortDirectionChange: () => undefined
  });
  expect([...detail.querySelectorAll('.quilt-card-tags .collection-tag')].map(node => node.textContent))
    .toEqual(['#Eve', '#Project']);
  expect(detail.querySelector('h1')?.textContent).toBe('%Architecture');

  const chooser = createPinChooserDialog({
    source: { kind: 'message', excerpt: 'Keep this.' },
    quilts: [quilt],
    collections,
    onConfirm: () => undefined
  });
  expect([...chooser.querySelectorAll('.pin-quilt-choice-meta .collection-tag')].map(node => node.textContent))
    .toEqual(['#Eve', '#Project']);
  expect([...chooser.querySelectorAll('.pin-new-quilt-chip-list .collection-chip')].map(node => node.textContent))
    .toEqual(['#Eve', '#Project']);
  expect(chooser.querySelector('.pin-quilt-choice-text strong')?.textContent).toBe('%Architecture');

  const alreadyPrefixed = createPinChooserDialog({
    source: { kind: 'message', excerpt: 'Keep this too.' },
    quilts: [{ ...quilt, title: '%2.1.8' }],
    collections: [{ id: 'collection-eve', label: '#Eve' }],
    onConfirm: () => undefined
  });
  expect(alreadyPrefixed.querySelector('.pin-quilt-choice-text strong')?.textContent).toBe('%2.1.8');
  expect(alreadyPrefixed.querySelector('.pin-new-quilt-chip-list .collection-chip')?.textContent).toBe('#Eve');
});

it('renders pinned image thumbnails in Thread covers and detail with a graceful unavailable state', () => {
  const readyImage = { src: 'data:image/png;base64,YQ==', alt: 'diagram.png', state: 'ready' as const };
  const unavailableImage = { alt: 'missing.png', state: 'unavailable' as const };
  const library = createPinsLibrary({
    quilts: [{
      id: 'quilt-images',
      title: 'Visual notes',
      state: 'pinned',
      pins: [
        { id: 'pin-image', kind: 'message', image: readyImage },
        { id: 'pin-text', kind: 'message', excerpt: 'Text stays text.' }
      ],
      collections: []
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
    onDeleteQuilt: () => undefined
  });
  const imageTile = library.querySelector<HTMLElement>('.quilt-preview-tile[data-kind="message"]')!;
  expect(imageTile.querySelector<HTMLImageElement>('.quilt-preview-image')?.src).toBe(readyImage.src);
  expect(imageTile.querySelector<HTMLImageElement>('.quilt-preview-image')?.alt).toBe('diagram.png');
  expect(library.querySelectorAll('.quilt-preview-image')).toHaveLength(1);

  const detail = createQuiltDetail({
    quilt: {
      id: 'quilt-images',
      title: 'Visual notes',
      state: 'pinned',
      collections: [],
      pins: [
        { id: 'pin-image', kind: 'message', image: readyImage, savedAt: 2 },
        { id: 'pin-missing', kind: 'message', image: unavailableImage, savedAt: 1 },
        { id: 'pin-text', kind: 'message', excerpt: 'Text stays text.', savedAt: 0 }
      ]
    },
    sortKey: 'saved',
    sortDirection: 'desc',
    onBack: () => undefined,
    onStartChat: () => undefined,
    onSortChange: () => undefined,
    onSortDirectionChange: () => undefined
  });
  expect(detail.querySelector<HTMLImageElement>('[data-pin-id="pin-image"] .quilt-pin-image')?.src).toBe(readyImage.src);
  const fallback = detail.querySelector<HTMLElement>('[data-pin-id="pin-missing"] .quilt-pin-image-fallback')!;
  expect(fallback.textContent).toBe('Image unavailable');
  expect(fallback.getAttribute('aria-label')).toContain('missing.png');
  expect(detail.querySelector('[data-pin-id="pin-text"] .quilt-pin-media')).toBeNull();
  expect(detail.querySelector('[data-pin-id="pin-text"] .quilt-pin-primary')?.textContent).toBe('Text stays text.');
});

it('offers permanent delete only from archived Thread cards', () => {
  let repinned: string | null = null;
  let deleted: string | null = null;
  const root = createPinsLibrary({
    quilts: [{ id: 'quilt-old', title: 'Old receipts', state: 'archived', pins: [], collections: [] }],
    collections: [],
    activeTab: 'archived',
    activeCollectionId: null,
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: id => { repinned = id; },
    onDeleteQuilt: id => { deleted = id; }
  });

  const actions = [...root.querySelectorAll<HTMLButtonElement>('.quilt-card-action')];
  expect(actions.map(button => button.textContent)).toEqual(['Restore', 'Delete Thread']);
  expect(actions[0]?.getAttribute('aria-label')).toBe('Restore Thread Old receipts');
  expect(actions[1]?.getAttribute('aria-label')).toBe('Delete Thread Old receipts');
  expect(root.textContent).not.toContain('Archive Thread');
  actions[0]?.click();
  actions[1]?.click();
  expect(repinned).toBe('quilt-old');
  expect(deleted).toBe('quilt-old');
});

const sortablePins: QuiltPinDetailViewModel[] = [
  { id: 'a', kind: 'message', excerpt: 'A', sourceLabel: 'Chat alpha', sourceSessionId: 'session-alpha', savedAt: 300, sentAt: 100, contextAt: 10 },
  { id: 'b', kind: 'message', excerpt: 'B', sourceLabel: 'Chat beta', sourceSessionId: 'session-beta', savedAt: 100, sentAt: 300, contextAt: 20 },
  { id: 'c', kind: 'message', excerpt: 'C', sourceLabel: 'Chat alpha', sourceSessionId: 'session-alpha', savedAt: 200, sentAt: 200, contextAt: 10 },
  { id: 'd', kind: 'message', excerpt: 'Legacy unknown chronology', sourceLabel: 'Old chat', sourceSessionId: 'session-old', savedAt: 400 }
];

it('sorts Thread Pins by saved, sent, or context date in both directions', () => {
  const ids = (key: 'saved' | 'sent' | 'context', direction: 'asc' | 'desc') =>
    sortQuiltPins(sortablePins, key, direction).map(pin => pin.id);

  expect(ids('saved', 'asc')).toEqual(['b', 'c', 'a', 'd']);
  expect(ids('saved', 'desc')).toEqual(['d', 'a', 'c', 'b']);
  expect(ids('sent', 'asc')).toEqual(['a', 'c', 'b', 'd']);
  expect(ids('sent', 'desc')).toEqual(['b', 'c', 'a', 'd']);
  expect(ids('context', 'asc')).toEqual(['a', 'c', 'b', 'd']);
  expect(ids('context', 'desc')).toEqual(['b', 'c', 'a', 'd']);
});

it('keeps Prompt Pins at the top of a Thread while sorting the remaining Pins normally', () => {
  const pins: QuiltPinDetailViewModel[] = [
    { id: 'reply-newest', kind: 'message', excerpt: 'Reply', savedAt: 400, sentAt: 400, contextAt: 40 },
    { id: 'prompt', kind: 'prompt', excerpt: 'Prompt', savedAt: 100, sentAt: 100, contextAt: 10 },
    { id: 'result', kind: 'result', title: 'Result', savedAt: 200, sentAt: 200, contextAt: 20 }
  ];

  expect(sortQuiltPins(pins, 'saved', 'desc').map(pin => pin.id)).toEqual(['prompt', 'reply-newest', 'result']);
  expect(sortQuiltPins(pins, 'saved', 'asc').map(pin => pin.id)).toEqual(['prompt', 'result', 'reply-newest']);
  expect(sortQuiltPins(pins, 'sent', 'desc').map(pin => pin.id)[0]).toBe('prompt');
  expect(sortQuiltPins(pins, 'context', 'desc').map(pin => pin.id)[0]).toBe('prompt');
});

it('opens a Thread as a Pin list with context bands and interactive sort controls', () => {
  let sort: string | null = null;
  let direction: string | null = null;
  let openedSource: string | null = null;
  let removedPin: string | null = null;
  let archived = false;
  let deleted = false;
  let started: string | null = null;
  const root = createQuiltDetail({
    quilt: {
      id: 'quilt-a', title: 'Weekend reading', state: 'pinned', collections: [], pins: sortablePins
    },
    sortKey: 'context',
    sortDirection: 'asc',
    onBack: () => undefined,
    onStartChat: id => { started = id; },
    onArchiveQuilt: () => { archived = true; },
    onSortChange: value => { sort = value; },
    onSortDirectionChange: value => { direction = value; },
    onOpenSource: pin => { openedSource = pin.id; },
    onRemovePin: pin => { removedPin = pin.id; },
    onDeleteQuilt: () => { deleted = true; }
  });

  expect([...root.querySelectorAll<HTMLElement>('.quilt-context-band')].map(node => node.dataset.contextAt))
    .toEqual(['10', '20', 'unknown']);
  expect([...root.querySelectorAll<HTMLElement>('.quilt-context-band')].map(node => node.textContent))
    .toEqual(['Context · Chat alpha', 'Context · Chat beta', 'Context · Old chat']);
  expect([...root.querySelectorAll<HTMLElement>('.quilt-pin-row')].map(node => node.dataset.pinId))
    .toEqual(['a', 'c', 'b', 'd']);
  expect(root.querySelector<HTMLElement>('.quilt-pin-row[data-pin-id="a"] .quilt-pin-dates')?.textContent)
    .toContain('ContextChat alpha');
  expect(root.querySelector<HTMLElement>('.quilt-pin-row[data-pin-id="a"] .quilt-pin-dates')?.textContent)
    .not.toContain('Unknown');
  const start = root.querySelector<HTMLButtonElement>('.quilt-detail-chat-button')!;
  expect(start.textContent).toBe('Chat about this');
  expect(start.getAttribute('aria-label')).toBe('Start a chat about Weekend reading');
  start.click();
  expect(started).toBe('quilt-a');

  const sourceLink = root.querySelector<HTMLButtonElement>('.quilt-pin-row[data-pin-id="a"] .quilt-context-link');
  expect(sourceLink?.textContent).toBe('Chat alpha');
  sourceLink?.click();
  expect(openedSource).toBe('a');
  root.querySelector<HTMLButtonElement>('.quilt-pin-row[data-pin-id="a"] .quilt-pin-unpin')?.click();
  expect(removedPin).toBe('a');
  const archive = root.querySelector<HTMLButtonElement>('.quilt-archive-button')!;
  expect(archive.textContent).toBe('Archive');
  expect(archive.getAttribute('aria-label')).toBe('Archive Thread Weekend reading');
  expect(root.querySelector('.quilt-delete-button')).toBeNull();
  archive.click();
  expect(archived).toBe(true);
  expect(deleted).toBe(false);

  const select = root.querySelector<HTMLSelectElement>('.quilt-sort-select')!;
  select.value = 'sent';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  expect(sort).toBe('sent');
  root.querySelector<HTMLButtonElement>('.quilt-sort-direction')?.click();
  expect(direction).toBe('desc');
});

it('shows permanent Delete Thread only in an archived Thread detail', () => {
  let archived = false;
  let deleted = false;
  const root = createQuiltDetail({
    quilt: { id: 'quilt-old', title: 'Old receipts', state: 'archived', collections: [], pins: sortablePins },
    sortKey: 'saved',
    sortDirection: 'desc',
    onBack: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => { archived = true; },
    onSortChange: () => undefined,
    onSortDirectionChange: () => undefined,
    onDeleteQuilt: () => { deleted = true; }
  });

  expect(root.querySelector('.quilt-archive-button')).toBeNull();
  const remove = root.querySelector<HTMLButtonElement>('.quilt-delete-button')!;
  expect(remove.textContent).toBe('Delete Thread');
  expect(remove.getAttribute('aria-label')).toBe('Delete Thread Old receipts');
  remove.click();
  expect(deleted).toBe(true);
  expect(archived).toBe(false);
});

it('uses durable event sequence navigation to load and reveal the exact pinned source row', () => {
  const source = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8');
  expect(source).toContain('row.dataset.eventSeq = String(event.seq);');
  expect(source).toContain('await navigateHistory(eventSeq + 1);');
  expect(source).toContain("row.scrollIntoView({ block: 'center' });");
  expect(source).toContain('let historyFor: string | null = null;');
  expect(source).toContain('historyFor = before === null ? null : selected;');
  expect(source).toContain('historyBefore !== null && historyFor === wanted && !navigate');
  expect(source).toContain('historyBefore !== null && historyFor !== wanted');
  expect(source).toContain('if (detailFor === wanted) paintDetail(false);');
  expect(source).toContain("showView('timeline');");
  expect(source).toContain('agentFilter = null;');

  const start = source.indexOf('onWorkspaceNavigation(state => {');
  const end = source.indexOf('onPinStateChanged(() => {', start + 1);
  const listener = source.slice(start, end > start ? end : undefined);
  expect(listener).toContain('if (state.sessionId === selectedId)');
  expect(listener).toContain('void revealSourceEvent(state.eventSeq);');
  expect(listener).toContain('targetEventSeq: state.eventSeq');
});

it('edits a Thread title, description, optional Link destination, and Quilt names from the Thread detail', async () => {
  let saved: { title: string; description: string; link: string; collectionNames: string[] } | null = null;
  const root = createQuiltDetail({
    quilt: {
      id: 'quilt-a', title: 'Eve Architecture', state: 'pinned',
      description: 'How the pieces fit together.',
      collections: [{ id: 'collection-a', label: 'Research' }], pins: []
    },
    sortKey: 'saved',
    sortDirection: 'asc',
    onBack: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onSortChange: () => undefined,
    onSortDirectionChange: () => undefined,
    onSaveMetadata: value => { saved = value; }
  });
  const fields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.quilt-metadata-field input, .quilt-metadata-field textarea');
  const title = fields[0] as HTMLInputElement;
  const description = fields[1] as HTMLTextAreaElement;
  const link = fields[2] as HTMLInputElement;
  const collections = fields[3] as HTMLTextAreaElement;
  expect(description.closest('.quilt-metadata-description')).not.toBeNull();
  expect(description.rows).toBe(1);
  const stylesheet = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'pins-quilts.css'), 'utf8');
  expect(stylesheet).toMatch(/\.quilt-metadata-description textarea\s*\{[\s\S]*?height:\s*36px;[\s\S]*?min-height:\s*36px;[\s\S]*?\}/u);
  expect(stylesheet).toMatch(/\.quilt-metadata-form \.quilt-archive-button,[\s\S]*?\.quilt-metadata-form \.quilt-delete-button\s*\{[\s\S]*?min-height:\s*36px;[\s\S]*?white-space:\s*nowrap;/u);
  expect(link.closest('.quilt-metadata-link')).not.toBeNull();
  expect(collections.closest('.quilt-metadata-collections')).not.toBeNull();
  const form = root.querySelector<HTMLFormElement>('.quilt-metadata-form')!;
  const focusable = [...form.querySelectorAll<HTMLElement>('input, textarea, select, button')];
  expect(focusable.slice(0, 9).map(node => {
    if (node === title) return 'title';
    if (node === description) return 'description';
    if (node.classList.contains('quilt-metadata-save')) return 'save';
    if (node.classList.contains('quilt-detail-chat-button')) return 'chat';
    if (node === link) return 'link';
    if (node === collections) return 'quilts';
    if (node.classList.contains('quilt-sort-select')) return 'sort';
    if (node.classList.contains('quilt-sort-direction')) return 'direction';
    if (node.classList.contains('quilt-archive-button')) return 'archive';
    return 'other';
  })).toEqual(['title', 'description', 'save', 'chat', 'link', 'quilts', 'sort', 'direction', 'archive']);
  title.value = '%architecture';
  description.value = 'Architecture decisions, implementation notes, and review findings.';
  link.value = 'https://example.com/architecture';
  collections.value = '#Eve\n#Project';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  expect(saved).toEqual({
    title: '%architecture',
    description: 'Architecture decisions, implementation notes, and review findings.',
    link: 'https://example.com/architecture',
    collectionNames: ['#Eve', '#Project']
  });
});

it('turns Thread metadata Save green only while edits are unsaved and clears it after a successful save', async () => {
  let saved: { title: string; description: string; link: string; collectionNames: string[] } | null = null;
  const root = createQuiltDetail({
    quilt: {
      id: 'quilt-images',
      title: 'Images',
      description: 'Useful visual references.',
      state: 'pinned',
      collections: [{ id: 'collection-library', label: 'Library' }],
      pins: []
    },
    sortKey: 'saved',
    sortDirection: 'desc',
    onBack: () => undefined,
    onStartChat: () => undefined,
    onSortChange: () => undefined,
    onSortDirectionChange: () => undefined,
    onSaveMetadata: value => { saved = value; }
  });
  const save = root.querySelector<HTMLButtonElement>('.quilt-metadata-save')!;
  const startChat = root.querySelector<HTMLButtonElement>('.quilt-detail-chat-button')!;
  const description = root.querySelector<HTMLTextAreaElement>('.quilt-metadata-description textarea')!;
  const collections = root.querySelector<HTMLTextAreaElement>('.quilt-metadata-collections textarea')!;

  expect(save.dataset.dirty).toBe('false');
  expect(save.classList.contains('is-dirty')).toBe(false);
  expect(startChat.disabled).toBe(false);

  collections.value = 'Library\nReference';
  collections.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(save.dataset.dirty).toBe('true');
  expect(save.classList.contains('is-dirty')).toBe(true);
  expect(startChat.disabled).toBe(true);

  collections.value = 'Library';
  collections.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(save.dataset.dirty).toBe('false');
  expect(startChat.disabled).toBe(false);

  description.value = 'Useful visual references and screenshots.';
  description.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(save.classList.contains('is-dirty')).toBe(true);
  expect(startChat.disabled).toBe(true);
  save.click();
  await Promise.resolve();
  await Promise.resolve();

  expect(saved).toEqual({
    title: 'Images',
    description: 'Useful visual references and screenshots.',
    link: '',
    collectionNames: ['Library']
  });
  expect(save.dataset.dirty).toBe('false');
  expect(save.classList.contains('is-dirty')).toBe(false);
  expect(startChat.disabled).toBe(false);
});

it('keeps Chat about this disabled until both metadata and Prompt edits are saved or reverted', async () => {
  let savedPrompt = '';
  const root = createQuiltDetail({
    quilt: {
      id: 'concept-compose-dirty',
      title: 'Compose dirty state',
      description: 'Saved description.',
      prompt: 'Saved prompt.',
      state: 'pinned',
      collections: [],
      pins: []
    },
    sortKey: 'saved',
    sortDirection: 'desc',
    onBack: () => undefined,
    onStartChat: () => undefined,
    onSortChange: () => undefined,
    onSortDirectionChange: () => undefined,
    onSaveMetadata: () => undefined,
    onSavePrompt: value => { savedPrompt = value; }
  });
  const startChat = root.querySelector<HTMLButtonElement>('.quilt-detail-chat-button')!;
  const saveMetadata = root.querySelector<HTMLButtonElement>('.quilt-metadata-save')!;
  const description = root.querySelector<HTMLTextAreaElement>('.quilt-metadata-description textarea')!;
  const prompt = root.querySelector<HTMLTextAreaElement>('.thread-prompt-input')!;
  const savePrompt = root.querySelector<HTMLButtonElement>('.thread-prompt-save')!;

  description.value = 'Unsaved description.';
  description.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  prompt.value = 'Unsaved prompt.';
  prompt.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(startChat.disabled).toBe(true);

  description.value = 'Saved description.';
  description.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(startChat.disabled).toBe(true);
  prompt.value = 'Saved prompt.';
  prompt.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(startChat.disabled).toBe(false);

  description.value = 'Saved metadata update.';
  description.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  prompt.value = 'Saved prompt update.';
  prompt.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  saveMetadata.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(startChat.disabled).toBe(true);

  savePrompt.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(savedPrompt).toBe('Saved prompt update.');
  expect(startChat.disabled).toBe(false);
});

it('keeps Link orthogonal to zero-Pin type and delegates opening a Concept destination', () => {
  let opened = '';
  const root = createPinsLibrary({
    quilts: [{
      id: 'quilt-link',
      title: 'docs',
      description: 'Open the project documentation.',
      link: 'https://example.com/docs',
      state: 'pinned',
      pins: [],
      collections: []
    }],
    collections: [],
    activeTab: 'concept',
    activeCollectionId: null,
    onTabChange: () => undefined,
    onCollectionChange: () => undefined,
    onOpenQuilt: () => undefined,
    onStartChat: () => undefined,
    onArchiveQuilt: () => undefined,
    onRepinQuilt: () => undefined,
    onDeleteQuilt: () => undefined,
    onOpenDestination: quiltId => { opened = quiltId; }
  });
  expect(root.querySelector('[data-quilt-id="quilt-link"]')?.getAttribute('data-library-tab')).toBe('concept');
  const link = root.querySelector<HTMLButtonElement>('.quilt-hotlink-link')!;
  expect(link.textContent).toBe('https://example.com/docs');
  link.click();
  expect(opened).toBe('quilt-link');
});

it('starts the mandatory Thread chooser without an implicit existing destination', () => {
  const dialog = createPinChooserDialog({
    source: { kind: 'message', excerpt: 'A useful answer' },
    quilts: [{ id: 'quilt-a', title: 'Chosen intentionally', state: 'pinned', pins: [], collections: [] }],
    collections: [],
    onConfirm: () => undefined
  });

  expect(dialog.querySelector<HTMLInputElement>('input[name="pin-quilt-target"]')?.checked).toBe(false);
  expect(dialog.querySelector<HTMLButtonElement>('.pin-chooser-select')?.disabled).toBe(true);
  expect(dialog.querySelector<HTMLButtonElement>('.pin-chooser-create')?.disabled).toBe(true);
  expect(dialog.querySelector('.pin-chooser-actions')).toBeNull();
  expect(dialog.querySelector('h2')?.textContent).toBe('Pin to a Thread');
  expect([...dialog.querySelectorAll('.pin-chooser-section-title')].map(node => node.textContent))
    .toEqual(['Choose a Thread', 'Create new Thread']);
  expect(dialog.querySelector<HTMLButtonElement>('.pin-chooser-select')?.textContent).toBe('Select Thread');
  expect(dialog.querySelector<HTMLButtonElement>('.pin-chooser-create')?.textContent).toBe('Create Thread');
  expect(dialog.textContent).toContain('Every Pin belongs to one Thread.');
});

it('keeps Plan classification and source provenance visible in the compact pin summary', () => {
  const dialog = createPinChooserDialog({
    source: { kind: 'plan', title: 'Continue Debug Fix', sourceLabel: 'Plans' },
    quilts: [{
      id: 'quilt-a', title: '2.1.8', state: 'pinned', pins: [], collections: [], pinCount: 3
    }],
    collections: [],
    onConfirm: () => undefined
  });

  expect(dialog.querySelector('.pin-chooser-source strong')?.textContent).toBe('Continue Debug Fix');
  expect(dialog.querySelector('.pin-chooser-source-meta')?.textContent).toBe('Plan \u00b7 Plans');
  expect(dialog.querySelector('.pin-quilt-choice-text')?.textContent).toBe('%2.1.83 Pins');
});

it('keeps existing-Thread and create-Thread commits explicit when both areas contain input', async () => {
  let selectedTarget: unknown = null;
  const existingDialog = createPinChooserDialog({
    source: { kind: 'message', excerpt: 'A useful answer' },
    quilts: [{ id: 'quilt-a', title: 'Architecture', state: 'pinned', pins: [], collections: [] }],
    collections: [],
    onConfirm: target => {
      selectedTarget = target;
      return new Promise<void>(() => undefined);
    }
  });
  const existingRadio = existingDialog.querySelector<HTMLInputElement>('input[name="pin-quilt-target"]')!;
  existingRadio.checked = true;
  existingRadio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const existingName = existingDialog.querySelector<HTMLInputElement>('.pin-new-quilt-name input')!;
  existingName.value = 'New Architecture';
  existingName.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(existingDialog.querySelector<HTMLButtonElement>('.pin-chooser-select')?.disabled).toBe(false);
  expect(existingDialog.querySelector<HTMLButtonElement>('.pin-chooser-create')?.disabled).toBe(false);
  existingDialog.querySelector<HTMLButtonElement>('.pin-chooser-select')!.click();
  await Promise.resolve();
  expect(selectedTarget).toEqual({ mode: 'existing', quiltId: 'quilt-a' });

  let createdTarget: unknown = null;
  const createDialog = createPinChooserDialog({
    source: { kind: 'message', excerpt: 'A useful answer' },
    quilts: [{ id: 'quilt-a', title: 'Architecture', state: 'pinned', pins: [], collections: [] }],
    collections: [{ id: 'collection-a', label: 'Eve' }],
    onConfirm: target => {
      createdTarget = target;
      return new Promise<void>(() => undefined);
    }
  });
  const createRadio = createDialog.querySelector<HTMLInputElement>('input[name="pin-quilt-target"]')!;
  createRadio.checked = true;
  createRadio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const createName = createDialog.querySelector<HTMLInputElement>('.pin-new-quilt-name input')!;
  createName.value = '2.2.1';
  createName.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  createDialog.querySelector<HTMLButtonElement>('.pin-chooser-create')!.click();
  await Promise.resolve();
  expect(createdTarget).toEqual({ mode: 'new', title: '2.2.1', collectionIds: [] });
});

it('keeps the conversation list as the direct route back to Chat from Pins and Plans', () => {
  const source = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'main.ts'), 'utf8');
  expect(source).toContain("document.querySelector<HTMLElement>('.sidebar-sessions')!.hidden = settings;");
  expect(source).toContain("$('workspaceQuickRow').hidden = settings;");
  expect(source).toContain("navigateWorkspace({ screen: 'chat', sessionId: row.dataset.id });");
  expect(source).toContain("$('newChat').addEventListener('click', () => showTab('chat'));");
});

it('keeps authored chat messages state-backed Pin/Unpin surfaces, including non-final assistant rows', () => {
  const source = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8');
  const start = source.indexOf('function pinActionForEvent(');
  const end = source.indexOf('\nfunction ', start + 1);
  const pinAction = source.slice(start, end > start ? end : undefined);

  expect(start).toBeGreaterThan(0);
  expect(pinAction).toContain("event.kind === 'assistant_message'");
  expect(pinAction).toContain("event.kind === 'user_message'");
  const assistantBranch = pinAction.slice(
    pinAction.indexOf("event.kind === 'assistant_message'"),
    pinAction.indexOf("event.kind === 'user_message'")
  );
  const userBranch = pinAction.slice(pinAction.indexOf("event.kind === 'user_message'"), pinAction.indexOf("event.kind === 'tool_call'"));
  expect(assistantBranch).toContain("kind: 'message'");
  expect(assistantBranch).not.toContain("kind: 'prompt'");
  expect(userBranch).toContain("kind: 'prompt'");
  expect(pinAction).not.toContain('event.final');
  expect(pinAction).toContain('pinStateForDraft(draft!)');
  expect(pinAction).toContain('togglePinTarget(draft!)');
  expect(source).toContain('onPinStateChanged(() => {');
  expect(source).toContain('rowCache.clear();');
});

it('repaints Plans when the durable Pins snapshot changes', () => {
  const source = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'workspace-library.ts'), 'utf8');
  const start = source.indexOf('export async function refreshPinsSurface');
  const end = source.indexOf('\nexport async function refreshPlansSurface', start + 1);
  const refreshPins = source.slice(start, end > start ? end : undefined);

  expect(start).toBeGreaterThan(0);
  expect(refreshPins).toContain('if (pinsRevision(snapshot) !== previousRevision) {');
  expect(refreshPins).toContain('paintPlans();');
  expect(refreshPins).toContain('notifyPinStateChanged();');
});

it('refreshes open Plans and Pins surfaces when source-session activity changes', () => {
  const source = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'workspace-library.ts'), 'utf8');
  const start = source.indexOf('window.api.onSessionChanged(() => {');
  const end = source.indexOf('window.api.onPinsChanged', start + 1);
  const listener = source.slice(start, end > start ? end : undefined);

  expect(start).toBeGreaterThan(0);
  expect(listener).toContain("screen === 'plans' || screen === 'pins'");
  expect(listener).toContain('refreshPlansSurface()');
});
