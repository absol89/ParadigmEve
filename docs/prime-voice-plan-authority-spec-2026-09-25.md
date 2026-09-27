# Prime voice plan authority — 2026-09-25

## Problem

When the user is speaking in the Prime Eve ChatGPT conversation through Voice, the Core connector can arrive without exact Companion `sessionId` / `conversationId` proof. `work_context` correctly classifies that call as `shared-eve` when account-wide Eve access is enabled, but `update_plan` currently rejects before consulting that established authority path.

Observed failure: Prime Voice can read/reason over the current work and use ordinary Eve tools, but `update_plan` returns `Exact chat identity is required to update its plan`.

## Intended behavior

An ordinary connector-authenticated `update_plan` call may borrow the current durable Eve owner when all of the following are true:

1. `sharedEveOwnerForCurrentCall()` accepts the caller under the existing cross-chat Eve policy.
2. That owner resolves to one unique current local session whose current `conversationId` is the same durable Eve owner.
3. The normal session-plan stale-call fence accepts the mutation.

Exact callers continue unchanged.

## Security / ownership boundary

This change does **not** widen exact-owner lifecycle authority. In particular it does not change `chat_review_plan`, `chat_review_complete`, worker/helper exclusions, blocked/superseded/retired fences, session continuation ownership, or archive/signoff semantics.

The borrowed identity is used only to target the current Eve owner's ordinary displayed Plan. It never rewrites the incoming caller as Prime provenance and never guesses from title, recency, tabs, or history.

If the durable Eve owner is absent, shared access is disabled/rejected, or no unique current session matches that owner, `update_plan` still fails closed without mutation.

## Verification

- Regression: an unproven connector-authenticated shared-Eve call updates the current Prime session plan.
- Negative regression: an unproven caller with no resolvable shared Eve owner remains refused and performs no plan mutation.
- Existing exact-owner Plan tests continue to pass.
- Focused live acceptance after installing the fix: start a new Voice conversation in Prime Eve, call `update_plan`, and confirm the Plan is accepted while `work_context` may still honestly report `shared-eve` if Companion proof is absent.
- Separately confirm heartbeat receipt tools remain exact-owner only.
