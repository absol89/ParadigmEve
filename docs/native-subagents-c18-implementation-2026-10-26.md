# 2.4.5 c18 — Prime-mediated native delegation experiment

Status: source implementation under verification. This document is **not** an installed-feature or live-host acceptance claim.

## User decision and boundaries

- Visible, separately inspectable ChatGPT worker chats remain the default. Existing worker runs and ChatGPT model/reasoning choices remain unchanged.
- The native ChatGPT Work subagent routine is an explicitly opted-in, Prime-mediated **research request**, at most four bounded read-only assignments. It is not a third Eve worker executor, an external API call, or proof of a child start.
- The human chooses Chat versus Work in ChatGPT. Eve must not switch account model, reasoning, provider, or API billing route, and it must not use the unfinished GPT Work OAuth/Responses draft as a fallback.
- Eve records exact parent conversation/session request ownership and durable parent-conversation reports. Hosted child principal, tool receipts, reliable lifecycle, and separate approvals are not independently established. A missing or disputed result is unknown, not completed.
- A native child can share the parent's Eve caller proof. While a research request is active, Eve's effectful tools must fail closed for that exact parent context. Other hosted/third-party connector tools remain outside that lock, so this is not a separate sandbox.
- No browser tab mutation, uncertain-send replay, data migration, or public release is part of this feature. Luna/Terra changes are deferred.

## Baseline evidence

- Before c18 edits: branch `release/2.4.5`, HEAD `7fc064a0`; c17 debug still installed.
- Current protected uncommitted GPT Work draft: `package.json`, `package-lock.json`, `src/main/local-agent-runtime.ts`, `src/main/gpt-work-auth.ts`, `src/main/gpt-work-responses.ts`. Preserve and exclude from the c18 package.
- Baseline `verify:ci` at that HEAD previously passed 6,170 tests with 44 skipped. This does not validate newly authored c18 code.
- The c18 candidate label is unused. Candidate helper refuses a dirty `package-lock.json`; use a separately reproducible clean source checkout after focused/full verification, with byte/provenance checks.

## Acceptance gates

1. Ledger, MCP request/report/status, exact-caller and parent-wide effectful denial compile and pass positive plus negative tests.
2. UI opt-in defaults off, preserves the auditable worker route, and honestly states the external hosted limitation in supported locales.
3. Test restart recovery, malformed ledger/ambiguous identity, sibling family isolation, no provider/model fallback or automatic browser actions.
4. Complete `npm.cmd run verify:ci` from the implementation source; review its real failures.
5. Build c18 from a clean checkpoint without protected draft files; verify packaged runtime and installed bytes before live claims.
6. A human-selected eligible Work conversation must still demonstrate actual hosted delegation and approval behavior; source tests cannot establish account eligibility or separate child receipts.

## Results

- Implemented a separate durable `native-delegations` request/report/cancellation ledger and
  direct Core `native_delegation` tool, capped at four read-only assignments. Exact Prime
  conversation/session checks, default-off Settings opt-in, en/sv-SE/es-419 explanations, and
  parent-conversation Eve-effect admission guard are source-integrated.
- Reviewed recovery negatives: the parent lock also denies a same-conversation call with a
  stale or missing session join. The original Prime run ID remains recorded, but a changed or
  absent run ID does not orphan an otherwise exact conversation/session's own record. A wrong
  session or sibling conversation cannot inspect or settle it. Unknown/cancelled remains locked.
- Admission is rechecked immediately before handler entry after asynchronous MCP request
  bookkeeping. Effects admitted before a research lock was prepared are not retroactively
  revoked; third-party/ChatGPT connector effects remain outside Eve's lock.
- `npm.cmd run typecheck` passed; focused Vitest run of
  `native-delegation`, renderer-state, config, MCP declarations and feature parity passed
  **168/168** across five files; `git diff --check` passed. These are source checks only.
- Full `verify:ci`, clean candidate build, silent no-focus installation, installed-byte
  comparison and human-selected Work live-host acceptance remain separate, unverified gates.
