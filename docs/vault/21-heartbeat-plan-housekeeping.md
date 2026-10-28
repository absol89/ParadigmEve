# Heartbeat Plan Housekeeping

## c21 execution selection and permission boundaries

Heartbeat behavior is **independent** of the regular worker-execution dropdown:

- **OFF** (default, including upgrades from c20): no new automatic semantic review or queue reconciliation. Exact durable review debt, findings and receipts are retained. A lightweight settings check on the existing scheduler detects later opt-in; it does not read sessions or launch work while off. Work already admitted before switching off is not blindly cancelled or replayed.
- **Auditable chat**: the existing exact-Prime-owned ChatGPT heartbeat reviewer runs in a separate auditable worker chat with the existing read-only heartbeat tool allowlist. It may read local evidence, acknowledge exact Plans and report findings; it does not write user files or use Computer Use. ChatGPT provider approvals belong to that worker chat and cannot be copied from Prime.
- **Native subagent** (parent-mediated, lower-audit): the existing 22-minute scheduler queues the review into the exact idle-safe Prime chat. Prime may request native delegation from ChatGPT Work within its own turn, interpret the child's result, and save only Prime's bounded conclusion and exact Plan/heartbeat lifecycle receipts. The child needs no separate Eve identity or saved reasoning. If the hosted delegation action is unavailable, Prime must report `blocked`, not fabricate a child result. **Never fall back** to an ordinary helper chat or switch models.

Ordinary (non-heartbeat) ChatGPT worker chats can already use write-capable Eve tools when their exact authenticated caller, approved roots and live capabilities permit them; effects have durable worker execution receipts. Any per-chat ChatGPT provider approval is separate and must be granted in that chat by the provider. A child with only a parent's conversation proof must not be treated as the parent or granted its effectful Eve tools: lack of provenance cannot confer write authority. Prime remains responsible for applying and auditing changes proposed by unverified native children.

Changing heartbeat mode does not change model, reasoning effort, enabled worker count, roots, provider approval policy or existing worker backend. This c21 step does **not** implement the future Laya/local-CPU semantic reviewer.

## Debug-build reliability evidence (subsequent development)

The existing Activity/Health diagnostic path now groups **symptoms** from a bounded redacted log, without starting a new watcher, opening a browser, fetching account information or inferring host-side operations. A debug build adds a `reliability` area/signal tag to the JSON Activity export and displays content-free area counts in Health diagnostics. Areas include provider approval, heartbeat, native child proof, worker progress, attribution, Compact & Resume, browser recovery, delivery/ACK, model selection, Voice/VAD, and provider HTTP/stream errors. Explicit `RELIABILITY_DIAG` events use only compile-time event names, elapsed milliseconds and 12-character SHA-256 correlation hashes, not full conversation IDs, paths, text, or tokens. The existing bounded log rotation and debug-build compilation boundary govern retention and visibility.

Diagnostics do **not** grant native hosted-child execution or infer child permissions. The host-only `collaboration.spawn_agent` interface cannot be called unattended by Eve, so the Native heartbeat must be parent-mediated: Eve queues one review only when the exact Prime chat is eligible for its next turn; Prime itself requests a child if supported and writes the interpreted result. This has lower child-level audit intentionally. Full independent native-child write execution still requires a supported child lineage and authority contract; the research-only `native_delegation` ledger is not proof of such a contract. Never implement this via browser DOM injection or app-level impersonation, or interpret Prime-originating tool calls as child-owned effects.

## 2026-10-27 P1: image-bearing user messages and recovery proof

Exact chat `6ae034c4-8984-83ed-8884-2f0cfc268d71` proved a recorded user text turn following the prior assistant final, but the two provider `image_asset_pointer` attachments were not archived as pixels: debug log `page image trace ... parts=2 ... chatGptImageAttachments[2] ... images[2:pointer]`, then `page user image ... recorder=unavailable:ambiguous`. The previous capture accepted only an already-loaded `img` URL with `/backend-api/estuary/content?id=<exact asset>`, so ChatGPT's opaque user thumbnails could never pass the second content-script check even if Fiber proved the correct DOM message. That is not proof the entire user message was dropped, nor proof that a screenshot of a temporarily stale desktop timeline represents canonical on-disk ordering.

The fix extends the existing **single** Fiber-to-recorder pipeline, not a second attachment download mechanism. When the exact keyed user unit has precisely the number of visible images the page's typed user message lists, no conflicting explicit file IDs, and no partial URL matches, Fiber may stamp those DOM images by their typed message/asset pair. The isolated content script captures pixels only from those already-loaded stamped user nodes via canvas. Other roles still require the exact estuary file URL. Absent that evidence, preserve the `unavailable:ambiguous` result; never associate by nearby chat/turn, filename, image appearance or page history. Debug Activity/Health classifies missing previews and the unrelated bounded browser `10 offers unclaimed` recovery symptom separately. Recovery must never reload, navigate or steal focus from the active ChatGPT tab just to manufacture capture proof.

## Purpose

The 22-minute semantic heartbeat must not report a clean `completed` review while durable Plan state still contains proven housekeeping that Eve is expected to resolve or surface.

This change keeps the heartbeat review worker read-only. The worker discovers and classifies state; trusted app-owned lifecycle code or Prime performs any mutation under the existing authority and provenance rules.

## Current failure modes

### 1. Stale checklist state can close quietly

The heartbeat is already required to follow each selected Plan to its exact source and distinguish genuinely unfinished work from stale checklist state. However, the current acknowledgement/result contract allows every selected Plan to be acknowledged and the epoch to finish with `result=completed` even when source evidence shows that one or more still-open checklist items are already complete.

That loses the most useful maintenance outcome: Prime is not told that the Plan itself needs reconciliation.

### 2. `ready-to-archive` is not necessarily a clean outcome

`ready-to-archive` currently records a lifecycle classification, but the final receipt only requires one valid acknowledgement per selected Plan. It does not require the review result to reflect unresolved housekeeping implied by those acknowledgements.

For a human Plan, archiving remains an explicit human action. A human Plan that is already fully checked may therefore remain Live without being treated as an error. But a human Plan whose stored checklist disagrees with authoritative source evidence is actionable maintenance and must not disappear behind a quiet heartbeat completion.

For Eve/worker Activity, when `eveAuthority.archiveCompletedWork` is enabled, a completed Plan should move to Done automatically. If it remains Live after authoritative completion evidence, the app must either perform the permitted cleanup or produce a durable Prime finding explaining why it could not.

### 3. Heartbeat Activity can miss its own archive boundary

The heartbeat worker commonly records a final Plan item for the lifecycle receipt. `chat_review_complete` currently attempts to archive the worker session's finished Plans immediately after the receipt succeeds. At that moment the worker may not yet have been able to mark its final receipt item done. The later `update_plan` call completes the checklist, but there is no guaranteed second auto-archive trigger, leaving a fully completed Heartbeat review card in Live.

## Required behavior

### A. Preserve the read-only review lane

- Heartbeat workers may read exact local/session evidence, maintain only their own Activity checklist, and submit lifecycle classifications/receipts.
- They must not directly edit human Plans, archive human Plans, execute user work, delegate work, drive the browser, or infer ownership from titles/recency.
- Shared Eve authorization never substitutes for exact caller/session/worker lineage.

### B. Represent stale checklist evidence explicitly

The lifecycle protocol needs an explicit way to distinguish:

1. work is genuinely unfinished;
2. stored checklist state is stale because exact source evidence proves one or more open items are complete;
3. every stored item is already done and the Plan is merely waiting at an archive boundary;
4. work is blocked, superseded, or waiting on the user.

Use a non-mutating `stale-checklist` classification plus bounded `stale_item_ids` evidence identifying the exact open item ids believed complete. The evidence is review metadata only; it grants no mutation authority. It must be stored separately from the legacy `completed_item_ids` / mutation-request contract.

If a narrower implementation reuses `ready-to-archive`, it must still preserve the distinction between "stored checklist already complete" and "stored checklist is stale" in durable review state so the final receipt can make the correct housekeeping decision.

### C. Do not let actionable housekeeping close as `completed`

Before accepting a heartbeat receipt with `result=completed`, revalidate the exact Plan batch and its acknowledgements under the existing Plan-owner fence.

- A stale-checklist acknowledgement that has not been reconciled is actionable housekeeping. `completed` must be rejected; the review must return a provenance-bound finding to Prime.
- A completed Eve/worker Plan still Live while `archiveCompletedWork=true` is app-owned housekeeping. The host may archive it only after exact revision/source revalidation. If cleanup cannot be proven or committed, the review must return a finding rather than silently complete.
- A fully checked human Plan may remain Live as `ready-to-archive`; the heartbeat must not archive it automatically. This is not itself a defect unless source/checklist state disagrees or other actionable work remains.
- `tbd`, `blocked`, `superseded`, and `awaiting-user` keep their current semantics; do not manufacture Prime work when the source is already actively owned or the user decision is genuinely outstanding.

The durable receipt remains the only heartbeat completion boundary.

### D. Reconcile stale checkboxes only through Prime authority

When the review worker proves that specific open human-Plan items are complete:

1. persist a bounded structured reconciliation obligation containing the heartbeat key, coordinator session, exact Plan id/revision/provenance, and sorted stale item ids;
2. return a compact durable finding containing the exact Plan id, reviewed revision, item ids, and source-backed reason;
3. Prime re-reads the current Plan/source;
4. Prime consumes the structured obligation through a narrow Prime-only lifecycle action; the action derives its mutation target from durable state rather than trusting finding prose or model-supplied mutation arguments;
5. the Plans owner completes only the exact evidence-backed items through the existing expected-revision/provenance CAS path;
6. successful reconciliation updates the originating session-local Plan as well as the first-class catalog when that exact source still matches;
7. if the Plan changed meanwhile, fail closed and require re-review rather than applying stale completion;
8. consuming the same obligation twice is an idempotent success/no-op, and an obligation may be replaced only by a newer reviewed revision of the same Plan;
9. never infer completion merely from elapsed time, a final assistant message, or a worker report that is not bound to the Plan's source.

### E. Make Eve Activity auto-archive converge

When `archiveCompletedWork=true`, completed Eve/worker Plans must eventually leave Live without relying on a one-shot timing coincidence.

Add an idempotent post-projection cleanup trigger after a heartbeat worker successfully updates its own Plan to an all-done state. Do **not** use the existing session-wide archive helper for this trigger: it can sweep multiple ready Plans from the same session and does not bind the original cleanup decision to one reviewed revision/source.

Use an exact single-Plan CAS archive helper. It must:

- apply only to the exact heartbeat review worker/session;
- run only after the `update_plan` projection has durably succeeded;
- take the projected Plan id, expected `updatedAt`, full provenance and expected source session;
- re-read the exact Plan under the Plans mutation serializer;
- require the same live revision/provenance/session, derive `audience=eve`, and require `readyToArchive`;
- re-read `archiveCompletedWork` inside the serialized commit and refuse the automatic archive when disabled/revoked;
- archive only that one exact Plan;
- tolerate replay: already archived is success/no-op;
- never sweep unrelated Activity or human Plans.

If that projected Plan is itself a target in the currently active heartbeat debt, defer its automatic archive until that debt is gone so the worker cannot move the revision under its own active review batch.

Keep the existing receipt-time cleanup as an opportunistic fast path if useful, but correctness must not depend on the final checklist already being done before the receipt call.

### F. Existing stale Activity cards

Do not raw-edit `state/plans.json`.

Once the lifecycle fix is in place, the heartbeat Plan sweep should encounter old completed Eve Activity cards. With archive authority enabled, trusted host cleanup may archive an exact reviewed `readyToArchive` Eve Plan only through the same revision/provenance-fenced single-Plan helper. If an old card cannot be safely attributed or is not actually complete, surface it to Prime rather than guessing.

The review worker remains classification-only: it does not gain `archivePlan`, `completed_item_ids`, or generic Plan mutation authority. The trusted host may perform only the configured Eve-Activity archive after validating the worker's exact reviewed target.

## Safety and race requirements

- Preserve the existing heartbeat -> Plans lock order and exact revision/source fences.
- Never call a nested Plans mutation helper from inside `withPlanReviewValidationFence`; it already holds the Plans serializer. Any archive must happen through one owner-level mutation or before the final receipt fence, then the receipt re-observes the newer authoritative archive.
- Never turn an acknowledgement into mutation before re-reading the live Plan under the owner serializer.
- A newer Plan revision invalidates stale item-completion evidence.
- A later authoritative archive is acceptable and must remain idempotent.
- Crash between classification and receipt must leave review debt pending, not half-applied.
- Crash after a safe Eve-Activity archive but before receipt persistence must be replay-safe; the next attempt observes the authoritative archive rather than applying it twice.
- Revoking `archiveCompletedWork` between review and mutation must prevent automatic archive.
- Read-only heartbeat worker tool permissions must not be broadened to generic Plan mutation APIs.
- No browser/UI action is part of housekeeping.
- Archive/cancel source-card clearing must compare the full current Agent Plan document, not step text alone; a concurrent same-text reopen with changed status/details is newer work and must not be cleared.
- Repeated unchanged stale-checklist findings should be deduplicated by the exact reviewed Plan target/revision/source. A changed revision/source/archive state creates a new obligation and may be reported again.

## Regression coverage

Add focused tests for at least:

1. source proves an unchecked human Plan item is complete -> heartbeat cannot close quietly and returns actionable housekeeping metadata/finding;
2. the same Plan changes revision before Prime reconciliation -> no item is completed;
3. stale evidence is stored separately from legacy mutation metadata; workers still cannot submit `completed_item_ids`;
4. a structured reconciliation obligation survives restart, can be consumed only by the exact ordinary Prime session, mutates once, and rejects foreign/wrong-session/wrong-plan callers;
5. successful reconciliation updates both the first-class Plan and its exact still-matching session-local checklist;
6. a same-text but reopened/newer session-local checklist is not cleared or overwritten;
7. a fully checked human Plan remains Live/ready-to-archive without automatic archive;
8. completed Eve Activity + archive authority enabled -> exact Eve Plan archives;
9. completed Eve Activity + authority disabled/revoked -> remains Live without unauthorized mutation;
10. heartbeat receipt succeeds while its own final Activity item is still in progress, then the following all-done `update_plan` archives only the exact projected Plan;
11. an own-Activity Plan selected in the active heartbeat batch is not archived until that batch is no longer active;
12. replay of the post-update cleanup is idempotent;
13. unrelated Eve Activity and human Plans are never swept;
14. archive/revision race between acknowledgement and receipt either observes the newer authoritative state or fails closed;
15. blocked/awaiting-user/tbd/superseded reviews do not create false housekeeping findings;
16. restart with pending heartbeat debt preserves the same reconciliation obligation and does not duplicate mutations/findings;
17. unchanged stale-checklist evidence is not re-reported every sweep, but revision/source change makes it eligible for review again.

## Acceptance criteria

- A heartbeat may say `completed` only when the reviewed window contains no newly unowned actionable request and the selected Plans contain no unresolved housekeeping that Prime or permitted app-owned cleanup must perform.
- Stale unchecked checkboxes proven complete are surfaced to Prime with exact Plan/item provenance.
- Prime can safely reconcile those exact items after the worker review closes without turning finding prose into mutation authority.
- Finished Eve Activity no longer accumulates in Live when archive authority is enabled.
- Human Plans are never archived automatically by heartbeat maintenance.
- All cleanup paths are revision-fenced, provenance-bound, idempotent, restart-safe, and covered by focused tests.
