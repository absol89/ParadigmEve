import { el, icon } from './dom.js';
import { t } from './i18n.js';
import {
  CONCEPT_PIN_PREVIEW_DENSITIES,
  DEFAULT_CONCEPT_PREVIEW_SETTINGS,
  type ConceptPinPreviewDensity,
  type ConceptPreviewSettings,
  type ConceptPreviewTextSize
} from '../shared/concept-settings.js';

export type PinKind = 'prompt' | 'message' | 'result' | 'plan';
export type QuiltLibraryTab = 'pinned' | 'hotlink' | 'concept' | 'archived';
export type PinsObjectKind = 'thread' | 'hotlink' | 'concept';
export type QuiltCardState = 'pinned' | 'archived';
export const QUILT_PIN_PREVIEW_DENSITIES = CONCEPT_PIN_PREVIEW_DENSITIES;
export type QuiltPinPreviewDensity = ConceptPinPreviewDensity;
export type QuiltSortKey = 'saved' | 'sent' | 'context';
export type QuiltSortDirection = 'asc' | 'desc';

const PLAN_PRIORITY_LABEL: Record<'low' | 'medium' | 'high', string> = {
  low: 'Low priority',
  medium: 'Medium priority',
  high: 'High priority'
};

export interface CollectionChipViewModel {
  id: string;
  label: string;
  count?: number;
}

export interface QuiltPinImageViewModel {
  src?: string;
  alt: string;
  state: 'loading' | 'ready' | 'unavailable';
}

export interface QuiltPinPreviewViewModel {
  id: string;
  kind: PinKind;
  /** Heart-selected emphasis inside this Thread only. */
  sticky?: boolean;
  title?: string;
  excerpt?: string;
  sourceLabel?: string;
  image?: QuiltPinImageViewModel;
}

export interface QuiltPinDetailViewModel extends QuiltPinPreviewViewModel {
  savedAt: number;
  sentAt?: number;
  contextAt?: number;
  sourceSessionId?: string;
  sourceEventSeq?: number;
  plan?: {
    items: readonly {
      id: string;
      title: string;
      status: 'todo' | 'in_progress' | 'done';
      priority?: 'low' | 'medium' | 'high';
      relation?: 'current' | 'next';
    }[];
  };
}

export interface QuiltCardViewModel {
  id: string;
  title: string;
  description?: string;
  link?: string;
  prompt?: string;
  state: QuiltCardState;
  pins: readonly QuiltPinPreviewViewModel[];
  collections: readonly CollectionChipViewModel[];
  pinCount?: number;
  updatedLabel?: string;
  /** Presentation-only visibility for Prompt/Message text in this card's Pin preview. */
  messagePreviewsVisible?: boolean;
}

export type QuiltDetailViewModel = Omit<QuiltCardViewModel, 'pins'> & {
  pins: readonly QuiltPinDetailViewModel[];
};

export interface PinsQuiltsLabels {
  title: string;
  subtitle: string;
  pinned: string;
  hotlink: string;
  concept: string;
  archived: string;
  allCollections: string;
  noPinnedTitle: string;
  noPinnedBody: string;
  noHotlinkTitle: string;
  noHotlinkBody: string;
  noConceptTitle: string;
  noConceptBody: string;
  noArchivedTitle: string;
  noArchivedBody: string;
  noFilteredTitle: string;
  noFilteredBody: string;
  pinsCount: (count: number) => string;
  archive: string;
  archiveQuilt: string;
  repin: string;
  archiveQuiltAbout: (title: string) => string;
  repinQuiltAbout: (title: string) => string;
  openQuilt: (title: string) => string;
  hideMessagePreviews: (title: string) => string;
  showMessagePreviews: (title: string) => string;
  startChat: string;
  chatAboutThisQuilt: string;
  startChatAbout: (title: string) => string;
  filterCollection: (label: string) => string;
  prompt: string;
  message: string;
  result: string;
  plan: string;
  chooserTitle: string;
  chooserBody: string;
  chooseExisting: string;
  createNew: string;
  newQuiltName: string;
  newQuiltPlaceholder: string;
  threadDescription: string;
  threadDescriptionPlaceholder: string;
  generateDescription: string;
  collectionsForNewQuilt: string;
  noQuiltsAvailable: string;
  cancel: string;
  selectQuilt: string;
  createQuilt: string;
  selectedPin: string;
  backToQuilts: string;
  sortBy: string;
  dateSaved: string;
  dateSent: string;
  dateContext: string;
  ascending: string;
  descending: string;
  saved: string;
  sent: string;
  context: string;
  unknownDate: string;
  resolvingDates: string;
  save: string;
  create: string;
  saveRequiresName: string;
  requiresUniqueName: string;
  saveThread: string;
  saveHotlink: string;
  saveConcept: string;
  threadPrompt: string;
  threadPromptHelp: string;
  threadPromptPlaceholder: string;
  savePrompt: string;
  unpin: string;
  deleteQuilt: string;
}

function defaultLabels(): PinsQuiltsLabels {
  return {
    title: t('Pins'),
    subtitle: t('Gather useful things into groups so they stay connected to what they came from.\n%Threads have message pins, %Hotlinks have no pins, #Concepts use no prompt.'),
    pinned: `%${t('Threads')}`,
    hotlink: `%${t('Hotlinks')}`,
    concept: t('#Concepts'),
    archived: t('Archived'),
    allCollections: t('All Quilts'),
    noPinnedTitle: t('No Threads yet'),
    noPinnedBody: t('Pin a message, plan, or result and choose the Thread where it belongs.'),
    noHotlinkTitle: t('No Hotlinks yet'),
    noHotlinkBody: t('Prompted shortcuts without Pins live here for quick reuse.'),
    noConceptTitle: t('No Concepts yet'),
    noConceptBody: t('Promptless items without Pins collect here as lightweight concepts and labels.'),
    noArchivedTitle: t('No archived Threads'),
    noArchivedBody: t('Finished Threads can move here without losing their Pins or provenance.'),
    noFilteredTitle: t('No Threads in this Quilt'),
    noFilteredBody: t('Choose another Quilt or add this Quilt to a Thread.'),
    pinsCount: count => t(count === 1 ? '{0} Pin' : '{0} Pins', [count]),
    archive: t('Archive'),
    archiveQuilt: t('Archive Thread'),
    repin: t('Restore'),
    archiveQuiltAbout: title => t('Archive Thread {0}', [title]),
    repinQuiltAbout: title => t('Restore Thread {0}', [title]),
    openQuilt: title => t('Open Thread {0}', [title]),
    hideMessagePreviews: title => t('Hide pinned message text previews for Thread {0}', [title]),
    showMessagePreviews: title => t('Show pinned message text previews for Thread {0}', [title]),
    startChat: t('Start chat'),
    chatAboutThisQuilt: t('Chat about this'),
    startChatAbout: title => t('Start a chat about {0}', [title]),
    filterCollection: label => t('Filter by Quilt {0}', [label]),
    prompt: t('Prompt'),
    message: t('Message'),
    result: t('Result'),
    plan: t('Plan'),
    chooserTitle: t('Pin to a Thread'),
    chooserBody: t('Every Pin belongs to one Thread. Choose an existing Thread or create a new one.'),
    chooseExisting: t('Choose a Thread'),
    createNew: t('Create new Thread'),
    newQuiltName: t('Name'),
    newQuiltPlaceholder: t('What connects these things?'),
    threadDescription: t('Description'),
    threadDescriptionPlaceholder: t('A short description shown on the card.'),
    generateDescription: t('Create\ndescription'),
    collectionsForNewQuilt: t('Quilts'),
    noQuiltsAvailable: t('No active Threads are available yet. Create one below.'),
    cancel: t('Cancel'),
    selectQuilt: t('Select Thread'),
    createQuilt: t('Create Thread'),
    selectedPin: t('You are pinning'),
    backToQuilts: t('Back to overview'),
    sortBy: t('Sort by'),
    dateSaved: t('Date saved'),
    dateSent: t('Date sent'),
    dateContext: t('Date of context'),
    ascending: t('Ascending'),
    descending: t('Descending'),
    saved: t('Saved'),
    sent: t('Sent'),
    context: t('Context'),
    unknownDate: t('Unknown'),
    resolvingDates: t('Resolving dates from older Pins…'),
    save: t('Save'),
    create: t('Create'),
    saveRequiresName: t('Save requires name'),
    requiresUniqueName: t('Requires unique name'),
    saveThread: t('Save Thread'),
    saveHotlink: t('Save Hotlink'),
    saveConcept: t('Save Concept'),
    threadPrompt: t('Prompt'),
    threadPromptHelp: t('What should Eve know or do when chatting about this? Filling this in will turn the save button to Save Hotlink.'),
    threadPromptPlaceholder: t('What should Eve know or do when chatting about this?'),
    savePrompt: t('Save prompt'),
    unpin: t('Unpin'),
    deleteQuilt: t('Delete Thread')
  };
}

let chooserId = 0;

export interface PinsLibraryProps {
  quilts: readonly QuiltCardViewModel[];
  collections: readonly CollectionChipViewModel[];
  activeTab: QuiltLibraryTab;
  /** Number of rows/columns used by the square sticky Pin preview mosaic. */
  previewDensity?: QuiltPinPreviewDensity;
  /** Durable presentation choices for the #Concepts overview. */
  conceptPreviewSettings?: ConceptPreviewSettings;
  /** New multi-select form; activeCollectionId remains a compatibility input for focused callers/tests. */
  activeCollectionIds?: readonly string[];
  activeCollectionId: string | null;
  activeConceptId?: string | null;
  labels?: Partial<PinsQuiltsLabels>;
  onTabChange: (tab: QuiltLibraryTab) => void;
  onCollectionChange: (collectionId: string | null) => void;
  onConceptChange?: (conceptId: string | null) => void;
  onOpenQuilt: (quiltId: string) => void;
  onStartChat: (quiltId: string) => void;
  onArchiveQuilt: (quiltId: string) => void;
  onRepinQuilt: (quiltId: string) => void;
  onDeleteQuilt: (quiltId: string) => void;
  onToggleMessagePreviews?: (quiltId: string, visible: boolean) => void;
  onOpenDestination?: (quiltId: string) => void;
  onCreate?: () => void;
  onGenerateDescription?: (quiltId: string) => void;
}

export interface PinsCreateDraft {
  title: string;
  description: string;
  link: string;
  collectionNames: string[];
  prompt: string;
}

export interface PinsCreateViewProps {
  labels?: Partial<PinsQuiltsLabels>;
  existingThreadTitles?: readonly string[];
  onBack: () => void;
  onSave: (draft: PinsCreateDraft) => void | Promise<void>;
}

function conceptPreviewFontSize(size: ConceptPreviewTextSize): string {
  return size === 'small' ? '10.5px' : size === 'large' ? '13px' : '11.5px';
}

export interface QuiltDetailProps {
  quilt: QuiltDetailViewModel;
  sortKey: QuiltSortKey;
  sortDirection: QuiltSortDirection;
  resolvingChronology?: boolean;
  labels?: Partial<PinsQuiltsLabels>;
  onBack: () => void;
  onStartChat: (quiltId: string) => void;
  onArchiveQuilt?: () => void | Promise<void>;
  onSortChange: (sortKey: QuiltSortKey) => void;
  onSortDirectionChange: (direction: QuiltSortDirection) => void;
  onOpenSource?: (pin: QuiltPinDetailViewModel) => void;
  onRemovePin?: (pin: QuiltPinDetailViewModel) => void | Promise<void>;
  onSetPinSticky?: (pin: QuiltPinDetailViewModel, sticky: boolean) => void | Promise<void>;
  onDeleteQuilt?: () => void | Promise<void>;
  onSaveMetadata?: (metadata: { title: string; description: string; link: string; collectionNames: string[] }) => void | Promise<void>;
  onSavePrompt?: (prompt: string) => void | Promise<void>;
}

export type PinChooserTarget =
  | { mode: 'existing'; quiltId: string }
  | { mode: 'new'; title: string; collectionIds: string[] };

export interface PinChooserSourceViewModel {
  kind: PinKind;
  title?: string;
  excerpt?: string;
  sourceLabel?: string;
}

export interface PinChooserDialogProps {
  source: PinChooserSourceViewModel;
  quilts: readonly QuiltCardViewModel[];
  collections: readonly CollectionChipViewModel[];
  labels?: Partial<PinsQuiltsLabels>;
  initialQuiltId?: string | null;
  onConfirm: (target: PinChooserTarget) => void | Promise<void>;
  onCancel?: () => void;
}

function labels(overrides?: Partial<PinsQuiltsLabels>): PinsQuiltsLabels {
  return { ...defaultLabels(), ...overrides };
}

function textButton(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', className, text) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function quiltReferenceLabel(label: string): string {
  return label.startsWith('#') ? label : `#${label}`;
}

function threadTitleLabel(title: string): string {
  return `%${title.replace(/^[%#]/u, '')}`;
}

function pinsObjectTitleLabel(title: string, pinCount: number, prompt?: string): string {
  const bare = title.replace(/^[%#]/u, '');
  return pinsObjectKind(pinCount, prompt) === 'concept' ? `#${bare}` : `%${bare}`;
}

function tabButton(
  label: string,
  count: number,
  active: boolean,
  onClick: () => void
): HTMLButtonElement {
  const button = textButton('pins-tab', '', onClick);
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-selected', String(active));
  button.classList.toggle('is-active', active);
  button.append(el('span', '', label), el('span', 'pins-tab-count', String(count)));
  return button;
}

function collectionButton(
  chip: CollectionChipViewModel | null,
  active: boolean,
  copy: PinsQuiltsLabels,
  onClick: () => void
): HTMLButtonElement {
  const label = chip ? quiltReferenceLabel(chip.label) : copy.allCollections;
  const button = textButton('collection-chip', label, onClick);
  button.classList.toggle('is-active', active);
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', chip ? copy.filterCollection(label) : copy.allCollections);
  if (chip?.count !== undefined) button.append(el('span', 'collection-chip-count', String(chip.count)));
  return button;
}

function pinKindLabel(kind: PinKind, copy: PinsQuiltsLabels): string {
  if (kind === 'prompt') return copy.prompt;
  if (kind === 'message') return copy.message;
  if (kind === 'result') return copy.result;
  return copy.plan;
}

function previewTile(
  pin: QuiltPinPreviewViewModel | null,
  index: number,
  density: QuiltPinPreviewDensity,
  copy: PinsQuiltsLabels,
  showMessageText: boolean,
  forceSplitImageMessage = false
): HTMLElement {
  const tile = el('div', 'quilt-preview-tile');
  tile.dataset.checker = String(index % 2);
  if (!pin) {
    tile.classList.add('is-placeholder');
    tile.setAttribute('aria-hidden', 'true');
    tile.append(el('span', 'quilt-preview-plus', '+'));
    return tile;
  }
  tile.dataset.kind = pin.kind;
  // Prompt/message titles are intentionally generic ("Your message" / "ChatGPT reply"). The Quilt
  // mosaic should answer "what did I pin?", so those tiles lead with their saved excerpt while
  // result/plan tiles keep their more specific titles.
  const preview = pin.kind === 'prompt' || pin.kind === 'message' ? pin.excerpt ?? pin.title : pin.title ?? pin.excerpt;
  const messageTextVisible = (pin.kind !== 'prompt' && pin.kind !== 'message') || showMessageText;
  const splitImageMessage = (density === 1 || forceSplitImageMessage) &&
    pin.sticky === true &&
    Boolean(pin.image && preview && messageTextVisible);
  tile.dataset.sticky = String(pin.sticky === true);
  if (pin.image) {
    tile.classList.add('has-image');
    tile.classList.add(splitImageMessage ? 'is-split-preview' : 'is-image-thumbnail');
    if (pin.image.src) {
      const image = document.createElement('img');
      image.className = 'quilt-preview-image';
      image.src = pin.image.src;
      image.alt = pin.image.alt;
      image.loading = 'lazy';
      tile.append(image);
    } else {
      const fallback = el('span', 'quilt-preview-image-fallback', pin.image.state === 'unavailable' ? t('Image unavailable') : '');
      fallback.setAttribute('role', 'img');
      fallback.setAttribute('aria-label', pin.image.state === 'unavailable' ? `${pin.image.alt} · ${t('Image unavailable')}` : pin.image.alt);
      if (pin.image.state === 'loading') fallback.setAttribute('aria-busy', 'true');
      tile.append(fallback);
    }
  }
  tile.title = [pinKindLabel(pin.kind, copy), messageTextVisible ? preview : undefined, pin.sourceLabel].filter(Boolean).join(' · ');
  tile.append(el('span', 'quilt-preview-kind', pinKindLabel(pin.kind, copy)));
  // Image Pins use the image itself as their ordinary thumbnail. Emphasized layouts can instead
  // reserve a full top half for the image and a full bottom half for the paired saved message.
  if (preview && messageTextVisible && (!pin.image || splitImageMessage)) tile.append(el('span', 'quilt-preview-text', preview));
  return tile;
}

function quiltCover(
  quilt: QuiltCardViewModel,
  density: QuiltPinPreviewDensity,
  copy: PinsQuiltsLabels,
  showMessageText: boolean,
  onOpen: () => void
): HTMLButtonElement {
  const cover = textButton('quilt-cover', '', onOpen);
  cover.setAttribute('aria-label', copy.openQuilt(quilt.title));
  cover.dataset.previewDensity = String(density);
  cover.style.setProperty('--quilt-preview-density', String(density));
  const previewSlots = density * density;
  const previews = quilt.pins
    .map((pin, index) => ({ pin, index }))
    .sort((left, right) => {
      if (left.pin.sticky !== right.pin.sticky) return left.pin.sticky ? -1 : 1;
      if (left.pin.kind === 'prompt' && right.pin.kind !== 'prompt') return -1;
      if (left.pin.kind !== 'prompt' && right.pin.kind === 'prompt') return 1;
      return left.index - right.index;
    })
    .slice(0, previewSlots)
    .map(({ pin }) => pin);
  const emphasized = previews[0];
  const emphasizedText = emphasized && (emphasized.kind === 'prompt' || emphasized.kind === 'message')
    ? emphasized.excerpt ?? emphasized.title
    : emphasized?.title ?? emphasized?.excerpt;
  if (density === 2 &&
      emphasized?.sticky === true &&
      emphasized.image &&
      emphasizedText &&
      showMessageText) {
    // In the 2×2 design one Heart-selected image+message is one emphasized composition, not four
    // copies of the Pin: the image spans the full top row and its saved text spans the full bottom.
    const tile = previewTile(emphasized, 0, density, copy, showMessageText, true);
    tile.classList.add('is-2x2-emphasis');
    tile.style.gridColumn = '1 / -1';
    tile.style.gridRow = '1 / -1';
    cover.append(tile);
    return cover;
  }
  for (let index = 0; index < previewSlots; index++) {
    cover.append(previewTile(previews[index] ?? null, index, density, copy, showMessageText));
  }
  return cover;
}

export function pinsObjectKind(pinCount: number, prompt?: string): PinsObjectKind {
  if (pinCount > 0) return 'thread';
  return prompt?.trim() ? 'hotlink' : 'concept';
}

function threadNameKey(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith('%') ? trimmed.slice(1) : trimmed).normalize('NFKC').toLocaleLowerCase();
}

function libraryTabFor(quilt: QuiltCardViewModel): QuiltLibraryTab {
  if (quilt.state === 'archived') return 'archived';
  const kind = pinsObjectKind(quilt.pinCount ?? quilt.pins.length, quilt.prompt);
  return kind === 'thread' ? 'pinned' : kind;
}

function quiltCard(
  quilt: QuiltCardViewModel,
  copy: PinsQuiltsLabels,
  props: PinsLibraryProps,
  conceptOverview = false
): HTMLElement {
  const card = el('article', 'quilt-card');
  const conceptPreview = props.conceptPreviewSettings ?? DEFAULT_CONCEPT_PREVIEW_SETTINGS;
  const libraryTab = libraryTabFor(quilt);
  card.dataset.quiltId = quilt.id;
  card.dataset.state = quilt.state;
  card.dataset.libraryTab = libraryTab;
  const compactShortcut = conceptOverview || libraryTab === 'hotlink' || libraryTab === 'concept';
  // The Concepts overview stays compact for description/prompt-only cards, but a Thread that
  // actually owns Pins must still expose its configured sticky-preview mosaic there.
  const showPinPreview = !compactShortcut || (conceptOverview && quilt.pins.length > 0);
  const messagePreviewsVisible = quilt.messagePreviewsVisible !== false;
  const hasMessagePreviewText = showPinPreview && quilt.pins.some(pin =>
    (pin.kind === 'prompt' || pin.kind === 'message') && Boolean(pin.excerpt ?? pin.title)
  );
  card.classList.toggle('is-hotlink', compactShortcut);
  card.classList.toggle('is-concept', libraryTab === 'concept');
  card.classList.toggle('is-concept-overview', conceptOverview);
  if (showPinPreview) {
    card.append(quiltCover(
      quilt,
      props.previewDensity ?? conceptPreview.pinPreviewDensity,
      copy,
      messagePreviewsVisible,
      () => props.onOpenQuilt(quilt.id)
    ));
  }

  const meta = el('div', 'quilt-card-meta');
  const titleRow = el('div', 'quilt-card-title-row');
  const displayTitle = pinsObjectTitleLabel(quilt.title, quilt.pinCount ?? quilt.pins.length, quilt.prompt);
  const openTitle = textButton('quilt-title-button', displayTitle, () => props.onOpenQuilt(quilt.id));
  if (quilt.prompt) openTitle.title = quilt.prompt;
  titleRow.append(openTitle);
  const actions = el('div', 'quilt-card-actions');
  if (hasMessagePreviewText && props.onToggleMessagePreviews) {
    const label = messagePreviewsVisible
      ? copy.hideMessagePreviews(quilt.title)
      : copy.showMessagePreviews(quilt.title);
    const privacy = textButton('quilt-card-action quilt-card-preview-privacy', '', () =>
      props.onToggleMessagePreviews?.(quilt.id, !messagePreviewsVisible));
    privacy.setAttribute('aria-pressed', String(messagePreviewsVisible));
    privacy.setAttribute('aria-label', label);
    privacy.title = label;
    privacy.append(icon(messagePreviewsVisible ? 'i-eye' : 'i-eye-off', 'ico quilt-card-preview-icon'));
    actions.append(privacy);
  }
  if (quilt.state === 'archived') {
    const repin = textButton('quilt-card-action', copy.repin, () => props.onRepinQuilt(quilt.id));
    repin.setAttribute('aria-label', copy.repinQuiltAbout(quilt.title));
    const remove = textButton('quilt-card-action quilt-card-delete-action', copy.deleteQuilt, () => props.onDeleteQuilt(quilt.id));
    remove.setAttribute('aria-label', t('Delete Thread {0}', [quilt.title]));
    actions.append(repin, remove);
  } else {
    const archive = textButton('quilt-card-action', copy.archive, () => props.onArchiveQuilt(quilt.id));
    archive.setAttribute('aria-label', copy.archiveQuiltAbout(quilt.title));
    actions.append(archive);
  }
  titleRow.append(actions);
  meta.append(titleRow);
  if (compactShortcut) {
    const summary = el('div', 'quilt-hotlink-summary');
    if (quilt.description) {
      const description = el('p', 'quilt-hotlink-description', quilt.description);
      description.title = quilt.description;
      if (conceptOverview) {
        const descriptionSlot = el('div', 'quilt-hotlink-description-slot');
        const descriptionSize = conceptPreviewFontSize(conceptPreview.descriptionTextSize);
        descriptionSlot.style.fontSize = descriptionSize;
        descriptionSlot.style.height = `${conceptPreview.descriptionRows * 1.45}em`;
        description.style.fontSize = descriptionSize;
        description.style.setProperty('-webkit-line-clamp', String(conceptPreview.descriptionRows));
        descriptionSlot.append(description);
        summary.append(descriptionSlot);
      } else {
        summary.append(description);
      }
    } else if (conceptOverview && props.onGenerateDescription) {
      const descriptionSlot = el('div', 'quilt-hotlink-description-slot');
      descriptionSlot.style.fontSize = conceptPreviewFontSize(conceptPreview.descriptionTextSize);
      descriptionSlot.style.height = `${conceptPreview.descriptionRows * 1.45}em`;
      descriptionSlot.append(textButton(
        'quilt-concept-description-cta',
        copy.generateDescription,
        () => props.onGenerateDescription?.(quilt.id)
      ));
      summary.append(descriptionSlot);
    }
    if (quilt.prompt) {
      const prompt = el('p', 'quilt-hotlink-prompt', quilt.prompt);
      prompt.title = quilt.prompt;
      if (conceptOverview) {
        prompt.style.fontSize = conceptPreviewFontSize(conceptPreview.promptTextSize);
        prompt.style.setProperty('-webkit-line-clamp', String(conceptPreview.promptRows));
      }
      summary.append(prompt);
    }
    if (quilt.link) {
      const openLink = textButton('quilt-hotlink-link', quilt.link, () => props.onOpenDestination?.(quilt.id));
      openLink.title = quilt.link;
      openLink.setAttribute('aria-label', t('Open destination {0}', [quilt.link]));
      summary.append(openLink);
    }
    if (summary.childElementCount) meta.append(summary);
  } else if (quilt.description) {
    meta.append(el('p', 'quilt-card-description', quilt.description));
  } else if (props.onGenerateDescription) {
    const descriptionSlot = el('div', 'quilt-card-description-cta-slot');
    descriptionSlot.append(textButton(
      'quilt-concept-description-cta',
      copy.generateDescription,
      () => props.onGenerateDescription?.(quilt.id)
    ));
    meta.append(descriptionSlot);
  }

  const tags = el('div', 'quilt-card-tags');
  for (const collection of quilt.collections) tags.append(el('span', 'collection-tag', quiltReferenceLabel(collection.label)));
  if (!quilt.collections.length) {
    const addToQuilt = textButton(
      'collection-tag quilt-card-add-quilt',
      t('Add to #Quilt'),
      () => props.onOpenQuilt(quilt.id)
    );
    addToQuilt.setAttribute('aria-label', t('Add to #Quilt'));
    tags.append(addToQuilt);
  }
  meta.append(tags);

  const startChat = textButton('quilt-chat-button', copy.startChat, () => props.onStartChat(quilt.id));
  startChat.setAttribute('aria-label', copy.startChatAbout(quilt.title));
  startChat.title = copy.startChatAbout(quilt.title);
  meta.append(startChat);

  const foot = el('div', 'quilt-card-foot');
  if (!compactShortcut) foot.append(el('span', '', copy.pinsCount(quilt.pinCount ?? quilt.pins.length)));
  if (quilt.updatedLabel) foot.append(el('span', '', quilt.updatedLabel));
  meta.append(foot);
  card.append(meta);
  return card;
}

/** Pure renderer view. State and persistence stay with the caller. */
export function createPinsLibrary(props: PinsLibraryProps): HTMLElement {
  const copy = labels(props.labels);
  const conceptPreview = props.conceptPreviewSettings ?? DEFAULT_CONCEPT_PREVIEW_SETTINGS;
  const root = el('section', 'pins-library');
  const activeCollectionIds = new Set(
    props.activeCollectionIds ?? (props.activeCollectionId ? [props.activeCollectionId] : [])
  );
  root.setAttribute('aria-label', copy.title);

  const head = el('div', 'pins-library-head');
  const identity = el('div', 'pins-library-identity');
  const intro = el('div', 'pins-library-intro');
  intro.append(el('h1', '', copy.title), el('p', '', copy.subtitle));
  identity.append(icon('i-pins-heart-memo', 'pins-library-icon'), intro);
  head.append(identity);
  if (props.onCreate) {
    const create = textButton('pins-library-create', copy.create, props.onCreate);
    create.setAttribute('aria-label', t('Create a new Pins item'));
    head.append(create);
  }
  root.append(head);

  const pinnedCount = props.quilts.filter(quilt => libraryTabFor(quilt) === 'pinned').length;
  const hotlinkCount = props.quilts.filter(quilt => libraryTabFor(quilt) === 'hotlink').length;
  const conceptCount = props.quilts.filter(quilt => libraryTabFor(quilt) === 'concept').length;
  const archivedCount = props.quilts.filter(quilt => libraryTabFor(quilt) === 'archived').length;
  const tabs = el('div', 'pins-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.append(
    tabButton(copy.hotlink, hotlinkCount, props.activeTab === 'hotlink', () => props.onTabChange('hotlink')),
    tabButton(copy.pinned, pinnedCount, props.activeTab === 'pinned', () => props.onTabChange('pinned')),
    tabButton(copy.concept, conceptCount, props.activeTab === 'concept', () => props.onTabChange('concept')),
    tabButton(copy.archived, archivedCount, props.activeTab === 'archived', () => props.onTabChange('archived'))
  );
  root.append(tabs);

  if (props.collections.length || (props.activeTab === 'concept' && props.activeConceptId)) {
    const filters = el('div', 'collection-filter');
    filters.setAttribute('aria-label', copy.collectionsForNewQuilt);
    if (props.activeTab === 'concept') {
      // Pills are a fixed one-line control, so a row count can stay stable across widths.
      // Keep overflow scrollable rather than making clipped buttons keyboard-focusable offscreen.
      filters.classList.add('concept-collection-filter');
      filters.dataset.maxRows = String(conceptPreview.quiltRows);
      filters.style.maxHeight = `${conceptPreview.quiltRows * 29 + Math.max(0, conceptPreview.quiltRows - 1) * 7}px`;
      filters.style.overflowY = 'auto';
    }
    if (props.activeTab === 'concept' && props.activeConceptId) {
      const selectedConcept = props.quilts.find(quilt => quilt.id === props.activeConceptId);
      if (selectedConcept) {
        const chip = collectionButton(
          { id: selectedConcept.id, label: selectedConcept.title, count: 1 },
          true,
          copy,
          () => props.onConceptChange?.(null)
        );
        chip.classList.add('concept-filter-chip');
        chip.querySelector('.collection-chip-count')?.remove();
        filters.append(chip);
      }
    }
    filters.append(collectionButton(
      null,
      activeCollectionIds.size === 0 && !props.activeConceptId,
      copy,
      () => props.onCollectionChange(null)
    ));
    for (const collection of props.collections) {
      filters.append(collectionButton(
        collection,
        activeCollectionIds.has(collection.id),
        copy,
        () => props.onCollectionChange(collection.id)
      ));
    }
    root.append(filters);
  }

  const hasFilters = activeCollectionIds.size > 0 || (props.activeTab === 'concept' && Boolean(props.activeConceptId));
  const visible = props.quilts.filter(quilt => {
    if (props.activeTab === 'concept') {
      if (quilt.state === 'archived') return false;
      if (props.activeConceptId === quilt.id) return libraryTabFor(quilt) === 'concept';
      if (activeCollectionIds.size > 0) {
        return quilt.collections.some(collection => activeCollectionIds.has(collection.id));
      }
      if (props.activeConceptId) return false;
      return libraryTabFor(quilt) === 'concept';
    }
    if (libraryTabFor(quilt) !== props.activeTab) return false;
    if (!hasFilters) return true;
    return quilt.collections.some(collection => activeCollectionIds.has(collection.id));
  });
  const grid = el('div', 'quilt-grid');
  grid.setAttribute('role', 'tabpanel');
  if (visible.length) {
    for (const quilt of visible) grid.append(quiltCard(quilt, copy, props, props.activeTab === 'concept'));
  } else {
    const filtered = hasFilters;
    const title = filtered
      ? copy.noFilteredTitle
      : props.activeTab === 'pinned' ? copy.noPinnedTitle
        : props.activeTab === 'hotlink' ? copy.noHotlinkTitle
          : props.activeTab === 'concept' ? copy.noConceptTitle
          : copy.noArchivedTitle;
    const body = filtered
      ? copy.noFilteredBody
      : props.activeTab === 'pinned' ? copy.noPinnedBody
        : props.activeTab === 'hotlink' ? copy.noHotlinkBody
          : props.activeTab === 'concept' ? copy.noConceptBody
          : copy.noArchivedBody;
    const empty = el('div', 'pins-empty');
    empty.append(el('strong', '', title), el('p', '', body));
    grid.append(empty);
  }
  root.append(grid);
  return root;
}

function sortTimestamp(pin: QuiltPinDetailViewModel, key: QuiltSortKey): number | undefined {
  if (key === 'saved') return pin.savedAt;
  if (key === 'sent') return pin.sentAt;
  return pin.contextAt;
}

/**
 * Stable Quilt ordering. Unknown legacy chronology is always kept at the end rather than
 * pretending the save date was the send/context date. Context ties use the source timestamp so
 * all Pins from one chat stay together and retain a useful reading order inside that band.
 */
export function sortQuiltPins(
  pins: readonly QuiltPinDetailViewModel[],
  key: QuiltSortKey,
  direction: QuiltSortDirection
): QuiltPinDetailViewModel[] {
  const sign = direction === 'asc' ? 1 : -1;
  const original = new Map(pins.map((pin, index) => [pin.id, index]));
  return [...pins].sort((left, right) => {
    if (left.kind === 'prompt' && right.kind !== 'prompt') return -1;
    if (left.kind !== 'prompt' && right.kind === 'prompt') return 1;
    const a = sortTimestamp(left, key);
    const b = sortTimestamp(right, key);
    if (a === undefined || b === undefined) {
      if (a === undefined && b === undefined) return (original.get(left.id) ?? 0) - (original.get(right.id) ?? 0);
      return a === undefined ? 1 : -1;
    }
    if (a !== b) return (a - b) * sign;

    if (key === 'context') {
      const aSent = left.sentAt;
      const bSent = right.sentAt;
      if (aSent !== undefined && bSent !== undefined && aSent !== bSent) return (aSent - bSent) * sign;
      if (aSent === undefined && bSent !== undefined) return 1;
      if (aSent !== undefined && bSent === undefined) return -1;
    }
    if (left.savedAt !== right.savedAt) return (left.savedAt - right.savedAt) * sign;
    return (original.get(left.id) ?? 0) - (original.get(right.id) ?? 0);
  });
}

function quiltDate(timestamp: number | undefined, copy: PinsQuiltsLabels): string {
  if (timestamp === undefined) return copy.unknownDate;
  const date = new Date(timestamp);
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  const day = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' as const } : {})
  }).format(date);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
  return t('{0} at {1}', [day, time]);
}

function pinDate(label: string, timestamp: number | undefined, copy: PinsQuiltsLabels): HTMLElement {
  const item = el('span', 'quilt-pin-date');
  item.append(el('span', 'quilt-pin-date-label', label), el('span', '', quiltDate(timestamp, copy)));
  return item;
}

function pinContextName(pin: QuiltPinDetailViewModel): string {
  return pin.sourceLabel?.trim() || t('Source chat');
}

function pinContext(
  label: string,
  pin: QuiltPinDetailViewModel,
  onOpenSource?: (pin: QuiltPinDetailViewModel) => void
): HTMLElement {
  const item = el('span', 'quilt-pin-date');
  item.append(el('span', 'quilt-pin-date-label', label));
  const name = pinContextName(pin);
  if (pin.sourceSessionId && onOpenSource) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'quilt-context-link';
    link.textContent = name;
    link.title = t('Open {0}', [name]);
    link.addEventListener('click', () => onOpenSource(pin));
    item.append(link);
  } else {
    item.append(el('span', '', name));
  }
  return item;
}

function quiltPinRow(
  pin: QuiltPinDetailViewModel,
  copy: PinsQuiltsLabels,
  onOpenSource?: (pin: QuiltPinDetailViewModel) => void,
  onRemovePin?: (pin: QuiltPinDetailViewModel) => void | Promise<void>,
  onSetPinSticky?: (pin: QuiltPinDetailViewModel, sticky: boolean) => void | Promise<void>
): HTMLElement {
  const row = el('article', 'quilt-pin-row');
  row.dataset.pinId = pin.id;
  row.dataset.kind = pin.kind;
  row.dataset.savedAt = String(pin.savedAt);
  if (pin.sentAt !== undefined) row.dataset.sentAt = String(pin.sentAt);
  if (pin.contextAt !== undefined) row.dataset.contextAt = String(pin.contextAt);

  const top = el('div', 'quilt-pin-row-top');
  top.append(el('span', 'quilt-pin-kind', pinKindLabel(pin.kind, copy)));
  if (pin.sourceLabel) top.append(el('span', 'quilt-pin-source', pin.sourceLabel));
  let stickyHeart: HTMLButtonElement | null = null;
  if ((pin.kind === 'prompt' || pin.kind === 'message' || pin.kind === 'plan') && onSetPinSticky) {
    const sticky = pin.sticky === true;
    const heart = textButton('quilt-pin-sticky', sticky ? '♥' : '♡', () => {
      void onSetPinSticky(pin, !sticky);
    });
    heart.setAttribute('aria-pressed', String(sticky));
    heart.setAttribute('aria-label', t(sticky ? 'Remove sticky preview emphasis' : 'Use as a sticky preview'));
    heart.title = t(sticky ? 'Remove sticky preview emphasis' : 'Use as a sticky preview');
    stickyHeart = heart;
  }
  if (onRemovePin) {
    const unpin = textButton('quilt-pin-unpin', copy.unpin, () => { void onRemovePin(pin); });
    unpin.setAttribute('aria-label', t('Unpin this item'));
    top.append(unpin);
  }
  if (stickyHeart) top.append(stickyHeart);
  row.append(top);

  if (pin.image) {
    const media = el('div', 'quilt-pin-media');
    if (pin.image.src) {
      const image = document.createElement('img');
      image.className = 'quilt-pin-image';
      image.src = pin.image.src;
      image.alt = pin.image.alt;
      image.loading = 'lazy';
      media.append(image);
    } else {
      const fallback = el('div', 'quilt-pin-image-fallback', pin.image.state === 'unavailable' ? t('Image unavailable') : '');
      fallback.setAttribute('role', 'img');
      fallback.setAttribute('aria-label', pin.image.state === 'unavailable' ? `${pin.image.alt} · ${t('Image unavailable')}` : pin.image.alt);
      if (pin.image.state === 'loading') fallback.setAttribute('aria-busy', 'true');
      media.append(fallback);
    }
    row.append(media);
  }

  const messageLike = pin.kind === 'prompt' || pin.kind === 'message';
  const primary = messageLike ? pin.excerpt ?? pin.title : pin.title ?? pin.excerpt;
  const secondary = !messageLike && pin.title && pin.excerpt && primary !== pin.excerpt
    ? pin.excerpt : undefined;
  if (primary) row.append(el('p', 'quilt-pin-primary', primary));
  if (secondary) row.append(el('p', 'quilt-pin-secondary', secondary));
  if (pin.kind === 'plan' && pin.plan) {
    const list = document.createElement('ol');
    list.className = 'quilt-pin-plan';
    for (const item of pin.plan.items) {
      const line = document.createElement('li');
      line.className = 'quilt-pin-plan-item';
      line.dataset.status = item.status;
      if (item.relation) line.dataset.relation = item.relation;
      if (item.priority) line.dataset.priority = item.priority;
      const marker = el('span', 'quilt-pin-plan-marker');
      marker.setAttribute('aria-hidden', 'true');
      marker.textContent = item.status === 'done' ? '✓' : item.status === 'in_progress' ? '•' : '○';
      const title = el('span', 'quilt-pin-plan-title', item.title);
      title.dir = 'auto';
      line.append(marker, title);
      if (item.relation) {
        line.append(el('span', `quilt-pin-plan-relation is-${item.relation}`, () => t(item.relation === 'current' ? 'Current' : 'Next')));
      }
      const priority = item.priority;
      if (priority) line.append(el('span', `quilt-pin-plan-priority is-${priority}`, () => t(PLAN_PRIORITY_LABEL[priority])));
      list.append(line);
    }
    row.append(list);
  }

  const dates = el('div', 'quilt-pin-dates');
  dates.append(pinDate(copy.saved, pin.savedAt, copy));
  if (pin.sentAt !== undefined) dates.append(pinDate(copy.sent, pin.sentAt, copy));
  dates.append(pinContext(copy.context, pin, onOpenSource));
  row.append(dates);
  return row;
}

function sortSelect(props: QuiltDetailProps, copy: PinsQuiltsLabels): HTMLLabelElement {
  const label = el('label', 'quilt-sort-field') as HTMLLabelElement;
  label.append(el('span', '', copy.sortBy));
  const select = document.createElement('select');
  select.className = 'quilt-sort-select';
  const options: Array<[QuiltSortKey, string]> = [
    ['saved', copy.dateSaved],
    ['sent', copy.dateSent],
    ['context', copy.dateContext]
  ];
  for (const [value, text] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    option.selected = value === props.sortKey;
    select.append(option);
  }
  select.addEventListener('change', () => props.onSortChange(select.value as QuiltSortKey));
  label.append(select);
  return label;
}

/** Blank local editor for a not-yet-durable Pins item. One Save atomically creates it. */
export function createPinsCreateView(props: PinsCreateViewProps): HTMLElement {
  const copy = labels(props.labels);
  const root = el('section', 'pins-library quilt-detail pins-create-detail');
  root.append(textButton('quilt-back-button', '← ' + copy.backToQuilts, props.onBack));

  const head = el('div', 'quilt-detail-head');
  const intro = el('div', 'quilt-detail-intro');
  const titleBlock = el('div', 'quilt-detail-title-block');
  titleBlock.append(el('h1', '', copy.create));
  intro.append(titleBlock);

  const form = document.createElement('form');
  form.className = 'quilt-metadata-form pins-create-form';
  const titleField = el('label', 'quilt-metadata-field quilt-metadata-title') as HTMLLabelElement;
  titleField.append(el('span', '', copy.newQuiltName));
  const title = document.createElement('input');
  title.type = 'text';
  title.maxLength = 120;
  title.required = true;
  title.placeholder = copy.newQuiltPlaceholder;
  titleField.append(title);

  const descriptionField = el('label', 'quilt-metadata-field quilt-metadata-description') as HTMLLabelElement;
  descriptionField.append(el('span', '', copy.threadDescription));
  const description = document.createElement('textarea');
  description.rows = 1;
  description.maxLength = 1_000;
  description.placeholder = copy.threadDescriptionPlaceholder;
  descriptionField.append(description);

  const linkField = el('label', 'quilt-metadata-field quilt-metadata-link') as HTMLLabelElement;
  linkField.append(el('span', '', t('Destination link')));
  const link = document.createElement('input');
  link.type = 'text';
  link.maxLength = 8_192;
  link.placeholder = t('Opens Thread edit view by default · add https://… or C:\\… to override');
  linkField.append(link);

  const collectionsField = el('label', 'quilt-metadata-field quilt-metadata-collections') as HTMLLabelElement;
  collectionsField.append(el('span', '', copy.collectionsForNewQuilt));
  const collections = document.createElement('textarea');
  collections.rows = 1;
  collections.maxLength = 4_000;
  collectionsField.append(collections);

  const promptCard = el('section', 'thread-prompt-card pins-create-prompt-card');
  const promptTitle = el('div', 'thread-prompt-title');
  promptTitle.append(
    el('span', 'quilt-pin-kind', copy.threadPrompt),
    el('span', 'thread-prompt-help', copy.threadPromptHelp)
  );
  const prompt = document.createElement('textarea');
  prompt.className = 'thread-prompt-input';
  prompt.rows = 4;
  prompt.maxLength = 16_000;
  prompt.placeholder = copy.threadPromptPlaceholder;
  prompt.setAttribute('aria-label', copy.threadPrompt);
  promptCard.append(promptTitle, prompt);

  const save = textButton('quilt-metadata-save pins-create-save', copy.saveRequiresName, () => form.requestSubmit());
  let saving = false;
  const paintKind = (): void => {
    const hasName = Boolean(title.value.trim());
    const nameKey = threadNameKey(title.value);
    const duplicateName = hasName && (props.existingThreadTitles ?? [])
      .some(existing => threadNameKey(existing) === nameKey);
    const kind = pinsObjectKind(0, prompt.value);
    save.textContent = !hasName
      ? copy.saveRequiresName
      : duplicateName
        ? copy.requiresUniqueName
      : kind === 'hotlink'
        ? copy.saveHotlink
        : kind === 'thread'
          ? copy.saveThread
          : copy.saveConcept;
    save.disabled = saving || !hasName || duplicateName;
    save.classList.toggle('is-dirty', hasName && !duplicateName && Boolean(
      title.value.trim() || description.value.trim() || link.value.trim() ||
      collections.value.trim() || prompt.value.trim()
    ));
  };
  for (const field of [title, description, link, collections, prompt]) field.addEventListener('input', paintKind);
  paintKind();

  form.append(titleField, descriptionField, save, linkField, collectionsField);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (save.disabled) return;
    const draft: PinsCreateDraft = {
      title: title.value.trim(),
      description: description.value.trim(),
      link: link.value.trim(),
      collectionNames: collections.value.split(/\r?\n/u).map(value => value.trim()).filter(Boolean),
      prompt: prompt.value
    };
    saving = true;
    paintKind();
    void Promise.resolve(props.onSave(draft)).finally(() => {
      saving = false;
      paintKind();
    });
  });

  intro.append(form);
  head.append(intro);
  root.append(head, promptCard);
  return root;
}

/** Full Quilt contents view opened from either the mosaic or title. */
export function createQuiltDetail(props: QuiltDetailProps): HTMLElement {
  const copy = labels(props.labels);
  const root = el('section', 'pins-library quilt-detail');
  root.dataset.quiltId = props.quilt.id;

  const back = textButton('quilt-back-button', `← ${copy.backToQuilts}`, props.onBack);
  root.append(back);

  const head = el('div', 'quilt-detail-head');
  const intro = el('div', 'quilt-detail-intro');
  const titleBlock = el('div', 'quilt-detail-title-block');
  const heading = el('h1', '', pinsObjectTitleLabel(props.quilt.title, props.quilt.pins.length, props.quilt.prompt));
  if (props.quilt.prompt) heading.title = props.quilt.prompt;
  titleBlock.append(heading);
  if (props.quilt.description) titleBlock.append(el('p', '', props.quilt.description));
  const tags = el('div', 'quilt-card-tags');
  for (const collection of props.quilt.collections) tags.append(el('span', 'collection-tag', quiltReferenceLabel(collection.label)));
  if (props.quilt.collections.length) titleBlock.append(tags);

  const startChat = textButton('quilt-chat-button quilt-detail-chat-button', copy.chatAboutThisQuilt, () => props.onStartChat(props.quilt.id));
  startChat.setAttribute('aria-label', copy.startChatAbout(props.quilt.title));
  startChat.title = copy.startChatAbout(props.quilt.title);
  let metadataDirty = false;
  let promptDirty = false;
  const paintStartChatAvailability = (): void => {
    startChat.disabled = metadataDirty || promptDirty;
  };
  intro.append(titleBlock);

  const sort = sortSelect(props, copy);
  const direction = textButton(
    'quilt-sort-direction',
    props.sortDirection === 'asc' ? `↑ ${copy.ascending}` : `↓ ${copy.descending}`,
    () => props.onSortDirectionChange(props.sortDirection === 'asc' ? 'desc' : 'asc')
  );
  direction.setAttribute('aria-label', props.sortDirection === 'asc' ? copy.ascending : copy.descending);

  let threadStateAction: HTMLButtonElement | null = null;
  if (props.quilt.state === 'pinned' && props.onArchiveQuilt) {
    threadStateAction = textButton('quilt-archive-button', copy.archive, () => { void props.onArchiveQuilt!(); });
    threadStateAction.setAttribute('aria-label', copy.archiveQuiltAbout(props.quilt.title));
  } else if (props.quilt.state === 'archived' && props.onDeleteQuilt) {
    threadStateAction = textButton('quilt-delete-button', copy.deleteQuilt, () => { void props.onDeleteQuilt!(); });
    threadStateAction.setAttribute('aria-label', t('Delete Thread {0}', [props.quilt.title]));
  }
  if (props.onSaveMetadata) {
    const form = document.createElement('form');
    form.className = 'quilt-metadata-form';

    const titleField = el('label', 'quilt-metadata-field quilt-metadata-title') as HTMLLabelElement;
    titleField.append(el('span', '', copy.newQuiltName));
    const title = document.createElement('input');
    title.type = 'text';
    title.maxLength = 120;
    title.value = props.quilt.title;
    titleField.append(title);

    const descriptionField = el('label', 'quilt-metadata-field quilt-metadata-description') as HTMLLabelElement;
    descriptionField.append(el('span', '', copy.threadDescription));
    const description = document.createElement('textarea');
    description.rows = 1;
    description.maxLength = 1_000;
    description.value = props.quilt.description ?? '';
    description.placeholder = copy.threadDescriptionPlaceholder;
    descriptionField.append(description);

    const linkField = el('label', 'quilt-metadata-field quilt-metadata-link') as HTMLLabelElement;
    linkField.append(el('span', '', t('Destination link')));
    const link = document.createElement('input');
    link.type = 'text';
    link.maxLength = 8_192;
    link.value = props.quilt.link ?? '';
    link.placeholder = t('Opens Thread edit view by default · add https://… or C:\\… to override');
    linkField.append(link);

    const collectionsField = el('label', 'quilt-metadata-field quilt-metadata-collections') as HTMLLabelElement;
    collectionsField.append(el('span', '', copy.collectionsForNewQuilt));
    const collections = document.createElement('textarea');
    collections.rows = Math.max(1, Math.min(3, props.quilt.collections.length || 1));
    collections.maxLength = 4_000;
    collections.value = props.quilt.collections.map(collection => collection.label).join('\n');
    collectionsField.append(collections);

    const save = textButton('quilt-metadata-save', copy.save, () => { form.requestSubmit(); });
    type ThreadMetadataDraft = { title: string; description: string; link: string; collectionNames: string[] };
    const readMetadataDraft = (): ThreadMetadataDraft => ({
      title: title.value.trim(),
      description: description.value.trim(),
      link: link.value.trim(),
      collectionNames: collections.value.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)
    });
    let savedMetadata: ThreadMetadataDraft = readMetadataDraft();
    const metadataMatches = (left: ThreadMetadataDraft, right: ThreadMetadataDraft): boolean =>
      left.title === right.title &&
      left.description === right.description &&
      left.link === right.link &&
      left.collectionNames.length === right.collectionNames.length &&
      left.collectionNames.every((value, index) => value === right.collectionNames[index]);
    const paintMetadataDirtyState = (): void => {
      metadataDirty = !metadataMatches(readMetadataDraft(), savedMetadata);
      save.classList.toggle('is-dirty', metadataDirty);
      save.dataset.dirty = String(metadataDirty);
      paintStartChatAvailability();
    };
    for (const field of [title, description, link, collections]) {
      field.addEventListener('input', paintMetadataDirtyState);
    }
    paintMetadataDirtyState();
    // DOM order is the intended keyboard workflow: title, description, save,
    // start chat, optional destination link, Quilts, sort, direction, then archive/delete.
    form.append(titleField, descriptionField, save, startChat, linkField, collectionsField, sort, direction);
    if (threadStateAction) form.append(threadStateAction);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const metadata = readMetadataDraft();
      if (!metadata.title || save.disabled) return;
      save.disabled = true;
      void Promise.resolve(props.onSaveMetadata!(metadata))
        .then(() => {
          savedMetadata = {
            ...metadata,
            collectionNames: [...metadata.collectionNames]
          };
          paintMetadataDirtyState();
        })
        .finally(() => { save.disabled = false; });
    });
    intro.append(form);
  } else {
    const controls = el('div', 'quilt-detail-actions');
    controls.append(startChat, sort, direction);
    if (threadStateAction) controls.append(threadStateAction);
    intro.append(controls);
  }
  head.append(intro);
  root.append(head);

  if (props.onSavePrompt) {
    const promptCard = el('section', 'thread-prompt-card');
    const promptHead = el('div', 'thread-prompt-head');
    const promptTitle = el('div', 'thread-prompt-title');
    promptTitle.append(
      el('span', 'quilt-pin-kind', copy.threadPrompt),
      el('span', 'thread-prompt-help', copy.threadPromptHelp)
    );
    promptHead.append(promptTitle);

    const prompt = document.createElement('textarea');
    prompt.className = 'thread-prompt-input';
    prompt.rows = Math.max(3, Math.min(8, (props.quilt.prompt?.split(/\r?\n/u).length ?? 3)));
    prompt.maxLength = 16_000;
    prompt.value = props.quilt.prompt ?? '';
    prompt.placeholder = copy.threadPromptPlaceholder;
    prompt.setAttribute('aria-label', copy.threadPrompt);

    let savedPrompt = prompt.value;
    const savePrompt = textButton('thread-prompt-save', copy.savePrompt, () => {
      if (savePrompt.disabled) return;
      const promptValue = prompt.value;
      savePrompt.disabled = true;
      void Promise.resolve(props.onSavePrompt!(promptValue))
        .then(() => {
          savedPrompt = promptValue;
          paintPromptState();
        })
        .finally(() => { savePrompt.disabled = false; });
    });
    const paintPromptState = (): void => {
      if (props.quilt.pins.length > 0) savePrompt.textContent = copy.savePrompt;
      else savePrompt.textContent = pinsObjectKind(0, prompt.value) === 'hotlink' ? copy.saveHotlink : copy.saveConcept;
      promptDirty = prompt.value !== savedPrompt;
      paintStartChatAvailability();
    };
    prompt.addEventListener('input', paintPromptState);
    paintPromptState();
    promptHead.append(savePrompt);
    promptCard.append(promptHead, prompt);
    root.append(promptCard);
  }

  const summary = el('div', 'quilt-detail-summary');
  summary.classList.toggle('is-empty', props.quilt.pins.length === 0);
  summary.append(el('span', '', copy.pinsCount(props.quilt.pins.length)));
  if (props.resolvingChronology) summary.append(el('span', 'quilt-date-resolution', copy.resolvingDates));
  root.append(summary);

  const list = el('div', 'quilt-pin-list');
  const ordered = sortQuiltPins(props.quilt.pins, props.sortKey, props.sortDirection);
  const stickyCopies = ordered.filter(pin => (pin.kind === 'message' || pin.kind === 'plan') && pin.sticky === true);
  let stickyCopiesRendered = false;
  const appendStickyCopies = (): void => {
    if (stickyCopiesRendered) return;
    stickyCopiesRendered = true;
    for (const pin of stickyCopies) {
      const promoted = quiltPinRow(pin, copy, props.onOpenSource, props.onRemovePin, props.onSetPinSticky);
      promoted.classList.add('is-sticky-copy');
      promoted.dataset.stickyCopy = 'true';
      list.append(promoted);
    }
  };
  if (!ordered.some(pin => pin.kind === 'prompt')) appendStickyCopies();
  let contextBand: string | null = null;
  for (const pin of ordered) {
    const bandKey = pin.contextAt === undefined
      ? `source:${pinContextName(pin)}`
      : `time:${pin.contextAt}`;
    if (props.sortKey === 'context' && bandKey !== contextBand) {
      contextBand = bandKey;
      const band = el('div', 'quilt-context-band');
      band.dataset.contextAt = pin.contextAt === undefined ? 'unknown' : String(pin.contextAt);
      band.textContent = `${copy.context} · ${pinContextName(pin)}`;
      list.append(band);
    }
    list.append(quiltPinRow(pin, copy, props.onOpenSource, props.onRemovePin, props.onSetPinSticky));
    if (pin.kind === 'prompt') appendStickyCopies();
  }
  if (!ordered.length) {
    const empty = el('div', 'pins-empty');
    empty.append(el('strong', '', copy.pinsCount(0)));
    list.append(empty);
  }
  root.append(list);
  return root;
}

function chooserSource(source: PinChooserSourceViewModel, copy: PinsQuiltsLabels): HTMLElement {
  const box = el('div', 'pin-chooser-source');
  box.append(el('span', 'pin-chooser-source-label', copy.selectedPin));
  const title = source.title ?? source.excerpt ?? pinKindLabel(source.kind, copy);
  box.append(el('strong', '', title));
  const detail = [pinKindLabel(source.kind, copy), source.sourceLabel].filter(Boolean).join(' · ');
  if (detail) box.append(el('span', 'pin-chooser-source-meta', detail));
  return box;
}

function chooserQuiltRow(
  quilt: QuiltCardViewModel,
  selected: boolean,
  copy: PinsQuiltsLabels,
  onSelect: () => void
): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = el('label', 'pin-quilt-choice') as HTMLLabelElement;
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'pin-quilt-target';
  input.value = quilt.id;
  input.checked = selected;
  input.addEventListener('change', onSelect);
  const text = el('span', 'pin-quilt-choice-text');
  const title = el('strong', '', threadTitleLabel(quilt.title));
  if (quilt.prompt) title.title = quilt.prompt;
  text.append(title);
  const meta = el('span', 'pin-quilt-choice-meta');
  meta.append(el('span', '', copy.pinsCount(quilt.pinCount ?? quilt.pins.length)));
  for (const collection of quilt.collections.slice(0, 3)) meta.append(el('span', 'collection-tag', quiltReferenceLabel(collection.label)));
  text.append(meta);
  row.append(input, text);
  return { row, input };
}

/**
 * Mandatory Pin target chooser. `onConfirm` cannot fire without exactly one existing Quilt
 * or a non-empty new Quilt name, so callers never receive an orphan-Pin target.
 */
export function createPinChooserDialog(props: PinChooserDialogProps): HTMLDialogElement {
  const copy = labels(props.labels);
  const dialog = document.createElement('dialog');
  dialog.className = 'pin-chooser-dialog';
  const titleId = `pinChooserTitle-${++chooserId}`;
  dialog.setAttribute('aria-labelledby', titleId);

  let cancelNotified = false;
  const notifyCancel = () => {
    if (cancelNotified) return;
    cancelNotified = true;
    props.onCancel?.();
  };

  const head = el('div', 'pin-chooser-head');
  const headText = el('div', 'pin-chooser-head-text');
  const title = el('h2', '', copy.chooserTitle); title.id = titleId;
  headText.append(title, el('p', '', copy.chooserBody));
  const cancel = textButton('pin-chooser-cancel', copy.cancel, () => {
    notifyCancel();
    dialog.close('cancel');
  });
  head.append(headText, cancel);
  dialog.append(head, chooserSource(props.source, copy));

  const body = el('div', 'pin-chooser-body');
  const availableQuilts = props.quilts.filter(quilt => quilt.state === 'pinned');
  let selectedId = availableQuilts.some(quilt => quilt.id === props.initialQuiltId) ? props.initialQuiltId ?? null : null;
  const choiceInputs: HTMLInputElement[] = [];
  const selectedCollections = new Set<string>();
  let committing = false;

  const existing = el('section', 'pin-chooser-section');
  const existingHead = el('div', 'pin-chooser-section-head');
  existingHead.append(el('span', 'pin-chooser-section-title', copy.chooseExisting));
  const selectQuilt = textButton('pin-chooser-commit pin-chooser-select', copy.selectQuilt, () => { void commitExisting(); });
  existingHead.append(selectQuilt);
  existing.append(existingHead);
  const existingList = el('div', 'pin-quilt-list');
  if (availableQuilts.length) {
    for (const quilt of availableQuilts) {
      const choice = chooserQuiltRow(quilt, quilt.id === selectedId, copy, () => {
        selectedId = quilt.id;
        sync();
      });
      choiceInputs.push(choice.input);
      existingList.append(choice.row);
    }
  } else {
    existingList.append(el('p', 'pin-chooser-empty', copy.noQuiltsAvailable));
  }
  existing.append(existingList);
  body.append(existing);

  const create = el('section', 'pin-chooser-section');
  const createHead = el('div', 'pin-chooser-section-head');
  createHead.append(el('span', 'pin-chooser-section-title', copy.createNew));
  create.append(createHead);
  const newFields = el('div', 'pin-new-quilt-fields');
  const nameRow = el('div', 'pin-new-quilt-name-row');
  const nameLabel = el('label', 'pin-new-quilt-name');
  nameLabel.append(el('span', '', copy.newQuiltName));
  const name = document.createElement('input');
  name.type = 'text';
  name.maxLength = 120;
  name.placeholder = copy.newQuiltPlaceholder;
  name.addEventListener('input', sync);
  nameLabel.append(name);
  const createQuilt = textButton('pin-chooser-commit pin-chooser-create', copy.createQuilt, () => { void commitNew(); });
  nameRow.append(nameLabel, createQuilt);
  newFields.append(nameRow);
  if (props.collections.length) {
    const collections = el('div', 'pin-new-quilt-collections');
    collections.append(el('span', 'pin-new-quilt-collections-label', copy.collectionsForNewQuilt));
    const chips = el('div', 'pin-new-quilt-chip-list');
    for (const collection of props.collections) {
      const chip = textButton('collection-chip', quiltReferenceLabel(collection.label), () => {
        if (selectedCollections.has(collection.id)) selectedCollections.delete(collection.id);
        else selectedCollections.add(collection.id);
        chip.classList.toggle('is-active', selectedCollections.has(collection.id));
        chip.setAttribute('aria-pressed', String(selectedCollections.has(collection.id)));
      });
      chip.setAttribute('aria-pressed', 'false');
      chips.append(chip);
    }
    collections.append(chips);
    newFields.append(collections);
  }
  create.append(newFields);
  body.append(create);
  dialog.append(body);

  function sync(): void {
    for (const input of choiceInputs) input.checked = input.value === selectedId;
    existing.classList.toggle('is-active', selectedId !== null);
    create.classList.toggle('is-active', name.value.trim().length > 0);
    selectQuilt.disabled = committing || selectedId === null;
    createQuilt.disabled = committing || name.value.trim().length === 0;
  }

  async function commitExisting(): Promise<void> {
    if (committing || !selectedId) return;
    committing = true;
    sync();
    try {
      await props.onConfirm({ mode: 'existing', quiltId: selectedId });
      dialog.close('confirmed');
    } finally {
      committing = false;
      if (dialog.open) sync();
    }
  }

  async function commitNew(): Promise<void> {
    const titleValue = name.value.trim();
    if (committing || !titleValue) return;
    committing = true;
    sync();
    try {
      await props.onConfirm({ mode: 'new', title: titleValue, collectionIds: [...selectedCollections] });
      dialog.close('confirmed');
    } finally {
      committing = false;
      if (dialog.open) sync();
    }
  }

  dialog.addEventListener('cancel', notifyCancel);
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'confirmed') notifyCancel();
  });
  sync();
  return dialog;
}

/** Append and open a chooser in one call; the caller still owns persistence through callbacks. */
export function showPinChooserDialog(props: PinChooserDialogProps): HTMLDialogElement {
  const dialog = createPinChooserDialog(props);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  return dialog;
}
