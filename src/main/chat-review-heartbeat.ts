/**
 * Durable semantic heartbeat for user work that fell through the gap between ChatGPT prose and
 * ParadigmEve execution.
 *
 * This does not scrape or classify the user's transcript itself. Every 22 minutes it wakes one
 * exact, previously tool-proven Eve conversation and asks that model turn to review local session
 * recordings plus the live ChatGPT web history. That keeps intent/relevance decisions with the
 * model while exact browser/session ownership and delivery remain in the existing durable outbox.
 */
import { randomUUID } from 'node:crypto';
import { planIdSchema, type PlanLibrary, type PlanView } from '../shared/plans.js';
import type { SessionSummary } from '../shared/session.js';
import { currentAgentConversationId } from './agent-identity.js';
import { readDurable, writeDurableNow } from './durable.js';
import {
  listPlans,
  withPlanReviewValidationFence,
  type PlanReviewExpectation
} from './plans.js';
import { isChatBlocked } from './session/blocked-chats.js';
import {
  enqueueChatReviewAttention,
  type ChatReviewAttention,
  type ChatReviewPlanSnapshot
} from './session/input.js';
import { findSessionByConversation, indexedSessions } from './session/store.js';

export const CHAT_REVIEW_HEARTBEAT_MS = 22 * 60 * 1000;
export const CHAT_REVIEW_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const CHAT_REVIEW_RETRY_MS = 60 * 1000;
export const CHAT_REVIEW_PLAN_BATCH_SIZE = 4;
const CHAT_REVIEW_PLAN_CATALOG_MAX = 500;
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
  'tbd',
  'blocked',
  'superseded',
  'awaiting-user'
] as const;
export type ChatReviewPlanClassification = (typeof CHAT_REVIEW_PLAN_CLASSIFICATIONS)[number];

export interface ChatReviewPlanAck extends ChatReviewPlanTarget {
  classification: ChatReviewPlanClassification;
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

export interface ChatReviewDebt extends ChatReviewAttention {
  sessionId: string;
  conversationId: string;
  /** Absent only on receipt-backed debt written before durable Plan review shipped. */
  planBatch?: ChatReviewPlanTarget[];
  /** Absent only together with planBatch on legacy debt. */
  planAcks?: ChatReviewPlanAck[];
}
/**
 * Privacy-safe semantic result of one fully completed review epoch.
 *
 * This is deliberately an enum, never authored prose. `dispatched` means the review found
 * actionable unfinished work and actually handed bounded work to Eve/a worker before the exact
 * receipt was written. `blocked`/`failed` are completed reviews whose requested execution could
 * not safely finish; the next heartbeat still starts from this completed review boundary.
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
}
export interface ChatReviewHeartbeatState {
  lastCompletedAt?: number;
  debt?: ChatReviewDebt;
  lastReceipt?: ChatReviewCompletionReceipt;
  planSweep?: ChatReviewPlanSweep;
}
export type ChatReviewHeartbeatResult = {
  status: 'queued' | 'pending' | 'not-due' | 'no-coordinator';
  nextAt: number;
  sessionId?: string;
  conversationId?: string;
  reason?: 'debt-owner-unavailable' | 'no-successor' | 'no-fresh-coordinator';
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
  plans: () => Promise<PlanLibrary>;
  planFence: <T>(targets: readonly PlanReviewExpectation[], commit: () => Promise<T>) => Promise<T>;
  makeKey: () => string;
  agentConversation: () => string | null;
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
  return {
    ...target,
    classification: classification as ChatReviewPlanClassification,
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
    typeof row.conversationId === 'string' && row.conversationId.length >= 8 && row.conversationId.length <= 256)) return null;
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
    (row.result === undefined || (typeof row.result === 'string' && (CHAT_REVIEW_COMPLETION_RESULTS as readonly string[]).includes(row.result)))
    ? {
        key: row.key,
        sessionId: row.sessionId,
        conversationId: row.conversationId,
        requestId: row.requestId,
        completedAt: row.completedAt,
        // Receipts written before the result enum existed semantically meant only "review
        // completed". Preserve that exact meaning rather than rejecting old durable state.
        result: (row.result ?? 'completed') as ChatReviewCompletionResult
      }
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
  // Keep transport recovery responsive without re-spending a model turn every local retry.
  // The durable input owner may re-present a confirmed send only after the normal heartbeat cadence.
  enqueue: (sessionId, review) => enqueueChatReviewAttention(sessionId, review, CHAT_REVIEW_HEARTBEAT_MS),
  plans: listPlans,
  planFence: withPlanReviewValidationFence,
  makeKey: () => `heartbeat:${randomUUID()}`,
  agentConversation: currentAgentConversationId
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
  let remainingPlanIds = (state?.planSweep?.remainingPlanIds ?? []).filter(id => liveById.has(id));
  if (remainingPlanIds.length === 0) {
    // listPlans() already has stable Live ordering. Keep that ordering within each audience while
    // putting human commitments before worker/helper bookkeeping at the start of every cycle.
    remainingPlanIds = [
      ...checked.live.filter(plan => plan.audience === 'human').map(plan => plan.id),
      ...checked.live.filter(plan => plan.audience === 'eve').map(plan => plan.id)
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
    debt
  };
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
  const base = { key: debt.key, sinceAt: debt.sinceAt, untilAt: debt.untilAt };
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
  excludeSessionId: string | null = null
): Promise<ExactCoordinator | null> {
  // `uniqueSession()` includes exact historical chatIds. A stale product-identity pointer can
  // therefore still name pre-compaction chat A while the same durable session is currently attached
  // to B. That A→B lineage is exact continuation evidence, so heartbeat may target current B without
  // mutating product identity or granting B any MCP/tool authority. Ambiguous lineage returns null.
  const session = await deps.uniqueSession(identityConversationId);
  if (!session || session.id === excludeSessionId || !session.conversationId ||
      !session.chatIds.includes(identityConversationId) || !session.chatIds.includes(session.conversationId) ||
      deps.blocked(session.conversationId) || session.endedAt !== null || coordinatorTurnRetired(session) ||
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

/** New exact ordinary coordinator for a fresh epoch or a canonical retired/stalled-owner transfer. */
async function newestCoordinator(
  sessions: readonly SessionSummary[],
  deps: Dependencies,
  excludeSessionId: string | null = null
): Promise<ExactCoordinator | null> {
  const identityConversationId = deps.agentConversation();
  if (identityConversationId) {
    // Once the installation has an explicit Eve/Eva identity, never fall back to a merely recent
    // tool-proven chat if that exact identity/lineage cannot be resolved safely. The latter would
    // turn a stale or ambiguous product owner into permission to wake an unrelated conversation.
    return installationCoordinator(identityConversationId, deps, excludeSessionId);
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
      ...(mutationRequest ? { mutationRequest } : {})
    };
    if (previous && samePlanTarget(previous, acknowledgement)) {
      if (previous.classification !== acknowledgement.classification) return 'rejected';
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
  lastCompletedAt?: number;
  lastCompletionAt?: number;
  lastCompletionResult?: ChatReviewCompletionResult;
}

const publicStatusListeners = new Set<(status: ChatReviewHeartbeatPublicStatus) => void>();

function publicStatusFromState(state: ChatReviewHeartbeatState | null): ChatReviewHeartbeatPublicStatus {
  return {
    ...(state?.debt ? { pendingUntilAt: state.debt.untilAt } : {}),
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
        !receipt.requestId || receipt.requestId.length > 256 || !safeTime(receipt.completedAt)) return 'rejected';
    const state = await deps.readState();
    const debt = state?.debt;
    if (!debt) {
      const previous = state?.lastReceipt;
      return previous?.key === receipt.key && previous.sessionId === receipt.sessionId &&
        previous.conversationId === receipt.conversationId ? 'already-completed' : 'rejected';
    }
    const coordinator = await exactCoordinator(debt, deps);
    if (!coordinator || !receiptMatchesDebt(receipt, debt, coordinator) || !planBatchBelongsToSweep(state, debt)) return 'rejected';
    let planSweep = state?.planSweep;
    let liveExpectations: PlanReviewExpectation[] = [];
    if (debt.planBatch !== undefined) {
      if (!planSweep || debt.planAcks === undefined || debt.planAcks.length !== debt.planBatch.length) return 'rejected';
      const acknowledgementById = new Map(debt.planAcks.map(ack => [ack.planId, ack]));
      if (acknowledgementById.size !== debt.planAcks.length ||
          debt.planBatch.some(target => !acknowledgementById.has(target.planId))) return 'rejected';
      const library = checkedPlanLibrary(await deps.plans());
      const liveById = new Map(library.live.map(plan => [plan.id, plan]));
      const archivedIds = new Set(library.done.map(plan => plan.id));
      liveExpectations = [];
      for (const target of debt.planBatch) {
        const acknowledgement = acknowledgementById.get(target.planId)!;
        const live = liveById.get(target.planId);
        if (live) {
          if (!samePlanTarget(target, acknowledgement) || !samePlanTarget(planTarget(live), acknowledgement)) return 'rejected';
          liveExpectations.push({ planId: live.id, updatedAt: live.updatedAt, provenance: live.provenance });
        } else if (!archivedIds.has(target.planId)) {
          return 'rejected';
        }
      }
      const completedIds = new Set(debt.planBatch.map(target => target.planId));
      planSweep = { remainingPlanIds: planSweep.remainingPlanIds.filter(id => !completedIds.has(id)) };
    }
    const nextState: ChatReviewHeartbeatState = {
      lastCompletedAt: debt.untilAt,
      lastReceipt: receipt,
      ...(planSweep ? { planSweep } : {})
    };
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

export function runChatReviewHeartbeat(
  now = Date.now(),
  dependencies: Partial<Dependencies> = {}
): Promise<ChatReviewHeartbeatResult> {
  return serialHeartbeat(async () => {
    const deps = { ...defaults, ...dependencies };
    const state = await deps.readState();
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
      // Positive durable retirement (`endedAt`) and a canonically stalled/failed turn are the
      // ordinary cross-session handoff triggers. A different exact installation-agent identity is
      // the one additional positive handoff signal; do not infer any handoff from elapsed time, a
      // hidden tab, display sleep, or lack of browser ACK. Durably move this same epoch/key first,
      // and reject any later receipt from the old owner. If no safe successor exists the debt
      // simply remains owed.
      if (!coordinator || coordinatorTurnRetired(coordinator)) {
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
      await deps.enqueue(debt.sessionId, await attentionForDebt(debt, deps, retryLibrary));
      return {
        status: 'pending',
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
    if (now < dueAt) return { status: 'not-due', nextAt: dueAt };

    const unique = await newestCoordinator(await deps.sessions(), deps);
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
        planBatch: planReview.targets,
        planAcks: []
      };
      const attention: ChatReviewAttention = { ...review, plans: planReview.snapshots };
      // The obligation is durable before browser transport. If enqueue fails or the resulting
      // unclaimed attention is cancelled, restart still knows exactly what review remains owed.
      await deps.writeState({
        ...(lastCompletedAt === null ? {} : { lastCompletedAt }),
        ...(state?.lastReceipt ? { lastReceipt: state.lastReceipt } : {}),
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
  const run = options.run ?? ((at) => runChatReviewHeartbeat(at));
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
