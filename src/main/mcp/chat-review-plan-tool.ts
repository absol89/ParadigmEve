import { z } from 'zod';
import { PRIME_ID, heartbeatReviewWorkerCall } from '../agents.js';
import {
  acknowledgeChatReviewPlan,
  CHAT_REVIEW_PLAN_CLASSIFICATIONS,
  chatReviewRequiresWorker,
  chatReviewRequiresNativeParent,
  listChatReviewPlanReconciliations,
  reconcileChatReviewPlanHousekeeping,
  resolveChatReviewContinuity
} from '../chat-review-heartbeat.js';
import { archiveExactReadyEvePlan, completePlanItemsForReview, listPlans } from '../plans.js';
import { getConfig } from '../config.js';
import { getSession } from '../session/store.js';
import { planIdSchema, type PlanRecord } from '../../shared/plans.js';
import { currentAgent, currentCall, currentCaller } from './call-context.js';
import { fail, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';

const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const completedItemIdsSchema = z.array(planIdSchema).max(100)
  .refine(ids => new Set(ids).size === ids.length, 'Completed Plan item ids must be unique');
const staleItemIdsSchema = z.array(planIdSchema).min(1).max(100)
  .refine(ids => new Set(ids).size === ids.length, 'Stale Plan item ids must be unique');

function reconciliationFailure(error: unknown): ReturnType<typeof fail> {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes('Plan changed; refresh')) {
    return fail(`CHAT_REVIEW_PLAN_STALE: ${detail} Re-read this exact Plan and review its current state before retrying.`);
  }
  return fail(`CHAT_REVIEW_PLAN_CONFLICT: ${detail} Re-read this exact Plan and retry only if the heartbeat still asks you to review it.`);
}

/** Heartbeat-only lifecycle surface for acknowledging one exact durable Plan review target. */
export function registerChatReviewPlanTool(reg: SurfaceRegistrar): void {
  reg.register('chat_review_plan', toolDeclaration('chat_review_plan', () => ({
    title: 'Acknowledge heartbeat Plan review',
    description:
      'Classify a Plan in the exact heartbeat batch. stale-checklist records exact open item ids the source proves complete without mutating them. Read-only workers must omit completed_item_ids and cannot directly mutate or archive Plans; only legacy Prime-owned reviews retain bounded mutation authority. Reject stale or foreign lifecycle calls.',
    inputSchema: z.object({
      key: z.string().min(1).max(512).describe('Exact durable review key printed by the current heartbeat prompt.'),
      plan_id: planIdSchema.describe('Exact Plan id from this heartbeat batch.'),
      expected_updated_at: timestampSchema.describe('Exact Plan updatedAt revision you reviewed.'),
      classification: z.enum(CHAT_REVIEW_PLAN_CLASSIFICATIONS).describe('Current disposition after reviewing this exact Plan.'),
      stale_item_ids: staleItemIdsSchema.optional().describe('With stale-checklist only: exact still-open item ids that source evidence proves complete. Review evidence only; it grants no mutation authority.'),
      completed_item_ids: completedItemIdsSchema.optional().describe('Legacy Prime-owned heartbeat debt only: exact evidence-backed open items. Never supply this for a read-only heartbeat worker.')
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), async ({ key, plan_id: planId, expected_updated_at: expectedUpdatedAt, classification, stale_item_ids: staleItemIds, completed_item_ids: completedItemIds }) =>
    guard('chat_review_plan', async () => {
      if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings → Chat');

      let caller = currentCaller();
      const call = currentCall();
      const agent = currentAgent();
      const continuity = await resolveChatReviewContinuity(key);
      const reviewWorker = Boolean(continuity && heartbeatReviewWorkerCall(caller, key, continuity.conversationId));
      const workerRequired = await chatReviewRequiresWorker(key);
      const nativeParentRequired = await chatReviewRequiresNativeParent(key);
      if (workerRequired && !reviewWorker) {
        return fail('CHAT_REVIEW_WORKER_REQUIRED: this Plan review belongs to ParadigmEve’s read-only heartbeat worker. Prime/legacy callers cannot acknowledge it.');
      }
      if (nativeParentRequired && reviewWorker) {
        return fail('CHAT_REVIEW_NATIVE_PARENT_REQUIRED: this native review must be interpreted by its exact Prime parent.');
      }
      let reviewSessionId = caller.sessionId;
      let reviewConversationId = caller.conversationId;
      if (!reviewWorker && (caller.localPrincipal || (agent !== null && agent !== PRIME_ID))) {
        return fail('CHAT_REVIEW_PLAN_CALLER_REJECTED: only the exact ordinary coordinator or its app-owned heartbeat review worker may acknowledge this heartbeat Plan review.');
      }
      if ((reviewWorker || nativeParentRequired) && completedItemIds !== undefined) {
        return fail('CHAT_REVIEW_PLAN_READ_ONLY: the heartbeat worker may classify reviewed Plans but cannot complete checklist items, archive Plans, or perform any mutation. Return actionable work to Prime instead.');
      }
      if ((classification === 'stale-checklist') !== Boolean(staleItemIds?.length)) {
        return fail('CHAT_REVIEW_PLAN_EVIDENCE_REQUIRED: stale-checklist requires stale_item_ids, and stale_item_ids are invalid for every other classification.');
      }

      // Scheduled/headless heartbeat turns can lack page correlation while retaining the opaque
      // one-epoch key. Recover only the already-durable coordinator lineage, exactly as the final
      // heartbeat receipt does; never choose a chat from title, recency or model arguments.
      if (reviewWorker && continuity) {
        reviewSessionId = continuity.sessionId;
        reviewConversationId = continuity.conversationId;
      } else if (call && caller.requestId && (!caller.sessionId || !caller.conversationId) && continuity) {
        call.caller.sessionId = continuity.sessionId;
        call.caller.conversationId = continuity.conversationId;
        caller = call.caller;
        reviewSessionId = caller.sessionId;
        reviewConversationId = caller.conversationId;
      }
      if (!caller.requestId || !reviewSessionId || !reviewConversationId || !call) {
        return fail('CALLER_IDENTITY_REQUIRED: an exact Companion request, session and conversation are required to acknowledge a heartbeat Plan review. No Plan or heartbeat state was changed; retry from the exact heartbeat coordinator.');
      }

      const session = await getSession(reviewSessionId);
      if (!session || session.conversationId !== reviewConversationId ||
          session.origin?.kind === 'worker' || session.origin?.kind === 'helper') {
        return fail('CHAT_REVIEW_PLAN_CALLER_REJECTED: this call is not the exact ordinary coordinator session for the heartbeat. No Plan or heartbeat state was changed.');
      }

      try {
        const mutationItemIds = completedItemIds ?? [];
        const needsMutation = completedItemIds !== undefined;
        const mutationResult: { plan: PlanRecord | null } = { plan: null };
        const acknowledgement = await acknowledgeChatReviewPlan({
          key,
          sessionId: reviewSessionId,
          conversationId: reviewConversationId,
          planId,
          expectedUpdatedAt,
          classification,
          ...(staleItemIds ? { staleItemIds } : {}),
          ...(needsMutation ? {
            requestId: caller.requestId,
            completedItemIds: mutationItemIds
          } : {})
        }, !needsMutation ? {} : {
          mutate: async current => {
            if (mutationItemIds.length) {
              mutationResult.plan = await completePlanItemsForReview(
                planId,
                mutationItemIds,
                current.updatedAt,
                { provenance: current.provenance }
              );
            } else mutationResult.plan = current as PlanRecord;
          }
        });
        if (acknowledgement === 'rejected') {
          return fail('CHAT_REVIEW_PLAN_REJECTED: the heartbeat key, coordinator, batch membership, Plan revision/source, or prior acknowledgement no longer matches. Re-read the exact Plan and current heartbeat prompt; retry with the current updatedAt only after reviewing the changed state.');
        }
        // The review worker never receives archive authority. The trusted host applies the user's
        // existing Eve-housekeeping policy only to this exact reviewed revision/source.
        if (classification === 'ready-to-archive' &&
            getConfig().eveAuthority?.archiveCompletedWork === true) {
          const library = await listPlans();
          const reviewed = library.live.find(plan => plan.id === planId);
          const archiveUpdatedAt = mutationResult.plan?.updatedAt ?? expectedUpdatedAt;
          if (reviewed?.audience === 'eve' && reviewed.readyToArchive &&
              reviewed.updatedAt === archiveUpdatedAt && reviewed.provenance?.sessionId) {
            const cleanup = await archiveExactReadyEvePlan({
              planId,
              updatedAt: archiveUpdatedAt,
              provenance: reviewed.provenance,
              sessionId: reviewed.provenance.sessionId
            });
            if (cleanup === 'stale' || cleanup === 'not-ready' || cleanup === 'not-eve') {
              return fail(`CHAT_REVIEW_ARCHIVE_DEFERRED: exact reviewed Eve Plan could not be archived (${cleanup}). Review its current revision/source before completing this heartbeat; no unrelated Plan was changed.`);
            }
          }
        }
        return ok(acknowledgement === 'acknowledged'
          ? 'Heartbeat Plan review acknowledged.'
          : 'Heartbeat Plan review was already acknowledged.');
      } catch (error) {
        return reconciliationFailure(error);
      }
    }));
}

/** Exact ordinary-Prime surface for consuming source-proven stale-checklist housekeeping. */
export function registerChatReviewHousekeepingTool(reg: SurfaceRegistrar): void {
  reg.register('chat_review_housekeeping', toolDeclaration('chat_review_housekeeping', () => ({
    title: 'Reconcile heartbeat Plan housekeeping',
    description:
      'Lists or reconciles durable stale-checklist findings returned by the read-only heartbeat worker. Reconciliation derives exact Plan revision, provenance, and item ids from durable review state; callers cannot supply mutation details.',
    inputSchema: z.discriminatedUnion('action', [
      z.object({ action: z.literal('list') }).strict(),
      z.object({ action: z.literal('reconcile'), plan_id: planIdSchema }).strict()
    ]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), async input => guard('chat_review_housekeeping', async () => {
    if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings → Chat');
    const caller = currentCaller();
    const call = currentCall();
    const agent = currentAgent();
    if (!caller.requestId || !caller.sessionId || !caller.conversationId || !call || caller.localPrincipal ||
        (agent !== null && agent !== PRIME_ID)) {
      return fail('CHAT_REVIEW_HOUSEKEEPING_CALLER_REJECTED: exact ordinary Prime conversation identity is required. No Plan was changed.');
    }
    const session = await getSession(caller.sessionId);
    if (!session || session.conversationId !== caller.conversationId ||
        session.origin?.kind === 'worker' || session.origin?.kind === 'helper') {
      return fail('CHAT_REVIEW_HOUSEKEEPING_CALLER_REJECTED: this call is not the exact ordinary coordinator session. No Plan was changed.');
    }
    if (input.action === 'list') {
      const pending = await listChatReviewPlanReconciliations(caller.sessionId);
      return ok(pending.length
        ? JSON.stringify(pending.map(item => ({
            plan_id: item.planId,
            expected_updated_at: item.updatedAt,
            item_ids: item.itemIds,
            source_session_id: item.sourceSessionId,
            source_conversation_id: item.sourceConversationId,
            source_thread_id: item.sourceThreadId
          })))
        : 'No heartbeat Plan housekeeping is pending for this coordinator.');
    }
    const result = await reconcileChatReviewPlanHousekeeping(caller.sessionId, input.plan_id);
    return result === 'stale'
      ? fail('CHAT_REVIEW_HOUSEKEEPING_STALE: the reviewed Plan changed before reconciliation. The old obligation was retired; let the next heartbeat re-review current state.')
      : ok(result === 'reconciled'
        ? 'Heartbeat Plan housekeeping reconciled.'
        : 'Heartbeat Plan housekeeping was already reconciled.');
  }));
}
