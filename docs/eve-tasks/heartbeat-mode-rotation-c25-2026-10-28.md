# 2.4.5 c25: heartbeat mode-switch and rotation retry custody

## Reproduced incidents

- 2026-10-27 23:35:26 Stockholm: `HEARTBEAT_MODE_NOT_AUDITABLE`; the selected heartbeat mode was Native subagent, while an unacknowledged durable debt still belonged to the worker lane (`heartbeat:81cb4b20-...`). No native review had completed.
- 23:29:08, 23:34:14 and 23:37:15: three explicitly **not sent** automatic rotations for the same exact ChatGPT turn, straddling the c24 reinstall. The scheduler's two-attempt cap was process-memory-only.

## c25 source behavior

1. The existing heartbeat mode observer and Settings transaction retire incompatible review debt before dispatching the newly selected lane. The previous debt/key/window/Plan revision and acknowledged targets are fsynced to `chat-review-superseded-<index>` before the active debt is removed. `lastCompletedAt` is **not advanced** and the Plan sweep remains. A subsequent review uses a fresh key and includes the uncovered window. Old-key receipts are rejected. Every successful supersession advances `supersessionCount`; no human Plan mutation or automatic archive occurs.
2. Only definitely pre-Send heartbeat-attention rows may be cancelled during a mode change. A previous `sent`, send-authorized, or ambiguous legacy browser row blocks supersession; neither a second semantic review nor a silent worker/native fallback is launched. `off` stops new reviews, retaining coverage for later. Existing pending findings are independent and preserved.
3. Automatic turn rotation reserves a per-exact-turn filing budget in a separate durable app-owned ledger **before** appending the browser outbox row. The gate also recognizes retained pre-c25 rotation receipts. A failed ledger write prevents enqueue; a failed enqueue after reservation conservatively spends the attempt. The in-memory scheduler reads that ledger after restart to preserve both the cap and five-minute cooldown. Recovery-Continue text uses the prior independent path, and no failed send is automatically replayed.
4. Browser pre-Send refusals distinguish `turn-changed`, `turn-has-tools`, `stop-timeout`, and `composer-unavailable`; all are terminal `not sent` receipts and never permission to reload or resend. Exact user/turn ownership remains required.

## Acceptance gates

- Mode worker→native or native→off: exact former debt archived and removed; new review retains Plan batch and full uncovered time interval; no old-key `chat_review_complete` authority.
- Mode change with possible Send: no new review and no state loss.
- Crash during supersession archive: old debt remains live.
- Two spent automatic rotations remain spent after process restart, including old c24 failed rows; a new exact turn gets its own budget.
- No browser reload, focus change, model switch, uncertain-send replay, raw managed-state edit, worker/chat fallback, automatic human Plan archive, public tag or push.

Live Native subagent-host execution remains a separate acceptance item: queuing a parent-mediated review is not evidence a hosted child actually ran.
