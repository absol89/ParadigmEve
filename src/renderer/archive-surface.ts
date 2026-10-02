import { ago, el, run } from './dom.js';
import { currentLanguage, t, ui } from './i18n.js';
import type {
  ArchiveRendererOpenResult,
  ArchiveRendererRebuildResult,
  ArchiveRendererStatus
} from '../shared/archive-renderer.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
type ArchiveRendererApi = {
  archiveStatus: () => Promise<Reply<ArchiveRendererStatus>>;
  archiveRebuild: () => Promise<Reply<ArchiveRendererRebuildResult>>;
  archiveOpenStatic: () => Promise<Reply<ArchiveRendererOpenResult>>;
};

let initialized = false;
let refreshGeneration = 0;
let busy: 'rebuild' | 'open' | null = null;

function api(): ArchiveRendererApi {
  // Prime owns the preload contract. This renderer slice stays narrow and compiles while that
  // separately-owned AppApi addition lands in the shared worktree.
  return (window as unknown as { api: unknown }).api as ArchiveRendererApi;
}

function host(): HTMLElement {
  const node = document.getElementById('archiveLibraryHost');
  if (!node) throw new Error('Archive workspace host is missing');
  return node;
}

function metric(label: string, value: string): HTMLElement {
  const card = el('article', 'archive-metric');
  card.append(el('span', 'archive-metric-label', () => t(label)), el('strong', 'archive-metric-value', value));
  return card;
}

function surfaceSummary(status: ArchiveRendererStatus): string {
  if (status.disposed) return t('Archive runtime is stopped.');
  if (!status.initialized) return t('Archive is not initialized yet.');
  if (status.lastError) return t('Archive needs attention.');
  if (status.queuedSessions > 0 || status.reconcilingSessions > 0) return t('Archive is catching up.');
  return t('Local archive is ready.');
}

export function archiveWorkspaceLabel(): string {
  return currentLanguage() === 'en' ? 'Archive' : t('Archive workspace');
}

function paintStatus(status: ArchiveRendererStatus): void {
  const summary = document.getElementById('archiveSummary')!;
  const metrics = document.getElementById('archiveMetrics')!;
  const error = document.getElementById('archiveError')!;
  const recovery = document.getElementById('archiveRecoveryState')!;
  ui(summary, 'textContent', () => surfaceSummary(status));
  metrics.replaceChildren(
    metric('Indexed records', status.indexedDocuments === null ? '—' : String(status.indexedDocuments)),
    metric('Queued sessions', String(status.queuedSessions)),
    metric('Reconciling sessions', String(status.reconcilingSessions)),
    metric('Last reconciled', ago(status.lastReconciledAt)),
    metric('Static site derived', ago(status.lastDerivedAt))
  );
  error.hidden = !status.lastError;
  if (status.lastError) ui(error, 'textContent', () => t('Last archive error: {0}', [status.lastError]));
  recovery.dataset.ready = String(status.initialized && !status.disposed && status.lastDerivedAt !== null);
  ui(recovery, 'textContent', () => status.initialized && !status.disposed && status.lastDerivedAt !== null
    ? t('The static archive browser is available through your local archive data.')
    : t('The static archive browser will be available after it is done syncing.'));
}

function paintUnavailable(): void {
  ui(document.getElementById('archiveSummary')!, 'textContent', () => t('Archive status is unavailable.'));
  document.getElementById('archiveMetrics')!.replaceChildren();
  document.getElementById('archiveError')!.hidden = true;
  ui(document.getElementById('archiveRecoveryState')!, 'textContent', () => t('No local archive status could be read.'));
}

function setBusy(next: typeof busy): void {
  busy = next;
  const rebuild = document.getElementById('archiveRebuild') as HTMLButtonElement;
  const open = document.getElementById('archiveOpenStatic') as HTMLButtonElement;
  rebuild.disabled = next !== null;
  open.disabled = next !== null;
  ui(rebuild, 'textContent', () => t(next === 'rebuild' ? 'Rebuilding archive…' : 'Rebuild archive'));
  ui(open, 'textContent', () => t(next === 'open' ? 'Opening Archive Browser…' : 'Open Archive Browser'));
}

function actionMessage(message: () => string, tone: 'info' | 'error' = 'info'): void {
  const node = document.getElementById('archiveActionStatus')!;
  node.dataset.tone = tone;
  ui(node, 'textContent', message);
}

async function rebuildArchive(): Promise<void> {
  if (busy) return;
  setBusy('rebuild');
  try {
    const result = await run(api().archiveRebuild());
    if (!result) {
      actionMessage(() => t('Archive rebuild did not complete.'), 'error');
      return;
    }
    actionMessage(() => t('Archive rebuilt · {0} chats · {1} indexed records', [result.chats, result.indexedDocuments]));
    await refreshArchiveSurface();
  } finally {
    setBusy(null);
  }
}

async function openStaticArchive(): Promise<void> {
  if (busy) return;
  setBusy('open');
  try {
    const result = await run(api().archiveOpenStatic());
    if (!result) {
      actionMessage(() => t('Static archive could not be opened.'), 'error');
      return;
    }
    if (!result.ok) {
      actionMessage(() => t('Static archive could not be opened: {0}', [result.error ?? t('Unknown error')]), 'error');
      return;
    }
    actionMessage(() => t('Archive browser opened.'));
  } finally {
    setBusy(null);
  }
}

export function initArchiveSurface(): void {
  if (initialized) return;
  initialized = true;
  const root = el('section', 'archive-surface');
  const head = el('header', 'archive-head');
  const heading = el('div', 'archive-heading');
  heading.append(el('span', 'archive-eyebrow', () => t('LOCAL RECOVERY')), el('h1', '', archiveWorkspaceLabel),
  el('p', '', () => t('Browse the local chat traces Eve has retained. The static HTML browser is a recovery view, not the archive authority.')));
  head.append(heading);

  const statusCard = el('section', 'archive-status-card');
  statusCard.setAttribute('aria-live', 'polite');
  const summary = el('h2', '', () => t('Open Archive to load local status.'));
  summary.id = 'archiveSummary';
  const metrics = el('div', 'archive-metrics'); metrics.id = 'archiveMetrics';
  const error = el('div', 'archive-error'); error.id = 'archiveError'; error.hidden = true;
  statusCard.append(summary, metrics, error);

  const recoveryCard = el('section', 'archive-recovery-card');
  recoveryCard.append(el('div', 'archive-recovery-copy', () => t('Archive browser')));
  const recoveryState = el('p', '', () => t('Open Archive to check the generated local recovery view.'));
  recoveryState.id = 'archiveRecoveryState';
  recoveryCard.append(recoveryState);

  const actions = el('div', 'archive-actions');
  const rebuild = el('button', 'btn archive-action', () => t('Rebuild archive')) as HTMLButtonElement;
  rebuild.id = 'archiveRebuild'; rebuild.type = 'button';
  const open = el('button', 'btn btn-solid archive-action', () => t('Open Archive Browser')) as HTMLButtonElement;
  open.id = 'archiveOpenStatic'; open.type = 'button';
  actions.append(rebuild, open);
  const actionStatus = el('p', 'archive-action-status'); actionStatus.id = 'archiveActionStatus'; actionStatus.setAttribute('role', 'status');

  const note = el('p', 'archive-boundary', () => t('Archive actions use ParadigmEve’s own archive runtime. This screen never asks for a filesystem path and never embeds local files.'));
  root.append(head, statusCard, recoveryCard, actions, actionStatus, note);
  host().replaceChildren(root);
  rebuild.addEventListener('click', () => { void rebuildArchive(); });
  open.addEventListener('click', () => { void openStaticArchive(); });
}

export async function refreshArchiveSurface(): Promise<void> {
  if (!initialized) initArchiveSurface();
  const generation = ++refreshGeneration;
  const status = await run(api().archiveStatus());
  if (generation !== refreshGeneration) return;
  if (!status) paintUnavailable();
  else paintStatus(status);
}
