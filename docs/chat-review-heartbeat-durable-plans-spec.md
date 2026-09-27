# Durable Plan review in the 22-minute heartbeat

Status: implementation specification
Date: 2026-09-21
Target line: ParadigmEve 2.2.3 development

## 1. User problem and outcome

The recovery heartbeat currently has durable cadence, coordinator ownership, browser-only delivery,
retry and explicit completion receipts, but its semantic prompt is centered on a recent time window.
That is not enough for work that already became a first-class Live Plan. A Plan can remain open for
days after the source chat moved on, so an unattended Eve can repeatedly review recent chats while
forgetting durable work that still says it is unfinished.

The heartbeat must therefore own **two review obligations** on every due epoch:

1. **Recent-request review** — the existing exact `sinceAt..untilAt` local-session + ChatGPT-web
   review for execution requests that fell through as prose.
2. **Durable-Plan review** — a bounded, rotating batch from the complete unarchived Live Plans
   catalog, independent of Plan age. Every Live Plan must eventually be revisited while the human is
   away, and a heartbeat receipt must not be accepted until the exact batch selected for that epoch
   has been explicitly reviewed.

The goal is not to make the heartbeat a generic autonomous planner. It is to stop durable work from
becoming invisible merely because it is old.

## 2. Existing contracts that remain authoritative

- `src/main/chat-review-heartbeat.ts` remains the one durable owner of heartbeat cadence, debt,
  coordinator lineage, retries and completion receipts.
- `src/main/plans.ts` remains the one durable owner of Plan records and Plan projections. Heartbeat
  state may remember **review scheduling/progress**, but must never mirror Plan completion as a
  second source of truth.
- Exact Plan provenance wins over title/date inference. Follow the Plan's exact source session and,
  where present, exact Thread/source metadata. Do not route by similar names.
- `lastTurnOutcome === 'completed'`, a source session final, or a stale `activeTurnId` is not proof
  that a Plan item is complete. Completion requires task-specific evidence from the source and/or
  the resulting files/tools/runtime state.
- A Plan whose checklist is all done becomes **Ready to archive**. Heartbeat review never treats its
  own receipt as Plan signoff and never archives a human Plan on the user's behalf.
- Newer user instructions, current active work, ambiguous ownership and already-completed results
  override old Plan text. Unknown ownership fails closed.
- The shared tree is dirty. No reset/clean/checkout/rebase, broad reformat, unrelated cleanup,
  packaging, install, commit or publish is part of this change.

## 3. Durable heartbeat state

Extend the heartbeat state only with review-scheduling facts. Do not add a second Plan database.

Conceptually:

```ts
type PlanReviewTarget = {
  planId: string;
  updatedAt: number;
  // Exact source identity matters even though setPlanThreadSource intentionally does not bump
  // updatedAt. Store the current provenance fields needed to detect a source change.
  sourceSessionId?: string;
  sourceConversationId?: string;
  sourceThreadId?: string;
};

type PlanReviewAck = PlanReviewTarget & {
  classification: 'ready-to-archive' | 'tbd' | 'blocked' | 'superseded' | 'awaiting-user';
};

type PlanSweep = {
  // Exact Plan ids left in this cycle. This is a work queue, not a completion projection.
  remainingPlanIds: string[];
};

type ChatReviewDebt = {
  // existing key/window/session/conversation fields
  planBatch: PlanReviewTarget[];
  planAcks: PlanReviewAck[];
};
```

Requirements:

- Bound every collection by the existing Plan catalog maximum. Reject malformed, duplicate or
  oversized persisted values rather than accepting ambiguous state.
- A restart, retry, Compact & Resume transfer, stalled-owner transfer or installation-identity
  rebound keeps the **same debt key and same exact Plan batch/acks**.
- A failed durable write must not advance the sweep or browser transport.
- Old heartbeat state without Plan sweep fields migrates conservatively: keep its existing receipt
  semantics and start a fresh Plan sweep the next time a new epoch is created.

## 4. Selecting the rotating Plan batch

Use `listPlans()`; do not read `plans.json` directly from the heartbeat.

Default deep-review batch size: **4 Plans per heartbeat**. This keeps each turn bounded while a
normal backlog of roughly forty Plans receives a complete pass in a few hours instead of being
ignored for days.

On a new epoch:

1. Read the current Live catalog.
2. Reconcile `planSweep.remainingPlanIds` against current Live ids; drop ids that are no longer Live.
3. If the remaining queue is empty, start a new cycle from the current stable Live ordering. Use the
   Plans projection's stable ordering rather than sorting by volatile checkbox updates.
4. Select the first four ids that still resolve to Live Plans. The batch is fixed in the newly
   durable debt before browser enqueue.
5. Preserve all remaining ids for later epochs. Do not remove the selected ids from the durable
   sweep until this exact debt receives a valid completion receipt.
6. New Plans created during a cycle may wait for the next cycle; the recent-request pass still
   covers their fresh source work. Do not mutate an in-flight debt to chase catalog churn.

All unarchived Live Plans participate. Human-facing Plans should remain ahead of worker/helper Plans
when a fresh cycle is built so user commitments cannot be starved by internal implementation
bookkeeping. Worker Plans still participate after the human set; their existing finish-report and
archive rules remain unchanged by this feature.

## 5. What the heartbeat prompt must contain

The browser-authored heartbeat message must say plainly that the epoch has **two obligations** and
that both must be finished before `chat_review_complete`.

For the durable batch, include a bounded snapshot for each selected Plan:

- exact Plan id and `updatedAt` revision;
- title;
- audience (`human` / Eve-worker projection when known);
- Ready-to-archive state;
- checklist item ids, text and statuses;
- exact provenance fields available to the Plan (`sessionId`, `conversationId`, `threadId`, label);
- worker report state when it affects the current projection.

The prompt must instruct the coordinator to:

1. use `session search/read` on exact source provenance before judging old work;
2. inspect current files/repository/tool history before executing anything;
3. distinguish stale checklist state from genuinely unfinished work;
4. carry out or delegate bounded still-valid work when it is safely executable;
5. explicitly acknowledge every Plan in the exact batch through the heartbeat-only Plan review
   lifecycle tool described below;
6. never archive a human Plan, invent completion, or silently resolve a user decision;
7. call `chat_review_complete` only after the recent pass **and** every Plan target are complete.

The Plan snapshot is local review context for this exact user's coordinator. It is not a public UI
status and must not be copied into the privacy-safe heartbeat public status.

## 6. Heartbeat-only Plan review lifecycle tool

Add one narrow Core lifecycle tool, tentatively `chat_review_plan`, alongside
`chat_review_complete`. It exists to make the durable Plan obligation machine-checkable instead of
relying only on prose instructions.

The tool is available in the normal schema but succeeds only when all of these are true:

- the supplied heartbeat key resolves through `resolveChatReviewContinuity()` to the exact current
  ordinary coordinator;
- an active durable debt exists for that exact key/session/conversation;
- `plan_id` belongs to that debt's exact `planBatch`;
- the current Plan either still matches the target review identity/revision or has become archived
  through a newer authoritative action;
- the caller is not a worker/helper and normal heartbeat identity restrictions still pass.

Suggested arguments:

```ts
{
  key: string;
  plan_id: string;
  expected_updated_at: number;
  classification: 'ready-to-archive' | 'tbd' | 'blocked' | 'superseded' | 'awaiting-user';
  completed_item_ids?: string[];
}
```

### Safe reconciliation

`completed_item_ids` is optional and deliberately narrow. When supplied, the tool may change only
those exact currently-open item ids to `done` through the normal `updatePlan()` mutation owner. It
must preserve title, item order, item text, priority/reminder metadata and every unmentioned item's
status. It must use optimistic `expected_updated_at`; a concurrent change rejects the mutation and
requires the coordinator to refresh/re-review.

Reporting or handing off to Prime is lifecycle evidence, not a Plan checklist item. New Eve/worker
Plans must not add `Report to Prime`, `Hand off to Prime`, or equivalent handoff-only steps.
For legacy Plans that still contain one trailing report-only item after the substantive work is
complete, the last real task plus the archive boundary represents the handoff when explicit report
proof is unavailable. Report-only debt must not keep completed Eve Activity live. Explicit report
delivery remains useful metadata when it is available, but it is not an archive prerequisite.

The tool must never:

- archive a human Plan;
- mark an item done merely because the source chat ended or said “done” in prose;
- change `todo` ↔ `in_progress`, reopen completed items, edit title/text, delete/reorder items, or
  alter provenance;
- operate on a Plan outside the exact heartbeat batch;
- use title, recency or fuzzy matching to recover a missing Plan id.

After any permitted item reconciliation, record the acknowledgement against the **new** Plan
revision/source identity. An acknowledgement without item mutation is still useful for `tbd`,
`blocked`, `superseded` and `awaiting-user` Plans.

Calls are idempotent for the same key/Plan/current revision/classification. A conflicting second
acknowledgement for the same current revision must fail closed rather than silently rewrite review
history.

## 7. Receipt gate and races

`chat_review_complete` remains the only event that retires a heartbeat debt. Harden it so a receipt
for a debt with a non-empty `planBatch` is rejected until every target has one valid acknowledgement.

Immediately before accepting the final receipt, re-read the Live Plans catalog and validate each
acknowledged target:

- if it is still Live, its current `updatedAt` and exact source provenance must match the
  acknowledgement revision;
- if it was archived after review, that newer authoritative disposition is acceptable;
- if it changed while the coordinator was reviewing it, reject completion and require that Plan to
  be reviewed/acknowledged again before the same debt can close.

Only after a valid receipt:

- advance `lastCompletedAt` exactly as today;
- store the privacy-safe `lastReceipt` exactly as today;
- remove this debt's exact batch ids from `planSweep.remainingPlanIds`;
- clear the debt/acks while preserving the remaining sweep queue for the next epoch.

The following races need explicit tests:

- restart/retry with a partially acknowledged batch;
- Compact & Resume or coordinator transfer after one or more Plan acks;
- duplicate `chat_review_plan` calls;
- Plan edited between debt creation and first ack;
- Plan edited after ack but before receipt;
- Plan archived after ack but before receipt;
- source Thread/provenance changed without a Plan `updatedAt` bump;
- receipt persistence failure after all acks;
- duplicate receipt after a successful close;
- a new Plan arriving during the current sweep;
- selected Plan disappearing from Live before it is reviewed.

## 8. Unattended execution behavior

The durable Plan pass is intended to keep Eve useful while the human is away, not merely produce a
status report.

For a `tbd` Plan, after exact source/current-state review:

- if a bounded next action is already authorized by the original request and can be completed
  safely, execute it now or hand it to an available worker, then verify the result;
- if execution is already running elsewhere, do not duplicate it;
- if ownership is ambiguous, fail closed;
- if the next step genuinely requires a human decision/credential/physical action, classify
  `awaiting-user` and leave it open;
- if the Plan was superseded by a newer explicit instruction, classify `superseded` and leave its
  durable checklist untouched unless newer authoritative evidence separately proves item
  completion.

Finding actionable Plan work and actually executing/dispatching it makes the epoch's final heartbeat
result `dispatched`. Merely discovering a Plan is not dispatch.

## 9. Public/UI behavior

No new noisy notification stream is required for this hardening. Existing heartbeat public status
remains bounded and privacy-safe. The coordinator may summarize useful findings in its normal reply,
but the durable Plans screen remains the user's primary backlog view.

Human Plan completion remains **Ready to archive**, not auto-archived signoff.

## 10. Tests and acceptance

Minimum focused source acceptance:

1. Existing `test/chat-review-heartbeat.test.ts` behavior remains green.
2. New heartbeat tests prove deterministic batch selection, cycle rotation, restart preservation,
   transfer preservation and cursor advancement only after a valid receipt.
3. Lifecycle-tool tests prove exact key/session/conversation/batch authority, optimistic revision
   checks, bounded done-only reconciliation, idempotency and all negative cases above.
4. A receipt with an unreviewed Plan target is rejected.
5. A Plan edit after acknowledgement invalidates final completion until re-review.
6. Old state without sweep fields migrates without losing its established heartbeat cursor/receipt.
7. `session-input` tests assert the generated heartbeat copy contains both review obligations and
   the bounded exact Plan snapshot while retaining browser-only transport and explicit receipt copy.
8. Nearest Plan tests verify reconciliation preserves item ids/text/order/metadata and never archives
   a human Plan.
9. Run focused heartbeat + session-input + Plans/MCP suites, TypeScript, `git diff --check`, then
   `npm run verify` for the integrated production change. If a broad gate fails outside this change,
   record the exact pre-existing/current-tree failure instead of widening scope.

## 11. Completion bar

This hardening is source-complete only when:

- every new heartbeat debt durably carries a bounded exact Plan batch;
- the coordinator receives enough exact Plan context to source-follow it without raw AppData reads;
- the batch rotates across all Live Plans while the human is away;
- each target must be explicitly acknowledged before the heartbeat receipt is accepted;
- safe evidence-backed stale checklist items can be reconciled to `done` without granting broader
  Plan editing or archive authority;
- retries/transfers preserve the same batch and partial progress;
- concurrent Plan changes invalidate stale acknowledgements;
- focused and adjacent regressions pass; and
- the engineering docs/worklog state what was actually implemented and verified.
