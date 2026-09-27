import {
  pinSourceKey,
  type CreatePinInput,
  type MessagePinProvenance,
  type Pin,
  type PinImageRef,
  type PinKind,
  type PinQuiltTarget,
  type PinsLibrarySnapshot,
  type PlanPinProvenance,
  type ResultPinProvenance
} from '../shared/pins.js';
import type { PlanLibrary, PlanView } from '../shared/plans.js';
import { CONTINUATION_MARKER, type SessionEvent } from '../shared/session.js';
import {
  DEFAULT_CONCEPT_PREVIEW_SETTINGS,
  type ConceptPreviewSettings
} from '../shared/concept-settings.js';
import { $, run, toast } from './dom.js';
import { t } from './i18n.js';
import {
  createPinsCreateView,
  createQuiltDetail,
  createPinsLibrary,
  showPinChooserDialog,
  type CollectionChipViewModel,
  type PinChooserSourceViewModel,
  type QuiltCardViewModel,
  type QuiltDetailViewModel,
  type QuiltLibraryTab,
  type QuiltPinImageViewModel,
  type QuiltPinDetailViewModel,
  type QuiltSortDirection,
  type QuiltSortKey
} from './pins-quilts.js';
import {
  currentWorkspaceNavigation,
  exactSourceWorkspaceNavigation,
  navigateWorkspace,
  onWorkspaceNavigation,
  startWorkspaceThreadChat,
  type WorkspaceNavigationState
} from './workspace-navigation.js';
import {
  createPlansLibrary,
  type PlanPriority as PlanCardPriority,
  type PlanViewModel,
  type PlansLibraryController,
  workerActivityCardTitle
} from './plans-library.js';
import { decorateWorkspaceReferenceLinks } from './workspace-reference-links.js';

interface PinDraftBase {
  sourceCreatedAt?: number;
  contextCreatedAt?: number;
  title?: string;
  excerpt?: string;
  sourceLabel?: string;
}

export type PinDraft =
  | (PinDraftBase & { kind: 'prompt'; provenance: MessagePinProvenance; image?: PinImageRef })
  | (PinDraftBase & { kind: 'message'; provenance: MessagePinProvenance; image?: PinImageRef })
  | (PinDraftBase & { kind: 'result'; provenance: ResultPinProvenance })
  | (PinDraftBase & { kind: 'plan'; provenance: PlanPinProvenance });

export interface PinState {
  pin: Pin;
  quiltTitle: string;
}

let pinsSnapshot: PinsLibrarySnapshot = { version: 1, quilts: [], pins: [], collections: [] };
/** Presentation only; main resolves the durable id again when preparing the opening. */
export function threadContextLabel(id: string): string | null {
  const thread = pinsSnapshot.quilts.find(row => row.id === id);
  return thread ? `%${thread.title.replace(/^%/u, '')}` : null;
}
let pinsTab: QuiltLibraryTab = 'hotlink';
const collectionFilters = new Set<string>();
let conceptFilter: string | null = null;
let conceptPreviewSettings: ConceptPreviewSettings = { ...DEFAULT_CONCEPT_PREVIEW_SETTINGS };
const HIDDEN_CARD_MESSAGE_PREVIEWS_KEY = 'cos.ui.hidden-thread-message-previews';
function loadHiddenCardMessagePreviews(): Set<string> {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(HIDDEN_CARD_MESSAGE_PREVIEWS_KEY) ?? '[]');
    if (!Array.isArray(saved)) return new Set();
    return new Set(saved.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256));
  } catch { return new Set(); }
}
function saveHiddenCardMessagePreviews(): void {
  try { window.localStorage.setItem(HIDDEN_CARD_MESSAGE_PREVIEWS_KEY, JSON.stringify([...hiddenCardMessagePreviews])); }
  catch { /* Privacy still applies for this renderer when optional preference storage is unavailable. */ }
}
/** Durable UI preference only: Thread ids persist locally; Pin text/provenance and catalog authority do not. */
const hiddenCardMessagePreviews = loadHiddenCardMessagePreviews();
let openQuiltId: string | null = null;
let creatingPinsObject = false;
let quiltSortKey: QuiltSortKey = 'saved';
let quiltSortDirection: QuiltSortDirection = 'desc';
let resolvingQuiltChronology = false;
let quiltChronologyGeneration = 0;
const legacyPinChronology = new Map<string, { sourceCreatedAt?: number; contextCreatedAt?: number }>();
const pinSourceTitles = new Map<string, string>();
const pinImagePreviews = new Map<string, QuiltPinImageViewModel>();
let plansController: PlansLibraryController | null = null;
let planLibrary: PlanLibrary = { live: [], done: [] };
let initialized = false;
const pinStateListeners = new Set<() => void>();

export function setConceptPreviewSettings(next: ConceptPreviewSettings): void {
  if (
    conceptPreviewSettings.quiltRows === next.quiltRows &&
    conceptPreviewSettings.pinPreviewDensity === next.pinPreviewDensity &&
    conceptPreviewSettings.descriptionTextSize === next.descriptionTextSize &&
    conceptPreviewSettings.descriptionRows === next.descriptionRows &&
    conceptPreviewSettings.promptTextSize === next.promptTextSize &&
    conceptPreviewSettings.promptRows === next.promptRows
  ) return;
  conceptPreviewSettings = { ...next };
  if (initialized) paintPins();
}

function startWorkspaceChatDraft(text: string): void {
  navigateWorkspace({ screen: 'chat' });
  const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.focus();
}

function pinsRevision(snapshot: PinsLibrarySnapshot): string {
  return JSON.stringify([
    snapshot.quilts.map(quilt => [quilt.id, quilt.state, quilt.updatedAt]),
    snapshot.pins.map(pin => [pin.id, pin.quiltId, pin.createdAt]),
    snapshot.collections.map(collection => [collection.id, collection.name])
  ]);
}

/** Decorate currently resolvable product references without exposing the mutable snapshot itself. */
export function decoratePinsWorkspaceReferences(root: HTMLElement): void {
  decorateWorkspaceReferenceLinks(
    root,
    pinsSnapshot,
    state => navigateWorkspace(state),
    threadId => { void run(window.api.openThreadDestination(threadId)); }
  );
}

function plansRevision(library: PlanLibrary): string {
  return JSON.stringify([...library.live, ...library.done].map(plan => [
    plan.id, plan.updatedAt, plan.archivedAt, plan.provenance?.threadId ?? null
  ]));
}

const PIN_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Keep only a small pointer in the Pin. The source session remains the authority for image data. */
export function pinImageRefForMessage(
  event: Extract<SessionEvent, { kind: 'user_message' }>
): PinImageRef | undefined {
  const asset = event.assets?.find(row => PIN_IMAGE_MIME_TYPES.has(row.mimeType));
  if (asset) return { source: 'asset', id: asset.id, mimeType: asset.mimeType };
  const attachment = event.attachments?.find(row => row.mimeType.startsWith('image/'));
  if (!attachment) return undefined;
  return {
    source: 'attachment',
    id: attachment.id,
    mimeType: attachment.mimeType,
    alt: attachment.name
  };
}

function notifyPinStateChanged(): void {
  for (const listener of pinStateListeners) listener();
}

export function onPinStateChanged(listener: () => void): () => void {
  pinStateListeners.add(listener);
  return () => pinStateListeners.delete(listener);
}

export function pinStateForDraft(draft: PinDraft): PinState | null {
  const key = pinSourceKey(draft);
  const pin = [...pinsSnapshot.pins].reverse().find(row => pinSourceKey(row) === key);
  if (!pin) return null;
  const quilt = pinsSnapshot.quilts.find(row => row.id === pin.quiltId);
  return quilt ? { pin, quiltTitle: quilt.title } : null;
}

function relativeTime(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return t('Just now');
  if (delta < 3_600_000) return t('{0}m ago', [Math.max(1, Math.floor(delta / 60_000))]);
  if (delta < 86_400_000) return t('{0}h ago', [Math.max(1, Math.floor(delta / 3_600_000))]);
  return t('{0}d ago', [Math.max(1, Math.floor(delta / 86_400_000))]);
}

function collectionViews(snapshot: PinsLibrarySnapshot): CollectionChipViewModel[] {
  return snapshot.collections.map(collection => ({
    id: collection.id,
    label: collection.name,
    count: snapshot.quilts.filter(quilt => quilt.collectionIds.includes(collection.id)).length
  }));
}

function imageView(pin: Pin): QuiltPinImageViewModel | undefined {
  if ((pin.kind !== 'prompt' && pin.kind !== 'message') || !pin.image) return undefined;
  return pinImagePreviews.get(pin.id) ?? {
    alt: pin.image.alt ?? t('User attachment'),
    state: 'loading'
  };
}

function quiltViews(snapshot: PinsLibrarySnapshot): QuiltCardViewModel[] {
  const collections = new Map(collectionViews(snapshot).map(collection => [collection.id, collection]));
  return [...snapshot.quilts]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(quilt => {
      const pins = snapshot.pins
        .filter(pin => pin.quiltId === quilt.id)
        .sort((a, b) => b.createdAt - a.createdAt);
      return {
        id: quilt.id,
        title: quilt.title,
        ...(quilt.description ? { description: quilt.description } : {}),
        ...(quilt.link ? { link: quilt.link } : {}),
        ...(quilt.prompt ? { prompt: quilt.prompt } : {}),
        state: quilt.state,
        pins: pins.map(pin => ({
          id: pin.id,
          kind: pin.kind,
          ...((pin.kind === 'prompt' || pin.kind === 'message' || pin.kind === 'plan') && pin.sticky ? { sticky: true } : {}),
          ...(pin.title ? { title: pin.title } : {}),
          ...(pin.excerpt ? { excerpt: pin.excerpt } : {}),
          ...(pin.sourceLabel ? { sourceLabel: pin.sourceLabel } : {}),
          ...(imageView(pin) ? { image: imageView(pin) } : {})
        })),
        collections: quilt.collectionIds.flatMap(id => collections.get(id) ? [collections.get(id)!] : []),
        pinCount: pins.length,
        updatedLabel: relativeTime(quilt.updatedAt),
        messagePreviewsVisible: !hiddenCardMessagePreviews.has(quilt.id)
      } satisfies QuiltCardViewModel;
    });
}

function quiltDetailView(snapshot: PinsLibrarySnapshot, quiltId: string): QuiltDetailViewModel | null {
  const quilt = snapshot.quilts.find(row => row.id === quiltId);
  if (!quilt) return null;
  const collections = new Map(collectionViews(snapshot).map(collection => [collection.id, collection]));
  const plans = new Map(allPlans().map(plan => [plan.id, plan]));
  const pins = snapshot.pins.filter(pin => pin.quiltId === quilt.id).map(pin => {
    const legacy = legacyPinChronology.get(pin.id);
    const sentAt = pin.sourceCreatedAt ?? legacy?.sourceCreatedAt;
    const contextAt = pin.contextCreatedAt ?? legacy?.contextCreatedAt;
    const sourceSessionId = pin.kind === 'plan'
      ? pin.provenance.sourceSessionId ?? undefined
      : pin.provenance.sessionId;
    const sourceEventSeq = pin.kind === 'plan' ? undefined : pin.provenance.eventSeq;
    const sourceLabel = pinSourceTitles.get(pin.id) ?? pin.sourceLabel;
    const plan = pin.kind === 'plan' ? plans.get(pin.provenance.planId) : undefined;
    const title = plan?.title ?? pin.title;
    const excerpt = plan
      ? `${plan.items.filter(item => item.status === 'done').length} / ${plan.items.length} complete`
      : pin.excerpt;
    return {
      id: pin.id,
      kind: pin.kind,
      ...((pin.kind === 'prompt' || pin.kind === 'message' || pin.kind === 'plan') && pin.sticky ? { sticky: true } : {}),
      savedAt: pin.createdAt,
      ...(sentAt !== undefined ? { sentAt } : {}),
      ...(contextAt !== undefined ? { contextAt } : {}),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(sourceEventSeq !== undefined ? { sourceEventSeq } : {}),
      ...(title ? { title } : {}),
      ...(excerpt ? { excerpt } : {}),
      ...(sourceLabel ? { sourceLabel } : {}),
      ...(imageView(pin) ? { image: imageView(pin) } : {}),
      ...(plan ? {
        plan: {
          items: plan.items.map(item => ({
            id: item.id,
            title: item.text,
            status: item.status,
            ...(item.priority ? { priority: item.priority } : {}),
            ...(plan.currentItemId === item.id
              ? { relation: 'current' as const }
              : plan.nextItemId === item.id ? { relation: 'next' as const } : {})
          }))
        }
      } : {})
    };
  });
  return {
    id: quilt.id,
    title: quilt.title,
    ...(quilt.description ? { description: quilt.description } : {}),
    ...(quilt.link ? { link: quilt.link } : {}),
    ...(quilt.prompt ? { prompt: quilt.prompt } : {}),
    state: quilt.state,
    pins,
    collections: quilt.collectionIds.flatMap(id => collections.get(id) ? [collections.get(id)!] : []),
    pinCount: pins.length,
    updatedLabel: relativeTime(quilt.updatedAt)
  };
}

function paintPins(): void {
  const host = $('pinsLibraryHost');
  if (creatingPinsObject) {
    host.replaceChildren(createPinsCreateView({
      existingThreadTitles: pinsSnapshot.quilts.map(thread => thread.title),
      onBack() {
        creatingPinsObject = false;
        paintPins();
      },
      async onSave(draft) {
        const created = await run(window.api.createThread({
          title: draft.title,
          ...(draft.description ? { description: draft.description } : {}),
          ...(draft.prompt.trim() ? { prompt: draft.prompt } : {}),
          ...(draft.link ? { link: draft.link } : {}),
          collectionNames: draft.collectionNames
        }));
        if (!created) return;
        creatingPinsObject = false;
        await refreshPinsSurface();
        navigateWorkspace({ screen: 'pins', quiltId: created.id }, { replace: true });
        toast(t('Saved'));
      }
    }));
    return;
  }
  if (openQuiltId) {
    const quilt = quiltDetailView(pinsSnapshot, openQuiltId);
    if (quilt) {
      host.replaceChildren(createQuiltDetail({
        quilt,
        sortKey: quiltSortKey,
        sortDirection: quiltSortDirection,
        resolvingChronology: resolvingQuiltChronology,
        onBack() {
          window.history.back();
        },
        onStartChat(quiltId) {
          navigateWorkspace({ screen: 'chat', quiltId });
        },
        onArchiveQuilt: quilt.state === 'pinned' ? async () => {
          if (!await mutateQuiltState(quilt.id, 'archived')) return;
          openQuiltId = null;
          quiltChronologyGeneration += 1;
          resolvingQuiltChronology = false;
          navigateWorkspace({ screen: 'pins' }, { replace: true });
        } : undefined,
        onSortChange(sortKey) {
          quiltSortKey = sortKey;
          paintPins();
        },
        onSortDirectionChange(direction) {
          quiltSortDirection = direction;
          paintPins();
        },
        onOpenSource(pin) {
          void openPinSource(pin);
        },
        async onRemovePin(pin) {
          const removed = await run(window.api.removePin(pin.id));
          if (removed === null) return;
          await refreshPinsSurface();
          if (removed) toast(t('Pin removed'));
        },
        async onSetPinSticky(pin, sticky) {
          if (await run(window.api.setPinSticky(pin.id, sticky)) === null) return;
          await refreshPinsSurface();
          const rows = [...document.querySelectorAll<HTMLElement>('.quilt-pin-row')]
            .filter(row => row.dataset.pinId === pin.id);
          const destination = sticky
            ? rows.find(row => row.dataset.stickyCopy === 'true') ?? rows[0]
            : rows.find(row => row.dataset.stickyCopy !== 'true') ?? rows[0];
          destination?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        },
        onDeleteQuilt: quilt.state === 'archived' ? async () => {
          const deleted = await run(window.api.deleteQuilt(quilt.id));
          if (deleted === null) return;
          openQuiltId = null;
          quiltChronologyGeneration += 1;
          resolvingQuiltChronology = false;
          await refreshPinsSurface();
          navigateWorkspace({ screen: 'pins' }, { replace: true });
          if (deleted) toast(t('Thread deleted'));
        } : undefined,
        async onSaveMetadata(metadata) {
          if (await run(window.api.updateQuilt(
            quilt.id,
            metadata.title,
            metadata.description,
            metadata.collectionNames,
            metadata.link
          )) === null) return;
          await refreshPinsSurface();
          toast(t('Saved'));
        },
        async onSavePrompt(prompt) {
          if (await run(window.api.setQuiltPrompt(quilt.id, prompt)) === null) return;
          await refreshPinsSurface();
          toast(t('Saved'));
        }
      }));
      return;
    }
    openQuiltId = null;
  }
  const quilts = quiltViews(pinsSnapshot);
  const collections = collectionViews(pinsSnapshot);
  host.replaceChildren(createPinsLibrary({
    quilts,
    collections,
    activeTab: pinsTab,
    previewDensity: conceptPreviewSettings.pinPreviewDensity,
    conceptPreviewSettings,
    activeCollectionIds: [...collectionFilters],
    activeCollectionId: collectionFilters.size === 1 ? [...collectionFilters][0]! : null,
    activeConceptId: conceptFilter,
    onTabChange(tab) {
      pinsTab = tab;
      if (tab !== 'concept') conceptFilter = null;
      openQuiltId = null;
      paintPins();
    },
    onCollectionChange(collectionId) {
      if (collectionId === null) collectionFilters.clear();
      else if (collectionFilters.has(collectionId)) collectionFilters.delete(collectionId);
      else collectionFilters.add(collectionId);
      openQuiltId = null;
      paintPins();
    },
    onConceptChange(conceptId) {
      conceptFilter = conceptId;
      pinsTab = 'concept';
      openQuiltId = null;
      paintPins();
    },
    onOpenQuilt(quiltId) {
      navigateWorkspace({ screen: 'pins', quiltId });
    },
    onStartChat(quiltId) {
      navigateWorkspace({ screen: 'chat', quiltId });
    },
    onOpenDestination(quiltId) {
      void run(window.api.openThreadDestination(quiltId));
    },
    onCreate() {
      creatingPinsObject = true;
      openQuiltId = null;
      paintPins();
    },
    onArchiveQuilt(quiltId) {
      void mutateQuiltState(quiltId, 'archived');
    },
    onRepinQuilt(quiltId) {
      void mutateQuiltState(quiltId, 'pinned');
    },
    async onDeleteQuilt(quiltId) {
      const deleted = await run(window.api.deleteQuilt(quiltId));
      if (deleted === null) return;
      await refreshPinsSurface();
      if (deleted) toast(t('Thread deleted'));
    },
    onToggleMessagePreviews(quiltId, visible) {
      if (visible) hiddenCardMessagePreviews.delete(quiltId);
      else hiddenCardMessagePreviews.add(quiltId);
      saveHiddenCardMessagePreviews();
      paintPins();
    },
    onGenerateDescription(quiltId) {
      const thread = pinsSnapshot.quilts.find(row => row.id === quiltId);
      if (!thread) return;
      const reference = `%${thread.title.replace(/^%/u, '')}`;
      startWorkspaceChatDraft(t(
        'Generate a concise durable description for {0}. Search durable session history and related #Concepts first. Update only this exact Thread description; do not change its title, prompt, Pins, Quilts, or Link.',
        [reference]
      ));
    }
  }));
}

async function sessionDetailQuiet(
  sessionId: string,
  options: { from?: number; before?: number; limit?: number }
) {
  const reply = await window.api.getSession(sessionId, options);
  return reply.ok ? reply.data : null;
}

async function resolvePinImage(pin: Extract<Pin, { kind: 'prompt' | 'message' }>): Promise<QuiltPinImageViewModel> {
  const image = pin.image!;
  const alt = image.alt ?? t('User attachment');
  if (image.source === 'asset') {
    const reply = await window.api.getSessionImageThumbnail(pin.provenance.sessionId, image.id);
    return reply.ok && reply.data
      ? { src: reply.data, alt, state: 'ready' }
      : { alt, state: 'unavailable' };
  }

  const page = await sessionDetailQuiet(pin.provenance.sessionId, {
    before: pin.provenance.eventSeq + 1,
    limit: 1
  });
  const source = page?.events.find(event => event.seq === pin.provenance.eventSeq);
  const attachment = source?.kind === 'user_message'
    ? source.attachments?.find(row => row.id === image.id)
    : undefined;
  return attachment?.preview
    ? { src: attachment.preview, alt: image.alt ?? attachment.name, state: 'ready' }
    : { alt, state: 'unavailable' };
}

async function hydratePinImages(snapshot: PinsLibrarySnapshot): Promise<void> {
  const liveImagePins = snapshot.pins.filter((pin): pin is Extract<Pin, { kind: 'prompt' | 'message' }> =>
    (pin.kind === 'prompt' || pin.kind === 'message') && pin.image !== undefined);
  const liveIds = new Set(liveImagePins.map(pin => pin.id));
  for (const id of pinImagePreviews.keys()) if (!liveIds.has(id)) pinImagePreviews.delete(id);
  const queue = liveImagePins.filter(pin => !pinImagePreviews.has(pin.id));
  if (!queue.length) return;

  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const pin = queue.shift();
      if (!pin) return;
      try {
        pinImagePreviews.set(pin.id, await resolvePinImage(pin));
      } catch {
        pinImagePreviews.set(pin.id, {
          alt: pin.image?.alt ?? t('User attachment'),
          state: 'unavailable'
        });
      }
    }
  });
  await Promise.all(workers);
  if (pinsSnapshot === snapshot) paintPins();
}

async function openPinSource(pin: QuiltPinDetailViewModel): Promise<void> {
  if (!pin.sourceSessionId) {
    toast(t('This Pin does not have a recorded source chat.'));
    return;
  }
  const page = await sessionDetailQuiet(pin.sourceSessionId, { limit: 1 });
  if (!page?.summary) {
    toast(t('That source chat is no longer available in Eve.'));
    return;
  }
  const target = pin.sourceEventSeq === undefined
    ? { screen: 'chat' as const, sessionId: pin.sourceSessionId }
    : exactSourceWorkspaceNavigation(pin.sourceSessionId, pin.sourceEventSeq);
  if (!target) {
    toast(t('That source chat is no longer available in Eve.'));
    return;
  }
  navigateWorkspace(target);
}

function isResumeBoundary(event: SessionEvent): boolean {
  if (event.kind !== 'user_message') return false;
  const match = CONTINUATION_MARKER.exec(event.message.text);
  return match?.[1] === 'RESUME';
}

/**
 * Resolves chronology from the durable recording rather than from the Pin's save order. The
 * nearest RESUME bootstrap is the beginning of the ChatGPT context that owns the source event;
 * before the first compaction, the durable session start is the context start.
 */
async function recordedPinChronology(
  sessionId: string,
  eventSeq: number,
  knownSourceCreatedAt?: number
): Promise<{ sourceCreatedAt?: number; contextCreatedAt?: number }> {
  let sourceCreatedAt = knownSourceCreatedAt;
  let contextCreatedAt: number | undefined;
  let before = eventSeq + 1;
  let startedAt: number | undefined;

  for (;;) {
    const page = await sessionDetailQuiet(sessionId, { before, limit: 1000 });
    if (!page?.summary) break;
    startedAt ??= page.summary.startedAt;
    if (sourceCreatedAt === undefined) {
      const source = page.events.find(event => event.seq === eventSeq);
      if (source) sourceCreatedAt = source.time;
    }
    const eligible = page.events.filter(event => event.seq <= eventSeq).sort((a, b) => b.seq - a.seq);
    const resume = eligible.find(isResumeBoundary);
    if (resume) {
      contextCreatedAt = resume.time;
      break;
    }
    if (!eligible.length) break;
    const earliest = Math.min(...eligible.map(event => event.seq));
    if (earliest <= 1 || earliest >= before) break;
    before = earliest;
  }

  if (contextCreatedAt === undefined) contextCreatedAt = startedAt;
  return {
    ...(sourceCreatedAt !== undefined ? { sourceCreatedAt } : {}),
    ...(contextCreatedAt !== undefined ? { contextCreatedAt } : {})
  };
}

async function hydratePinDraftChronology(draft: PinDraft): Promise<PinDraft> {
  if (draft.kind === 'plan' || (draft.sourceCreatedAt !== undefined && draft.contextCreatedAt !== undefined)) return draft;
  const resolved = await recordedPinChronology(draft.provenance.sessionId, draft.provenance.eventSeq, draft.sourceCreatedAt);
  return {
    ...draft,
    ...(draft.sourceCreatedAt !== undefined || resolved.sourceCreatedAt === undefined
      ? {} : { sourceCreatedAt: resolved.sourceCreatedAt }),
    ...(draft.contextCreatedAt !== undefined || resolved.contextCreatedAt === undefined
      ? {} : { contextCreatedAt: resolved.contextCreatedAt })
  } as PinDraft;
}

async function openQuilt(quiltId: string): Promise<void> {
  if (!pinsSnapshot.quilts.some(row => row.id === quiltId)) return;
  openQuiltId = quiltId;
  const generation = ++quiltChronologyGeneration;
  const quiltPins = pinsSnapshot.pins.filter(pin => pin.quiltId === quiltId);
  const unresolved = pinsSnapshot.pins.filter(pin =>
    pin.quiltId === quiltId &&
    (pin.kind === 'prompt' || pin.kind === 'message' || pin.kind === 'result') &&
    (pin.sourceCreatedAt === undefined || pin.contextCreatedAt === undefined) &&
    !legacyPinChronology.has(pin.id)
  );
  resolvingQuiltChronology = unresolved.length > 0;
  paintPins();

  // Source labels are presentation, not identity. Resolve the current recorded chat title when
  // possible so a Plan Pin says the chat it came from rather than the generic "Plans" surface.
  await Promise.all(quiltPins.map(async pin => {
    if (pinSourceTitles.has(pin.id)) return;
    const sourceSessionId = pin.kind === 'plan'
      ? pin.provenance.sourceSessionId ?? undefined
      : pin.provenance.sessionId;
    if (!sourceSessionId) return;
    const page = await sessionDetailQuiet(sourceSessionId, { limit: 1 });
    if (page?.summary?.title) pinSourceTitles.set(pin.id, page.summary.title);
  }));
  if (generation !== quiltChronologyGeneration || openQuiltId !== quiltId) return;
  paintPins();
  if (!unresolved.length) return;

  // Legacy Pins predate chronology snapshots. Resolve a small bounded set in parallel so opening
  // a Quilt stays responsive without flooding the local IPC bridge for a large collection.
  const queue = [...unresolved];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const pin = queue.shift();
      if (!pin) return;
      const provenance = pin.provenance as MessagePinProvenance | ResultPinProvenance;
      const chronology = await recordedPinChronology(provenance.sessionId, provenance.eventSeq, pin.sourceCreatedAt);
      legacyPinChronology.set(pin.id, chronology);
    }
  });
  await Promise.all(workers);
  if (generation !== quiltChronologyGeneration || openQuiltId !== quiltId) return;
  resolvingQuiltChronology = false;
  paintPins();
}

async function mutateQuiltState(quiltId: string, state: 'pinned' | 'archived'): Promise<boolean> {
  if (await run(window.api.setQuiltState(quiltId, state)) === null) return false;
  await refreshPinsSurface();
  toast(t(state === 'archived' ? 'Thread archived' : 'Thread restored'));
  return true;
}

function priorityFor(plan: PlanView): PlanCardPriority | undefined {
  if (plan.items.some(item => item.priority === 'high')) return 'high';
  if (plan.items.some(item => item.priority === 'medium')) return 'medium';
  if (plan.items.some(item => item.priority === 'low')) return 'low';
  return undefined;
}

function reminderLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function planCard(plan: PlanView): PlanViewModel {
  const lifecycle: PlanViewModel['lifecycle'] = plan.section === 'done'
    ? 'done'
    : plan.readyToArchive ? 'ready-to-archive' : 'live';
  const source = plan.provenance;
  const sourceThread = source?.threadId
    ? pinsSnapshot.quilts.find(thread => thread.id === source.threadId)
    : undefined;
  const pinState = pinStateForDraft(pinDraftForPlan(plan));
  return {
    id: plan.id,
    title: plan.worker
      ? workerActivityCardTitle(
          plan.worker.id,
          plan.title,
          plan.createdAt,
          plan.items.find(item => item.status === 'in_progress')?.text ??
            plan.items.find(item => item.status !== 'done')?.text ??
            plan.items[0]?.text ??
            t('Work')
        )
      : plan.title,
    lifecycle,
    audience: plan.audience,
    updatedAt: plan.updatedAt,
    items: plan.items.map(item => ({
      id: item.id,
      title: item.text,
      status: item.status === 'in_progress' ? 'in-progress' as const : item.status,
      ...(item.priority ? { priority: item.priority } : {})
    })),
    currentItemId: plan.currentItemId,
    nextItemId: plan.nextItemId,
    ...(priorityFor(plan) ? { priority: priorityFor(plan) } : {}),
    reminder: plan.nextReminderAt === null ? null : {
      label: `Next reminder · ${reminderLabel(plan.nextReminderAt)}`,
      due: plan.nextReminderAt <= Date.now()
    },
    provenance: source ? {
      label: sourceThread
        ? (threadContextLabel(sourceThread.id) ?? 'Thread source')
        : source.label ?? (source.sessionId ? 'Chat plan' : 'Saved plan'),
      detail: sourceThread
        ? undefined
        : source.conversationId ? `Conversation ${source.conversationId.slice(0, 8)}…` : undefined,
      sourceState: sourceThread || source.sessionId ? 'linked' : 'saved-only'
    } : null,
    ...(pinState ? { pinLabel: `Unpin · ${pinState.quiltTitle}`, pinned: true } : {}),
    ...(plan.cancelledAt !== undefined
      ? { cancelled: true, completedLabel: `Cancelled ${relativeTime(plan.cancelledAt)}` }
      : plan.archivedAt ? { completedLabel: `Finished ${relativeTime(plan.archivedAt)}` } : {})
  };
}

function allPlans(): PlanView[] {
  return [...planLibrary.live, ...planLibrary.done];
}

function paintPlans(): void {
  const views = allPlans().map(planCard);
  if (!plansController) {
    plansController = createPlansLibrary({
      host: $('plansLibraryHost'),
      plans: views,
      onToggleItemDone(planId, itemId, done) {
        void togglePlanItem(planId, itemId, done);
      },
      onArchive(planId) {
        void archivePlan(planId);
      },
      onCancel(planId) {
        void cancelPlan(planId);
      },
      onPin(planId) {
        const plan = allPlans().find(row => row.id === planId);
        if (plan) void togglePinTarget(pinDraftForPlan(plan));
      },
      onOpenSource(planId) {
        const plan = allPlans().find(row => row.id === planId);
        const threadId = plan?.provenance?.threadId;
        if (threadId && pinsSnapshot.quilts.some(thread => thread.id === threadId)) {
          navigateWorkspace({ screen: 'pins', quiltId: threadId });
          return;
        }
        if (plan?.provenance?.sessionId) navigateWorkspace({ screen: 'chat', sessionId: plan.provenance.sessionId });
      },
      async onCreatePlanChat() {
        const starter = await run(window.api.getStarterThread('plans'));
        if (!starter) {
          toast(t('Plans starter is unavailable'));
          return;
        }
        startWorkspaceThreadChat(starter.threadId, t('Make me a 3 step plan to get started with %plans'));
      },
      onReviewPlansChat() {
        startWorkspaceChatDraft(t('Review #plans with me.'));
      }
    });
  } else {
    plansController.update(views);
  }
}

async function togglePlanItem(planId: string, itemId: string, done: boolean): Promise<void> {
  const plan = allPlans().find(row => row.id === planId);
  if (!plan || plan.section === 'done') return;
  const items = plan.items.map(item => item.id === itemId
    ? { ...item, status: done ? 'done' as const : 'todo' as const }
    : item);
  if (await run(window.api.updatePlan(planId, { items }, plan.updatedAt)) === null) return;
  await refreshPlansSurface();
}

async function cancelPlan(planId: string): Promise<void> {
  if (await run(window.api.cancelPlan(planId)) === null) return;
  await refreshPlansSurface();
  toast(t('Plan cancelled'));
}

async function archivePlan(planId: string): Promise<void> {
  if (await run(window.api.archivePlan(planId)) === null) return;
  await refreshPlansSurface();
  toast(t('Plan archived as finished'));
}

export async function refreshPinsSurface(): Promise<void> {
  const snapshot = await run(window.api.getPinsLibrary());
  if (!snapshot) return;
  const previousRevision = pinsRevision(pinsSnapshot);
  pinsSnapshot = snapshot;
  for (const id of [...collectionFilters]) {
    if (!snapshot.collections.some(row => row.id === id)) collectionFilters.delete(id);
  }
  let privacyPreferencesChanged = false;
  for (const id of [...hiddenCardMessagePreviews]) {
    if (!snapshot.quilts.some(row => row.id === id)) {
      hiddenCardMessagePreviews.delete(id);
      privacyPreferencesChanged = true;
    }
  }
  if (privacyPreferencesChanged) saveHiddenCardMessagePreviews();
  if (conceptFilter && !snapshot.quilts.some(row => row.id === conceptFilter)) conceptFilter = null;
  const navigation = currentWorkspaceNavigation();
  if (navigation?.screen === 'pins') applyPinsNavigation(navigation);
  else paintPins();
  void hydratePinImages(snapshot);
  // Plans cards derive their Pin/Unpin label from the same durable Pins snapshot. Repainting
  // only the Pins destination left an already-visible Plan card stuck on its old label after
  // create/remove even though the persistence layer had committed the change correctly.
  if (pinsRevision(snapshot) !== previousRevision) {
    paintPlans();
    notifyPinStateChanged();
  }
}

function applyPinsNavigation(state: WorkspaceNavigationState): void {
  if (state.screen !== 'pins') return;
  creatingPinsObject = false;
  if (state.quiltId) {
    if (!pinsSnapshot.quilts.some(row => row.id === state.quiltId)) {
      openQuiltId = null;
      quiltChronologyGeneration += 1;
      resolvingQuiltChronology = false;
      paintPins();
      return;
    }
    void openQuilt(state.quiltId);
    return;
  }
  openQuiltId = null;
  quiltChronologyGeneration += 1;
  resolvingQuiltChronology = false;
  const requestedCollections = state.collectionIds ??
    (state.collectionId ? [state.collectionId] : []);
  collectionFilters.clear();
  for (const id of requestedCollections) {
    if (pinsSnapshot.collections.some(row => row.id === id)) collectionFilters.add(id);
  }
  conceptFilter = state.conceptId && pinsSnapshot.quilts.some(row => row.id === state.conceptId)
    ? state.conceptId
    : null;
  if (conceptFilter) pinsTab = 'concept';
  else if (requestedCollections.length > 0) pinsTab = 'pinned';
  paintPins();
}

export async function refreshPlansSurface(): Promise<void> {
  const library = await run(window.api.listPlans());
  if (!library) return;
  const previousRevision = plansRevision(planLibrary);
  planLibrary = library;
  paintPlans();
  if (currentWorkspaceNavigation()?.screen === 'pins') paintPins();
  if (plansRevision(library) !== previousRevision) notifyPinStateChanged();
}

export function initWorkspaceLibrary(): void {
  if (initialized) return;
  initialized = true;
  paintPins();
  paintPlans();
  onWorkspaceNavigation(applyPinsNavigation);
  window.api.onPlansChanged(() => { void refreshPlansSurface(); });
  // Plan records change when update_plan runs, but the "Current" relation also depends on the
  // source session still having live work. A completed/final turn does not rewrite plans.json, so
  // while Plans or a Thread with an embedded Plan is actually open, repaint from that newer
  // session boundary instead of leaving a stale Current badge until the user navigates away.
  window.api.onSessionChanged(() => {
    const screen = currentWorkspaceNavigation()?.screen;
    if (screen === 'plans' || screen === 'pins') void refreshPlansSurface();
  });
  window.api.onPinsChanged(() => { void refreshPinsSurface(); });
  void refreshPinsSurface();
  void refreshPlansSurface();
}

function sourceView(draft: PinDraft): PinChooserSourceViewModel {
  return {
    kind: draft.kind,
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.excerpt ? { excerpt: draft.excerpt } : {}),
    ...(draft.sourceLabel ? { sourceLabel: draft.sourceLabel } : {})
  };
}

function withTarget(draft: PinDraft, target: PinQuiltTarget): CreatePinInput {
  return { ...draft, target } as CreatePinInput;
}

export async function choosePinTarget(draft: PinDraft): Promise<{ pin: Pin; quiltTitle: string } | null> {
  await refreshPinsSurface();
  const quilts = quiltViews(pinsSnapshot);
  const collections = collectionViews(pinsSnapshot);
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: { pin: Pin; quiltTitle: string } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    showPinChooserDialog({
      source: sourceView(draft),
      quilts,
      collections,
      async onConfirm(target) {
        const hydrated = await hydratePinDraftChronology(draft);
        const created = await run(window.api.createPin(withTarget(hydrated, target)));
        if (!created) throw new Error('Pin was not saved');
        await refreshPinsSurface();
        toast(t('Pinned to “{0}”', [created.quilt.title]));
        finish({ pin: created.pin, quiltTitle: created.quilt.title });
      },
      onCancel() { finish(null); }
    });
  });
}

export async function unpinDraft(draft: PinDraft): Promise<boolean> {
  await refreshPinsSurface();
  const state = pinStateForDraft(draft);
  if (!state) return false;
  const removed = await run(window.api.removePin(state.pin.id));
  if (removed === null) return false;
  await refreshPinsSurface();
  if (removed) toast(t('Unpinned from “{0}”', [state.quiltTitle]));
  return removed;
}

/** One visible control is a true Pin/Unpin toggle backed by the durable Pins catalog. */
export async function togglePinTarget(draft: PinDraft): Promise<PinState | null> {
  await refreshPinsSurface();
  const existing = pinStateForDraft(draft);
  if (existing) {
    await unpinDraft(draft);
    return null;
  }
  return choosePinTarget(draft);
}

export function pinDraftForPlan(plan: PlanView): PinDraft {
  const done = plan.items.filter(item => item.status === 'done').length;
  return {
    kind: 'plan',
    provenance: {
      planId: plan.id,
      ...(plan.provenance?.sessionId ? { sourceSessionId: plan.provenance.sessionId } : {}),
      ...(plan.provenance?.conversationId ? { sourceConversationId: plan.provenance.conversationId } : {})
    },
    title: plan.title,
    excerpt: `${done} / ${plan.items.length} complete`,
    sourceLabel: 'Plans'
  };
}

export async function pinLivePlanForSession(sessionId: string): Promise<{ pin: Pin; quiltTitle: string } | null> {
  await refreshPlansSurface();
  let plan = planLibrary.live.find(row => row.provenance?.sessionId === sessionId);
  if (!plan) {
    const ensured = await run(window.api.ensureSessionPlan(sessionId));
    if (ensured) {
      await refreshPlansSurface();
      plan = planLibrary.live.find(row => row.id === ensured.id) ?? ensured;
    }
  }
  return plan ? choosePinTarget(pinDraftForPlan(plan)) : null;
}

export function pinStateForSessionPlan(sessionId: string): PinState | null {
  const plan = planLibrary.live.find(row => row.provenance?.sessionId === sessionId);
  return plan ? pinStateForDraft(pinDraftForPlan(plan)) : null;
}

export async function toggleLivePlanPinForSession(sessionId: string): Promise<PinState | null> {
  await refreshPlansSurface();
  let plan = planLibrary.live.find(row => row.provenance?.sessionId === sessionId);
  if (!plan) {
    const ensured = await run(window.api.ensureSessionPlan(sessionId));
    if (!ensured) return null;
    await refreshPlansSurface();
    plan = planLibrary.live.find(row => row.id === ensured.id) ?? ensured;
  }
  return togglePinTarget(pinDraftForPlan(plan));
}

export function pinKindLabel(kind: PinKind): string {
  return kind === 'prompt' ? 'Prompt' : kind === 'message' ? 'Message' : kind === 'result' ? 'Result' : 'Plan';
}
