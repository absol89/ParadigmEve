/**
 * Pure presentation input for the rebuildable static archive viewer.
 *
 * These types deliberately do not import the archive store. Canonical evidence owns chronology,
 * identity and blob authority; a future adapter may project that evidence into this inert shape.
 * The HTML generator never fetches provider data or repairs missing evidence.
 */

export type ArchiveViewCaptureState =
  | 'retained'
  | 'missing'
  | 'provider-only'
  | 'metadata-only'
  | 'capture-error';

export type ArchiveViewChatCaptureState = 'complete' | 'partial' | 'metadata-only';

export interface ArchiveViewMetadataRow {
  label: string;
  value: string;
}

export interface ArchiveViewAsset {
  kind: 'image' | 'file';
  label: string;
  captureState: ArchiveViewCaptureState;
  /** Archive-relative path such as `assets/ab/cdef.png`. Never an absolute/provider URL. */
  localPath?: string;
  mimeType?: string;
  byteLength?: number;
  width?: number;
  height?: number;
  detail?: string;
}

export interface ArchiveViewMessage {
  kind: 'message';
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestampLabel?: string;
  modelLabel?: string;
  assets?: readonly ArchiveViewAsset[];
}

export interface ArchiveViewToolCall {
  name: string;
  status?: string;
  argumentsText?: string;
  resultText?: string;
  assets?: readonly ArchiveViewAsset[];
}

export interface ArchiveViewToolGroup {
  kind: 'tool-group';
  id: string;
  label: string;
  summary?: string;
  calls: readonly ArchiveViewToolCall[];
}

export interface ArchiveViewNotice {
  kind: 'notice';
  id: string;
  tone: 'info' | 'partial' | 'missing';
  title: string;
  text?: string;
}

export interface ArchiveViewContinuation {
  kind: 'continuation';
  id: string;
  label: string;
  detail?: string;
  /** Durable chat id in this same generated view. Missing targets remain explicit, inert text. */
  targetChatId?: string;
}

export type ArchiveViewTranscriptItem =
  | ArchiveViewMessage
  | ArchiveViewToolGroup
  | ArchiveViewNotice
  | ArchiveViewContinuation;

export interface ArchiveViewChat {
  id: string;
  title: string;
  subtitle?: string;
  /** Provider conversation id used only to preserve the original /c/<id> archive hash tail. */
  providerConversationId?: string;
  /** Canonical archive-session update time used only to order the static chat list. */
  updatedAt?: number;
  captureState?: ArchiveViewChatCaptureState;
  metadata?: readonly ArchiveViewMetadataRow[];
  transcript: readonly ArchiveViewTranscriptItem[];
}

/** Lightweight chat metadata used to build the static archive shell without retaining transcripts. */
export type ArchiveViewChatHeader = Omit<ArchiveViewChat, 'transcript'>;

export interface ArchiveHtmlViewModel {
  archiveTitle?: string;
  generatedAtLabel?: string;
  selectedChatId?: string;
  chats: readonly ArchiveViewChat[];
}
