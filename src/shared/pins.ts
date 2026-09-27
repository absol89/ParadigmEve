/** Durable Pins/Quilts data shared across the main process and renderer boundary. */

export type PinKind = 'prompt' | 'message' | 'result' | 'plan';
export type QuiltState = 'pinned' | 'archived';

/** Exact local/chat location retained when a transcript message is pinned. */
export interface MessagePinProvenance {
  sessionId: string;
  conversationId: string | null;
  eventSeq: number;
  messageId?: string;
  turnId?: string;
}

/** Exact local/chat location retained when a result/tool row is pinned. */
export interface ResultPinProvenance {
  sessionId: string;
  conversationId: string | null;
  eventSeq: number;
  callId?: string;
  turnId?: string;
}

/** A first-class plan is identified independently of the chat that originally produced it. */
export interface PlanPinProvenance {
  planId: string;
  sourceSessionId?: string | null;
  sourceConversationId?: string | null;
}

/**
 * Small durable pointer used to rehydrate a pinned message thumbnail. Image bytes stay in the
 * session asset/event stores; Pins retain only enough metadata to find the source again and to
 * render an accessible unavailable state if that source later disappears.
 */
export interface PinImageRef {
  source: 'asset' | 'attachment';
  id: string;
  mimeType: string;
  alt?: string;
}

/** Stable source identity shared by persistence and every renderer state projection. */
export type PinSourceIdentity =
  | { kind: 'prompt'; provenance: MessagePinProvenance }
  | { kind: 'message'; provenance: MessagePinProvenance }
  | { kind: 'result'; provenance: ResultPinProvenance }
  | { kind: 'plan'; provenance: PlanPinProvenance };

export function pinSourceKey(value: PinSourceIdentity): string {
  if (value.kind === 'prompt' || value.kind === 'message') {
    const source = value.provenance;
    return source.messageId
      ? `message:${source.sessionId}:message:${source.messageId}`
      : `message:${source.sessionId}:seq:${source.eventSeq}`;
  }
  if (value.kind === 'result') {
    const source = value.provenance;
    return source.callId
      ? `result:${source.sessionId}:call:${source.callId}`
      : `result:${source.sessionId}:seq:${source.eventSeq}`;
  }
  return `plan:${value.provenance.planId}`;
}

interface PinBase {
  id: string;
  /** Required on every Pin. A Pin cannot exist outside exactly one Quilt. */
  quiltId: string;
  /** When this item was added to the Quilt. */
  createdAt: number;
  /**
   * Timestamp of the recorded source item itself (for example the message send/receive time).
   * Optional so Pins saved before chronology snapshots existed remain readable.
   */
  sourceCreatedAt?: number;
  /**
   * Start of the ChatGPT context that contained the source item. Compact & Resume creates a new
   * context while keeping the same durable local session, so equal values deliberately group Pins
   * from the same chat into one sortable band.
   */
  contextCreatedAt?: number;
  /** Small display snapshot; provenance remains the source of identity. */
  title?: string;
  excerpt?: string;
  sourceLabel?: string;
}

export type Pin =
  | (PinBase & { kind: 'prompt'; provenance: MessagePinProvenance; image?: PinImageRef; sticky?: boolean })
  | (PinBase & { kind: 'message'; provenance: MessagePinProvenance; image?: PinImageRef; sticky?: boolean })
  | (PinBase & { kind: 'result'; provenance: ResultPinProvenance })
  | (PinBase & { kind: 'plan'; provenance: PlanPinProvenance; sticky?: boolean });

export interface Quilt {
  id: string;
  title: string;
  description?: string;
  /** Optional safe URL or absolute local resource destination for this Thread/Hotlink. */
  link?: string;
  /** User-maintained opening guidance for this Thread. It is not an ordinary Pin. */
  prompt?: string;
  state: QuiltState;
  /** Wider user-facing Quilts group Threads. Legacy storage keeps these as collection ids. */
  collectionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface QuiltCollection {
  id: string;
  name: string;
  /** Optional durable summary for the wider Quilt itself, distinct from member Thread descriptions. */
  description?: string;
  createdAt: number;
}

export interface PinsLibrarySnapshot {
  version: 1;
  quilts: Quilt[];
  pins: Pin[];
  collections: QuiltCollection[];
}

/** The chooser must make one of these choices. There is no orphan-Pin form. */
export type PinQuiltTarget =
  | { mode: 'existing'; quiltId: string }
  | { mode: 'new'; title: string; collectionIds: string[] };

interface CreatePinBase {
  target: PinQuiltTarget;
  sourceCreatedAt?: number;
  contextCreatedAt?: number;
  title?: string;
  excerpt?: string;
  sourceLabel?: string;
}

export type CreatePinInput =
  | (CreatePinBase & { kind: 'prompt'; provenance: MessagePinProvenance; image?: PinImageRef })
  | (CreatePinBase & { kind: 'message'; provenance: MessagePinProvenance; image?: PinImageRef })
  | (CreatePinBase & { kind: 'result'; provenance: ResultPinProvenance })
  | (CreatePinBase & { kind: 'plan'; provenance: PlanPinProvenance });

export interface CreatePinResult {
  pin: Pin;
  quilt: Quilt;
}
