import { z } from 'zod';
import { PRIME_ID } from '../agents.js';
import {
  acknowledgeChatReviewPlan,
  CHAT_REVIEW_PLAN_CLASSIFICATIONS,
  resolveChatReviewContinuity
} from '../chat-review-heartbeat.js';
import { archivePlan, completePlanItemsForReview, listPlans } from '../plans.js';
import { getConfig } from '../config.js';
import { getSession } from '../session/store.js';
import { planIdSchema } from '../../shared/plans.js';
import { currentAgent, currentCall, currentCaller } from './call-context.js';
import { fail, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';

const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const completedItemIdsSchema = z.array(planIdSchema).max(100)
  .refine(ids => new Set(ids).size === ids.length, 'Completed Plan item ids must be unique');

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
      'Internal lifecycle tool for ParadigmEve’s 22-minute recovery heartbeat. Call it directly only for a Plan in the exact heartbeat batch after reviewing that Plan’s exact source and current state. It can mark only explicitly supplied, evidence-backed open checklist items done. When a reviewed Eve-owned Plan is ready to archive and the user has enabled Eve archive authority, the same acknowledgement archives that Plan; human Plans are never auto-archived. Stale revisions, foreign batches, workers/helpers and nested/code-mode calls fail closed.',
    inputSchema: z.object({
      key: z.string().min(1).max(512).describe('Exact durable review key printed by the current heartbeat prompt.'),
      plan_id: planIdSchema.describe('Exact Plan id from this heartbeat batch.'),
      expected_updated_at: timestampSchema.describe('Exact Plan updatedAt revision you reviewed.'),
      classification: z.enum(CHAT_REVIEW_PLAN_CLASSIFICATIONS).describe('Current disposition after reviewing this exact Plan.'),
      completed_item_ids: completedItemIdsSchema.optional().describe('Exact currently-open Plan item ids whose completion you verified. Only these items may move to done.')
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), async ({ key, plan_id: planId, expected_updated_at: expectedUpdatedAt, classification, completed_item_ids: completedItemIds }) =>
    guard('chat_review_plan', async () => {
      if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings → Chat');

      let caller = currentCaller();
      const call = currentCall();
      const agent = currentAgent();
      if (caller.localPrincipal || (agent !== null && agent !== PRIME_ID)) {
        return fail('CHAT_REVIEW_PLAN_CALLER_REJECTED: workers and helpers cannot acknowledge heartbeat Plan reviews. Return this review to the exact ordinary coordinator that owns the heartbeat.');
      }

      // Scheduled/headless heartbeat turns can lack page correlation while retaining the opaque
      // one-epoch key. Recover only the already-durable coordinator lineage, exactly as the final
      // heartbeat receipt does; never choose a chat from title, recency or model arguments.
      if (call && caller.requestId && (!caller.sessionId || !caller.conversationId)) {
        const continuity = await resolveChatReviewContinuity(key);
        if (continuity) {
          call.caller.sessionId = continuity.sessionId;
          call.caller.conversationId = continuity.conversationId;
          caller = call.caller;
        }
      }
      if (!caller.requestId || !caller.sessionId || !caller.conversationId || !call) {
        return fail('CALLER_IDENTITY_REQUIRED: an exact Companion request, session and conversation are required to acknowledge a heartbeat Plan review. No Plan or heartbeat state was changed; retry from the exact heartbeat coordinator.');
      }

      const session = await getSession(caller.sessionId);
      if (!session || session.conversationId !== caller.conversationId ||
          session.origin?.kind === 'worker' || session.origin?.kind === 'helper') {
        return fail('CHAT_REVIEW_PLAN_CALLER_REJECTED: this call is not the exact ordinary coordinator session for the heartbeat. No Plan or heartbeat state was changed.');
      }

      try {
        const archiveReviewedEvePlan =
          classification === 'ready-to-archive' &&
          getConfig().eveAuthority?.archiveCompletedWork === true;
        const mutationItemIds = completedItemIds ?? [];
        const needsMutation = completedItemIds !== undefined || archiveReviewedEvePlan;
        const acknowledgement = await acknowledgeChatReviewPlan({
          key,
          sessionId: caller.sessionId,
          conversationId: caller.conversationId,
          planId,
          expectedUpdatedAt,
          classification,
          ...(needsMutation ? {
            requestId: caller.requestId,
            completedItemIds: mutationItemIds
          } : {})
        }, !needsMutation ? {} : {
          mutate: async current => {
            if (mutationItemIds.length) {
              await completePlanItemsForReview(
                planId,
                mutationItemIds,
                current.updatedAt,
                { provenance: current.provenance }
              );
            }
            if (!archiveReviewedEvePlan) return;
            const library = await listPlans();
            const reviewed = library.live.find(plan => plan.id === planId);
            if (reviewed?.audience === 'eve' && reviewed.readyToArchive) {
              await archivePlan(planId);
            }
          }
        });
        if (acknowledgement === 'rejected') {
          return fail('CHAT_REVIEW_PLAN_REJECTED: the heartbeat key, coordinator, batch membership, Plan revision/source, or prior acknowledgement no longer matches. Re-read the exact Plan and current heartbeat prompt; retry with the current updatedAt only after reviewing the changed state.');
        }
        return ok(acknowledgement === 'acknowledged'
          ? 'Heartbeat Plan review acknowledged.'
          : 'Heartbeat Plan review was already acknowledged.');
      } catch (error) {
        return reconciliationFailure(error);
      }
    }));
}
