/** Non-destructive scan adapter: current durable sessions can project into the archive later. */

import type { ArchiveSessionManifest, ArchiveSessionProjection, ArchiveSessionReadResult } from '../../shared/archive.js';
import { ArchiveStore } from './archive-store.js';

export interface ArchiveProjectionScanSource {
  /** Stable source ids. Order is irrelevant; migration sorts/deduplicates them. */
  listSessionIds(): Promise<string[]>;
  /** Return null when a source disappeared between enumeration and projection. */
  projectSession(sessionId: string): Promise<ArchiveSessionProjection | null>;
}

export interface ArchiveRebuildHooks {
  beforeSession?: (sessionId: string) => void | Promise<void>;
  afterSession?: (manifest: ArchiveSessionManifest) => void | Promise<void>;
  skippedSession?: (sessionId: string) => void | Promise<void>;
}

export interface ArchiveRebuildReport {
  scannedSessionIds: string[];
  publishedSessionIds: string[];
  skippedSessionIds: string[];
}

/**
 * Rebuilds canonical archive projections from an external authoritative scan without importing
 * that owner's filesystem/session modules here. The source adapter must retain any claimed blobs
 * before returning events that mark those assets `retained`; ArchiveStore verifies that boundary.
 */
export async function rebuildArchiveFromScan(
  store: ArchiveStore,
  source: ArchiveProjectionScanSource,
  hooks: ArchiveRebuildHooks = {}
): Promise<ArchiveRebuildReport> {
  await store.initialize();
  const scannedSessionIds = [...new Set(await source.listSessionIds())].sort();
  const publishedSessionIds: string[] = [];
  const skippedSessionIds: string[] = [];
  for (const sessionId of scannedSessionIds) {
    await hooks.beforeSession?.(sessionId);
    const projection = await source.projectSession(sessionId);
    if (!projection) {
      skippedSessionIds.push(sessionId);
      await hooks.skippedSession?.(sessionId);
      continue;
    }
    if (projection.manifest.sessionId !== sessionId) throw new Error(`ARCHIVE_SCAN_SESSION_ID_MISMATCH: ${sessionId}`);
    const manifest = await store.publishSession(projection);
    publishedSessionIds.push(sessionId);
    await hooks.afterSession?.(manifest);
  }
  const root = await store.readArchiveManifest();
  if (root.state !== 'complete' || !root.manifest) throw new Error('ARCHIVE_MANIFEST_UNAVAILABLE_AFTER_REBUILD');
  const migratedAt = Date.now();
  await store.publishArchiveManifest({
    ...root.manifest,
    updatedAt: Math.max(root.manifest.updatedAt, migratedAt),
    migratedAt
  });
  return { scannedSessionIds, publishedSessionIds, skippedSessionIds };
}

/**
 * Read-only archive self-scan hook for future index/site rebuilders. Partial sessions are yielded
 * rather than hidden; derived projections decide how to present their explicit issues.
 */
export async function scanArchiveForRebuild(
  store: ArchiveStore,
  visit: (session: ArchiveSessionReadResult) => void | Promise<void>
): Promise<void> {
  for (const sessionId of await store.listSessionIds()) await visit(await store.readSession(sessionId));
}
