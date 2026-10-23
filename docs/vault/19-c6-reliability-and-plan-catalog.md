# 2.4.4 c6 reliability and Plan-catalog recovery

Status: implementation specification, 2026-10-23. Source is the c5 installed
dogfood and the dirty `release/2.4.4` c6 worktree; this is not an acceptance
claim for an installed c6.

## Evidence and priority

- Installed c5 remains in use. Do not rebuild/reinstall it as a workaround.
- At inspection the live `plans.json` was 777,880 bytes, with 281 records:
  255 archived, 23 live with every item marked done, and 3 live unfinished.
  A done checklist is **not** by itself proof that the source work and delivery
  receipts settled. Historical archived records are user history, not garbage.
- Heartbeat `heartbeat:420430eb-f007-4dc5-a9e2-9e23f7b98972`
  remains unacknowledged. Its historical sources were read, but current revisions
  could not be verified by the installed worker. Do not fabricate acknowledgments,
  complete the debt, or retry an ambiguous mutation.
- Generic Eve `read` deliberately caps model-visible text to 512 KiB; the
  incorrect dependency is forcing a heartbeat reviewer to read an entire
  single-line catalog. Keep a bounded output cap and return the exact scoped
  records instead. Source already has `currentChatReviewPlanEvidence()` and a
  review-worker projection in `tools-core.ts`; c6 must exercise this path end
  to end, including a >512 KiB catalog and exact worker identity.

## Invariants and ownership

1. **Plan storage:** `plans.ts` owns mutation and serialization. Never edit
   `/appdata/state/plans.json` directly to retire, reorder, or complete Plans.
   A Plan with `archivedAt` is immutable history. A live Plan may be archived
   only through `archivePlan(id)` after `readyFromRealWork` confirms the
   source/delivery boundary. Incomplete, awaiting-user, blocked, or ambiguous
   Plans remain live. Preserve source provenance, items, receipt references,
   revision and audit history. A bulk operation must re-check each ID under the
   existing mutation serializer and report successes/rejections individually.
2. **Read projection:** The review worker gets only the current durable debt's
   exact `planBatch`, with live updatedAt, source session/conversation, and
   acknowledgement state. It never gets the whole catalog merely by using an
   app-owned maintenance path. A wrong worker, missing caller proof, changed
   debt key, or wrong epoch fails closed. Scope and authorization are checked
   both before and after asynchronous attribution. No line-range trick may
   fall through to an unbounded raw read. Projection size is bounded by four
   Plans, not total catalog bytes.
3. **Caller authority:** Exact chat/session plus worker/run/invocation proof is
   required for worker Plans, foreign inbox mutation, and review receipts.
   Shared-Eve permission is not a substitute for this proof. No fallback that
   attributes an unknown worker to Prime. An unattributed worker cannot update
   Prime's `update_plan`; retries must wait for fresh exact page evidence.
4. **Heartbeat:** Source session search/read precedes a Plan classification.
   Each `chat_review_plan` uses the exact current key/id/revision; the terminal
   `chat_review_complete` occurs only after every acknowledgement. A failed
   review leaves debt durable. Compact & Resume transfer is an informational
   deferral with retry, never an excuse for duplicate findings.
5. **Browser:** Recovery obtains current-generation Chrome document proof
   without reload. Unattributed repair needs positive exact page status and
   fresh tab state; active, audible, streaming, draft, pending-navigation or
   unknown states veto reload. Do not open duplicate ChatGPT tabs, replay
   uncertain sends, or change the user's model/reasoning.
6. **Worker receipts:** A tool invocation receipt must bind exact worker,
   run, invocation, action and result. Persist the intent/lease before dispatch
   and settle success/failure only on authoritative evidence. On restart,
   reconcile incomplete receipts; ambiguous external effects never replay.
   Upstream ChatGPT approval remains an independent gate.

## Free-plan Compact & Resume comparison

The upstream chat-on-steroids **v2.1.45** release (2026-10-22) says it fixed a
Free-plan resume that stopped before Send because Free lacks a model picker;
its destination now uses ChatGPT's current model. This is reference behavior,
not authority to switch Eve architecture.

Eve's `extension/content.js` bootstrap calls `selectModelSettings` only if
the command carries a model or reasoning value. In `chatgpt-dom.js`,
`selectModelSettings` first checks `nativeDefaultModelSurface` and returns
without opening the picker for positively identified native-default accounts.
The detector requires a visible composer and no picker/paid-tier evidence,
plus provider-native control before its picker wait completes. However an
unrecognized Free UI may still fall into the 15-second picker path and fail
`picker_trigger_missing`. Thus **partial source protection, not proven
end-to-end Free-plan acceptance**.

Acceptance: a Free/Go destination without a model picker submits its first
resume message using the provider's native current model; saved paid selections
cannot block it or cause picker clicks. A paid destination with temporarily
unhydrated picker is never misclassified as Free. A real paid requested model
is selected only with user-confirmed authority; no fallback silently switches
model or effort. Wrong route, draft, or ambiguous send retains the durable
outbox without a replay. Exercise the actual resume bootstrap, not just the
picker helper.

## c6 acceptance matrix

| Case | Required evidence |
| --- | --- |
| >512 KiB single-line Plan catalog | Exact heartbeat batch projection returns current revisions within output budget |
| Foreign/unattributed worker | No catalog disclosure, Plan mutation or receipt |
| Debt rotates during read | Previous worker sees rejection, never newer batch |
| 23 currently all-done live Plans | Exact source/receipt checks; archive individually only if `readyToArchive`, with rejected IDs reported |
| Three unfinished live Plans | Remain untouched regardless of cleanup request |
| Free/native-default resume | First message reaches provider without picker or paid-model selection |
| Paid picker hydrates slowly | No mistaken Free classification or silent model change |
| Missing Companion recovery proof | In-place re-registration, no reload |
| Browser tab selected mid-repair | Reload veto persists after async probe |
| Worker tool result ambiguous on restart | Durable unknown receipt, no duplicate action |
| `update_plan` unknown/worker owner | Prime Plan remains byte/revision-identical |

## Scope decision

**c6 now:** source-level browser recovery repairs already dirty in the tree;
scoped Plan reader regression and correct ownership checks; Free/native-default
bootstrap regression; selective ready-to-archive cleanup through supported
Plan APIs; combined focused tests, typecheck and diff check.

**Not automatically c6:** unbounded archive re-index redesign (observed
820 MiB peak), model catalog refresh optimization (68.7 s observed), broad
storage migration to per-Plan files, and removal of terminal workers with
waiting messages. These require their own measured acceptance and migration
or lifecycle design. Do not increase the generic read payload limit to hide
the Plan problem.

## Claude reverse prompt if owner conflict prevents safe implementation

Work only on ParadigmEve `release/2.4.4` in the canonical shared worktree.
Read `AGENTS.md`, this spec and every current diff. Do not reset, stash, clean,
or overwrite c5/c6 staged edits. Implement durable independent-worker
execution receipts and restart reconciliation in exact scope
`src/main/mcp/kernel.ts`, `src/main/session/recorder.ts`,
`src/shared/session.ts`, and one **new** dedicated regression test;
coordinate ownership with unfinished worker-65 work before touching files.
Identity must bind caller conversation, session, worker/run and invocation;
shared Eve authority never synthesizes Prime identity; a foreign/unknown
caller fails closed; record intent before effect, settle only with evidence;
restart must neither lose a receipt nor replay an ambiguous effect.
Negative tests: unknown identity, recycled worker number/new run, stale
invocation after retirement, duplicate retry after ambiguous result,
restart between effect and receipt, and denied upstream approval.
Validate the new focused Vitest suite, `tsc -p tsconfig.json --noEmit`,
and `git diff --check`. No browser manipulation, app install, raw state edit,
new grant store, broad tool privileges, PR, push or release.

Separately investigate model-catalog latency and archive peak RSS in their
own bounded tasks; collect profiles before changing architecture.
