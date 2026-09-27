import { pinsLibrary } from './pins.js';
import { listPlans, setPlanThreadSource } from './plans.js';
import { listRequestTrail, requestTrailById } from './request-trail.js';
import type { RequestTrailRecord } from '../shared/request-trail.js';

/**
 * Projects the Request Trail's exact owning Thread onto its linked high-level Plan.
 * Request Trail remains the owner; this only copies its durable id into Plan source metadata so
 * renderer navigation does not need title matching or a second relationship store.
 */
export async function reconcileRequestPlanThreadSourceRecords(
  records: readonly RequestTrailRecord[]
): Promise<number> {
  const linked = records.filter(record => record.planId !== null || record.threadId !== null);
  if (linked.length === 0) return 0;

  const [pins, plans] = await Promise.all([pinsLibrary(), listPlans()]);
  const threadIds = new Set(pins.quilts.map(thread => thread.id));
  const assignments = new Map<string, string | null>();
  for (const record of linked) {
    if (record.threadId !== null && !threadIds.has(record.threadId)) {
      throw new Error('Owning request Thread was not found');
    }
    if (record.planId === null) continue;
    const hasAssignment = assignments.has(record.planId);
    const assigned = assignments.get(record.planId) ?? null;
    if (hasAssignment && assigned !== record.threadId) {
      throw new Error('Linked high-level Plan has conflicting owning Threads');
    }
    assignments.set(record.planId, record.threadId);
  }

  const byPlan = new Map([...plans.live, ...plans.done].map(plan => [plan.id, plan]));
  let changed = 0;
  for (const [planId, threadId] of assignments) {
    const plan = byPlan.get(planId);
    if (!plan) throw new Error('Linked high-level Plan was not found');
    if (plan.audience !== 'human') throw new Error('Linked high-level Plan must be user-owned');
    if ((plan.provenance?.threadId ?? null) === threadId) continue;
    await setPlanThreadSource(plan.id, threadId);
    changed += 1;
  }
  return changed;
}

export async function reconcileRequestPlanThreadSource(requestId: string): Promise<boolean> {
  const record = await requestTrailById(requestId);
  if (!record) return false;
  return (await reconcileRequestPlanThreadSourceRecords([record])) > 0;
}

/** Repairs source projection after restart or for records created before this seam existed. */
export async function reconcileAllRequestPlanThreadSources(): Promise<number> {
  return reconcileRequestPlanThreadSourceRecords(await listRequestTrail());
}
