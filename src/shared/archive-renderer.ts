/** Minimal archive contract that is safe to expose to the Electron renderer. */

export const ARCHIVE_RENDERER_ERROR_MAX_CHARS = 240;

export interface ArchiveRendererStatus {
  initialized: boolean;
  disposed: boolean;
  queuedSessions: number;
  reconcilingSessions: number;
  lastReconciledAt: number | null;
  lastDerivedAt: number | null;
  lastError: string | null;
  indexedDocuments: number | null;
}

export interface ArchiveRendererRebuildResult {
  chats: number;
  indexedDocuments: number;
}

export type ArchiveRendererOpenResult =
  | { ok: true }
  | { ok: false; error: string };

interface ArchiveRendererStatusSource {
  initialized: boolean;
  disposed: boolean;
  queuedSessions: number;
  reconcilingSessions: number;
  lastReconciledAt: number | null;
  lastDerivedAt: number | null;
  lastError: string | null;
  index: { documents: number } | null;
}

interface ArchiveRendererRebuildSource {
  chats: number;
  index: { documents: number };
}

// Archive errors may originate in fs/path/shell APIs. If one contains anything that looks like
// a native path, keep the useful operation-level fallback instead of trying to redact fragments.
// This makes accidental path disclosure fail closed while preserving bounded path-free details.
const PATH_LIKE_ERROR = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|file:\/\/\/|(?:^|[\s("'`=:])\/[^\s"'`]+)/u;

function boundedErrorText(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= ARCHIVE_RENDERER_ERROR_MAX_CHARS) return normalized;
  return `${normalized.slice(0, ARCHIVE_RENDERER_ERROR_MAX_CHARS - 1)}…`;
}

export function sanitizeArchiveRendererError(value: unknown, fallback: string): string {
  const boundedFallback = boundedErrorText(fallback) || 'Archive operation failed.';
  const safeFallback = PATH_LIKE_ERROR.test(boundedFallback) ? 'Archive operation failed.' : boundedFallback;
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  const normalized = raw.replace(/\s+/gu, ' ').trim();
  if (!normalized || PATH_LIKE_ERROR.test(normalized)) return safeFallback;
  return boundedErrorText(normalized);
}

export function archiveStatusForRenderer(status: ArchiveRendererStatusSource): ArchiveRendererStatus {
  return {
    initialized: status.initialized,
    disposed: status.disposed,
    queuedSessions: status.queuedSessions,
    reconcilingSessions: status.reconcilingSessions,
    lastReconciledAt: status.lastReconciledAt,
    lastDerivedAt: status.lastDerivedAt,
    lastError: status.lastError === null
      ? null
      : sanitizeArchiveRendererError(status.lastError, 'Archive runtime reported an error.'),
    indexedDocuments: status.index?.documents ?? null
  };
}

export function archiveRebuildForRenderer(result: ArchiveRendererRebuildSource): ArchiveRendererRebuildResult {
  return {
    chats: result.chats,
    indexedDocuments: result.index.documents
  };
}
