// A toy optimistic-concurrency update; no user Plans are accessed.
export function applyPlanUpdate(plan, expectedRevision, nextStatus) {
  if (expectedRevision < plan.revision) return false;
  plan.status = nextStatus;
  plan.revision = expectedRevision + 1;
  return true;
}
