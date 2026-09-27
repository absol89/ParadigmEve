/** Read-only integrity scan over canonical archive evidence and content-addressed bytes. */

import {
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveBlobRef,
  type ArchiveIntegrityIssue,
  type ArchiveIntegrityReport,
  type ArchiveIntegritySessionResult,
  type ArchiveProjectionIssue
} from '../../shared/archive.js';
import { ArchiveStore } from './archive-store.js';

function projectionIssue(sessionId: string, issue: ArchiveProjectionIssue): ArchiveIntegrityIssue {
  const severe = ['invalid-jsonl', 'event-invalid', 'event-sequence', 'duplicate-event-id', 'unsupported-schema'].includes(issue.code);
  return {
    code: issue.code,
    severity: severe ? 'error' : 'warning',
    message: issue.message,
    sessionId,
    ...(issue.eventSeq !== undefined ? { eventSeq: issue.eventSeq } : {})
  };
}

function reportStatus(
  issues: readonly ArchiveIntegrityIssue[],
  sessions: readonly ArchiveIntegritySessionResult[]
): ArchiveIntegrityReport['status'] {
  if (issues.some(issue => issue.severity === 'error')) return 'corrupt';
  return issues.length || sessions.some(session => session.state !== 'complete') ? 'partial' : 'clean';
}

export async function scanArchiveIntegrity(store: ArchiveStore, scannedAt = Date.now()): Promise<ArchiveIntegrityReport> {
  const issues: ArchiveIntegrityIssue[] = [];
  const sessions: ArchiveIntegritySessionResult[] = [];
  const referenced = new Map<string, ArchiveBlobRef>();
  const manifests = new Map<string, Awaited<ReturnType<ArchiveStore['readSession']>>['manifest']>();

  const rootManifest = await store.readArchiveManifest();
  if (rootManifest.state === 'missing') {
    issues.push({ code: 'archive-manifest-missing', severity: 'warning', message: 'archive-manifest.json is missing.' });
  } else if (rootManifest.state === 'partial' || rootManifest.manifest?.schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
    issues.push({ code: 'archive-manifest-invalid', severity: 'error', message: 'archive-manifest.json is invalid or uses an unsupported schema.' });
  }

  for (const sessionId of await store.listSessionIds()) {
    const before = issues.length;
    const read = await store.readSession(sessionId, 0);
    manifests.set(sessionId, read.manifest);
    for (const issue of read.issues) issues.push(projectionIssue(sessionId, issue));
    await store.scanSessionEvents(sessionId, {
      collectLimit: 0,
      onEvent: async event => {
        for (const asset of event.assets) {
          if (asset.blob) referenced.set(asset.blob.sha256, asset.blob);
          if (asset.captureState !== 'retained' || !asset.blob) continue;
          const inspection = await store.blobs.inspect(asset.blob);
          if (inspection.state === 'missing') {
            issues.push({ code: 'missing-blob', severity: 'error', sessionId, eventSeq: event.eventSeq,
              blobSha256: asset.blob.sha256, path: inspection.path,
              message: `Retained asset ${asset.id} references a missing blob.` });
          } else if (inspection.state === 'corrupt') {
            issues.push({ code: 'hash-mismatch', severity: 'error', sessionId, eventSeq: event.eventSeq,
              blobSha256: asset.blob.sha256, path: inspection.path,
              message: `Retained asset ${asset.id} does not match its SHA-256/byte-length record.` });
          }
        }
      }
    });
    sessions.push({ sessionId, state: issues.length === before ? read.state : 'partial', issueCount: issues.length - before });
  }

  const knownSessions = new Set(manifests.keys());
  for (const [sessionId, manifest] of manifests) {
    if (!manifest?.continuation) continue;
    const { predecessorSessionId, successorSessionId } = manifest.continuation;
    for (const [direction, target] of [['predecessor', predecessorSessionId], ['successor', successorSessionId]] as const) {
      if (!target) continue;
      if (target === sessionId || !knownSessions.has(target)) {
        issues.push({ code: 'impossible-lineage', severity: 'error', sessionId,
          message: `${direction} lineage points to ${target === sessionId ? 'the same session' : `missing session ${target}`}.` });
      }
    }
    if (successorSessionId) {
      const successor = manifests.get(successorSessionId);
      if (successor?.continuation?.predecessorSessionId && successor.continuation.predecessorSessionId !== sessionId) {
        issues.push({ code: 'impossible-lineage', severity: 'error', sessionId,
          message: `Successor ${successorSessionId} names a different predecessor.` });
      }
    }
  }

  const stored = await store.blobs.scanStored();
  for (const blob of stored) {
    if (!blob.sha256) {
      issues.push({ code: 'orphan-blob', severity: 'warning', path: blob.path, message: 'Unrecognized file exists in the canonical blob tree.' });
      continue;
    }
    const actual = await store.blobs.hashStoredFile(blob.path);
    if (actual.sha256 !== blob.sha256) {
      issues.push({ code: 'hash-mismatch', severity: 'error', blobSha256: blob.sha256, path: blob.path,
        message: 'Stored blob bytes do not match the SHA-256 encoded by their canonical path.' });
    }
    if (!referenced.has(blob.sha256)) {
      issues.push({ code: 'orphan-blob', severity: 'warning', blobSha256: blob.sha256, path: blob.path,
        message: 'Stored blob has no canonical event reference.' });
    }
  }

  // Lineage issues are discovered after each per-session result is made; fold them into the
  // final session state/count without hiding the session itself.
  for (const session of sessions) {
    const count = issues.filter(issue => issue.sessionId === session.sessionId).length;
    session.issueCount = count;
    if (count > 0) session.state = 'partial';
  }

  return {
    scannedAt,
    status: reportStatus(issues, sessions),
    sessions,
    issues,
    referencedBlobCount: referenced.size,
    storedBlobCount: stored.filter(blob => blob.sha256 !== null).length
  };
}

/** Integrity result is a rebuildable projection; publishing it never rewrites canonical events. */
export async function publishArchiveIntegritySummary(store: ArchiveStore, report: ArchiveIntegrityReport): Promise<void> {
  const current = await store.readArchiveManifest();
  if (current.state !== 'complete' || !current.manifest) throw new Error('ARCHIVE_MANIFEST_UNAVAILABLE');
  await store.publishArchiveManifest({
    ...current.manifest,
    updatedAt: Math.max(current.manifest.updatedAt, report.scannedAt),
    integrity: { scannedAt: report.scannedAt, status: report.status, issueCount: report.issues.length }
  });
}
