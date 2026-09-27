import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';

export type PlanItemStatus = 'todo' | 'in-progress' | 'done';
export type PlanPriority = 'high' | 'medium' | 'low';
export type PlanLifecycle = 'live' | 'ready-to-archive' | 'done';
export type PlanAudience = 'human' | 'eve';

export interface PlanProvenance {
  /** Human label such as "Living room refresh" or "Chat · Sep 12". */
  label: string;
  /** Optional supporting context that can be shown without exposing internal ids. */
  detail?: string;
  /** Only `linked` permits the Open source callback. */
  sourceState: 'linked' | 'saved-only';
}

export interface PlanReminder {
  /** Already human-formatted reminder text, e.g. "Tomorrow · 08:30". */
  label: string;
  /** A due reminder is visually stronger but has no scheduling authority here. */
  due?: boolean;
}

export interface PlanItemViewModel {
  id: string;
  title: string;
  status: PlanItemStatus;
  detail?: string;
  priority?: PlanPriority;
  /** App-owned status rows (such as worker report proof) are informative, not user-editable. */
  readOnly?: boolean;
}

export interface PlanViewModel {
  id: string;
  title: string;
  description?: string;
  lifecycle: PlanLifecycle;
  /** Defaults to human so manually-authored/test plans remain in the manager-facing view. */
  audience?: PlanAudience;
  items: readonly PlanItemViewModel[];
  /** These ids are presentation facts supplied by the plan owner; the renderer does not infer them. */
  currentItemId?: string | null;
  nextItemId?: string | null;
  /** Durable record revision, used only as the final Live-card recency tie-break. */
  updatedAt?: number;
  priority?: PlanPriority;
  reminder?: PlanReminder | null;
  provenance?: PlanProvenance | null;
  /** Optional display text such as "Finished today" for an archived plan. */
  completedLabel?: string;
  /** Durable Pins-library projection for this Plan; the presentational card never infers it. */
  pinned?: boolean;
  /** User-facing Pin/Unpin label supplied by the Pins owner, including its Quilt when useful. */
  pinLabel?: string;
  /** Disables mutating controls while the owner is committing an acknowledged change. */
  pending?: boolean;
}

export interface PlansLibraryCallbacks {
  /** The owner decides whether an unchecked item returns to todo or another valid state. */
  onToggleItemDone?: (planId: string, itemId: string, done: boolean) => void;
  onArchive?: (planId: string) => void;
  onPin?: (planId: string) => void;
  onOpenSource?: (planId: string, provenance: PlanProvenance) => void;
  /** Starts the 2.2.3 conversational Plan-create flow; durable Plan mutation remains Eve/tool-owned. */
  onCreatePlanChat?: () => void;
  /** Review remains an editable chat shortcut. */
  onReviewPlansChat?: () => void;
}

export interface PlansLibraryOptions extends PlansLibraryCallbacks {
  host: HTMLElement;
  plans?: readonly PlanViewModel[];
}

export interface PlansLibraryController {
  update(plans: readonly PlanViewModel[]): void;
  destroy(): void;
}

const PRIORITY_LABEL: Record<PlanPriority, string> = {
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority'
};

export function workerActivityCardTitle(workerId: string, title: string, createdAt: number, fallbackTitle: string): string {
  const numericId = /^(?:worker-)?(\d+)$/i.exec(workerId)?.[1];
  const workerLabel = numericId ? numericId.padStart(2, '0') : workerId;
  const stripped = title
    .replace(/^(?:Resumed\s*\u00b7\s*)+/i, '')
    .replace(/^worker-\d+\s*[\u00b7:\u2014-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const generic = !stripped || /^(?:Worker-?\d+|resumed session|task helper)$/i.test(stripped);
  const rawTitle = generic ? fallbackTitle : stripped;
  const shortTitle = rawTitle.length > 44 ? `${rawTitle.slice(0, 43).trimEnd()}\u2026` : rawTitle;
  const stamp = new Date(createdAt);
  const two = (value: number) => String(value).padStart(2, '0');
  const date = `${two(stamp.getDate())}.${two(stamp.getMonth() + 1)}.${stamp.getFullYear()}`;
  const time = `${two(stamp.getHours())}:${two(stamp.getMinutes())}`;
  return `Worker ${workerLabel} - ${shortTitle} - ${date} - ${time}`;
}

function priorityChip(priority: PlanPriority, compact = false): HTMLElement {
  const chip = el('span', `plans-priority is-${priority}`);
  chip.textContent = compact ? t(priority[0]!.toUpperCase()) : t(PRIORITY_LABEL[priority]);
  chip.title = t(PRIORITY_LABEL[priority]);
  return chip;
}

function progress(plan: PlanViewModel): { done: number; total: number; percent: number } {
  const total = plan.items.length;
  const done = plan.items.reduce((count, item) => count + (item.status === 'done' ? 1 : 0), 0);
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

function itemRelation(plan: PlanViewModel, item: PlanItemViewModel): 'current' | 'next' | null {
  if (plan.currentItemId === item.id) return 'current';
  if (plan.nextItemId === item.id) return 'next';
  return null;
}

function itemRow(
  plan: PlanViewModel,
  item: PlanItemViewModel,
  callbacks: PlansLibraryCallbacks
): HTMLLIElement {
  const relation = itemRelation(plan, item);
  const row = document.createElement('li');
  row.className = 'plans-item';
  row.dataset.status = item.status;
  if (relation) row.dataset.relation = relation;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'plans-item-toggle';
  toggle.disabled = item.readOnly === true || plan.lifecycle === 'done' || plan.pending === true || callbacks.onToggleItemDone === undefined;
  toggle.setAttribute('aria-pressed', String(item.status === 'done'));
  if (item.readOnly === true) toggle.setAttribute('aria-label', item.title);
  else ui(toggle, 'aria-label', () => t(
      item.status === 'done' ? 'Mark {0} unfinished' : 'Mark {0} done',
      [item.title]
    ));
  if (item.status === 'done') toggle.append(icon('i-check'));
  else if (item.status === 'in-progress') toggle.append(el('span', 'plans-item-dot'));
  toggle.addEventListener('click', () => {
    callbacks.onToggleItemDone?.(plan.id, item.id, item.status !== 'done');
  });

  const content = el('div', 'plans-item-content');
  const titleLine = el('div', 'plans-item-title');
  const title = el('span', '', item.title);
  title.dir = 'auto';
  titleLine.append(title);
  if (relation) titleLine.append(el('span', `plans-item-relation is-${relation}`, () => t(relation === 'current' ? 'Current' : 'Next')));
  if (item.priority) titleLine.append(priorityChip(item.priority, true));
  content.append(titleLine);
  if (item.detail) {
    const detail = el('p', 'plans-item-detail', item.detail);
    detail.dir = 'auto';
    content.append(detail);
  }

  row.append(toggle, content);
  return row;
}

function provenanceRow(plan: PlanViewModel, callbacks: PlansLibraryCallbacks): HTMLElement | null {
  const provenance = plan.provenance;
  if (!provenance) return null;

  const row = el('div', 'plans-source');
  const copy = el('div', 'plans-source-copy');
  const state = el(
    'span',
    `plans-source-state is-${provenance.sourceState}`,
    () => t(provenance.sourceState === 'linked' ? 'Source linked' : 'Saved copy only')
  );
  const label = el('strong', '', provenance.label);
  label.dir = 'auto';
  copy.append(state, label);
  if (provenance.detail) {
    const detail = el('span', 'plans-source-detail', provenance.detail);
    detail.dir = 'auto';
    copy.append(detail);
  }
  row.append(copy);

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'plans-source-open';
  open.disabled = provenance.sourceState !== 'linked' || callbacks.onOpenSource === undefined;
  open.setAttribute('aria-label', `${t('Open source')} · ${provenance.label}`);
  open.append(icon('i-out'), el('span', '', () => t('Open source')));
  open.addEventListener('click', () => callbacks.onOpenSource?.(plan.id, provenance));
  row.append(open);
  return row;
}

function planCard(plan: PlanViewModel, callbacks: PlansLibraryCallbacks): HTMLElement {
  const card = el('article', 'plans-card');
  card.setAttribute('aria-label', plan.title);
  card.dataset.lifecycle = plan.lifecycle;
  if (plan.priority) card.dataset.priority = plan.priority;
  if (plan.pending) card.dataset.pending = 'true';

  const head = el('div', 'plans-card-head');
  const heading = el('div', 'plans-card-heading');
  const titleLine = el('div', 'plans-card-title-line');
  const title = el('h3', '', plan.title);
  title.dir = 'auto';
  titleLine.append(title);
  if (plan.priority) titleLine.append(priorityChip(plan.priority));
  heading.append(titleLine);
  if (plan.description) {
    const description = el('p', '', plan.description);
    description.dir = 'auto';
    heading.append(description);
  }
  head.append(heading);
  const headActions = el('div', 'plans-card-head-actions');
  if (callbacks.onPin) {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = `plans-pin${plan.pinned ? ' is-pinned' : ''}`;
    pin.textContent = plan.pinLabel ?? t('Pin');
    ui(pin, 'title', () => plan.pinned ? t('Unpin this plan') : t('Pin this plan to a Thread'));
    pin.setAttribute('aria-pressed', String(plan.pinned === true));
    pin.addEventListener('click', () => callbacks.onPin?.(plan.id));
    headActions.append(pin);
  }
  if (plan.lifecycle === 'ready-to-archive') {
    headActions.append(el('span', 'plans-ready', () => t('Ready to archive')));
  } else if (plan.lifecycle === 'done') {
    headActions.append(el('span', 'plans-finished', () => t('Finished')));
  }
  if (headActions.childElementCount) head.append(headActions);
  card.append(head);

  const tally = progress(plan);
  const progressRow = el('div', 'plans-progress');
  const progressTrack = el('div', 'plans-progress-track');
  progressTrack.setAttribute('role', 'progressbar');
  progressTrack.setAttribute('aria-valuemin', '0');
  progressTrack.setAttribute('aria-valuemax', String(tally.total));
  progressTrack.setAttribute('aria-valuenow', String(tally.done));
  ui(progressTrack, 'aria-valuetext', () => t('{0} of {1} complete', [tally.done, tally.total]));
  const progressFill = el('span', 'plans-progress-fill');
  progressFill.style.setProperty('--plans-progress', `${tally.percent}%`);
  progressTrack.append(progressFill);
  progressRow.append(
    progressTrack,
    el('span', 'plans-progress-label', () => t('{0} / {1}', [tally.done, tally.total]))
  );
  card.append(progressRow);

  if (plan.reminder) {
    const reminder = el('div', `plans-reminder${plan.reminder.due ? ' is-due' : ''}`);
    reminder.append(icon('i-clock'), el('span', '', plan.reminder.label));
    card.append(reminder);
  }

  const list = document.createElement('ol');
  list.className = 'plans-checklist';
  if (plan.items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'plans-items-empty';
    empty.append(el('span', '', () => t('No checklist items yet')));
    list.append(empty);
  } else {
    for (const item of plan.items) list.append(itemRow(plan, item, callbacks));
  }
  card.append(list);

  const source = provenanceRow(plan, callbacks);
  if (source) card.append(source);

  if (plan.lifecycle === 'ready-to-archive') {
    const actions = el('div', 'plans-card-actions');
    const status = el('span', 'plans-archive-note', () => t('Everything is complete. Archive this plan as finished when you are ready.'));
    const archive = document.createElement('button');
    archive.type = 'button';
    archive.className = 'plans-archive';
    archive.disabled = plan.pending === true || callbacks.onArchive === undefined;
    archive.setAttribute('aria-label', `${t(plan.pending ? 'Archiving…' : 'Archive as finished')} · ${plan.title}`);
    archive.append(icon('i-check'), el('span', '', () => t(plan.pending ? 'Archiving…' : 'Archive as finished')));
    archive.addEventListener('click', () => callbacks.onArchive?.(plan.id));
    actions.append(status, archive);
    card.append(actions);
  } else if (plan.lifecycle === 'done' && plan.completedLabel) {
    card.append(el('div', 'plans-completed-label', plan.completedLabel));
  }

  return card;
}

function section(
  title: string,
  plans: readonly PlanViewModel[],
  emptyText: string,
  callbacks: PlansLibraryCallbacks
): HTMLElement {
  const root = el('section', 'plans-section');
  const head = el('div', 'plans-section-head');
  const heading = el('h2', '', () => t(title));
  const count = el('span', 'plans-section-count', String(plans.length));
  head.append(heading, count);
  root.append(head);

  if (plans.length === 0) {
    root.append(el('div', 'plans-empty', () => t(emptyText)));
    return root;
  }

  const cards = el('div', 'plans-cards');
  cards.append(...plans.map(plan => planCard(plan, callbacks)));
  root.append(cards);
  return root;
}

/**
 * Worker plans are valuable evidence, but their full execution cards overwhelm the manager view.
 * Keep a compact, expandable record here so completed audits/checklists remain visible without
 * turning Plans into a worker transcript. The full cards stay available under Eve activity.
 */
function verifiedWorkSection(plans: readonly PlanViewModel[]): HTMLElement {
  const root = el('section', 'plans-section plans-verified-work');
  const head = el('div', 'plans-section-head');
  head.append(
    el('h2', '', () => t('Verified work')),
    el('span', 'plans-section-count', String(plans.length))
  );
  root.append(head);
  if (!plans.length) {
    root.append(el('div', 'plans-empty', () => t('No worker evidence yet. Completed audits and verification will collect here.')));
    return root;
  }

  const stack = el('div', 'plans-evidence-stack');
  for (const plan of plans) {
    const tally = progress(plan);
    const details = document.createElement('details');
    details.className = 'plans-evidence';
    const summary = document.createElement('summary');
    const title = el('span', 'plans-evidence-title', plan.title);
    title.dir = 'auto';
    summary.append(
      title,
      el('span', 'plans-evidence-progress', () => t('{0} of {1} complete', [tally.done, tally.total]))
    );
    details.append(summary);

    const list = document.createElement('ol');
    list.className = 'plans-evidence-items';
    for (const item of plan.items) {
      const row = document.createElement('li');
      row.dataset.status = item.status;
      row.append(
        item.status === 'done' ? icon('i-check') : el('span', 'plans-evidence-dot'),
        el('span', '', item.title)
      );
      list.append(row);
    }
    details.append(list);
    stack.append(details);
  }
  root.append(stack);
  return root;
}

/**
 * Presentational Plans surface. Durable plan state remains with the caller: every action emits a
 * callback and this component only changes after the owner supplies a new `update(...)` snapshot.
 */
export function createPlansLibrary(options: PlansLibraryOptions): PlansLibraryController {
  const callbacks: PlansLibraryCallbacks = {
    onToggleItemDone: options.onToggleItemDone,
    onArchive: options.onArchive,
    onPin: options.onPin,
    onOpenSource: options.onOpenSource,
    onCreatePlanChat: options.onCreatePlanChat,
    onReviewPlansChat: options.onReviewPlansChat
  };
  const root = el('div', 'plans-library');
  const intro = el('div', 'plans-library-head');
  const introCopy = el('div', 'plans-library-intro-copy');
  introCopy.append(
    el('h1', '', () => t('Plans')),
    el('p', '', () => t('Keep active plans visible here until the whole checklist is finished.'))
  );
  intro.append(icon('i-plan-steps', 'plans-library-icon'), introCopy);
  const headActions = el('div', 'plans-head-actions');
  const createPlanChat = document.createElement('button');
  createPlanChat.type = 'button';
  createPlanChat.className = 'plans-header-create';
  createPlanChat.textContent = t('Create');
  createPlanChat.disabled = callbacks.onCreatePlanChat === undefined;
  createPlanChat.addEventListener('click', () => callbacks.onCreatePlanChat?.());
  const shortcuts = el('div', 'plans-chat-shortcuts');
  const reviewPlansChat = document.createElement('button');
  reviewPlansChat.type = 'button';
  reviewPlansChat.className = 'plans-chat-shortcut';
  reviewPlansChat.textContent = t('Review #Plans');
  reviewPlansChat.disabled = callbacks.onReviewPlansChat === undefined;
  reviewPlansChat.addEventListener('click', () => callbacks.onReviewPlansChat?.());
  shortcuts.append(reviewPlansChat);
  headActions.append(createPlanChat, shortcuts);
  intro.append(headActions);
  const switcher = el('div', 'plans-audience-tabs');
  switcher.setAttribute('role', 'tablist');
  let audience: PlanAudience = 'human';
  const humanTab = document.createElement('button');
  const eveTab = document.createElement('button');
  for (const [button, value, label] of [
    [humanTab, 'human', 'Plans'],
    [eveTab, 'eve', 'Eve activity']
  ] as const) {
    button.type = 'button';
    button.className = 'plans-audience-tab';
    button.setAttribute('role', 'tab');
    button.dataset.audience = value;
    button.append(el('span', '', () => t(label)), el('span', 'plans-audience-count', '0'));
    button.addEventListener('click', () => {
      audience = value;
      paint(currentPlans);
    });
    switcher.append(button);
  }
  root.append(intro, switcher);
  options.host.replaceChildren(root);

  let currentPlans: readonly PlanViewModel[] = options.plans ?? [];
  function paint(plans: readonly PlanViewModel[]): void {
    currentPlans = plans;
    const human = plans.filter(plan => (plan.audience ?? 'human') === 'human');
    const eve = plans.filter(plan => plan.audience === 'eve');
    humanTab.querySelector<HTMLElement>('.plans-audience-count')!.textContent = String(human.length);
    eveTab.querySelector<HTMLElement>('.plans-audience-count')!.textContent = String(eve.length);
    for (const button of [humanTab, eveTab]) {
      const selected = button.dataset.audience === audience;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected', String(selected));
    }
    const visible = audience === 'eve' ? eve : human;
    // Preserve the durable Live order supplied by the Plans owner. Checklist progress, Current/
    // Next changes, Pin state and other card updates must repaint in place instead of making the
    // user's cards jump around. Archiving removes one card; the remaining relative order stays put.
    const live = visible.filter(plan => plan.lifecycle !== 'done');
    const done = visible.filter(plan => plan.lifecycle === 'done');
    const sections = el('div', 'plans-sections');
    sections.append(
      section('Live', live, audience === 'eve'
        ? 'No live Eve activity. Worker execution plans appear here when they are active.'
        : 'No live plans. Keep this view for meaningful goals and milestones from the work you asked Eve to do.', callbacks),
      section('Done', done, audience === 'eve'
        ? 'Finished worker execution plans collect here after they are archived.'
        : 'Finished goals collect here after you archive them.', callbacks),
      ...(audience === 'human' ? [verifiedWorkSection(eve)] : [])
    );
    root.querySelector('.plans-sections')?.remove();
    root.append(sections);
  }

  paint(currentPlans);
  return {
    update: paint,
    destroy(): void {
      if (root.parentElement === options.host) root.remove();
    }
  };
}
