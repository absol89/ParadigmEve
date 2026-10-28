# 2.4.5 local issue — Compact & Resume cancellation provenance and Voice-exit safety

**Status:** Open — first-pass bridge cancellation logging added locally; durable provenance and live acceptance pending. Not a published issue or release claim.
**Priority:** Reliability blocker for local c5 acceptance. **Owner:** Prime Eve.

## Goal

Determine whether Compact & Resume stalled before Eric cancelled it, whether an incoming message superseded the handoff, or whether Eve cancelled independently. Ensure ending a ChatGPT Voice call cannot strand Prime's tool access or trigger unsafe browser repairs, duplicate handoff sends, or unwanted replacement tabs.

## Observed evidence (2026-10-25 UTC)

- Prime local session `2026-10-15-88246b67`, source conversation `6ade4110-ffc8-83eb-8e19-1997c04ba2d8`.
- `mwMgxkhx` opened 21:48:13.567; durable `cancelled` 22:20:50.637. A new Prime turn started at 22:20:49.371 (1.266 seconds earlier).
- `AsoENVG_` opened 22:20:53.271; `cancelled` 22:24:44.092. The last recorded Prime turn ended at 22:24:33.131.
- `MVKOk1nn` opened 22:24:51.784; `cancelled` 22:29:24.655. Its last recorded Prime turn ended at 22:26:58.049.
- These generic `cancelled` records do **not** prove which user or app action initiated the abort. The older `qmNydd4v` has a distinct explicit log that a newer message replaced the handoff request.
- Chrome DevTools showed HTTP 401 on an old conversation API request (longstanding per user), plus HTTP 404 on an OpenAI static Voice path `/voice/silero-vad-v6/ort-wasm-simd-threaded...`. The latter appears to be a Voice Activity Detection runtime asset, **not** an Eve bridge endpoint. Its exact Network request is not retained; do not reload the active tab to recover it.
- Eve logged Voice activity at 22:29:49.750, after the latest abort. This proves Voice activity was observed, not that every Voice component initialized normally.

## Scope

1. Label every cancellation origin at the existing bridge/UI/Companion/automatic-off/summary-validation/stop/superseded-message callsite. Distinguish a human-initiated control from an app-generated request; unknown remains unknown.
2. Capture token, local session, exact source conversation and turn, cancellation timestamp, phase, automatic/manual ticket, source send checkpoint, destination authorization/placement checkpoint and proven request/document identity. Log bounded metadata only, never message bodies, cookies, tokens, headers or model secrets.
3. Persist provenance with the authoritative continuation abort rather than a second independently writable ledger. Keep idempotency and restart reconciliation: one authoritative outcome per token.
4. Establish the earliest failed handoff prerequisite from the recorded source-send/summary/destination checkpoints. Verify whether cancellation occurred before or after an actual stall.
5. During Voice, preserve the existing no-compaction/no-reload guard; after Voice ends, re-evaluate the outstanding ticket once under exact session/document ownership, never blindly resend an ambiguous source or open a duplicate wake chat.
6. Examine the Silero/ONNX 404 separately: capture only URL path, status, initiator and timing on a future naturally occurring Voice start; determine whether another runtime asset loaded and whether Voice functionality was degraded. No forced reload or synthetic Voice call.
7. Compare applicable unreleased upstream changes, notably `totec448-spec/chat-on-steroids` PR #1853 / commit `ded8c4f63bb8465c971aba78bc055dfcf7a907bd` (recorded-brief chosen-browser gate) and open PR #1843 (proven-unsent Goal messages). Do not port unrelated work blindly.

## Non-goals / invariants

- No automatic replay of an uncertain send; no page reload, navigation, retargeting, closure, focus theft or model/reasoning change in an active ChatGPT tab.
- Do not reinterpret shared-Eve authority as exact caller proof, automatically approve provider requests, or allow a heartbeat worker to mutate human Plans.
- Do not edit raw managed AppData records, delete historical handoffs, restart Eve/Chrome, or build/install/publish without a separate decision.
- Preserve all pre-existing dirty tree changes. This issue and diagnostics are local; no commit, push, tag or public issue is authorized.

## Acceptance criteria

- [ ] A manual Cancel records the real caller and exact UI/bridge entry point, without attributing a Companion-generated request to the human by assumption.
- [ ] Superseding user message, automatic-compaction Off, Stop, invalid brief and destination placement failure have distinct machine-readable origins.
- [ ] Every terminal abort records phase and pre-abort send/destination checkpoints; `unknown` is explicit when provenance is missing.
- [ ] Multiple/restarted cancellation attempts produce one coherent durable outcome, with no duplicate send or replacement chat.
- [ ] Commit/committing fence remains non-abortable; source chat and worker family stay attached until a proven destination commit.
- [ ] Voice-active test blocks compaction and browser repair, while Voice exit neither loses a ticket nor bypasses source Send proof.
- [ ] Tests cover user interruption before summary, idle cancellation after a stalled wait, restart, concurrent source/destination events and stale document ownership.
- [ ] A future natural Voice-start observation distinguishes the 404 asset failure from successful/fallback VAD initialization and from Eve tool availability.
- [ ] Focused tests, typecheck and `git diff --check` pass; exact test commands and results are recorded separately from installed-runtime acceptance.
- [ ] One local c5/c6 acceptance run confirms an authentic handoff and worker/tool continuity, or produces a fully attributed safe failure.

## Local implementation / verification checkpoint

- `src/main/bridge.ts` now labels `stop_turn`, `session_ui_cancel`, `companion_cancel_request`, `summary_validation_failed`, `automatic_compaction_disabled`, and `source_message_superseded` at existing cancellation calls. It logs the origin, session, short continuation identifier, phase, automatic flag, source-send checkpoint, saved-summary flag and placement-queued flag before the existing durable abort. The default for other callers remains `unknown`.
- This is **diagnostic logging only**; it does not yet persist an origin field atomically in the continuation record or prove a human click. No cancellation decision or send fence was changed.
- `git diff --check` passed; `npm.cmd run typecheck` passed; `npx.cmd vitest run test/resume.test.ts test/bridge.test.ts --reporter=dot` passed **425/425 tests across two files**. An initial `npm`/`npx` invocation was blocked by Windows PowerShell script policy; the supported `.cmd` shims succeeded.
- Existing unrelated dirty edits in `src/main/bridge.ts` and other files remain preserved. No commit, build, installation or browser action was performed for this issue.

### 27 October 2026 — sent handoff's open answer was reloaded

- Source session `2026-10-26-bd4b2828`, conversation `6adfdae9-c090-83eb-8d5a-8b3ee8d6bc6e`,
  token `77exSw_XcomFvAS61RjwEg`: source Send was durably `sent` at 23:52 UTC; the
  ledger stayed `awaiting-summary`, without a saved brief or destination attempt.
- Eve's session read presents an assistant handoff text at 23:58, but the canonical session
  events show the source answer's `turn_start` and no matching terminal `turn_end` through
  00:08. The visible text is therefore **not** evidence of a completed answer eligible to
  be attached. This does not establish a lost or valid final.
- Installed `app.log` records three `writing` pickup reloads at 23:58:04, 00:03:04 and
  00:08:04 UTC. The old code did not test the durable open answer turn before those reloads;
  the source had not proved that its brief finished. This is a source-level safety gap,
  irrespective of whether some other provider failure also occurred.
- Local source fix: `src/main/bridge.ts` now defers a writing-phase automatic pickup
  while that same source session has an open answer turn. It does not increment the reload
  budget, declare the brief valid, cancel a sent request or replay it. The existing bounded
  pickups remain available once that turn is durably ended.
- Added `test/bridge.test.ts` negative coverage: four five-minute intervals cannot
  reload an open source answer; after its `turn_end`, an ordinary permitted pickup is
  possible. Focused bridge/MCP/native-ledger suites passed **617 tests, 6 skipped**;
  TypeScript and diff checks passed. No browser interaction or live repair was performed.
- The old transfer remains blocked by its open continuation. Do not clear the family's
  transfer flag or alter raw managed continuation data. A new source/installed runtime
  acceptance is required to prove a future complete A→B handoff.

## Starting points

- `src/main/bridge.ts`: `cancelSessionCompaction`, `cancelResumeNowLocked`, `cancelResumeNow`, `cancelAutomaticResumesNow`, `inspectOwedCompactions`, `considerAutomaticCompaction`, source `/resume` handler.
- `src/main/session/continuation.ts`: `abortContinuationNow`, `Continuation` snapshot, source-send state and commit boundary.
- `extension/content.js`, `extension/background.js`: source prompt, document ownership, Voice and repair eligibility.
- `test/resume.test.ts`, `test/bridge.test.ts`, `test/content-script.test.ts`.
- `%APPDATA%\ParadigmEve\app.log`, exact session `events.jsonl` via supported read-only diagnostics.

## Prompt for Eve

Continue this local, uncommitted 2.4.5 issue under the repo's `AGENTS.md` rules. First restate the goal and plan, confirm before changing code if this is a separate handoff, then inspect the current dirty diff and authoritative source. Implement the smallest provenance instrumentation, add negative tests, and collect evidence for Voice-exit/compaction interaction without disturbing the active ChatGPT tab. Report exact source changes, tests, unknowns and live acceptance. Do not commit, push, build or install without further authorization.
