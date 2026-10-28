/**
 * Durable semantic heartbeat for user work that fell through the gap between ChatGPT prose and
 * ParadigmEve execution.
 *
 * This does not scrape or classify the user's transcript itself. Every 22 minutes it dispatches
 * one review-only maintenance worker owned by the exact, previously tool-proven Prime conversation.
 * The worker decides whether anything needs action and returns that finding to Prime; it never
 * executes user work itself and never commandeers Prime's foreground browser turn.
 */
import { randomUUID } from 'node:crypto';
import {
  PLAN_CATALOG_MAX,
  planIdSchema,
  planProvenanceSchema,
  type PlanLibrary,
  type PlanProvenance,
  type PlanView
} from '../shared/plans.js';
import type { SessionSummary } from '../shared/session.js';
import { currentAgentConversationId } from './agent-identity.js';
import { getConfig } from './config.js';
import { readDurable, readDurableStrict, writeDurableNow } from './durable.js';
import { logInfo, logWarn } from './logger.js';
import {
  listPlans,
  planReviewScopeDigest,
  reconcileReviewedPlanItems,
  withPlanReviewValidationFence,
  type PlanReviewExpectation
} from './plans.js';
import { isChatBlocked } from './session/blocked-chats.js';
import {
  dispatchChatReviewWorker,
  dispatchChatReviewNativeParent,
  enqueueChatReviewFinding,
  chatReviewTransportStage,
  LEGACY_HEARTBEAT_AMBIGUOUS,
  legacyChatReviewActivityAt,
  reconcileHeartbeatFindingQueue,
  retireLegacyChatReviewAttention,
  type ChatReviewAttention,
  type ChatReviewPlanSnapshot
} from './session/input.js';
import { findSessionByConversation, indexedSessions } from './session/store.js';

export const CHAT_REVIEW_HEARTBEAT_MS = 22 * 60 * 1000;
export const CHAT_REVIEW_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const CHAT_REVIEW_RETRY_MS = 60 * 1000;
export const CHAT_REVIEW_PLAN_BATCH_SIZE = 4;
const CHAT_REVIEW_PLAN_CATALOG_MAX = PLAN_CATALOG_MAX;
const CHAT_REVIEW_RECONCILIATION_MAX = 512;
const STATE = 'chat-review-heartbeat';

export interface ChatReviewPlanTarget {
  planId: string;
  updatedAt: number;
  sourceSessionId?: string;
  sourceConversationId?: string;
  sourceThreadId?: string;
}

export const CHAT_REVIEW_PLAN_CLASSIFICATIONS = [
  'ready-to-archive',
  'stale-checklist',
  'tbd',
  'blocked',
  'superseded',
  'awaiting-user'
] as const;
export type ChatReviewPlanClassification = (typeof CHAT_REVIEW_PLAN_CLASSIFICATIONS)[number];

export interface ChatReviewPlanAck extends ChatReviewPlanTarget {
  classification: ChatReviewPlanClassification;
  /** Non-mutating review evidence: exact currently-open items the source proves complete. */
  staleItemIds?: string[];
  mutationRequest?: ChatReviewPlanMutationRequest;
}

export interface ChatReviewPlanMutationRequest {
  requestId: string;
  expectedUpdatedAt: number;
  completedItemIds: string[];
}

export interface ChatReviewPlanSweep {
  remainingPlanIds: string[];
}

export interface ChatReviewPlanReconciliation extends ChatReviewPlanTarget {
  heartbeatKey: string;
  coordinatorSessionId: string;
  itemIds: string[];
  scopeDigest: string;
  createdAt: number;
  provenance?: PlanProvenance;
}

export interface ChatReviewDebt extends Omit<ChatReviewAttention, 'reviewLane'> {
  sessionId: string;
  conversationId: string;
  /** New epochs run only in the app-owned read/review worker. Absent on legacy Prime-owned debt. */
  reviewLane?: 'worker' | 'native-parent';
  /** Absent only on receipt-backed debt written before durable Plan review shipped. */
  planBatch?: ChatReviewPlanTarget[];
  /** Absent only together with planBatch on legacy debt. */
  planAcks?: ChatReviewPlanAck[];
}
type ReviewLaneSelection = 'worker' | 'native-parent' | 'off';
/** Immutable audit custody written before an incompatible epoch is invalidated. */
export interface ChatReviewSupersession {
  debt: ChatReviewDebt;
  supersededAt: number;
  selectedLane: ReviewLaneSelection;
  /** `-after-possible-send`: the old prompt may have reached Prime; it was quiet a full cadence. */
  reason: 'mode-changed' | 'mode-changed-after-possible-send';
}
/**
 * Privacy-safe semantic result of one fully completed review epoch.
 *
 * This is deliberately an enum, never authored prose. `dispatched` means the review found
 * actionable unfinished work and durably returned that finding to Prime before the exact receipt
 * was written. It never means that the heartbeat worker executed the work. `blocked`/`failed` are
 * completed reviews that could not safely determine a disposition.
 */
export const CHAT_REVIEW_COMPLETION_RESULTS = ['completed', 'dispatched', 'blocked', 'failed'] as const;
export type ChatReviewCompletionResult = (typeof CHAT_REVIEW_COMPLETION_RESULTS)[number];
export interface ChatReviewCompletionReceipt {
  key: string;
  sessionId: string;
  conversationId: string;
  requestId: string;
  completedAt: number;
  result: ChatReviewCompletionResult;
  /** App-owned proof added by the lifecycle tool; never accepted from model arguments. */
  reviewLane?: 'worker' | 'native-parent';
  /** Compact provenance-bound handoff for Prime. Required when result=dispatched. */
  finding?: string;
}
export interface ChatReviewPrimeFinding {
  key: string;
  sessionId: string;
  conversationId: string;
  text: string;
  createdAt: number;
}
export interface ChatReviewHeartbeatState {
  lastCompletedAt?: number;
  debt?: ChatReviewDebt;
  lastReceipt?: ChatReviewCompletionReceipt;
  planSweep?: ChatReviewPlanSweep;
  /** Source-proven stale checklist items waiting for the exact ordinary Prime to reconcile. */
  planReconciliations?: ChatReviewPlanReconciliation[];
  pendingFinding?: ChatReviewPrimeFinding;
  /** Overflow custody for previous still-pending findings; file per index, not a lossy ring. */
  findingSpoolRead?: number;
  findingSpoolWrite?: number;
  /** Findings whose native Send was authorized but confirmation was lost. Never auto-resend. */
  uncertainFindings?: ChatReviewPrimeFinding[];
  /** Older uncertain findings are preserved in numbered durable archive slots. */
  uncertainArchiveCount?: number;
  /** Each exact superseded obligation has its own durable audit slot; never a completion receipt. */
  supersessionCount?: number;
}
export type ChatReviewHeartbeatResult = {
  status: 'queued' | 'pending' | 'not-due' | 'no-coordinator' | 'paused';
  nextAt: number;
  sessionId?: string;
  conversationId?: string;
  reason?: 'debt-owner-unavailable' | 'no-successor' | 'no-fresh-coordinator' | 'off' |
    /** Pending: a Native review not yet put into any Prime tool result. Prime has not called Eve since. */
    'awaiting-prime-tool-call' |
    /** Pending: the Native review reached (or was offered to) Prime; no exact receipt yet. */
    'awaiting-native-receipt' |
    'awaiting-worker-receipt' |
    /** Pending: Settings chose another lane, but the old prompt may have reached Prime recently. */
    'mode-change-held';
  /** With a pending reason: when the owed review window closed, i.e. how long it has waited. */
  waitingSince?: number;
  /**
   * With `no-successor`: the saved Eve/Eva identity that could not be used as the successor, or
   * absent when there is none. Diagnostic only — it names why the heartbeat waits, never a target.
   */
  staleIdentity?: string;
};

type Dependencies = {
  readState: () => Promise<ChatReviewHeartbeatState | null>;
  writeState: (state: ChatReviewHeartbeatState) => Promise<void>;
  sessions: () => Promise<SessionSummary[]>;
  uniqueSession: (conversationId: string) => Promise<SessionSummary | null>;
  blocked: (conversationId: string) => boolean;
  enqueue: (sessionId: string, review: ChatReviewAttention) => Promise<unknown>;
  enqueueFinding: (sessionId: string, key: string, text: string) => Promise<{
    state?: string;
    /** Exact unsent user-dismissal tombstone from the input owner (no browser Send). */
    dismissed?: boolean;
    sendAuthorizedAt?: number;
    deliveredAt?: number;
    messageId?: string;
  }>;
  /** fsync an older uncertain finding before removing it from the recent bounded state. */
  archiveUncertainFinding: (index: number, finding: ChatReviewPrimeFinding) => Promise<void>;
  writePendingSpool: (index: number, finding: ChatReviewPrimeFinding) => Promise<void>;
  readPendingSpool: (index: number) => Promise<ChatReviewPrimeFinding | null>;
  archiveSupersession: (index: number, record: ChatReviewSupersession) => Promise<void>;
  /**
   * Refuse to supersede if this epoch may already have crossed browser Send, unless every row for
   * the key has been quiet since `quietBefore` (then `quiet`, with its open transport closed).
   */
  retireAttention: (key: string, quietBefore?: number) => Promise<'retired' | 'none' | 'ambiguous' | 'quiet'>;
  /** Diagnostics only: how far this key's review prompt has travelled toward Prime. */
  transportStage: (key: string) => Promise<'none' | 'queued' | 'offered' | 'delivered' | 'closed'>;
  plans: () => Promise<PlanLibrary>;
  /** Current user authority, rechecked at final receipt; tests can inject an exact value. */
  archiveAuthority: () => boolean;
  planFence: <T>(targets: readonly PlanReviewExpectation[], commit: () => Promise<T>) => Promise<T>;
  makeKey: () => string;
  agentConversation: () => string | null;
  /** Latest transport activity of pre-2.4.0 Prime-composer rows for a review key, or null. */
  legacyActivityAt: (key: string) => Promise<number | null>;
};

const safeTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function safePlanId(value: unknown): value is string {
  return typeof value === 'string' && planIdSchema.safeParse(value).success;
}

function optionalBoundedString(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max);
}

function parsePlanTarget(value: unknown): ChatReviewPlanTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!safePlanId(row.planId) || !safeTime(row.updatedAt) ||
      !optionalBoundedString(row.sourceSessionId, 160) ||
      !optionalBoundedString(row.sourceConversationId, 160) ||
      !optionalBoundedString(row.sourceThreadId, 64) ||
      (row.sourceThreadId !== undefined && !safePlanId(row.sourceThreadId))) return null;
  return {
    planId: row.planId,
    updatedAt: row.updatedAt,
    ...(row.sourceSessionId === undefined ? {} : { sourceSessionId: row.sourceSessionId }),
    ...(row.sourceConversationId === undefined ? {} : { sourceConversationId: row.sourceConversationId }),
    ...(row.sourceThreadId === undefined ? {} : { sourceThreadId: row.sourceThreadId })
  };
}

function parsePlanAck(value: unknown): ChatReviewPlanAck | null {
  const target = parsePlanTarget(value);
  if (!target || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const classification = row.classification;
  if (typeof classification !== 'string' ||
      !(CHAT_REVIEW_PLAN_CLASSIFICATIONS as readonly string[]).includes(classification)) return null;
  let mutationRequest: ChatReviewPlanMutationRequest | undefined;
  if (row.mutationRequest !== undefined) {
    if (!row.mutationRequest || typeof row.mutationRequest !== 'object' || Array.isArray(row.mutationRequest)) return null;
    const request = row.mutationRequest as Record<string, unknown>;
    if (typeof request.requestId !== 'string' || request.requestId.length === 0 || request.requestId.length > 256 ||
        !safeTime(request.expectedUpdatedAt) || !Array.isArray(request.completedItemIds) || request.completedItemIds.length > 100 ||
        !request.completedItemIds.every(safePlanId) || new Set(request.completedItemIds).size !== request.completedItemIds.length) return null;
    mutationRequest = {
      requestId: request.requestId,
      expectedUpdatedAt: request.expectedUpdatedAt,
      completedItemIds: [...request.completedItemIds].sort()
    };
  }
  let staleItemIds: string[] | undefined;
  if (row.staleItemIds !== undefined) {
    if (!Array.isArray(row.staleItemIds) || row.staleItemIds.length === 0 || row.staleItemIds.length > 100 ||
        !row.staleItemIds.every(safePlanId) || new Set(row.staleItemIds).size !== row.staleItemIds.length) return null;
    staleItemIds = [...row.staleItemIds].sort();
  }
  if ((classification === 'stale-checklist') !== Boolean(staleItemIds) ||
      (staleItemIds && mutationRequest)) return null;
  return {
    ...target,
    classification: classification as ChatReviewPlanClassification,
    ...(staleItemIds ? { staleItemIds } : {}),
    ...(mutationRequest ? { mutationRequest } : {})
  };
}

function parsePlanSweep(value: unknown): ChatReviewPlanSweep | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ids = (value as Record<string, unknown>).remainingPlanIds;
  if (!Array.isArray(ids) || ids.length > CHAT_REVIEW_PLAN_CATALOG_MAX || !ids.every(safePlanId) ||
      new Set(ids).size !== ids.length) return null;
  return { remainingPlanIds: [...ids] };
}

function parsePlanReconciliation(value: unknown): ChatReviewPlanReconciliation | null {
  const target = parsePlanTarget(value);
  if (!target || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.heartbeatKey !== 'string' || row.heartbeatKey.length === 0 || row.heartbeatKey.length > 512 ||
      typeof row.coordinatorSessionId !== 'string' || row.coordinatorSessionId.length < 8 || row.coordinatorSessionId.length > 160 ||
      !Array.isArray(row.itemIds) || row.itemIds.length === 0 || row.itemIds.length > 100 ||
      !row.itemIds.every(safePlanId) || new Set(row.itemIds).size !== row.itemIds.length ||
      typeof row.scopeDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(row.scopeDigest) ||
      !safeTime(row.createdAt)) return null;
  const provenance = row.provenance === undefined ? undefined : planProvenanceSchema.safeParse(row.provenance);
  if (provenance !== undefined && !provenance.success) return null;
  return {
    ...target,
    heartbeatKey: row.heartbeatKey,
    coordinatorSessionId: row.coordinatorSessionId,
    itemIds: [...row.itemIds].sort(),
    scopeDigest: row.scopeDigest.toLowerCase(),
    createdAt: row.createdAt,
    ...(provenance === undefined ? {} : { provenance: provenance.data })
  };
}

/** Positive recorder evidence that this coordinator has no live turn to finish the owed review. */
function coordinatorTurnRetired(session: SessionSummary): boolean {
  return session.activeTurnId === null && (session.lastTurnOutcome === 'stalled' || session.lastTurnOutcome === 'failed');
}

function parseDebt(value: unknown): ChatReviewDebt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!(typeof row.key === 'string' && row.key.length > 0 && row.key.length <= 512 &&
    safeTime(row.sinceAt) && safeTime(row.untilAt) && row.untilAt >= row.sinceAt &&
    typeof row.sessionId === 'string' && row.sessionId.length >= 8 && row.sessionId.length <= 64 &&
    typeof row.conversationId === 'string' && row.conversationId.length >= 8 && row.conversationId.length <= 256 &&
    (row.reviewLane === undefined || row.reviewLane === 'worker' || row.reviewLane === 'native-parent'))) return null;
  const legacyPlanDebt = row.planBatch === undefined && row.planAcks === undefined;
  if ((row.planBatch === undefined) !== (row.planAcks === undefined)) return null;
  let planBatch: ChatReviewPlanTarget[] | undefined;
  let planAcks: ChatReviewPlanAck[] | undefined;
  if (!legacyPlanDebt) {
    if (!Array.isArray(row.planBatch) || row.planBatch.length > CHAT_REVIEW_PLAN_BATCH_SIZE ||
        !Array.isArray(row.planAcks) || row.planAcks.length > CHAT_REVIEW_PLAN_BATCH_SIZE) return null;
    planBatch = row.planBatch.map(parsePlanTarget).filter((target): target is ChatReviewPlanTarget => target !== null);
    planAcks = row.planAcks.map(parsePlanAck).filter((ack): ack is ChatReviewPlanAck => ack !== null);
    if (planBatch.length !== row.planBatch.length || planAcks.length !== row.planAcks.length ||
        new Set(planBatch.map(target => target.planId)).size !== planBatch.length ||
        new Set(planAcks.map(ack => ack.planId)).size !== planAcks.length) return null;
    const batchIds = new Set(planBatch.map(target => target.planId));
    if (planAcks.some(ack => !batchIds.has(ack.planId))) return null;
  }
  return {
    key: row.key,
    sinceAt: row.sinceAt,
    untilAt: row.untilAt,
    sessionId: row.sessionId,
    conversationId: row.conversationId,
    ...(row.reviewLane === 'worker' || row.reviewLane === 'native-parent' ? { reviewLane: row.reviewLane } : {}),
    ...(planBatch === undefined ? {} : { planBatch, planAcks: planAcks! })
  };
}

function parseReceipt(value: unknown): ChatReviewCompletionReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return typeof row.key === 'string' && row.key.length > 0 && row.key.length <= 512 &&
    typeof row.sessionId === 'string' && row.sessionId.length >= 8 && row.sessionId.length <= 64 &&
    typeof row.conversationId === 'string' && row.conversationId.length >= 8 && row.conversationId.length <= 256 &&
    typeof row.requestId === 'string' && row.requestId.length > 0 && row.requestId.length <= 256 &&
    safeTime(row.completedAt) &&
    (row.reviewLane === undefined || row.reviewLane === 'worker' || row.reviewLane === 'native-parent') &&
    (row.finding === undefined || (typeof row.finding === 'string' && row.finding.trim().length > 0 && row.finding.length <= 6000)) &&
    (row.result === undefined || (typeof row.result === 'string' && (CHAT_REVIEW_COMPLETION_RESULTS as readonly string[]).includes(row.result)))
    ? {
        key: row.key,
        sessionId: row.sessionId,
        conversationId: row.conversationId,
        requestId: row.requestId,
        completedAt: row.completedAt,
        // Receipts written before the result enum existed semantically meant only "review
        // completed". Preserve that exact meaning rather than rejecting old durable state.
        result: (row.result ?? 'completed') as ChatReviewCompletionResult,
        ...(row.reviewLane === 'worker' || row.reviewLane === 'native-parent' ? { reviewLane: row.reviewLane } : {}),
        ...(row.finding === undefined ? {} : { finding: row.finding })
      }
    : null;
}

function parsePendingFinding(value: unknown): ChatReviewPrimeFinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return typeof row.key === 'string' && row.key.length > 0 && row.key.length <= 512 &&
    typeof row.sessionId === 'string' && row.sessionId.length >= 8 && row.sessionId.length <= 64 &&
    typeof row.conversationId === 'string' && row.conversationId.length >= 8 && row.conversationId.length <= 256 &&
    typeof row.text === 'string' && row.text.trim().length > 0 && row.text.length <= 6000 && safeTime(row.createdAt)
    ? { key: row.key, sessionId: row.sessionId, conversationId: row.conversationId, text: row.text, createdAt: row.createdAt }
    : null;
}

const defaults: Dependencies = {
  async readState() {
    const raw = await readDurable<unknown>(STATE);
    if (raw === null || raw === undefined) return null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The chat review heartbeat state could not be read safely');
    const value = raw as Record<string, unknown>;
    // 2.0.19 stamped this timestamp after queueing, before the model had completed the review.
    // It is therefore deliberately not promoted to a completion cursor on upgrade. A legacy-only
    // row causes one conservative fresh review, then the receipt-backed state replaces it.
    if (safeTime(value.lastQueuedAt) && value.lastCompletedAt === undefined && value.debt === undefined && value.lastReceipt === undefined) return null;
    if (value.lastQueuedAt !== undefined) throw new Error('The chat review heartbeat state has mixed legacy and receipt-backed fields');
    const state: ChatReviewHeartbeatState = {};
    if (value.lastCompletedAt !== undefined) {
      if (!safeTime(value.lastCompletedAt)) throw new Error('The chat review completion cursor is invalid');
      state.lastCompletedAt = value.lastCompletedAt;
    }
    if (value.debt !== undefined) {
      const debt = parseDebt(value.debt);
      if (!debt) throw new Error('The durable chat review debt is invalid');
      state.debt = debt;
    }
    if (value.lastReceipt !== undefined) {
      const receipt = parseReceipt(value.lastReceipt);
      if (!receipt) throw new Error('The durable chat review receipt is invalid');
      state.lastReceipt = receipt;
    }
    if (value.planSweep !== undefined) {
      const planSweep = parsePlanSweep(value.planSweep);
      if (!planSweep) throw new Error('The durable chat review Plan sweep is invalid');
      state.planSweep = planSweep;
    }
    if (value.planReconciliations !== undefined) {
      if (!Array.isArray(value.planReconciliations) || value.planReconciliations.length > CHAT_REVIEW_RECONCILIATION_MAX) {
        throw new Error('The durable chat review Plan reconciliations are invalid');
      }
      const reconciliations = value.planReconciliations.map(parsePlanReconciliation);
      if (reconciliations.some(item => item === null) ||
          new Set((reconciliations as ChatReviewPlanReconciliation[]).map(item => item.planId)).size !== reconciliations.length) {
        throw new Error('The durable chat review Plan reconciliations are invalid');
      }
      state.planReconciliations = reconciliations as ChatReviewPlanReconciliation[];
    }
    if (value.pendingFinding !== undefined) {
      const pendingFinding = parsePendingFinding(value.pendingFinding);
      if (!pendingFinding) throw new Error('The durable chat review Prime finding is invalid');
      state.pendingFinding = pendingFinding;
    }
    if (value.findingSpoolRead !== undefined || value.findingSpoolWrite !== undefined) {
      if (!safeTime(value.findingSpoolRead) || !safeTime(value.findingSpoolWrite) ||
          value.findingSpoolRead > value.findingSpoolWrite) {
        throw new Error('The durable chat review finding spool cursor is invalid');
      }
      state.findingSpoolRead = value.findingSpoolRead;
      state.findingSpoolWrite = value.findingSpoolWrite;
    }
    if (value.uncertainFindings !== undefined) {
      if (!Array.isArray(value.uncertainFindings) || value.uncertainFindings.length > 8) {
        throw new Error('The durable chat review uncertain findings are invalid');
      }
      const findings = value.uncertainFindings.map(parsePendingFinding);
      if (findings.some(finding => finding === null)) throw new Error('The durable chat review uncertain findings are invalid');
      state.uncertainFindings = findings as ChatReviewPrimeFinding[];
    }
    if (value.uncertainArchiveCount !== undefined) {
      if (!safeTime(value.uncertainArchiveCount)) throw new Error('The durable chat review uncertain archive cursor is invalid');
      state.uncertainArchiveCount = value.uncertainArchiveCount;
    }
    if (value.supersessionCount !== undefined) {
      if (!safeTime(value.supersessionCount)) throw new Error('The durable chat review supersession cursor is invalid');
      state.supersessionCount = value.supersessionCount;
    }
    if (state.debt?.planBatch !== undefined && !state.planSweep) {
      throw new Error('The durable chat review Plan debt has no sweep cursor');
    }
    if (state.debt?.planBatch !== undefined && state.planSweep) {
      const remaining = new Set(state.planSweep.remainingPlanIds);
      if (state.debt.planBatch.some(target => !remaining.has(target.planId))) {
        throw new Error('The durable chat review Plan batch is outside the sweep cursor');
      }
    }
    if (state.lastReceipt && state.lastCompletedAt === undefined) throw new Error('The chat review receipt has no completion cursor');
    return state;
  },
  writeState: async (state) => {
    await writeDurableNow(STATE, state);
    publishPublicStatus(state);
  },
  sessions: indexedSessions,
  // Historical lineage is needed only to carry an already-existing debt across an exact
  // Compact & Resume A→B rebind. Callers below still require the durable session id and current
  // executable conversation to agree before transport or completion authority moves to B.
  uniqueSession: (conversationId) => findSessionByConversation(conversationId, { includeHistorical: true, requireUnique: true }),
  blocked: isChatBlocked,
  // Prime remains the durable debt owner while review executes in an app-owned worker lane.
  enqueue: (sessionId, review) => review.reviewLane === 'native-parent'
    ? dispatchChatReviewNativeParent(sessionId, review)
    : dispatchChatReviewWorker(sessionId, review),
  enqueueFinding: (sessionId, key, text) => enqueueChatReviewFinding(sessionId, key, text),
  archiveUncertainFinding: (index, finding) =>
    writeDurableNow(`chat-review-uncertain-${index.toString(36)}`, finding),
  writePendingSpool: (index, finding) =>
    writeDurableNow(`chat-review-finding-${index.toString(36)}`, finding),
  archiveSupersession: (index, record) =>
    writeDurableNow(`chat-review-superseded-${index.toString(36)}`, record),
  retireAttention: (key, quietBefore) => retireLegacyChatReviewAttention(key, 'mode-changed', quietBefore),
  transportStage: (key) => chatReviewTransportStage(key),
  async readPendingSpool(index) {
    const row = await readDurableStrict<unknown>(`chat-review-finding-${index.toString(36)}`);
    const finding = parsePendingFinding(row);
    if (!finding) throw new Error('A durable chat review finding spool entry is missing or invalid');
    return finding;
  },
  plans: listPlans,
  archiveAuthority: () => getConfig().eveAuthority?.archiveCompletedWork === true,
  planFence: withPlanReviewValidationFence,
  makeKey: () => `heartbeat:${randomUUID()}`,
  agentConversation: currentAgentConversationId,
  legacyActivityAt: (key) => legacyChatReviewActivityAt(key)
};

let heartbeatChain: Promise<unknown> = Promise.resolve();
function serialHeartbeat<T>(work: () => Promise<T>): Promise<T> {
  const result = heartbeatChain.then(work, work);
  heartbeatChain = result.catch(() => undefined);
  return result;
}

function planTarget(plan: PlanView): ChatReviewPlanTarget {
  return {
    planId: plan.id,
    updatedAt: plan.updatedAt,
    ...(plan.provenance?.sessionId ? { sourceSessionId: plan.provenance.sessionId } : {}),
    ...(plan.provenance?.conversationId ? { sourceConversationId: plan.provenance.conversationId } : {}),
    ...(plan.provenance?.threadId ? { sourceThreadId: plan.provenance.threadId } : {})
  };
}

function samePlanTarget(left: ChatReviewPlanTarget, right: ChatReviewPlanTarget): boolean {
  return left.planId === right.planId && left.updatedAt === right.updatedAt &&
    left.sourceSessionId === right.sourceSessionId &&
    left.sourceConversationId === right.sourceConversationId &&
    left.sourceThreadId === right.sourceThreadId;
}

function planSnapshot(plan: PlanView): ChatReviewPlanSnapshot {
  return {
    id: plan.id,
    updatedAt: plan.updatedAt,
    title: plan.title,
    audience: plan.audience,
    readyToArchive: plan.readyToArchive,
    items: plan.items.map(item => ({ id: item.id, text: item.text, status: item.status })),
    ...(plan.provenance ? {
      provenance: {
        ...(plan.provenance.sessionId ? { sessionId: plan.provenance.sessionId } : {}),
        ...(plan.provenance.conversationId ? { conversationId: plan.provenance.conversationId } : {}),
        ...(plan.provenance.threadId ? { threadId: plan.provenance.threadId } : {}),
        ...(plan.provenance.label ? { label: plan.provenance.label } : {})
      }
    } : {}),
    ...(plan.worker ? { worker: { ...plan.worker } } : {})
  };
}

function checkedPlanLibrary(library: PlanLibrary): PlanLibrary {
  const all = [...library.live, ...library.done];
  if (all.length > CHAT_REVIEW_PLAN_CATALOG_MAX || new Set(all.map(plan => plan.id)).size !== all.length) {
    throw new Error('The Plan catalog cannot be used safely for chat review');
  }
  return library;
}

function selectPlanReviewBatch(
  state: ChatReviewHeartbeatState | null,
  library: PlanLibrary
): { sweep: ChatReviewPlanSweep; targets: ChatReviewPlanTarget[]; snapshots: ChatReviewPlanSnapshot[] } {
  const checked = checkedPlanLibrary(library);
  const liveById = new Map(checked.live.map(plan => [plan.id, plan]));
  const pendingReconciliationIds = new Set((state?.planReconciliations ?? [])
    .filter(reconciliation => {
      const live = liveById.get(reconciliation.planId);
      return Boolean(live && samePlanTarget(planTarget(live), reconciliation));
    })
    .map(reconciliation => reconciliation.planId));
  let remainingPlanIds = (state?.planSweep?.remainingPlanIds ?? [])
    .filter(id => liveById.has(id) && !pendingReconciliationIds.has(id));
  if (remainingPlanIds.length === 0) {
    // listPlans() already has stable Live ordering. Keep that ordering within each audience while
    // putting human commitments before worker/helper bookkeeping at the start of every cycle.
    remainingPlanIds = [
      ...checked.live.filter(plan => plan.audience === 'human' && !pendingReconciliationIds.has(plan.id)).map(plan => plan.id),
      ...checked.live.filter(plan => plan.audience === 'eve' && !pendingReconciliationIds.has(plan.id)).map(plan => plan.id)
    ];
  }
  const selected = remainingPlanIds.slice(0, CHAT_REVIEW_PLAN_BATCH_SIZE).map(id => liveById.get(id)!);
  return {
    sweep: { remainingPlanIds },
    targets: selected.map(planTarget),
    snapshots: selected.map(planSnapshot)
  };
}

function stateWithDebt(state: ChatReviewHeartbeatState | null, debt: ChatReviewDebt): ChatReviewHeartbeatState {
  return {
    ...(state?.lastCompletedAt === undefined ? {} : { lastCompletedAt: state.lastCompletedAt }),
    ...(state?.lastReceipt ? { lastReceipt: state.lastReceipt } : {}),
    ...(state?.planSweep ? { planSweep: state.planSweep } : {}),
    ...(state?.planReconciliations?.length ? { planReconciliations: state.planReconciliations } : {}),
    ...(state?.pendingFinding ? { pendingFinding: state.pendingFinding } : {}),
    ...(state?.findingSpoolWrite !== undefined ? { findingSpoolRead: state.findingSpoolRead, findingSpoolWrite: state.findingSpoolWrite } : {}),
    ...(state?.uncertainFindings?.length ? { uncertainFindings: state.uncertainFindings } : {}),
    ...(state?.uncertainArchiveCount ? { uncertainArchiveCount: state.uncertainArchiveCount } : {}),
    ...(state?.supersessionCount !== undefined ? { supersessionCount: state.supersessionCount } : {}),
    debt
  };
}

/**
 * A Settings mode change invalidates the old lane's receipt capability without declaring its
 * work complete. Keep the exact previous debt (including Plan revisions/ACKs) in an fsynced
 * audit slot before removing the live blockage; the completion cursor never advances here.
 *
 * The browser-owned attention outbox is fenced first: only definitely pre-Send messages may
 * be cancelled. A possible Send leaves the old debt intact while it is recent, so a new review
 * cannot race it. When another lane is selected, that hold ends once the old prompt has been
 * quiet for a full cadence and its Prime is not mid-turn: a Native prompt handed to an idle Prime
 * may never be answered, and holding for it stopped every Auditable review after the switch.
 * Its window is not lost: the completion cursor stays put, so the next epoch reviews it again.
 */
async function supersedeIncompatibleReviewDebt(
  now: number, state: ChatReviewHeartbeatState | null, selectedLane: ReviewLaneSelection,
  deps: Dependencies
): Promise<{ state: ChatReviewHeartbeatState | null; blocked: boolean }> {
  const old = state?.debt;
  if (!old || (selectedLane !== 'off' && (old.reviewLane ?? 'worker') === selectedLane)) {
    return { state, blocked: false };
  }
  let retirement = await deps.retireAttention(old.key);
  if (retirement === 'ambiguous' && selectedLane !== 'off') {
    // OFF launches nothing, so it never needs to end the hold; returning to the old lane resumes it.
    // A Prime that is mid-turn and recorded work within the cadence may be answering the old
    // prompt right now, so it keeps the hold; so does an owner lookup that fails. A turn whose end
    // was never observed but shows no activity for a full cadence does not hold it forever.
    const quietBefore = now - CHAT_REVIEW_HEARTBEAT_MS;
    const owner = await exactDebtOwner(old, deps).catch(() => undefined);
    const ownerWorking = owner !== null && (owner === undefined ||
      (Boolean(owner.activeTurnId) && Math.max(owner.lastToolCallAt ?? 0, owner.updatedAt) > quietBefore));
    if (!ownerWorking) retirement = await deps.retireAttention(old.key, quietBefore);
  }
  if (retirement === 'ambiguous') return { state, blocked: true };
  const index = state.supersessionCount ?? 0;
  if (!Number.isSafeInteger(index + 1)) throw new Error('The chat review supersession audit index is exhausted');
  const possiblySent = retirement === 'quiet';
  await deps.archiveSupersession(index, {
    debt: old, supersededAt: now, selectedLane, reason: possiblySent ? 'mode-changed-after-possible-send' : 'mode-changed'
  });
  const next: ChatReviewHeartbeatState = { ...state, supersessionCount: index + 1 };
  delete next.debt;
  await deps.writeState(next);
  (possiblySent ? logWarn : logInfo)(`chat review heartbeat: superseded ${old.reviewLane ?? 'legacy-worker'} epoch ${old.key} ` +
    `for ${selectedLane}${possiblySent ? ' after its possibly-sent prompt was quiet for a full cadence' : ''}; ` +
    'exact debt archived, review coverage and Plan sweep preserved');
  return { state: next, blocked: false };
}

/** Called by the existing Settings transaction as well as the existing semantic timer. */
export function reconcileChatReviewHeartbeatMode(
  now = Date.now(), selectedMode: 'off' | 'auditable-chat' | 'native-subagent' = 'off',
  dependencies: Partial<Dependencies> = {}
): Promise<'unchanged' | 'superseded' | 'ambiguous'> {
  return serialHeartbeat(async () => {
    const deps = { ...defaults, ...dependencies };
    const before = await deps.readState();
    const selectedLane: ReviewLaneSelection = selectedMode === 'off' ? 'off' :
      selectedMode === 'native-subagent' ? 'native-parent' : 'worker';
    const outcome = await supersedeIncompatibleReviewDebt(now, before, selectedLane, deps);
    return outcome.blocked ? 'ambiguous' : outcome.state?.debt !== before?.debt ? 'superseded' : 'unchanged';
  });
}

function planBatchBelongsToSweep(state: ChatReviewHeartbeatState | null, debt: ChatReviewDebt): boolean {
  if (debt.planBatch === undefined) return true;
  if (!state?.planSweep) return false;
  const remaining = new Set(state.planSweep.remainingPlanIds);
  return debt.planBatch.every(target => remaining.has(target.planId));
}

function planById(library: PlanLibrary): Map<string, PlanView> {
  return new Map([...library.live, ...library.done].map(plan => [plan.id, plan]));
}

function refreshDebtPlanBatch(debt: ChatReviewDebt, library: PlanLibrary): ChatReviewDebt {
  if (debt.planBatch === undefined || debt.planAcks === undefined) return debt;
  const checked = checkedPlanLibrary(library);
  const byId = planById(checked);
  const liveIds = new Set(checked.live.map(plan => plan.id));
  const currentTargets = new Map<string, ChatReviewPlanTarget>();
  const planBatch = debt.planBatch.map(target => {
    const current = byId.get(target.planId);
    if (!current) throw new Error('A durable chat review Plan target is unavailable');
    const next = planTarget(current);
    currentTargets.set(target.planId, next);
    return next;
  });
  // A Live Plan that changed after acknowledgement must be reviewed again. Archiving is a newer
  // authoritative disposition, so an acknowledgement made before archive remains sufficient.
  const planAcks = debt.planAcks.filter(ack =>
    !liveIds.has(ack.planId) || samePlanTarget(ack, currentTargets.get(ack.planId)!));
  const batchChanged = planBatch.some((target, index) => !samePlanTarget(target, debt.planBatch![index]!));
  const acksChanged = planAcks.length !== debt.planAcks.length;
  return batchChanged || acksChanged ? { ...debt, planBatch, planAcks } : debt;
}

async function attentionForDebt(
  debt: ChatReviewDebt,
  deps: Dependencies,
  knownLibrary?: PlanLibrary
): Promise<ChatReviewAttention> {
  const base: ChatReviewAttention = { key: debt.key, sinceAt: debt.sinceAt, untilAt: debt.untilAt,
    ...(debt.reviewLane === 'native-parent' ? { reviewLane: 'native-parent' as const } : {}) };
  if (debt.planBatch === undefined) return base;
  const library = checkedPlanLibrary(knownLibrary ?? await deps.plans());
  const byId = planById(library);
  const acknowledgedIds = new Set((debt.planAcks ?? []).map(ack => ack.planId));
  const snapshots = debt.planBatch
    .filter(target => !acknowledgedIds.has(target.planId))
    .map(target => byId.get(target.planId));
  if (snapshots.some(plan => plan === undefined)) {
    throw new Error('A durable chat review Plan target is unavailable');
  }
  return { ...base, plans: snapshots.map(plan => planSnapshot(plan!)) };
}

/**
 * A bounded, read-only projection for the app-owned reviewer to inspect instead of the full,
 * single-line plans.json catalog. The caller must separately prove exact heartbeat-worker
 * ownership before exposing this result; this helper never grants permission to read it.
 * Revisions and provenance are sourced from the live Plan library, not inferred from the debt.
 */
export async function currentChatReviewPlanEvidence(
  dependencies: Partial<Dependencies> = {}
): Promise<{
  key: string;
  targets: ChatReviewPlanTarget[];
  acknowledgedPlanIds: string[];
  plans: ChatReviewPlanSnapshot[];
} | null> {
  const deps = { ...defaults, ...dependencies };
  const state = await deps.readState();
  const debt = state?.debt;
  if (!debt?.planBatch || !debt.planAcks) return null;
  const attention = await attentionForDebt(debt, deps);
  return {
    key: debt.key,
    targets: debt.planBatch,
    acknowledgedPlanIds: debt.planAcks.map(ack => ack.planId),
    plans: attention.plans ?? []
  };
}

/** Newest exact non-worker conversation that has positively used Eve's connector. */
export function chatReviewCoordinatorCandidates(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions
    .filter((session) => Boolean(
      session.conversationId &&
      session.endedAt === null &&
      typeof session.lastToolCallAt === 'number' &&
      session.toolCalls > 0 &&
      !coordinatorTurnRetired(session) &&
      session.origin?.kind !== 'worker' &&
      session.origin?.kind !== 'helper'
    ))
    .sort((left, right) =>
      (right.lastToolCallAt ?? 0) - (left.lastToolCallAt ?? 0) ||
      right.updatedAt - left.updatedAt ||
      right.id.localeCompare(left.id)
    );
}

type ExactCoordinator = SessionSummary & { conversationId: string };

/**
 * Prefer the product's dedicated Eve/Eva identity when it names a current ordinary session.
 *
 * Heartbeat predates `agent-identity.ts` and historically inferred its coordinator from recent
 * attributed tool calls. That works only while Companion request attribution is healthy: a run of
 * otherwise valid calls filed under Unattributed leaves the real Eve/Eva session with no new tool
 * evidence and can make the heartbeat silently report `no-coordinator` forever. The dedicated
 * identity is stronger evidence — it is claimed only from an exact browser ACK and transferred only
 * by the proven Compact & Resume commit — so it is safe to use even when recent tool attribution is
 * temporarily unavailable. This chooses a browser review target only; it grants no tool authority.
 */
async function installationCoordinator(
  identityConversationId: string,
  deps: Dependencies,
  excludeSessionId: string | null = null,
  workerLane = false
): Promise<ExactCoordinator | null> {
  // `uniqueSession()` includes exact historical chatIds. A stale product-identity pointer can
  // therefore still name pre-compaction chat A while the same durable session is currently attached
  // to B. That A→B lineage is exact continuation evidence, so heartbeat may target current B without
  // mutating product identity or granting B any MCP/tool authority. Ambiguous lineage returns null.
  const session = await deps.uniqueSession(identityConversationId);
  if (!session || session.id === excludeSessionId || !session.conversationId ||
      !session.chatIds.includes(identityConversationId) || !session.chatIds.includes(session.conversationId) ||
      deps.blocked(session.conversationId) || session.endedAt !== null ||
      // A stalled/failed last turn matters only to a lane that types into this chat. The worker
      // lane reviews in its own chat, and a stalled Prime is what it exists to catch: requiring a
      // fresh Prime turn paused every review until someone nudged Eve (laptop, 2026-10-20).
      (!workerLane && coordinatorTurnRetired(session)) ||
      session.origin?.kind === 'worker' || session.origin?.kind === 'helper') return null;
  return session as ExactCoordinator;
}

async function exactDebtOwner(debt: ChatReviewDebt, deps: Dependencies): Promise<ExactCoordinator | null> {
  if (deps.blocked(debt.conversationId)) return null;
  const session = await deps.uniqueSession(debt.conversationId);
  if (!session || session.id !== debt.sessionId || !session.chatIds.includes(debt.conversationId) || !session.conversationId ||
      deps.blocked(session.conversationId) ||
      session.origin?.kind === 'worker' || session.origin?.kind === 'helper') return null;
  return session as ExactCoordinator;
}

async function exactCoordinator(debt: ChatReviewDebt, deps: Dependencies): Promise<ExactCoordinator | null> {
  const session = await exactDebtOwner(debt, deps);
  return session?.endedAt === null ? session : null;
}

/**
 * Resolve the one opaque heartbeat capability back to its already-durable coordinator lineage.
 *
 * Scheduled/headless ChatGPT turns can reach MCP without a Companion page request-id correlation.
 * The heartbeat key is different: it is random, durably bound to one exact session/conversation,
 * and printed only in the browser-authored heartbeat prompt after that debt was committed. It may
 * therefore recover that *existing* lineage, but never choose a coordinator by recency/title or
 * create a new owner. Once the debt is completed/replaced the key immediately stops resolving.
 */
export async function resolveChatReviewContinuity(
  key: string,
  dependencies: Partial<Dependencies> = {}
): Promise<{ sessionId: string; conversationId: string } | null> {
  if (!key || key.length > 512) return null;
  const deps = { ...defaults, ...dependencies };
  const state = await deps.readState();
  const debt = state?.debt;
  if (!debt || debt.key !== key) return null;
  const coordinator = await exactCoordinator(debt, deps);
  if (!coordinator) return null;
  return { sessionId: coordinator.id, conversationId: coordinator.conversationId };
}

/** New heartbeat epochs are worker-owned; legacy durable debt remains Prime-compatible. */
export async function chatReviewRequiresWorker(
  key: string,
  dependencies: Partial<Dependencies> = {}
): Promise<boolean> {
  if (!key || key.length > 512) return false;
  const deps = { ...defaults, ...dependencies };
  const state = await deps.readState();
  return state?.debt?.key === key && state.debt.reviewLane === 'worker';
}
/** A native-child's output is interpreted and acknowledged only by this exact Prime parent. */
export async function chatReviewRequiresNativeParent(key: string, dependencies: Partial<Dependencies> = {}): Promise<boolean> {
  if (!key || key.length > 512) return false;
  const deps = { ...defaults, ...dependencies };
  const state = await deps.readState();
  return state?.debt?.key === key && state.debt.reviewLane === 'native-parent';
}

/** New exact ordinary coordinator for a fresh epoch or a canonical retired/stalled-owner transfer. */
async function newestCoordinator(
  sessions: readonly SessionSummary[],
  deps: Dependencies,
  excludeSessionId: string | null = null,
  workerLane = false
): Promise<ExactCoordinator | null> {
  const identityConversationId = deps.agentConversation();
  if (identityConversationId) {
    // Once the installation has an explicit Eve/Eva identity, never fall back to a merely recent
    // tool-proven chat if that exact identity/lineage cannot be resolved safely. The latter would
    // turn a stale or ambiguous product owner into permission to wake an unrelated conversation.
    return installationCoordinator(identityConversationId, deps, excludeSessionId, workerLane);
  }
  for (const candidate of chatReviewCoordinatorCandidates(sessions)) {
    if (candidate.id === excludeSessionId) continue;
    const conversationId = candidate.conversationId!;
    if (deps.blocked(conversationId)) continue;
    const unique = await deps.uniqueSession(conversationId);
    if (!unique || unique.id !== candidate.id || unique.conversationId !== conversationId ||
        coordinatorTurnRetired(unique) ||
        unique.origin?.kind === 'worker' || unique.origin?.kind === 'helper') continue;
    return unique as ExactCoordinator;
  }
  return null;
}

function receiptMatchesDebt(receipt: ChatReviewCompletionReceipt, debt: ChatReviewDebt, coordinator: ExactCoordinator): boolean {
  return receipt.key === debt.key && receipt.sessionId === debt.sessionId && receipt.conversationId === coordinator.conversationId &&
    receipt.requestId.length > 0 && receipt.requestId.length <= 256 && safeTime(receipt.completedAt);
}

export type ChatReviewReceiptResult = 'completed' | 'already-completed' | 'rejected';

export interface ChatReviewPlanAcknowledgementInput {
  key: string;
  sessionId: string;
  conversationId: string;
  planId: string;
  expectedUpdatedAt: number;
  classification: ChatReviewPlanClassification;
  /** Non-mutating worker review evidence. Valid only with classification=stale-checklist. */
  staleItemIds?: readonly string[];
  /** Exact Companion request identity for safely recognizing a replay after a bounded Plan mutation. */
  requestId?: string;
  /** Canonical mutation arguments. Required with `options.mutate`, omitted for non-mutating acks. */
  completedItemIds?: readonly string[];
}

export type ChatReviewPlanAcknowledgementResult = 'acknowledged' | 'already-acknowledged' | 'rejected';
export interface ChatReviewPlanAcknowledgementOptions {
  /**
   * Optional narrow Plan mutation owned by the lifecycle tool (for example proven done-only item
   * reconciliation). It runs only after this owner validates key/caller/batch/current revision.
   * The Plan is re-read before an acknowledgement can be persisted.
   */
  mutate?: (current: PlanView) => Promise<unknown>;
  dependencies?: Partial<Dependencies>;
}

function samePlanSource(left: ChatReviewPlanTarget, right: ChatReviewPlanTarget): boolean {
  return left.planId === right.planId &&
    left.sourceSessionId === right.sourceSessionId &&
    left.sourceConversationId === right.sourceConversationId &&
    left.sourceThreadId === right.sourceThreadId;
}

function mutationRequestFromInput(
  input: ChatReviewPlanAcknowledgementInput,
  mutate: ChatReviewPlanAcknowledgementOptions['mutate']
): ChatReviewPlanMutationRequest | null | 'invalid' {
  if (!mutate) return input.requestId === undefined && input.completedItemIds === undefined ? null : 'invalid';
  if (!input.requestId || input.requestId.length > 256 || !Array.isArray(input.completedItemIds) ||
      input.completedItemIds.length > 100 || !input.completedItemIds.every(safePlanId) ||
      new Set(input.completedItemIds).size !== input.completedItemIds.length) return 'invalid';
  return {
    requestId: input.requestId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    completedItemIds: [...input.completedItemIds].sort()
  };
}

function sameMutationRequest(left: ChatReviewPlanMutationRequest, right: ChatReviewPlanMutationRequest): boolean {
  return left.requestId === right.requestId && left.expectedUpdatedAt === right.expectedUpdatedAt &&
    left.completedItemIds.length === right.completedItemIds.length &&
    left.completedItemIds.every((itemId, index) => itemId === right.completedItemIds[index]);
}

function sameStaleItemIds(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (!left || !right) return left === right;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Persist one exact Plan review against the current revision/source of this heartbeat's fixed batch. */
export function acknowledgeChatReviewPlan(
  input: ChatReviewPlanAcknowledgementInput,
  options: ChatReviewPlanAcknowledgementOptions = {}
): Promise<ChatReviewPlanAcknowledgementResult> {
  return serialHeartbeat(async () => {
    const deps = { ...defaults, ...(options.dependencies ?? {}) };
    if (!input.key || input.key.length > 512 || !input.sessionId || !input.conversationId ||
        !safePlanId(input.planId) || !safeTime(input.expectedUpdatedAt) ||
        !(CHAT_REVIEW_PLAN_CLASSIFICATIONS as readonly string[]).includes(input.classification)) return 'rejected';
    const mutationRequest = mutationRequestFromInput(input, options.mutate);
    if (mutationRequest === 'invalid') return 'rejected';
    const staleItemIds = input.staleItemIds === undefined ? undefined : [...input.staleItemIds].sort();
    if ((input.classification === 'stale-checklist') !== Boolean(staleItemIds?.length) ||
        (staleItemIds && (staleItemIds.length > 100 || !staleItemIds.every(safePlanId) ||
          new Set(staleItemIds).size !== staleItemIds.length || options.mutate))) return 'rejected';
    const state = await deps.readState();
    const debt = state?.debt;
    if (!debt || debt.key !== input.key || debt.planBatch === undefined || debt.planAcks === undefined ||
        !state?.planSweep || !planBatchBelongsToSweep(state, debt)) return 'rejected';
    const coordinator = await exactCoordinator(debt, deps);
    if (!coordinator || input.sessionId !== debt.sessionId || input.conversationId !== coordinator.conversationId) return 'rejected';
    const batchIndex = debt.planBatch.findIndex(target => target.planId === input.planId);
    if (batchIndex < 0) return 'rejected';
    const batchTarget = debt.planBatch[batchIndex]!;
    const previous = debt.planAcks.find(ack => ack.planId === input.planId);
    if (mutationRequest && previous) {
      if (previous.classification !== input.classification || !previous.mutationRequest ||
          !sameMutationRequest(previous.mutationRequest, mutationRequest)) return 'rejected';
      return 'already-acknowledged';
    }

    const library = checkedPlanLibrary(await deps.plans());
    const currentLive = library.live.find(plan => plan.id === input.planId);
    const current = currentLive ?? library.done.find(plan => plan.id === input.planId);
    if (!current || current.updatedAt !== input.expectedUpdatedAt) return 'rejected';
    if (staleItemIds) {
      const currentItems = new Map(current.items.map(item => [item.id, item]));
      if (staleItemIds.some(id => !currentItems.has(id) || currentItems.get(id)!.status === 'done')) return 'rejected';
    }
    const beforeMutation = planTarget(current);
    // Live revision/source drift means the prompt snapshot is stale. Reject this attempt and let
    // the durable retry path refresh the target before the coordinator reviews it again. Archived
    // is the one exception: that newer authoritative disposition may be acknowledged directly.
    if (currentLive && !samePlanTarget(beforeMutation, batchTarget)) return 'rejected';
    if (options.mutate) await options.mutate(current);
    const afterLibrary = options.mutate ? checkedPlanLibrary(await deps.plans()) : library;
    const after = afterLibrary.live.find(plan => plan.id === input.planId) ?? afterLibrary.done.find(plan => plan.id === input.planId);
    if (!after || !samePlanSource(beforeMutation, planTarget(after))) return 'rejected';
    const afterTarget = planTarget(after);
    const acknowledgement: ChatReviewPlanAck = {
      ...afterTarget,
      classification: input.classification,
      ...(staleItemIds ? { staleItemIds } : {}),
      ...(mutationRequest ? { mutationRequest } : {})
    };
    if (previous && samePlanTarget(previous, acknowledgement)) {
      if (previous.classification !== acknowledgement.classification ||
          !sameStaleItemIds(previous.staleItemIds, acknowledgement.staleItemIds)) return 'rejected';
      if (!samePlanTarget(batchTarget, afterTarget)) {
        const planBatch = debt.planBatch.map((target, index) => index === batchIndex ? afterTarget : target);
        await deps.writeState(stateWithDebt(state, { ...debt, planBatch }));
      }
      return 'already-acknowledged';
    }

    const planAcks = previous
      ? debt.planAcks.map(ack => ack.planId === input.planId ? acknowledgement : ack)
      : [...debt.planAcks, acknowledgement];
    const planBatch = debt.planBatch.map((target, index) => index === batchIndex ? afterTarget : target);
    await deps.writeState(stateWithDebt(state, { ...debt, planBatch, planAcks }));
    return 'acknowledged';
  });
}

/**
 * Narrow status seam for UI/LAN presence. No review key, session, conversation or request identity
 * crosses this boundary.
 */
export interface ChatReviewHeartbeatPublicStatus {
  pendingUntilAt?: number;
  uncertainFindingCount?: number;
  lastCompletedAt?: number;
  lastCompletionAt?: number;
  lastCompletionResult?: ChatReviewCompletionResult;
}

const publicStatusListeners = new Set<(status: ChatReviewHeartbeatPublicStatus) => void>();

function publicStatusFromState(state: ChatReviewHeartbeatState | null): ChatReviewHeartbeatPublicStatus {
  return {
    ...(state?.debt ? { pendingUntilAt: state.debt.untilAt } : {}),
    ...((state?.uncertainFindings?.length ?? 0) + (state?.uncertainArchiveCount ?? 0) > 0
      ? { uncertainFindingCount: (state?.uncertainFindings?.length ?? 0) + (state?.uncertainArchiveCount ?? 0) }
      : {}),
    ...(state?.lastCompletedAt === undefined ? {} : { lastCompletedAt: state.lastCompletedAt }),
    ...(state?.lastReceipt ? {
      lastCompletionAt: state.lastReceipt.completedAt,
      lastCompletionResult: state.lastReceipt.result
    } : {})
  };
}

function publishPublicStatus(state: ChatReviewHeartbeatState | null): void {
  const status = publicStatusFromState(state);
  for (const listener of publicStatusListeners) {
    try { listener(status); } catch { /* observer only */ }
  }
}

export function onChatReviewHeartbeatPublicStatus(
  listener: (status: ChatReviewHeartbeatPublicStatus) => void
): () => void {
  publicStatusListeners.add(listener);
  return () => publicStatusListeners.delete(listener);
}

export async function readChatReviewHeartbeatPublicStatus(): Promise<ChatReviewHeartbeatPublicStatus> {
  const state = await defaults.readState();
  return publicStatusFromState(state);
}

/**
 * Retire one durable semantic-review debt from the exact coordinator's explicit MCP receipt.
 *
 * Browser delivery and a normal assistant final are deliberately insufficient: they prove that a
 * turn was sent/settled, not that Eve finished checking all requested work. The coordinator calls
 * this only after its review is actually complete. The call context supplies session, conversation
 * and request identity; this owner rechecks the current debt and ordinary-chat role before fsync.
 */
export function completeChatReviewHeartbeat(
  receipt: ChatReviewCompletionReceipt,
  dependencies: Partial<Dependencies> = {}
): Promise<ChatReviewReceiptResult> {
  return serialHeartbeat(async () => {
    const deps = { ...defaults, ...dependencies };
    if (!receipt.key || receipt.key.length > 512 || !receipt.sessionId || !receipt.conversationId ||
        !receipt.requestId || receipt.requestId.length > 256 || !safeTime(receipt.completedAt) ||
        !(CHAT_REVIEW_COMPLETION_RESULTS as readonly string[]).includes(receipt.result) ||
        (receipt.reviewLane !== undefined && receipt.reviewLane !== 'worker' && receipt.reviewLane !== 'native-parent') ||
        (receipt.finding !== undefined && (!receipt.finding.trim() || receipt.finding.length > 6000)) ||
        (receipt.result !== 'completed' && !receipt.finding?.trim())) return 'rejected';
    const state = await deps.readState();
    const debt = state?.debt;
    if (!debt) {
      const previous = state?.lastReceipt;
      return previous?.key === receipt.key && previous.sessionId === receipt.sessionId &&
        previous.conversationId === receipt.conversationId ? 'already-completed' : 'rejected';
    }
    if (debt.reviewLane === 'worker' && receipt.reviewLane !== 'worker') return 'rejected';
    if (debt.reviewLane === 'native-parent' && receipt.reviewLane !== 'native-parent') return 'rejected';
    const coordinator = await exactCoordinator(debt, deps);
    if (!coordinator || !receiptMatchesDebt(receipt, debt, coordinator) || !planBatchBelongsToSweep(state, debt)) return 'rejected';
    let planSweep = state?.planSweep;
    let liveExpectations: PlanReviewExpectation[] = [];
    let planReconciliations = [...(state?.planReconciliations ?? [])];
    if (debt.planBatch !== undefined) {
      if (!planSweep || debt.planAcks === undefined || debt.planAcks.length !== debt.planBatch.length) return 'rejected';
      const acknowledgementById = new Map(debt.planAcks.map(ack => [ack.planId, ack]));
      if (acknowledgementById.size !== debt.planAcks.length ||
          debt.planBatch.some(target => !acknowledgementById.has(target.planId))) return 'rejected';
      const library = checkedPlanLibrary(await deps.plans());
      const liveById = new Map(library.live.map(plan => [plan.id, plan]));
      const archivedIds = new Set(library.done.map(plan => plan.id));
      const staleReconciliations: ChatReviewPlanReconciliation[] = [];
      liveExpectations = [];
      for (const target of debt.planBatch) {
        const acknowledgement = acknowledgementById.get(target.planId)!;
        const live = liveById.get(target.planId);
        if (live) {
          if (!samePlanTarget(target, acknowledgement) || !samePlanTarget(planTarget(live), acknowledgement)) return 'rejected';
          liveExpectations.push({ planId: live.id, updatedAt: live.updatedAt, provenance: live.provenance });
          // An acknowledged ready Eve Activity is not proof that its authorized exact archive
          // succeeded. Do not quietly close the epoch while that same revision remains Live.
          // Human/manual Plans and authority-disabled Eve Activity remain explicit boundaries.
          if (receipt.result === 'completed' && acknowledgement.classification === 'ready-to-archive' &&
              live.audience === 'eve' && live.readyToArchive && deps.archiveAuthority()) return 'rejected';
          if (acknowledgement.classification === 'stale-checklist') {
            if (!acknowledgement.staleItemIds?.length) return 'rejected';
            staleReconciliations.push({
              ...planTarget(live),
              heartbeatKey: debt.key,
              coordinatorSessionId: debt.sessionId,
              itemIds: [...acknowledgement.staleItemIds],
              scopeDigest: planReviewScopeDigest(live),
              createdAt: receipt.completedAt,
              ...(live.provenance ? { provenance: live.provenance } : {})
            });
          }
        } else if (!archivedIds.has(target.planId)) {
          return 'rejected';
        }
      }
      if (receipt.result === 'completed' && staleReconciliations.length) return 'rejected';
      const completedIds = new Set(debt.planBatch.map(target => target.planId));
      planSweep = { remainingPlanIds: planSweep.remainingPlanIds.filter(id => !completedIds.has(id)) };
      // A current re-review supersedes any older housekeeping obligation for that exact Plan.
      planReconciliations = planReconciliations.filter(item => !completedIds.has(item.planId));
      for (const reconciliation of staleReconciliations) planReconciliations.push(reconciliation);
      if (planReconciliations.length > CHAT_REVIEW_RECONCILIATION_MAX) return 'rejected';
    }
    const nextState: ChatReviewHeartbeatState = {
      lastCompletedAt: debt.untilAt,
      lastReceipt: receipt,
      ...(planSweep ? { planSweep } : {}),
      ...(planReconciliations.length ? { planReconciliations } : {}),
      ...(state?.uncertainFindings?.length ? { uncertainFindings: state.uncertainFindings } : {}),
      ...(state?.uncertainArchiveCount ? { uncertainArchiveCount: state.uncertainArchiveCount } : {}),
      ...(state?.supersessionCount !== undefined ? { supersessionCount: state.supersessionCount } : {}),
      ...(state?.findingSpoolWrite !== undefined ? { findingSpoolRead: state.findingSpoolRead, findingSpoolWrite: state.findingSpoolWrite } : {}),
      ...(!receipt.finding && state?.pendingFinding ? { pendingFinding: state.pendingFinding } : {}),
      ...(receipt.finding ? {
        pendingFinding: {
          key: debt.key,
          sessionId: debt.sessionId,
          conversationId: coordinator.conversationId,
          text: receipt.finding.trim(),
          createdAt: receipt.completedAt
        }
      } : {})
    };
    if (receipt.finding && state?.pendingFinding) {
      const writeIndex = state.findingSpoolWrite ?? 0;
      if (!Number.isSafeInteger(writeIndex + 1)) throw new Error('The finding spool index is exhausted');
      // Transactional intent goes to its own durable slot *before* replacing the single
      // recent finding. A crash before the state commit replays the same slot, not a new one.
      await deps.writePendingSpool(writeIndex, state.pendingFinding);
      nextState.findingSpoolRead = state.findingSpoolRead ?? 0;
      nextState.findingSpoolWrite = writeIndex + 1;
    }
    if (debt.planBatch === undefined) {
      await deps.writeState(nextState);
    } else {
      let commitStarted = false;
      try {
        await deps.planFence(liveExpectations, async () => {
          commitStarted = true;
          await deps.writeState(nextState);
        });
      } catch (error) {
        if (!commitStarted) return 'rejected';
        throw error;
      }
    }
    return 'completed';
  });
}

export type ChatReviewHousekeepingResult = 'reconciled' | 'already-reconciled' | 'stale';

/** Bounded structured housekeeping owned by one exact ordinary coordinator session. */
export function listChatReviewPlanReconciliations(sessionId: string): Promise<ChatReviewPlanReconciliation[]> {
  return serialHeartbeat(async () => {
    const state = await defaults.readState();
    return (state?.planReconciliations ?? [])
      .filter(item => item.coordinatorSessionId === sessionId)
      .map(item => ({ ...item, itemIds: [...item.itemIds], ...(item.provenance ? { provenance: { ...item.provenance } } : {}) }));
  });
}

/**
 * Consumes one durable stale-checklist obligation. The target comes entirely from durable review
 * state; the caller supplies only its exact coordinator session and Plan id.
 */
export function reconcileChatReviewPlanHousekeeping(
  sessionId: string,
  planId: string
): Promise<ChatReviewHousekeepingResult> {
  return serialHeartbeat(async () => {
    if (!sessionId || sessionId.length > 160 || !safePlanId(planId)) return 'stale';
    const state = await defaults.readState();
    const reconciliation = state?.planReconciliations?.find(item =>
      item.coordinatorSessionId === sessionId && item.planId === planId);
    if (!state || !reconciliation) return 'already-reconciled';

    const result = await reconcileReviewedPlanItems({
      planId: reconciliation.planId,
      updatedAt: reconciliation.updatedAt,
      ...(reconciliation.provenance ? { provenance: reconciliation.provenance } : {}),
      itemIds: reconciliation.itemIds,
      scopeDigest: reconciliation.scopeDigest
    });
    const remaining = (state.planReconciliations ?? []).filter(item => item.planId !== reconciliation.planId);
    const nextState: ChatReviewHeartbeatState = { ...state };
    if (remaining.length) nextState.planReconciliations = remaining;
    else delete nextState.planReconciliations;
    // `reconciled` may have changed the Plan before this state commit. If this write fails, the
    // durable obligation remains; the next retry recognizes the same-scope done items as already
    // reconciled and removes the obligation without applying the effect twice.
    await defaults.writeState(nextState);
    return result;
  });
}

export function runChatReviewHeartbeat(
  now = Date.now(),
  dependencies: Partial<Dependencies> = {},
  requestedLane: 'worker' | 'native-parent' = 'worker'
): Promise<ChatReviewHeartbeatResult> {
  return serialHeartbeat(async () => {
    const deps = { ...defaults, ...dependencies };
    let state = await deps.readState();
    // Older still-pending findings live in individually fsynced spool slots, not in the
    // single current-review state field. Attempt the oldest once per tick, independently
    // of the 22-minute review clock. Native Send authorization is never retried.
    const readIndex = state?.findingSpoolRead ?? 0;
    if (state && readIndex < (state.findingSpoolWrite ?? 0)) {
      const finding = await deps.readPendingSpool(readIndex);
      if (!finding) throw new Error('The durable heartbeat finding spool entry is missing');
      const owner = await deps.uniqueSession(finding.conversationId);
      if (owner && owner.id === finding.sessionId && owner.conversationId &&
          owner.chatIds.includes(finding.conversationId) && owner.chatIds.includes(owner.conversationId) &&
          owner.origin?.kind !== 'worker' && owner.origin?.kind !== 'helper' && !deps.blocked(owner.conversationId)) {
        // App-chat transport failure is NOT heartbeat review failure. The spool slot remains
        // durable and can be retried while an independent review becomes due.
        const delivery = await deps.enqueueFinding(finding.sessionId, finding.key, finding.text).catch(() => null);
        const ambiguous = delivery !== null && (delivery.state === 'failed' || delivery.state === 'cancelled') &&
          (delivery.sendAuthorizedAt !== undefined || delivery.deliveredAt !== undefined || Boolean(delivery.messageId));
        if (delivery?.state === 'sent' || delivery?.dismissed === true || ambiguous) {
          const next = { ...state, findingSpoolRead: readIndex + 1 };
          if (ambiguous) {
            const uncertain = [...(next.uncertainFindings ?? []).filter(item => item.key !== finding.key), finding];
            if (uncertain.length > 8) {
              const archiveIndex = next.uncertainArchiveCount ?? 0;
              if (!Number.isSafeInteger(archiveIndex + 1)) throw new Error('The uncertain finding archive index is exhausted');
              await deps.archiveUncertainFinding(archiveIndex, uncertain[0]!);
              next.uncertainArchiveCount = archiveIndex + 1;
              uncertain.shift();
            }
            next.uncertainFindings = uncertain;
          }
          await deps.writeState(next);
          state = next;
        }
      }
    }
    if (state?.pendingFinding) {
      let finding = state.pendingFinding;
      const owner = await deps.uniqueSession(finding.conversationId);
      if (owner && owner.id === finding.sessionId && owner.conversationId &&
          owner.chatIds.includes(finding.conversationId) && owner.chatIds.includes(owner.conversationId) &&
          owner.origin?.kind !== 'worker' && owner.origin?.kind !== 'helper' && !deps.blocked(owner.conversationId)) {
        if (owner.conversationId !== finding.conversationId) {
          finding = { ...finding, conversationId: owner.conversationId };
          state = { ...state, pendingFinding: finding };
          await deps.writeState(state);
        }
        const delivery = await deps.enqueueFinding(finding.sessionId, finding.key, finding.text).catch(() => null);
        if (delivery?.state === 'sent' || delivery?.dismissed === true) {
          const { pendingFinding: _delivered, ...deliveredState } = state;
          await deps.writeState(deliveredState);
          state = deliveredState;
        } else if (delivery && (delivery.state === 'failed' || delivery.state === 'cancelled') &&
            (delivery.sendAuthorizedAt !== undefined || delivery.deliveredAt !== undefined || Boolean(delivery.messageId))) {
          const uncertain = [...(state.uncertainFindings ?? []).filter(item => item.key !== finding.key), finding];
          let archiveCount = state.uncertainArchiveCount ?? 0;
          if (uncertain.length > 8) {
            if (!Number.isSafeInteger(archiveCount + 1)) throw new Error('The uncertain finding archive has reached its safe index limit');
            // Crash after this fsync but before state commit repeats the identical slot.
            await deps.archiveUncertainFinding(archiveCount, uncertain[0]!);
            archiveCount += 1;
            uncertain.shift();
          }
          const { pendingFinding: _uncertain, ...withoutPending } = state;
          const nextState = { ...withoutPending, uncertainFindings: uncertain,
            ...(archiveCount ? { uncertainArchiveCount: archiveCount } : {}) };
          await deps.writeState(nextState);
          state = nextState;
        }
      }
      // A queued / deferred / unreachable finding remains durable, but cannot monopolize
      // the independent review clock. A later completed receipt spools it before replacement.
    }
    if (state?.debt) {
      const selection = await supersedeIncompatibleReviewDebt(now, state, requestedLane, deps);
      state = selection.state;
      if (selection.blocked) return {
        status: 'pending',
        reason: 'mode-change-held',
        waitingSince: state!.debt!.untilAt,
        nextAt: now + CHAT_REVIEW_RETRY_MS,
        sessionId: state!.debt!.sessionId,
        conversationId: state!.debt!.conversationId
      };
    }
    if (state?.debt) {
      let debt = state.debt;
      if (!planBatchBelongsToSweep(state, debt)) {
        throw new Error('The durable chat review Plan batch is outside the sweep cursor');
      }
      const owner = await exactDebtOwner(debt, deps);
      if (!owner) return {
        status: 'no-coordinator',
        reason: 'debt-owner-unavailable',
        nextAt: now + CHAT_REVIEW_RETRY_MS
      };
      // The dedicated installation-agent identity is positive browser-backed ownership evidence,
      // not a recency heuristic. If it now resolves exactly to a different ordinary session, that
      // explicit rebind supersedes a legacy owner that the recorder may still show as live because
      // its final turn/session boundary was never observed. Preserve the same debt/key/window and
      // move only to that one exact installation coordinator; ambiguous or missing identity does
      // not weaken the existing fail-closed behavior.
      const identityConversationId = deps.agentConversation();
      const installationSuccessor = identityConversationId
        ? await installationCoordinator(identityConversationId, deps, debt.sessionId)
        : null;
      const installationRebound = installationSuccessor !== null;
      let coordinator = owner.endedAt === null && !installationRebound ? owner : null;
      // A failed or stalled last turn retires an owner only for the lane that types into it. The
      // worker lane reviews in its own chat; while the installation identity still names this same
      // open chat, there is no other owner to find, and waiting stalled the review until someone
      // nudged Eve by hand (2026-10-15, a throttled Prime chat).
      const identityKeepsOwner = debt.reviewLane === 'worker' && owner.endedAt === null &&
        identityConversationId !== null && identityConversationId === owner.conversationId;
      // Positive durable retirement (`endedAt`) and a canonically stalled/failed turn are the
      // ordinary cross-session handoff triggers. A different exact installation-agent identity is
      // the one additional positive handoff signal; do not infer any handoff from elapsed time, a
      // hidden tab, display sleep, or lack of browser ACK. Durably move this same epoch/key first,
      // and reject any later receipt from the old owner. If no safe successor exists the debt
      // simply remains owed.
      if (!coordinator || (coordinatorTurnRetired(coordinator) && !identityKeepsOwner)) {
        const successor = installationSuccessor ?? await newestCoordinator(await deps.sessions(), deps, debt.sessionId);
        if (!successor) return {
          status: 'no-coordinator',
          reason: 'no-successor',
          nextAt: now + CHAT_REVIEW_RETRY_MS,
          ...(identityConversationId ? { staleIdentity: identityConversationId } : {})
        };
        debt = { ...debt, sessionId: successor.id, conversationId: successor.conversationId };
        coordinator = successor;
        await deps.writeState(stateWithDebt(state, debt));
      }
      // Compact & Resume preserves the durable session and historical A in chatIds while moving
      // executable authority to B. Re-home only that already-proven lineage; never choose a new
      // session/title/nearby chat. Persist the migration before browser transport so restart sees B.
      if (coordinator.conversationId !== debt.conversationId) {
        debt = { ...debt, conversationId: coordinator.conversationId };
        await deps.writeState(stateWithDebt(state, debt));
      }
      let retryLibrary: PlanLibrary | undefined;
      if (debt.planBatch !== undefined) {
        retryLibrary = checkedPlanLibrary(await deps.plans());
        const refreshed = refreshDebtPlanBatch(debt, retryLibrary);
        if (refreshed !== debt) {
          debt = refreshed;
          await deps.writeState(stateWithDebt(state, debt));
        }
      }
      try {
        await deps.enqueue(debt.sessionId, await attentionForDebt(debt, deps, retryLibrary));
      } catch (error) {
        // A pre-2.4.0 epoch whose Prime-composer message may already have been sent is never sent
        // again and never reviewed twice under its key, but it must not hold every later review
        // either (Eva, 2026-10-20: no heartbeat tab, the same deferral on every retry). Once that
        // old row has been quiet a full cadence, retire its key and review the same window afresh in
        // the worker lane. The old row stays untouched as the record of a possible Send.
        if (debt.reviewLane === 'worker' || debt.reviewLane === 'native-parent' || !String(error).includes(LEGACY_HEARTBEAT_AMBIGUOUS)) throw error;
        const lastActivity = await deps.legacyActivityAt(debt.key);
        if (lastActivity === null || now - lastActivity < CHAT_REVIEW_HEARTBEAT_MS) throw error;
        const library = retryLibrary ?? checkedPlanLibrary(await deps.plans());
        const planReview = selectPlanReviewBatch(state, library);
        const successor: ChatReviewDebt = {
          key: deps.makeKey(),
          sinceAt: debt.sinceAt,
          untilAt: Math.max(debt.untilAt, now),
          sessionId: debt.sessionId,
          conversationId: debt.conversationId,
          reviewLane: 'worker',
          planBatch: planReview.targets,
          planAcks: []
        };
        await deps.writeState({ ...stateWithDebt(state, successor), planSweep: planReview.sweep });
        logInfo(`chat review heartbeat: legacy epoch ${debt.key} may already have reached Prime and is not sent again; ` +
          `its window is reviewed again in the worker lane as ${successor.key}`);
        await deps.enqueue(successor.sessionId, { key: successor.key, sinceAt: successor.sinceAt, untilAt: successor.untilAt, plans: planReview.snapshots });
        return {
          status: 'queued',
          nextAt: now + CHAT_REVIEW_RETRY_MS,
          sessionId: successor.sessionId,
          conversationId: successor.conversationId
        };
      }
      let reason: ChatReviewHeartbeatResult['reason'] = 'awaiting-worker-receipt';
      if (debt.reviewLane === 'native-parent') {
        // Evidence for the Native limit: Eve cannot make an idle Prime run, so this says whether
        // the review is still waiting for Prime's next Eve tool call or for its receipt.
        const stage = await deps.transportStage(debt.key).catch(() => null);
        reason = stage === 'offered' || stage === 'delivered' ? 'awaiting-native-receipt' : 'awaiting-prime-tool-call';
      }
      return {
        status: 'pending',
        reason,
        waitingSince: debt.untilAt,
        nextAt: now + CHAT_REVIEW_RETRY_MS,
        sessionId: debt.sessionId,
        conversationId: debt.conversationId
      };
    }

    const lastCompletedAt = state?.lastCompletedAt ?? null;
    // `lastCompletedAt` is the semantic coverage cursor: it advances only to the end of the
    // review window that was actually inspected. A review can finish much later than that window
    // (for example after a temporarily rejected receipt). Do not use the old coverage boundary as
    // the cadence clock or completing one overdue review immediately creates a catch-up heartbeat.
    // The receipt time is safe as the scheduling anchor while the next review still starts from
    // `lastCompletedAt`, so work that arrived while the prior review was pending is not skipped.
    const cadenceAnchor = state?.lastReceipt?.completedAt ?? lastCompletedAt;
    // A wall-clock jump into the past must not postpone the heartbeat for hours/days. Its first
    // receipt after the jump resets the time cursor from a conservative lookback window.
    const clockReset = cadenceAnchor !== null && cadenceAnchor > now + CHAT_REVIEW_HEARTBEAT_MS;
    const dueAt = cadenceAnchor === null || clockReset ? now : cadenceAnchor + CHAT_REVIEW_HEARTBEAT_MS;
    if (now < dueAt) return { status: 'not-due', nextAt:
      state?.pendingFinding || (state?.findingSpoolRead ?? 0) < (state?.findingSpoolWrite ?? 0)
        ? Math.min(dueAt, now + CHAT_REVIEW_RETRY_MS) : dueAt };

    // A fresh epoch belongs to exactly one selected lane; never silently reroute
    // an earlier debt when Settings changes during an uncertain Send.
      const unique = await newestCoordinator(await deps.sessions(), deps, null, requestedLane === 'worker');
    if (unique) {
      const conversationId = unique.conversationId;
      const sinceAt = lastCompletedAt === null || clockReset
        ? Math.max(0, now - CHAT_REVIEW_INITIAL_LOOKBACK_MS)
        : lastCompletedAt;
      const review = {
        // The key is also the semantic receipt capability printed only in the heartbeat prompt.
        // Debt is durable before enqueue, so unlike the old queue-time cursor it need not be
        // derivable for crash retry; a random epoch key prevents an unrelated turn from guessing
        // a pending receipt before the review prompt is delivered.
        key: deps.makeKey(),
        sinceAt,
        untilAt: now
      };
      const library = checkedPlanLibrary(await deps.plans());
      const planReview = selectPlanReviewBatch(state, library);
      const debt: ChatReviewDebt = {
        ...review,
        sessionId: unique.id,
        conversationId,
        reviewLane: requestedLane,
        planBatch: planReview.targets,
        planAcks: []
      };
      const attention: ChatReviewAttention = { ...review, plans: planReview.snapshots,
        ...(requestedLane === 'native-parent' ? { reviewLane: 'native-parent' } : {}) };
      // The obligation is durable before browser transport. If enqueue fails or the resulting
      // unclaimed attention is cancelled, restart still knows exactly what review remains owed.
      await deps.writeState({
        ...(lastCompletedAt === null ? {} : { lastCompletedAt }),
        ...(state?.lastReceipt ? { lastReceipt: state.lastReceipt } : {}),
        ...(state?.planReconciliations?.length ? { planReconciliations: state.planReconciliations } : {}),
        ...(state?.uncertainFindings?.length ? { uncertainFindings: state.uncertainFindings } : {}),
        ...(state?.uncertainArchiveCount ? { uncertainArchiveCount: state.uncertainArchiveCount } : {}),
        ...(state?.supersessionCount !== undefined ? { supersessionCount: state.supersessionCount } : {}),
        ...(state?.pendingFinding ? { pendingFinding: state.pendingFinding } : {}),
        ...(state?.findingSpoolWrite !== undefined ? { findingSpoolRead: state.findingSpoolRead, findingSpoolWrite: state.findingSpoolWrite } : {}),
        planSweep: planReview.sweep,
        debt
      });
      await deps.enqueue(unique.id, attention);
      return {
        status: 'queued',
        nextAt: now + CHAT_REVIEW_RETRY_MS,
        sessionId: unique.id,
        conversationId
      };
    }
    return {
      status: 'no-coordinator',
      reason: 'no-fresh-coordinator',
      nextAt: now + CHAT_REVIEW_RETRY_MS
    };
  });
}

export function startChatReviewHeartbeatMaintenance(options: {
  now?: () => number;
  run?: (now: number) => Promise<ChatReviewHeartbeatResult>;
  onQueued?: (result: ChatReviewHeartbeatResult) => void;
  onResult?: (result: ChatReviewHeartbeatResult) => void;
  onError?: (error: Error) => void;
} = {}): () => void {
  const now = options.now ?? Date.now;
  // Housekeep the local outbox at the heartbeat cadence. Only exact-key
  // duplicates of a known Send or explicit queued dismissal are retired;
  // no unique finding, user input, or ambiguous browser claim is touched.
  const run = options.run ?? (async (at) => {
    const mode = getConfig().multiAgent.heartbeatMode ?? 'off';
    if (mode === 'off') {
      // The existing timer retires a definitely pre-Send review into append-only
      // custody, but never clears findings or launches an alternate lane.
      await reconcileChatReviewHeartbeatMode(at, 'off');
      return { status: 'paused' as const, reason: 'off' as const, nextAt: at + CHAT_REVIEW_RETRY_MS };
    }
    try {
      const retired = await reconcileHeartbeatFindingQueue();
      if (retired) logInfo(`chat review heartbeat retired ${retired} proven redundant queued finding(s)`);
    } catch (error) {
      // Queue housekeeping is never permission to stall a separate semantic review.
      logWarn(`chat review heartbeat queue reconciliation deferred: ${String(error)}`);
    }
    return runChatReviewHeartbeat(at, {}, mode === 'native-subagent' ? 'native-parent' : 'worker');
  });
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  const schedule = (at: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), Math.max(1_000, at - now()));
    timer.unref?.();
  };
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result = await run(now());
      if (result.status === 'queued') options.onQueued?.(result);
      options.onResult?.(result);
      schedule(result.nextAt);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      schedule(now() + CHAT_REVIEW_RETRY_MS);
    } finally {
      inFlight = false;
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
