# Cross-chat review heartbeat implementation status

Date: 2026-09-12; durable-Plan hardening updated 2026-09-21

This work closes the gap where a useful ChatGPT conversation could ask Eve for real computer-side
work, receive a good prose response, and then disappear from the execution workflow because the
request was made from another ChatGPT surface or before the local tools were actually used.

## Implemented

- Added a durable semantic review owner in `src/main/chat-review-heartbeat.ts` with a 22-minute
  cadence and a persisted review debt/receipt transaction.
- The first run reviews at most the previous 24 hours; later reviews start at the last **completed**
  heartbeat boundary. A review debt records its exact key, time window, session and conversation
  before any browser transport is attempted. If no trustworthy coordinator exists, nothing is
  advanced and the owner retries later.
- Every new debt uses an opaque random receipt key. Because debt now lands durably before enqueue,
  crash recovery no longer needs a clock-derived key. The random key is disclosed by the heartbeat
  prompt, preventing an unrelated turn from guessing `heartbeat:first` or a timestamp-derived
  receipt before the review prompt has actually reached the coordinator.
- Coordinator selection is deliberately narrow: newest non-worker/non-helper local session with a
  current conversation and positive connector-tool history, followed by a unique current-session
  ownership check. Blocked or ambiguous candidates are skipped rather than guessed.
- The heartbeat queues one normal durable **browser-only** attention input. It never enters an MCP
  tool result and does not type into an inferred source conversation.
- Review attention coalesces with an unclaimed worker-final attention row so internal maintenance
  cannot race itself for the next browser message. Stable review keys make transport replay
  idempotent when the earlier row may have been sent.
- Explicit user input keeps the existing higher priority: an unclaimed internal attention row is
  cancelled when a new user instruction is accepted. That cancels only the transport, **not the
  durable review obligation**. A positively unsent cancelled/failed transport may be reissued for
  the same debt; an ambiguous or acknowledged send is not duplicated.
- The review prompt tells Eve to use exact local `session search/read` history first, then Computer
  Use on the signed-in ChatGPT web history when a phone/app/web conversation has not been recorded
  locally. Sidebar unread/blue-dot state is explicitly not a completion or work signal.
- Eve is instructed to act only on still-valid requests for real execution where the requested
  persistent/computer-side result was not completed, and to recheck newer instructions, current
  files/repository state, already-completed work and running turns before doing anything.
- Browser delivery, send ACK, and a normal assistant final are deliberately **not** completion
  evidence. After the entire semantic review is finished, any still-valid bounded work has been
  executed, and concrete results have been verified, the exact coordinator must call the direct
  `chat_review_complete({ key })` Core lifecycle tool named by the heartbeat prompt.
- The model supplies only the durable review key. `chat_review_complete` obtains request, session
  and conversation identity from the authenticated call context, rechecks the current exact debt
  and ordinary-chat role, and then atomically writes `lastCompletedAt = debt.untilAt` plus an
  idempotent completion receipt. Wrong key/session/conversation, worker/helper callers, blocked or
  ambiguous ownership, missing Companion proof, and nested code-mode calls fail closed.
- A restart or stall with a pending debt reissues the **same review epoch** instead of minting a new
  window. A failed receipt persistence leaves the debt intact so the exact receipt can be retried.
- Compact & Resume does not strand a pending review. Historical conversation A may resolve only
  through the session store's unique retained lineage; if that exact same durable session is now
  attached to conversation B, the heartbeat first durably re-homes the debt to B and then reissues
  the same epoch/key there. It never chooses a replacement by title, recency, visible tab, or text.
- A canonical terminal `turn_end: stalled` can transfer the same pending epoch/key to the newest
  other exact ordinary connector-proven coordinator. This is not a silence timeout: the stalled
  owner must have no newer active turn. If it has started working again, it keeps the debt. The
  owner change is durable before reissue, so a later receipt from the old stalled chat is rejected
  and cannot close or fork the review.
- Legacy 2.0.19 state containing only `lastQueuedAt` is intentionally not treated as proof of
  completion. Upgrade performs one conservative fresh review and replaces that queue-time cursor
  with the receipt-backed format.
- The process-lifetime timer has one startup owner and an explicit shutdown stop hook.
- The existing `work_context` contract teaches direct ChatGPT conversations
  that the tools execute on the always-on computer, that being away from its keyboard does not
  remove access, and that a draft/plan is not equivalent to saving or dispatching the requested
  work.

## 2.2.3 durable-Plan hardening

The heartbeat now has **two independent obligations per new epoch**: the recent-request review
above and a bounded rotating review of durable Live Plans. The Plan pass is independent of age, so
older unfinished commitments cannot disappear merely because they fell outside the recent chat
window.

- `listPlans()` is the authoritative Plan catalog. A sweep keeps at most the bounded catalog of Live
  Plan ids, preserves stable Live ordering, puts human-facing Plans before Eve/worker bookkeeping,
  and freezes at most **four** exact Plan targets per heartbeat. Selected ids remain in the sweep
  until the final heartbeat receipt is durably accepted.
- Each selected target carries exact Plan id, `updatedAt`, source provenance, checklist ids/statuses,
  audience/Ready state and bounded display text. The browser prompt requires Plan → exact Source
  inspection before judgment. Full item text remains in the authoritative Plan/Source; transport may
  shorten only display text and marks it with `textTruncated:true`.
- Heartbeat rendering budgets against the real ChatGPT browser-message limit
  (`MAX_CHATGPT_MESSAGE_CHARS`, currently 96,000), not only the larger durable outbox-row bound. It
  measures the fully rendered attention message, deterministically shrinks only Plan-item display
  text, and re-budgets when worker-final attention coalesces. Exact ids, revisions, statuses and
  provenance are never truncated.
- Every selected Plan requires a direct `chat_review_plan` acknowledgement before
  `chat_review_complete` can succeed. Classifications are `ready-to-archive`, `tbd`, `blocked`,
  `superseded`, or `awaiting-user`. Human Plans are never auto-archived by this lifecycle.
- `completed_item_ids` is an optional evidence-backed, done-only reconciliation. It runs only after
  heartbeat key/caller/batch authority is proven. The Plans owner then atomically revalidates the
  exact expected revision **and full durable provenance** inside the Plans mutation serializer before
  changing only those still-open item statuses. Thread/source changes that deliberately do not bump
  `updatedAt` therefore still invalidate stale reconciliation.
- A successful mutating acknowledgement stores canonical request identity plus the original expected
  revision and exact completed-item set. An exact transport replay returns
  `already-acknowledged` without replaying the mutation; a changed classification/item set/request
  fails closed.
- Partial acknowledgements survive restart, retry, Compact & Resume and installation-owner transfer.
  Retry transport omits already-acknowledged Plan snapshots so unattended bounded work is not
  accidentally executed twice. If a still-Live Plan revision or source changes, its stale ack is
  cleared and that exact Plan is re-presented for review.
- Final `chat_review_complete` revalidates one ack per selected target. Live targets must still match
  exact revision/provenance; a later authoritative archive is accepted. The heartbeat serializer then
  acquires the Plans validation fence and keeps the Plans mutation serializer held through the
  heartbeat receipt write (lock order: heartbeat → Plans), closing the validation/write race without
  making heartbeat state a second Plan database.
- Persisted state fails closed if a Plan-bearing debt lacks its sweep or if any selected batch id is
  no longer present in `remainingPlanIds`. Missing selected Plans also fail closed; new Plans created
  mid-cycle wait for the next cycle.
- Public heartbeat status remains privacy-safe: Plan snapshots, provenance, classifications and item
  text stay out of the public status seam.

## Deliberate boundaries

- ParadigmEve does not claim its local session store already contains every cloud ChatGPT chat.
  Conversations never observed by the Companion are recovered by the coordinator inspecting the
  user's signed-in ChatGPT web history with authorized Computer Use.
- The heartbeat is a semantic review obligation, not a keyword classifier. It does not pre-label
  every recent chat as unfinished work and it grants no new file, account, messaging or source-chat
  authority.
- Existing exact conversation/session provenance remains authoritative for local mutations. If a
  source cannot be proven safely, review may inspect it but execution must fail closed rather than
  attach work to a plausible neighboring chat.
- `chat_review_complete` does not claim that a browser final means the work was reviewed. It is an
  explicit semantic receipt the coordinator is instructed to issue only after review/execution/
  verification. Its authority is limited to closing the already-existing exact debt; it cannot
  create work, change source ownership, or choose another coordinator.
- This source change does not by itself prove installed/runtime behavior. A packaged app or live
  22-minute cycle requires a separate build/install/live acceptance step when explicitly requested.

## Verification

### 2026-09-21 durable-Plan hardening

- Focused durable-Plan lifecycle suite (`chat-review-heartbeat`, `chat-review-plan-tool`,
  `plans-review-reconciliation`, `session-input`): **219/219 passed**.
- Adjacent Plan/direct-only/parity/evecron suite: **49 passed, 3 skipped**.
- Full Core MCP suite: **189 passed, 6 skipped**.
- `npm.cmd run typecheck` — passed on the settled shared tree.
- `git diff --check` — passed on the settled shared tree.
- `npm.cmd run verify` — **passed end to end** on the settled 2.2.3 shared tree: privacy-history,
  notices/native-source inventory, TypeScript and Electron gates passed; the main Vitest phase passed
  **4,880 tests with 42 skipped** across **230 files with 4 skipped**; dedicated
  `test/computer.test.ts` passed **20/20** and `test/mcp-shutdown.test.ts` passed **2/2**.
- These are source-level gates only. No package/install/live 22-minute dogfood was performed as part
  of this hardening task.

The regression matrix now covers stable human-first four-Plan rotation, mid-cycle newcomer deferral,
partial-ack restart/owner transfer, revision drift, provenance-only drift, exact mutating replay,
done-only source fencing, ack-aware redelivery, authoritative archive-after-ack, receipt-persistence
failure, Plans-owner validation held through receipt commit, malformed batch/sweep state, legacy-state
migration, and maximum legal heartbeat snapshots against the real 96k browser transport budget.

- `npm.cmd run typecheck` — passed after the final receipt/stall-transfer changes.
- Heartbeat/input regressions: `test/chat-review-heartbeat.test.ts` + `test/session-input.test.ts` —
  **162 passed**, including same-session Compact & Resume debt migration, canonical stalled-owner
  transfer, and the resumed-active-turn guard.
- Real Core MCP surface: `test/mcp.test.ts` — **176 passed, 6 skipped**.
- Receipt-specific code-mode/MCP checks — **2 passed, 8 skipped** when filtered to the new lifecycle
  cases. The full code-mode file still reproduces its two previously-known unrelated Windows
  Desktop failures; this heartbeat change does not claim those fixed.
- `git diff --check` — passed (repository line-ending warning only, no whitespace errors).
- `npm run verify` was attempted. It stopped before compilation/tests at the repository's public-
  history privacy gate because two existing commits reachable from `HEAD` use non-noreply
  maintainer identities. Shared Git history was not rewritten as part of this feature.
- The remaining verify stages were run independently: third-party notices/native-source checks
  passed, TypeScript passed, Electron resolved, and `mcp-shutdown` passed 2/2.
- The broad Vitest run excluding `mcp-shutdown` completed with 4,004 passed, 40 skipped and 34
  failed. Seven failures are the machine's PowerShell execution policy rejecting temporary `.ps1`
  probes. The other 27 were rerun in isolation and remained in pre-existing/current-tree areas:
  Compact & Resume (20 HTTP-401 assertions), renderer layout (2), renderer i18n (1), artifact
  declaration metadata (1), Desktop code-mode MCP (2), and model-catalog push integration (1).
  None exercises `chat-review-heartbeat.ts`; these were not broadened into this feature change.

These checks establish source contracts and regression behavior. They do not claim that the
currently installed **2.0.19** runtime contains this newer source change. The first directly
observed semantic heartbeat completed successfully on 2.0.19, but that installed build still used
the older queue-time cursor; the receipt-backed durability change requires a later build/install
before it can be dogfooded live.
