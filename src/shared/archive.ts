/** Canonical, provider-neutral chat archive contracts. Presentation/indexes are projections. */

export const ARCHIVE_SCHEMA_VERSION = 1 as const;
export const ARCHIVE_EVENT_SCHEMA_VERSION = 1 as const;
export const ARCHIVE_HASH_ALGORITHM = 'sha256' as const;
export const ARCHIVE_SITE_VERSION = 1 as const;
export const ARCHIVE_INDEX_SCHEMA_VERSION = 1 as const;

export type ArchiveCaptureState = 'complete' | 'partial' | 'metadata-only';
export type ArchiveAssetCaptureState = 'retained' | 'missing' | 'provider-only';
export type ArchiveReadState = 'complete' | 'partial' | 'missing';

export type ArchiveJson = null | boolean | number | string | ArchiveJson[] | { [key: string]: ArchiveJson };

export interface ArchiveFeatureFlags {
  appUploads: boolean;
  nativeProviderAssets: boolean;
  generatedImages: boolean;
  toolAssets: boolean;
}

export interface ArchiveIntegritySummary {
  scannedAt: number;
  status: 'clean' | 'partial' | 'corrupt';
  issueCount: number;
}

export interface ArchiveManifest {
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  createdAt: number;
  updatedAt: number;
  migratedAt: number | null;
  writerVersion: string;
  hashAlgorithm: typeof ARCHIVE_HASH_ALGORITHM;
  siteVersion: typeof ARCHIVE_SITE_VERSION;
  indexSchemaVersion: typeof ARCHIVE_INDEX_SCHEMA_VERSION;
  features: ArchiveFeatureFlags;
  integrity?: ArchiveIntegritySummary;
}

export interface ArchiveBlobRef {
  sha256: string;
  mimeType: string;
  byteLength: number;
  /** Presentation hint only; canonical blob paths are keyed solely by SHA-256. */
  extension?: string;
  width?: number;
  height?: number;
}

export interface ArchiveAssetRef {
  id: string;
  kind: 'image' | 'file' | 'tool-image' | 'generated-image' | 'unknown';
  captureState: ArchiveAssetCaptureState;
  blob?: ArchiveBlobRef;
  fileName?: string;
  providerAssetId?: string;
  error?: string;
}

export interface ArchiveProviderIdentity {
  provider?: string;
  model?: string;
  conversationId?: string;
  messageId?: string;
  turnId?: string;
}

export interface ArchiveSourceRef {
  kind: 'session' | 'input' | 'pin' | 'plan' | 'request' | 'provider' | 'other';
  id: string;
  eventSeq?: number;
}

/**
 * One immutable semantic projection of committed session evidence.
 *
 * `kind` deliberately stays open: the runtime session store owns its native event vocabulary.
 * Archive adapters project those events without making this experiment a second chronology owner.
 */
export interface ArchiveEvent {
  schemaVersion: typeof ARCHIVE_EVENT_SCHEMA_VERSION;
  sessionId: string;
  eventSeq: number;
  eventId: string;
  at: number;
  kind: string;
  actor: 'user' | 'assistant' | 'tool' | 'system' | 'unknown';
  appInputId?: string;
  provider?: ArchiveProviderIdentity;
  assets: ArchiveAssetRef[];
  sourceRefs: ArchiveSourceRef[];
  payload: ArchiveJson;
}

export interface ArchiveContinuation {
  predecessorSessionId?: string;
  successorSessionId?: string;
  providerFromConversationId?: string;
  providerToConversationId?: string;
}

export interface ArchiveSessionManifest {
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  projectId?: string;
  projectPathLabel?: string;
  threadIds: string[];
  quiltIds: string[];
  providerConversationIds: string[];
  continuation?: ArchiveContinuation;
  eventCount: number;
  /** Number of unique archive asset ids referenced by the canonical events. */
  assetCount: number;
  captureState: ArchiveCaptureState;
}

export type ArchiveProjectionIssueCode =
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'events-missing'
  | 'invalid-jsonl'
  | 'event-invalid'
  | 'event-sequence'
  | 'duplicate-event-id'
  | 'event-count-mismatch'
  | 'asset-count-mismatch'
  | 'unsupported-schema'
  | 'event-limit-exceeded';

export interface ArchiveProjectionIssue {
  code: ArchiveProjectionIssueCode;
  message: string;
  line?: number;
  eventSeq?: number;
}

export interface ArchiveSessionReadResult {
  sessionId: string;
  state: ArchiveReadState;
  manifest: ArchiveSessionManifest | null;
  events: ArchiveEvent[];
  issues: ArchiveProjectionIssue[];
}

export type ArchiveBlobInspection =
  | { state: 'present'; ref: ArchiveBlobRef; path: string }
  | { state: 'missing'; ref: ArchiveBlobRef; path: string }
  | { state: 'corrupt'; ref: ArchiveBlobRef; path: string; actualSha256: string; actualByteLength: number };

export type ArchiveIntegrityIssueCode =
  | ArchiveProjectionIssueCode
  | 'archive-manifest-missing'
  | 'archive-manifest-invalid'
  | 'missing-blob'
  | 'hash-mismatch'
  | 'orphan-blob'
  | 'impossible-lineage';

export interface ArchiveIntegrityIssue {
  code: ArchiveIntegrityIssueCode;
  severity: 'warning' | 'error';
  message: string;
  sessionId?: string;
  eventSeq?: number;
  blobSha256?: string;
  path?: string;
}

export interface ArchiveIntegritySessionResult {
  sessionId: string;
  state: ArchiveReadState;
  issueCount: number;
}

export interface ArchiveIntegrityReport {
  scannedAt: number;
  status: 'clean' | 'partial' | 'corrupt';
  sessions: ArchiveIntegritySessionResult[];
  issues: ArchiveIntegrityIssue[];
  referencedBlobCount: number;
  storedBlobCount: number;
}

export interface ArchiveSessionProjection {
  manifest: ArchiveSessionManifest;
  events: ArchiveEvent[];
}
