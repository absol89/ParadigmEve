import { currentCaller, currentCall } from './call-context.js';
import { fail, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
import { findSessionByConversation, getSession, updateSessionPlan } from '../session/store.js';
import { listPlans, syncSessionAgentPlan } from '../plans.js';
import { ensureRequestTrailForAcceptedPlan } from '../request-trail-admission.js';
import { agentPlanUpdateSchema } from '../../shared/agent-plan.js';
import { logInfo, logWarn } from '../logger.js';
import { sharedEveOwnerForCurrentCall } from '../eve-access.js';

/**
 * Adapted from OpenAI Codex's update_plan (Apache-2.0), revision
 * 1a4096e273e80da30947e57fdfa45be92858ca91. CoS adds bounded step details and
 * stores the plan under the proven durable session instead of an outer Codex turn.
 */
export function registerPlanTool(reg: SurfaceRegistrar): void {
  reg.register('update_plan', toolDeclaration('update_plan', () => ({
    title: 'Update plan',
    description: 'Updates your task plan in the user’s app. Use for work with several meaningful steps; skip simple tasks. Send the complete plan with short step headlines, useful details and current statuses. Keep at most one step in_progress. Never add Report to Prime, Hand off to Prime, or equivalent reporting/handoff as a Plan step: reporting is lifecycle, not work. Update after completing a step or changing approach. This only displays a plan; it does not execute steps or advance queued stages. Completing a human Plan leaves it Live as Ready to archive; only the user’s explicit archive is signoff.',
    inputSchema: agentPlanUpdateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), update => guard('update_plan', async () => {
    if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings → Chat');
    const caller = currentCaller();
    let sessionId = caller.sessionId;
    let conversationId = caller.conversationId;
    if (!sessionId || !conversationId) {
      const sharedOwner = sharedEveOwnerForCurrentCall();
      const sharedSession = sharedOwner
        ? await findSessionByConversation(sharedOwner, { requireUnique: true })
        : null;
      if (sharedOwner && sharedSession?.conversationId === sharedOwner) {
        sessionId = sharedSession.id;
        conversationId = sharedOwner;
      }
    }
    if (!sessionId || !conversationId) {
      return fail('Exact chat identity is required to update its plan. No plan was changed; retry after the companion reconnects.');
    }
    const accepted = await updateSessionPlan(sessionId, conversationId, update, currentCall()!.startedAt);
    if (!accepted) return fail('This plan update is stale or its chat was replaced. The current plan was preserved.');
    const summary = await getSession(sessionId);
    let projected;
    try {
      projected = await syncSessionAgentPlan(sessionId, conversationId, summary?.title ?? 'Chat plan', update);
    } catch (error) {
      return fail(`The chat plan was updated, but its durable Plans projection could not refresh: ${error instanceof Error ? error.message : String(error)}. The chat-local plan was preserved.`);
    }
    if (projected) {
      const library = await listPlans();
      const resolved = library.live.find(plan => plan.id === projected.id) ??
        library.done.find(plan => plan.id === projected.id) ??
        projected;
      try {
        await ensureRequestTrailForAcceptedPlan({
          sessionId,
          conversationId,
          plan: resolved
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const missingCanonicalTurn =
          detail === 'Accepted Plan has no exact active request turn' ||
          detail === 'Accepted Plan does not have one exact canonical user request message on its active turn';
        (missingCanonicalTurn ? logInfo : logWarn)(
          `update_plan: accepted Plan ${resolved.id} but Request Trail refresh failed: ${detail}`
        );
        // The accepted Plan and its first-class Plans projection are already durable. Treat a
        // secondary Request Trail repair as background continuity work. The model/user should not
        // be told a successful visible Plan update partially failed merely because there was no
        // exact canonical request message to attach yet.
        return ok('Plan updated');
      }
    }
    return ok('Plan updated');
  }));
}
