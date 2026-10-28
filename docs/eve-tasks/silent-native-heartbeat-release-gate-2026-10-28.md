# 2.4.5 — Native heartbeat must not wait for an extra permission click

## User-observed problem

Heartbeat activity appeared in a separate ChatGPT worker chat and asked the user to approve
another action. Unattended maintenance that waits for a fresh approval stalls. The user selected
Native Subagents and wants heartbeat to quietly inform Prime, which may continue or pivot based
on verified findings. The earlier manual worker-21 review was a distinct separate-chat task;
the selected Native heartbeat itself still used a Prime browser Send in c25.

## Source-only correction after installed c25

- Native-parent review and its findings use the existing durable tool-result delivery to the
  exact Prime session. No new worker, browser Send, tab or model selection is authorized by the
  heartbeat transport. If Prime is not currently calling Eve tools, the review remains queued.
- Existing c25 native review/finding browser entries migrate only if never claimed/offered.
  Already leased, authorized, ambiguous or sent entries remain original custody evidence.
  Browser claim and send authorization are fenced while Native heartbeat is selected.
- Existing legacy heartbeat-worker bootstrap, revival and inbox publication paths are fenced
  when Auditable Chat is no longer the selected heartbeat mode. The browser command redeemer
  checks again before handing out text. Unleased stale commands may retire; leased commands
  retain ACK/expiry custody. Historical worker/chat data is not erased.
- A tool-result maintenance header explicitly distinguishes review instructions from new
  instructions by the user. The reviewer cannot execute user work or mutate Plans.

## What this does **not** prove

- It does not bypass ChatGPT/provider tool permissions. A provider approval prompt still wins;
  silently granting permissions is neither possible nor authorized.
- A model which is idle cannot spontaneously execute a review. No new background model turn is
  opened; a pending review joins Prime's next already-running Eve tool call.
- It does not prove the ChatGPT model reliably *acts on* the tool-result appendix on all model
  configurations. This needs installed dogfood with GPT-6 High and matching request-id evidence.
- It does not prove a hosted Native Subagent child ran. With no available native delegation
  primitive, the review must be blocked rather than faked or sent to a legacy worker.
- Previously leased legacy browser commands may already have reached a provider page before
  revocation. Preserve their receipts; never claim their old approval cards were withdrawn.

## Release gates

1. Focused broker/heartbeat/outbox/MCP regression suite, typecheck and diff checks pass.
2. Build a **new monotonically numbered** candidate, never rebuild/relabel installed c25.
3. Silent non-focus install, verify installer/source provenance and installed app.asar hash.
4. Live test: during a continuing Prime Eve tool turn, one due Native heartbeat is appended
   to that tool result without new browser chat, Send or separate permission; the exact Plan
   acknowledgements and `chat_review_complete` receipt complete or block truthfully.
5. Verify stalled/absent Prime leaves the review queued with no duplicate retry, and a mode
   switch never reopens a legacy heartbeat worker; preserve ambiguous receipts.
6. Confirm real hosted native child execution separately when the host actually exposes it.

No public push, tag, main merge or release is authorized by this source-only fix.
