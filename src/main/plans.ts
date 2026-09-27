import { randomUUID } from 'node:crypto';
import { readDurableStrict, writeDurableNow } from './durable.js';
import { agentPlanUpdateSchema, type AgentPlanUpdate } from '../shared/agent-plan.js';
import { indexedSessions, readSessionPlan } from './session/store.js';
import {
  PLAN_CATALOG_MAX,
  planCatalogSchema,
  planCreateSchema,
  planIdSchema,
  planPatchSchema,
  planProvenanceSchema,
  type PlanCreate,
  type PlanAudience,
  type PlanItem,
  type PlanItemUpdate,
  type PlanLibrary,
  type PlanPatch,
  type PlanProvenance,
  type PlanRecord,
  type PlanView
} from '../shared/plans.js';

const PLANS_STATE = 'plans';
let mutations: Promise<unknown> = Promise.resolve();
const changeListeners = new Set<() => void>();
let sessionBackfill: Promise<void> | null = null;

function queueMutation<T>(mutate: () => Promise<T>): Promise<T> {
  const operation = mutations.then(mutate);
  mutations = operation.catch(() => undefined);
  return operation;
}

async function readRecords(): Promise<PlanRecord[]> {
  const raw = await readDurableStrict<unknown>(PLANS_STATE);
  if (raw === null) return [];
  const parsed = planCatalogSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Plan catalog is invalid');
  return parsed.data.plans;
}

async function writeRecords(plans: PlanRecord[]): Promise<void> {
  await writeDurableNow(PLANS_STATE, { version: 1, plans });
  for (const listener of changeListeners) listener();
}

function projectPlan(plan: PlanRecord, audience: PlanAudience = 'human', sourceSettled = false): PlanView {
  const activeItems = plan.items.filter(item => item.status !== 'done');
  const reminderTimes = activeItems.flatMap(item => item.reminderAt === undefined ? [] : [item.reminderAt]);
  const archived = plan.archivedAt !== null;
  const currentIndex = plan.items.findIndex(item => item.status === 'in_progress');
  const currentItemId = currentIndex >= 0 && !sourceSettled ? plan.items[currentIndex]!.id : null;
  // An `in_progress` checklist item is durable intent, but "Current" is a live-activity claim.
  // Once the source session has a newer completed boundary and no active turn, keep the item
  // unfinished while presenting it as the next thing to resume instead of pretending it is still
  // running. A later active turn makes it Current again without rewriting the Plan document.
  const nextItem = currentIndex >= 0
    ? sourceSettled ? plan.items[currentIndex]! : plan.items.slice(currentIndex + 1).find(item => item.status === 'todo')
    : plan.items.find(item => item.status === 'todo');
  return {
    ...plan,
    section: archived ? 'done' : 'live',
    audience,
    readyToArchive: !archived && plan.items.every(item => item.status === 'done'),
    currentItemId,
    nextItemId: nextItem?.id ?? null,
    nextReminderAt: reminderTimes.length ? Math.min(...reminderTimes) : null
  };
}

async function workerProjection(
  plan: PlanRecord,
  bySession: Map<string, Awaited<ReturnType<typeof indexedSessions>>[number]>,
  reportsBySession: Map<string, Array<{ messageId: string; sentAt: number }>>,
  deliveredByMessageId: Map<string, number>
): Promise<PlanView['worker'] | undefined> {
  const sourceSessionId = plan.provenance?.sessionId;
  if (!sourceSessionId) return undefined;
  const source = bySession.get(sourceSessionId);
  if (!source) return undefined;

  let session = source;
  const seen = new Set<string>();
  let workerId: string | null = null;
  while (!seen.has(session.id)) {
    seen.add(session.id);
    if (session.origin?.kind === 'worker' && session.origin.agentId) {
      workerId = session.origin.agentId;
      break;
    }
    if (session.origin?.kind !== 'resume' || !session.origin.fromSessionId) return undefined;
    const parent = bySession.get(session.origin.fromSessionId);
    if (!parent) return undefined;
    session = parent;
  }
  if (!workerId) return undefined;

  const descendsFromPlanSource = (candidateSessionId: string): boolean => {
    let currentId: string | null = candidateSessionId;
    const ancestry = new Set<string>();
    while (currentId && !ancestry.has(currentId)) {
      if (currentId === sourceSessionId) return true;
      ancestry.add(currentId);
      const current = bySession.get(currentId);
      if (current?.origin?.kind !== 'resume' || !current.origin.fromSessionId) return false;
      currentId = current.origin.fromSessionId;
    }
    return false;
  };
  const deliveredReports = [...reportsBySession.entries()]
    .filter(([sessionId]) => descendsFromPlanSource(sessionId))
    .flatMap(([, reports]) => reports)
    .filter(report => (deliveredByMessageId.get(report.messageId) ?? 0) >= report.sentAt)
    .sort((left, right) => right.sentAt - left.sentAt);
  let deliveredReport = deliveredReports.find(report => report.sentAt >= plan.updatedAt);

  // A later Prime/heartbeat reconciliation may truthfully mark stale worker checklist state done
  // after the worker has already reported. That catalog-only revision must not erase the durable
  // delivery proof. Fall back to the worker's own session-local Plan revision only when the current
  // Plan still has the exact same authored title + step text/order. Any later scope/title edit keeps
  // the stricter current Plan revision fence and therefore requires a newer worker report.
  if (!deliveredReport && deliveredReports.length) {
    const sourcePlan = await readSessionPlan(sourceSessionId);
    if (sourcePlan && sameAgentSteps(plan, sourcePlan)) {
      const sourcePlanTitle = (
        source.title.trim() ||
        sourcePlan.plan.find(step => step.status === 'in_progress')?.step ||
        sourcePlan.plan[0]?.step ||
        'Chat plan'
      ).slice(0, 160);
      if (plan.title === sourcePlanTitle) {
        deliveredReport = deliveredReports.find(report => report.sentAt >= sourcePlan.updatedAt);
      }
    }
  }
  return {
    id: workerId,
    reportedToPrime: Boolean(deliveredReport),
    ...(deliveredReport ? { reportMessageId: deliveredReport.messageId } : {})
  };
}

function replacementItems(current: PlanRecord, updates: PlanItemUpdate[]): PlanItem[] {
  const existing = new Map(current.items.map(item => [item.id, item]));
  return updates.map(update => {
    if (update.id !== undefined && !existing.has(update.id)) throw new Error('Plan item does not belong to this Plan');
    return {
      id: update.id ?? randomUUID(),
      text: update.text,
      status: update.status,
      ...(update.priority === undefined ? {} : { priority: update.priority }),
      ...(update.reminderAt === undefined ? {} : { reminderAt: update.reminderAt })
    };
  });
}

function nextTimestamp(previous: number): number {
  return Math.max(Date.now(), previous + 1);
}

export interface PlanReviewExpectation {
  planId: string;
  updatedAt: number;
  provenance?: PlanProvenance;
}

export interface PlanReviewSourceExpectation {
  provenance: PlanProvenance | undefined;
}

function samePlanProvenance(left: PlanProvenance | undefined, right: PlanProvenance | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.kind === right.kind &&
    left.threadId === right.threadId &&
    left.sessionId === right.sessionId &&
    left.conversationId === right.conversationId &&
    left.messageId === right.messageId &&
    left.toolCallId === right.toolCallId &&
    left.sourcePlanId === right.sourcePlanId &&
    left.label === right.label;
}

function planAudience(
  plan: PlanRecord,
  bySession: Map<string, Awaited<ReturnType<typeof indexedSessions>>[number]>
): PlanAudience {
  let sessionId = plan.provenance?.sessionId;
  const seen = new Set<string>();
  while (sessionId && !seen.has(sessionId)) {
    seen.add(sessionId);
    const session = bySession.get(sessionId);
    if (!session) break;
    if (session.origin?.kind === 'worker' || session.origin?.kind === 'helper') return 'eve';
    if (session.origin?.kind !== 'resume' || !session.origin.fromSessionId) break;
    sessionId = session.origin.fromSessionId;
  }
  return 'human';
}

function legacyPrimeHandoffItem(text: string): boolean {
  const normalized = text.trim();
  return /^(?:report\b.*\bto\s+(?:prime|primary)|hand\s*off\b.*\bto\s+(?:prime|primary))[.!]?$/i.test(normalized);
}

function readyFromRealWork(plan: PlanRecord, audience: PlanAudience): boolean {
  if (plan.archivedAt !== null) return false;
  return plan.items.every(item =>
    item.status === 'done' || (audience === 'eve' && legacyPrimeHandoffItem(item.text))
  );
}

function parsedReviewExpectation(input: PlanReviewExpectation): PlanReviewExpectation {
  if (!input || typeof input !== 'object') throw new Error('Plan review target is invalid');
  const planId = planUpdateId(input.planId);
  if (!Number.isInteger(input.updatedAt) || input.updatedAt < 0) throw new Error('Plan revision is invalid');
  const provenance = input.provenance === undefined ? undefined : planProvenanceSchema.parse(input.provenance);
  return { planId, updatedAt: input.updatedAt, ...(provenance === undefined ? {} : { provenance }) };
}

function exactLivePlanForReview(plans: PlanRecord[], expected: PlanReviewExpectation): PlanRecord {
  const current = plans.find(plan => plan.id === expected.planId);
  if (!current) throw new Error('Plan not found');
  if (current.archivedAt !== null) throw new Error('Archived Plans cannot be used for live review');
  if (current.updatedAt !== expected.updatedAt) throw new Error('Plan changed; refresh before editing it again');
  if (!samePlanProvenance(current.provenance, expected.provenance)) {
    throw new Error('Plan source changed; refresh before editing it again');
  }
  return current;
}

export async function listPlans(): Promise<PlanLibrary> {
  const [records, sessions] = await Promise.all([readRecords(), indexedSessions()]);
  const bySession = new Map(sessions.map(session => [session.id, session]));
  const reportsBySession = new Map<string, Array<{ messageId: string; sentAt: number }>>();
  const deliveredByMessageId = new Map<string, number>();
  for (const session of sessions) {
    for (const receipt of session.deliveredAgentMessages ?? []) {
      deliveredByMessageId.set(
        receipt.messageId,
        Math.max(deliveredByMessageId.get(receipt.messageId) ?? 0, receipt.deliveredAt)
      );
    }
    const reports = session.workerFinishReports ?? [];
    if (!reports.length) continue;
    reportsBySession.set(session.id, reports);
  }
  const sourceSettled = (plan: PlanRecord): boolean => {
    const sessionId = plan.provenance?.sessionId;
    if (!sessionId) return false;
    const session = bySession.get(sessionId);
    if (!session || session.activeTurnId) return false;
    const completedAt = Math.max(
      session.lastFinishReportAt ?? 0,
      session.lastAssistantFinalAt ?? 0,
      session.lastTurnOutcome === 'completed' ? session.lastTurnEndAt ?? 0 : 0
    );
    return completedAt >= plan.updatedAt;
  };
  const plans = await Promise.all(records.map(async plan => {
    const audience = planAudience(plan, bySession);
    const worker = await workerProjection(plan, bySession, reportsBySession, deliveredByMessageId);
    const projected = projectPlan(plan, audience, sourceSettled(plan));
    const hideCurrent = projected.currentItemId !== null &&
      plan.items.some(item => item.id === projected.currentItemId && audience === 'eve' && legacyPrimeHandoffItem(item.text));
    const hideNext = projected.nextItemId !== null &&
      plan.items.some(item => item.id === projected.nextItemId && audience === 'eve' && legacyPrimeHandoffItem(item.text));
    return {
      ...projected,
      ...(worker ? { worker } : {}),
      // Reporting to Prime is lifecycle evidence, not a checklist milestone. A completed Eve/
      // worker Plan is Ready to archive from its real work items alone; explicit report proof
      // remains useful metadata when available but never blocks the archive boundary.
      readyToArchive: readyFromRealWork(plan, audience),
      ...(hideCurrent ? { currentItemId: null } : {}),
      ...(hideNext ? { nextItemId: null } : {})
    };
  }));
  return {
    // Records are appended when a Plan is created and replaced in place when it changes. Reverse
    // that durable insertion order for the Live view so new Plans appear first while checkbox,
    // progress and Current/Next updates never reshuffle existing cards. Archiving simply removes
    // the archived card from this projection and leaves the rest in the same relative order.
    live: plans.filter(plan => plan.section === 'live').reverse(),
    done: plans.filter(plan => plan.section === 'done').sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  };
}

/**
 * 2.1.1 introduced the app-wide Plans catalog after session-local `plan.json` already existed.
 * Backfill those durable documents once per process so upgrading does not make an active plan
 * disappear until the model happens to call update_plan again.
 *
 * A session that crossed Compact & Resume no longer has exact per-plan frontend provenance in
 * the legacy document, so deliberately omit conversationId there instead of attributing an old
 * plan to the session's newest chat.
 */
export function backfillSessionPlans(): Promise<void> {
  if (sessionBackfill) return sessionBackfill;
  const work = (async () => {
    const sessions = (await indexedSessions()).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const session of sessions) {
      const plan = await readSessionPlan(session.id);
      if (!plan?.plan.length) continue;
      const exactConversation = session.chatIds.length <= 1 ? session.conversationId : null;
      await syncSessionAgentPlan(session.id, exactConversation, session.title, {
        ...(plan.explanation ? { explanation: plan.explanation } : {}),
        plan: plan.plan
      }, { importOnly: true });
    }
  })();
  sessionBackfill = work.catch((error) => {
    sessionBackfill = null;
    throw error;
  });
  return sessionBackfill;
}

/** Ensure one session's already-durable plan has a first-class Plans projection on demand. */
export async function ensureSessionPlan(sessionId: string): Promise<PlanView | null> {
  const [summary, plan] = await Promise.all([
    indexedSessions().then(rows => rows.find(row => row.id === sessionId) ?? null),
    readSessionPlan(sessionId)
  ]);
  if (!summary || !plan?.plan.length) return null;
  const exactConversation = summary.chatIds.length <= 1 ? summary.conversationId : null;
  return syncSessionAgentPlan(sessionId, exactConversation, summary.title, {
    ...(plan.explanation ? { explanation: plan.explanation } : {}),
    plan: plan.plan
  }, { importOnly: true });
}

export function onPlansChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function sameAgentSteps(plan: PlanRecord, update: AgentPlanUpdate): boolean {
  return plan.items.length === update.plan.length && plan.items.every((item, index) => item.text === update.plan[index]!.step);
}

function agentStatus(status: AgentPlanUpdate['plan'][number]['status']): PlanItem['status'] {
  return status === 'completed' ? 'done' : status === 'in_progress' ? 'in_progress' : 'todo';
}

function sameAgentDocument(plan: PlanRecord, update: AgentPlanUpdate): boolean {
  return sameAgentSteps(plan, update) && plan.items.every((item, index) => item.status === agentStatus(update.plan[index]!.status));
}

function agentItems(current: PlanRecord | null, update: AgentPlanUpdate): PlanItem[] {
  return update.plan.map((step, index) => ({
    id: current?.items[index]?.id ?? randomUUID(),
    text: step.step,
    status: agentStatus(step.status)
  }));
}

/**
 * Projects an accepted session-local `update_plan` document into the app-wide Live Plans view.
 *
 * The session store remains the stale-call/Compact & Resume authority. Call this only after that
 * store accepted the exact conversation update. A completed projected Plan remains Live and ready
 * to archive; a later, different checklist in the same durable session starts a new Plan instead
 * of overwriting the completed one the user has not archived yet.
 */
export function syncSessionAgentPlan(
  sessionId: string,
  conversationId: string | null,
  sourceTitle: string,
  input: AgentPlanUpdate,
  options: { importOnly?: boolean } = {}
): Promise<PlanView | null> {
  const update = agentPlanUpdateSchema.parse(input);
  if (!update.plan.length) return Promise.resolve(null);
  return queueMutation(async () => {
    const plans = await readRecords();
    const fromSession = plans.filter(plan => plan.provenance?.kind === 'plan' && plan.provenance.sessionId === sessionId);
    const title = (sourceTitle.trim() || update.plan.find(step => step.status === 'in_progress')?.step || update.plan[0]!.step || 'Chat plan').slice(0, 160);
    const now = Date.now();

    // Upgrade/session recovery reads an older session-local `plan.json`; it is not a newly
    // accepted update_plan command. Once a matching first-class Plan exists, that Plan owns its
    // progress and archive state. Replaying the legacy document must therefore be import-only:
    // preserve the existing revision exactly, even when the user has advanced or archived it.
    // If this legacy checklist has never been projected, create it without overwriting another
    // first-class checklist from the same session.
    if (options.importOnly) {
      const imported = fromSession.find(plan => sameAgentSteps(plan, update));
      if (imported) return projectPlan(imported);
      const room = withRoomForPlan(plans);
      const created: PlanRecord = {
        id: randomUUID(),
        title,
        items: agentItems(null, update),
        provenance: {
          kind: 'plan',
          sessionId,
          ...(conversationId ? { conversationId } : {}),
          label: sourceTitle.trim() || 'Chat plan'
        },
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      };
      await writeRecords([...room, created]);
      return projectPlan(created);
    }

    // An archived Plan is an immutable completed record. Only an exact completed replay may map
    // back to it. If the session later reopens the same checklist (todo/in_progress), that accepted
    // update needs a Live projection rather than being hidden behind the old Done copy.
    const archivedExact = fromSession.find(plan => plan.archivedAt !== null && sameAgentDocument(plan, update));
    if (archivedExact) return projectPlan(archivedExact);

    const live = fromSession.filter(plan => plan.archivedAt === null);
    const exact = live.find(plan => sameAgentSteps(plan, update));
    const unfinished = live.find(plan => !plan.items.every(item => item.status === 'done'));
    const current = exact ?? unfinished ?? null;

    // A lazy upgrade backfill can encounter the same unchanged document many times over the
    // process lifetime. Do not manufacture a fresh revision merely because the Plans screen was
    // opened again.
    if (exact && sameAgentDocument(exact, update) && exact.title === title) return projectPlan(exact);

    // A different checklist must not erase a finished list that is still waiting for the user
    // to archive it. Treat that as a new Live Plan in the same source session.
    const replaceCurrent = current && (!current.items.every(item => item.status === 'done') || sameAgentSteps(current, update));
    if (replaceCurrent) {
      const updated: PlanRecord = {
        ...current,
        title,
        items: agentItems(current, update),
        updatedAt: nextTimestamp(current.updatedAt)
      };
      const next = plans.map(plan => plan.id === updated.id ? updated : plan);
      await writeRecords(next);
      return projectPlan(updated);
    }

    const room = withRoomForPlan(plans);
    const created: PlanRecord = {
      id: randomUUID(),
      title,
      items: agentItems(null, update),
      provenance: {
        kind: 'plan',
        sessionId,
        ...(conversationId ? { conversationId } : {}),
        label: sourceTitle.trim() || 'Chat plan'
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    await writeRecords([...room, created]);
    return projectPlan(created);
  });
}

/**
 * The catalog holds at most this many Plans, live and archived together. Archived Plans are the
 * user's history and are never removed behind their back; 500 filled in two weeks of heavy use
 * (live 2026-09-27), so the bound is sized for months. The whole catalog is one file rewritten on
 * every Plan change and the Plans surface renders every archived card, so an unbounded catalog
 * needs per-Plan storage and paging rather than a larger number here.
 */
const MAX_PLANS = PLAN_CATALOG_MAX;

/** The catalog, refusing one more Plan once it is full. */
function withRoomForPlan(plans: PlanRecord[]): PlanRecord[] {
  if (plans.length >= MAX_PLANS) throw new Error('Plan catalog limit reached');
  return plans;
}

export function createPlan(input: PlanCreate): Promise<PlanView> {
  return queueMutation(async () => {
    const parsed = planCreateSchema.parse(input);
    const plans = withRoomForPlan(await readRecords());
    const now = Date.now();
    const plan: PlanRecord = {
      id: randomUUID(),
      title: parsed.title,
      items: parsed.items.map(item => ({ id: randomUUID(), ...item })),
      ...(parsed.provenance === undefined ? {} : { provenance: parsed.provenance }),
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    await writeRecords([...plans, plan]);
    return projectPlan(plan);
  });
}

/**
 * Promotes one exact owning Thread to the Plan's primary Source/context anchor.
 *
 * Historical session/message provenance is deliberately preserved as evidence/fallback. This
 * mutation never archives the Plan and never derives a Thread from title/prose. The caller must
 * already have validated the durable Thread id against the Pins owner.
 */
export function setPlanThreadSource(id: string, threadId: string | null): Promise<PlanView> {
  return queueMutation(async () => {
    const parsedId = planUpdateId(id);
    // Thread ids and Plan ids share the app's UUID shape, but remain different authorities.
    const parsedThreadId = threadId === null ? null : planIdSchema.parse(threadId);
    const plans = await readRecords();
    const index = plans.findIndex(plan => plan.id === parsedId);
    if (index < 0) throw new Error('Plan not found');
    const current = plans[index]!;
    if ((current.provenance?.threadId ?? null) === parsedThreadId) return projectPlan(current);
    const provenance = parsedThreadId === null
      ? (() => {
          const { threadId: _threadId, ...historical } = current.provenance!;
          return historical;
        })()
      : current.provenance
        ? { ...current.provenance, threadId: parsedThreadId }
        : { kind: 'manual' as const, threadId: parsedThreadId, label: 'Thread source' };
    // Source/navigation metadata is not checklist progress. Preserve updatedAt so anchoring an
    // already-complete Plan cannot manufacture a newer completion time or invalidate report proof.
    const updated: PlanRecord = { ...current, provenance };
    const next = [...plans];
    next[index] = updated;
    await writeRecords(next);
    return projectPlan(updated);
  });
}

export function updatePlan(id: string, patch: PlanPatch, expectedUpdatedAt: number): Promise<PlanView> {
  return queueMutation(async () => {
    const parsedId = planUpdateId(id);
    const parsedPatch = planPatchSchema.parse(patch);
    if (!Number.isInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) throw new Error('Plan revision is invalid');
    const plans = await readRecords();
    const index = plans.findIndex(plan => plan.id === parsedId);
    if (index < 0) throw new Error('Plan not found');
    const current = plans[index]!;
    if (current.archivedAt !== null) throw new Error('Archived Plans cannot be edited');
    if (current.updatedAt !== expectedUpdatedAt) throw new Error('Plan changed; refresh before editing it again');
    const updated: PlanRecord = {
      ...current,
      ...(parsedPatch.title === undefined ? {} : { title: parsedPatch.title }),
      ...(parsedPatch.items === undefined ? {} : { items: replacementItems(current, parsedPatch.items) }),
      updatedAt: nextTimestamp(current.updatedAt)
    };
    const next = [...plans];
    next[index] = updated;
    await writeRecords(next);
    return projectPlan(updated);
  });
}

/**
 * Completes only the exact still-open checklist items proven by a durable review.
 *
 * This deliberately shares the Plans mutation serializer and optimistic revision fence with
 * ordinary edits. The caller supplies evidence; this owner only applies the bounded status
 * transition and preserves every other durable Plan field. An empty item set is a revision-checked
 * no-op so review callers can safely use one primitive without manufacturing a new revision.
 * The result is the neutral durable record: callers that need audience/worker/report projections
 * must resolve those through listPlans(), where the required session evidence is available.
 */
export function completePlanItemsForReview(
  planId: string,
  completedItemIds: readonly string[],
  expectedUpdatedAt: number,
  expectedSource: PlanReviewSourceExpectation
): Promise<PlanRecord> {
  return queueMutation(async () => {
    const parsedPlanId = planUpdateId(planId);
    if (!Number.isInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) throw new Error('Plan revision is invalid');
    const expectedProvenance = expectedSource.provenance === undefined
      ? undefined
      : planProvenanceSchema.parse(expectedSource.provenance);
    if (!Array.isArray(completedItemIds) || completedItemIds.length > 100) throw new Error('Completed Plan item ids are invalid');
    const parsedItemIds = completedItemIds.map(itemId => planIdSchema.parse(itemId));
    if (new Set(parsedItemIds).size !== parsedItemIds.length) throw new Error('Completed Plan item ids must be unique');

    const plans = await readRecords();
    const current = exactLivePlanForReview(plans, {
      planId: parsedPlanId,
      updatedAt: expectedUpdatedAt,
      ...(expectedProvenance === undefined ? {} : { provenance: expectedProvenance })
    });
    const index = plans.findIndex(plan => plan.id === parsedPlanId);
    if (parsedItemIds.length === 0) return current;

    const itemsById = new Map(current.items.map(item => [item.id, item]));
    for (const itemId of parsedItemIds) {
      const item = itemsById.get(itemId);
      if (!item) throw new Error('Plan item does not belong to this Plan');
      if (item.status === 'done') throw new Error('Plan item is already complete');
    }

    const completed = new Set(parsedItemIds);
    const updated: PlanRecord = {
      ...current,
      items: current.items.map(item => completed.has(item.id) ? { ...item, status: 'done' as const } : item),
      updatedAt: nextTimestamp(current.updatedAt)
    };
    const next = [...plans];
    next[index] = updated;
    await writeRecords(next);
    return updated;
  });
}

/**
 * Holds the Plans mutation serializer across exact live-target validation and one awaited external
 * commit. Heartbeat callers acquire their own serializer first, then enter this fence, preserving
 * the required heartbeat -> Plans lock order. The commit must not call a Plans mutation helper or
 * it would wait on its own fence. This helper never edits or archives a Plan itself.
 */
export function withPlanReviewValidationFence<T>(
  targets: readonly PlanReviewExpectation[],
  commit: () => Promise<T>
): Promise<T> {
  return queueMutation(async () => {
    if (!Array.isArray(targets) || targets.length > PLAN_CATALOG_MAX) throw new Error('Plan review targets are invalid');
    if (typeof commit !== 'function') throw new Error('Plan review commit is invalid');
    const expected = targets.map(parsedReviewExpectation);
    if (new Set(expected.map(target => target.planId)).size !== expected.length) {
      throw new Error('Plan review target ids must be unique');
    }
    const plans = await readRecords();
    for (const target of expected) exactLivePlanForReview(plans, target);
    return commit();
  });
}

export async function archivePlan(id: string): Promise<PlanView> {
  const sessions = await indexedSessions();
  const bySession = new Map(sessions.map(session => [session.id, session]));
  return queueMutation(async () => {
    const parsedId = planUpdateId(id);
    const plans = await readRecords();
    const index = plans.findIndex(plan => plan.id === parsedId);
    if (index < 0) throw new Error('Plan not found');
    const current = plans[index]!;
    if (current.archivedAt !== null) return projectPlan(current);
    const audience = planAudience(current, bySession);
    if (!readyFromRealWork(current, audience)) throw new Error('Plan is not ready to archive');
    const items = audience === 'eve'
      ? current.items.map(item =>
          item.status !== 'done' && legacyPrimeHandoffItem(item.text)
            ? { ...item, status: 'done' as const }
            : item
        )
      : current.items;
    const archivedAt = nextTimestamp(current.updatedAt);
    const archived: PlanRecord = { ...current, items, archivedAt, updatedAt: archivedAt };
    const next = [...plans];
    next[index] = archived;
    await writeRecords(next);
    return projectPlan(archived, audience);
  });
}

/**
 * Auto-archives only completed worker Plans whose own current-generation finish report has
 * already crossed the recipient-side delivery boundary. The stable report message id keeps this
 * hook scoped to the acknowledgement that triggered it instead of sweeping unrelated Activity.
 */
export async function archiveWorkerPlansForDeliveredReport(messageId: string): Promise<number> {
  const library = await listPlans();
  const matches = library.live.filter(plan =>
    plan.worker?.reportedToPrime === true &&
    plan.worker.reportMessageId === messageId &&
    plan.readyToArchive
  );
  for (const plan of matches) await archivePlan(plan.id);
  return matches.length;
}

function planUpdateId(id: string): string {
  // Keep validation here as well as at IPC so other main-process callers cannot bypass it.
  return planIdSchema.parse(id);
}

/** Test seam: Plans have no in-memory state beyond the mutation serializer. */
export function resetPlansForTests(): void {
  mutations = Promise.resolve();
  sessionBackfill = null;
  changeListeners.clear();
}
