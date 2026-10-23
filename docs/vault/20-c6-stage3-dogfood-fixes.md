# ParadigmEve 2.4.4 c6 — Stage 3 dogfood fixes

This is the implementation specification for the remaining Stage 3 reliability
work after the installed c6 dogfood run. Work only in the canonical
`release/2.4.4` worktree. Preserve every existing staged/unstaged change.

**Later release status (2026-10-23):** This document retains the original c6
specification and its then-current prohibitions as historical instructions.
The user subsequently authorized cumulative 2.4.4 integration into main,
source tag and GitHub push, but did not authorize `publish.yml` or Latest
promotion. c7 has since been installed and dogfooded. The source now includes
additional native Send observer rearming, Compact & Resume live-handoff
protection and input pickup log clarity **after c7**. The durable worker
receipt seam below was taken over after the user cleared the swarm and the
Agents UI showed no workers. A source-level pre-effect ledger has been added
for exact ChatGPT-hosted and local in-process worker calls. Completed-result
reoffer and installed restart behavior still require acceptance; see the
release notes.

## Current verified state

- c6 was built, installed and restarted successfully on Windows.
- Full pre-build verification passed: 5,983 tests passed, 44 skipped.
- The installed `resources/app.asar` matched the c6 packaged payload exactly.
- The tree remains intentionally dirty on commit `02245c7d`.
- The installed c6 dogfood clipboard contained exactly **15 WARN lines**.
  They collapse to caller-attribution / worker-identity failures rather than
  fifteen independent defects:
  - request `bb4db1b0-4519-4e4a-a811-5dde3d877899`: 8 attribution warnings;
  - request `708c053f-e014-4994-aca0-de7038242787`: 5 ordinary attribution
    warnings plus one `agents caller not identified` warning;
  - request `00904970-da74-48b2-a03d-608fe93e1eba`: 1 attribution warning.
- Large direct reads of `/appdata/state/plans.json` are still rejected. The
  generic 512 KiB output ceiling is not to be increased; exact Plan records
  must be projected through bounded APIs.
- The generated Archive contains the Prime conversation but its published
  snapshot lagged the newest messages after restart/install.
- Dogfood logs showed browser repair reloads after assistant transport failure
  and unattributed recovery. The logs do not prove draft loss, but active,
  selected, audible, streaming, draft-bearing, navigating or otherwise
  uncertain ChatGPT tabs must never be reloaded.
- Historical Plan reviews have accumulated exact ready-to-archive receipts.
  Do not delete or rewrite those receipts. Do not infer completion for blocked
  worker-65 provenance work.

## Goal

Finish c6 Stage 3 by repairing the smallest ownership and recovery boundaries
that explain the dogfood evidence, then prove them with regressions. Do not
paper over failures by widening permissions, increasing generic output limits,
inventing caller identity, replaying uncertain effects, or bulk-editing state.

## Priority 1 — exact caller attribution and worker identity

Trace the complete request path from model-facing MCP admission through
request-id/page evidence correlation, recorder ownership, and worker broker
authorization.

Required invariants:

1. One HTTP/MCP request id may produce several tool calls. Every child tool
   must retain the same exact proven conversation/session identity when that
   evidence exists; later calls must not repeatedly time out into Unattributed.
2. Shared Eve permission is authorization only. It must never synthesize
   Prime, worker, run or conversation identity.
3. Exact worker authority binds conversation + session + worker id + run id +
   invocation. A recycled worker number or stale invocation is foreign.
4. `agents`, `update_plan`, foreign inbox reads and Plan mutation fail
   closed when exact identity is absent.
5. Read-only tools may be recorded as Unattributed when proof truly cannot be
   established, but a previously proven same-request identity must not be
   discarded accidentally.
6. Attribution repair must be idempotent and restart-safe. An ambiguous
   external effect is never replayed simply to obtain attribution.

Likely owners to inspect before editing:

- `src/main/mcp/kernel.ts`
- `src/main/correlation.ts` and request-attribution owners
- `src/main/session/recorder.ts`
- `src/shared/session.ts`
- `src/main/agents.ts`
- `src/main/mcp/tools-core.ts`
- `src/main/mcp/plan-tool.ts`
- nearest attribution / call-context / agents tests

Do not overwrite unfinished worker-65 work. Inspect current diff and any
durable worker status before touching `kernel.ts`, `recorder.ts` or
`shared/session.ts`.

Negative tests must include:

- several child tools under one proven request id retain exact caller identity;
- missing page evidence from the beginning remains Unattributed;
- shared authority never becomes Prime;
- stale request evidence cannot attach to another conversation;
- recycled worker id/new run is refused;
- worker tool call after retirement is refused;
- restart between external effect and receipt does not replay the effect;
- `agents` and `update_plan` refuse unknown/foreign caller.

## Priority 2 — scalable exact Plan reads and archival

The generic file reader stays bounded. Heartbeat and Plan maintenance must read
only the exact batch/ids/revisions required even when the underlying
`plans.json` is a large single-line file.

Required invariants:

1. A >512 KiB catalog does not block exact heartbeat Plan retrieval.
2. The worker receives only the debt's exact Plan batch, never unrelated Plans.
3. Debt-key or revision rotation during the read rejects stale work.
4. Archive only exact Plans already classified `ready-to-archive` with
   matching current revision and preserved source/review receipts.
5. Active, blocked, awaiting-user, sleeping-worker-owned or otherwise
   unfinished Plans remain unchanged.
6. Never raw-edit `plans.json` and never raise the generic read limit.

Add regression coverage for a >512 KiB **single-line** catalog and a mixed
catalog containing ready, active, blocked and foreign Plans.

## Priority 3 — protected browser recovery

Reconcile the installed-c6 reload evidence with the intended safety policy.
Check every reload reason, not only `reason === 'unattributed'`.

Required invariants:

1. Never reload, navigate, close, retarget, replace or steal focus from a
   currently selected/active ChatGPT tab.
2. Audible/voice-call, streaming, unsent-draft, pending-navigation, unknown
   page status, stale conversation proof, or failed safety probe all veto
   automatic reload.
3. Acquire fresh Companion document proof by current-page re-registration or
   in-place content reinjection with `allowReload:false`; never reload merely
   to manufacture proof.
4. Immediately before any permitted background reload, re-read native tab
   state and exact conversation evidence to close the selection race.
5. No uncertain Send is replayed and no duplicate ChatGPT tab is opened.

Add a regression where an inactive tab becomes selected after the initial
probe for **each automatic recovery reason capable of reloading**, including
assistant-error recovery if applicable.

## Priority 4 — Archive freshness after restart

The Archive may rebuild successfully while the published static snapshot lags
new canonical session messages. Find the earliest missing durable boundary.

Required invariants:

1. Canonically recorded user/assistant messages committed after startup cause
   the already-published Archive to become dirty and refresh within the normal
   bounded publication policy.
2. Restart/install does not leave a permanently stale static generation.
3. A refresh failure preserves the previous valid site and remains retryable.
4. Do not scrape ChatGPT browser history to reconstruct missing messages.
5. Do not duplicate canonical messages during recovery.

Use the observed sequence as a regression shape: Archive publishes; newer
Prime messages commit; static Archive initially lacks them; next publication
must include them exactly once.

## Durable worker execution receipts

If not already completed by worker-65, implement the existing c6 contract:
persist intent/lease before dispatch; bind receipt to exact
conversation/session/worker/run/invocation/action; settle only from
authoritative evidence; reconcile incomplete receipts after restart; retain
`unknown` for ambiguous external effects and never replay them.

If current worker-65 changes conflict or ownership is unclear, do **not**
overwrite them. Report the exact conflict and leave a precise follow-up diff
scope instead.

## Validation

Run the nearest focused suites first, then adjacent boundary suites:

- attribution/correlation/call-context/MCP;
- agents/worker broker;
- Plan authority + heartbeat + Plan reconciliation;
- extension/background + bridge + content-script;
- archive runtime/store/restart integration;
- dedicated worker receipt regression if implemented.

Then run:

```powershell
& .\node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit
git diff --check
```

If focused and adjacent suites pass, run full `verify:ci` before packaging
another candidate.

## Explicit do-not constraints

- Do not reset, clean, stash or overwrite the shared dirty worktree.
- Do not merge, tag, push, publish or create a public release.
- Do not build/install another candidate until fixes and tests justify it.
- Do not inspect ChatGPT browser history.
- Do not raw-edit worker, Plan, receipt or Archive state.
- Do not replay uncertain sends or external tool effects.
- Do not widen shared Eve permissions to solve identity.
- Do not synthesize Prime/worker identity from connector authorization.
- Do not increase the generic 512 KiB reader limit to hide Plan scaling.
- Do not change the user's ChatGPT model/reasoning selection.
- Do not reload/close/retarget/navigate away from an active ChatGPT tab.
- Do not remove sleeping workers 65/66/heartbeat infrastructure merely for
  cleanup.

## Completion report

Return:

1. root cause for each dogfood finding actually addressed;
2. exact files/functions changed;
3. tests added and their negative cases;
4. commands and pass counts;
5. anything intentionally deferred and why;
6. whether the remaining Stage 3 acceptance matrix is now fully satisfied.

Do not stop at a prose audit if a bounded safe implementation is possible.

## Implementation status at the c6 checkpoint (2026-10-23; superseded in part)

Addressed in the dirty `release/2.4.4` tree; no candidate was built or installed.

- **Worker-lane heartbeat key impersonated Prime** (`src/main/mcp/tools-core.ts`, `callerNow`).
  Request `708c053f`: worker-67's unattributed `agents` call carried its worker-lane `review_key`,
  resolved through `resolveChatReviewContinuity()` to the coordinator, ran as Prime (revived
  Prime's dormant run, then failed as Prime messaging itself) and was recorded under Prime.
  Worker-lane keys are printed only into the reviewer's task, so they no longer recover any
  `agents` identity; only legacy Prime-lane keys do. Regression: `agents.test.ts`
  "never turns a worker-lane heartbeat key into Prime identity for an unattributed call".
- **Unattributed request ids** (`bb4db1b0`, `708c053f`, `00904970`): the app-side join is
  already per-request, first-proof-wins and permanent, with late exact repair. The page never
  reported these ids, even after the reload; the browser-side cause is not proven from logs.
  The raw `plans.json` rejections in the same requests follow from that: without exact worker
  identity the scoped heartbeat projection correctly fails closed.
- **Protected browser recovery** (`extension/background.js`, `performBrowserRepairs`,
  new `browserRepairReloadVetoed`). Selected tabs are vetoed for every reason, not only
  `unattributed`. Immediately before any reload, the exact-document protection probe is
  repeated and Chrome's tab state re-read (selected, audible, pending URL, loading, conversation
  changed, tab unavailable). Focus selection now follows the reload. Regressions in
  `extension.test.ts` cover each reload-capable reason.
- **Archive freshness after restart** (`src/main/archive/archive-runtime.ts`). Background
  refresh only ran for a site this process had built, so a site published before a
  restart/install never caught up until opened. The runtime now restores the durable site's
  publication time at `start()`, marks a session static-dirty only when its manifest changed
  or is newer than that site, and retries a failed refresh after the normal interval while
  the previous site stays valid. Regressions in `archive-runtime.test.ts`.
- **Plan scaling:** generic read limit unchanged. Added a >512 KiB single-line mixed-catalog
  archival regression in `plans.test.ts`.

**Deferred:** durable worker execution receipts (intent/lease, restart reconciliation, unknown
receipts) remain worker-65's exclusive scope (`src/main/mcp/kernel.ts`,
`src/main/session/recorder.ts`, `src/shared/session.ts` + a new test). Worker-65 is sleeping
with no result, and none of its work is in the tree. Those files were not edited.

**Validation:** 21 focused/adjacent suites, 1,924 passed / 6 skipped; `tsc -p tsconfig.json
--noEmit` clean; `git diff --check` and `git diff --cached --check` clean; full `verify:ci` from
PowerShell exit 0 (main 6,021 passed / 44 skipped; computer 20; mcp-shutdown 2). The new restart,
worker-lane identity and browser-gate regressions were each confirmed failing without their fix.

## Interrupted-response recovery after the worker-65 401 (2026-10-23)

Evidence (Eve log, worker recording `2026-10-22-950cef16`, no live-tab interaction): the revival
turn `g-1y4bc9p8zeu5r-0-1` showed "Error in message stream" with Retry at 15:44:46 and was
reloaded 24 ms later. The reloaded page ended that same turn `failed` with the same card, and it
was reloaded again at 15:48:10, 84 s after Eve had parked the worker. The tab then showed
"Something went wrong. Please try again" while ChatGPT's own conversation fetch answered 401.
Connectivity was already degraded (tunnel timeouts from 15:22; last good handshake ≈15:44:49),
so the tunnel outage is a likely common cause, not a consequence. The 401's cause is unproven.

Changes, source only:

- `src/main/bridge.ts`: the `assistant-error` episode and its one-remedy budget are keyed by the
  session's recorded `turn_start` (fallback: latest user message), not by page turn state or
  error text. A failed end of the broken turn no longer releases the budget; a new recorded turn
  or an attributed local tool call does. `queueBrowserRecovery` refuses every repair for a
  sleeping/finished/failed worker. New receipt outcomes: `continued` (files one durable in-place
  Continue through the existing direct-turn rotation input, `RECOVERY_CONTINUE_MESSAGE`) and
  `blocked` (kept, reason shown in the timeline, budget spent).
- `extension/chatgpt-dom.js`: page-level "Something went wrong[. Please try again]",
  "Could not load this conversation" etc. are `conversation-unavailable`, `recoverable: false`;
  the same wording inside an assistant turn remains a stream failure.
- `extension/content.js`: `clf-page-status` reports `assistantErrorKind`
  (`stream-interrupted` while Stop shows, `stream-failed`, `conversation-unavailable`).
- `extension/background.js`: `assistant-error` keeps the page when status is unknown or the chat
  is unavailable (`blocked`), retries later when the page moved to another conversation, reports
  `continued` for an interrupted live answer, and reloads only an ended-turn stream failure,
  through the Stage-3 pre-reload gate.
- Direct-turn delivery already re-checks the turn, presses Stop and fails without sending if it
  cannot; a Continue is never re-sent once authorized, and the original instruction never is.

Tests: `bridge.test.ts` (c6 sequence, parked worker, Continue exactly once, Continue refused after
the turn ended, blocked kinds); `extension.test.ts` (each kind, conversation change, selected/draft/
audible during recovery); `chatgpt-dom-recovery-kind.test.ts` (new); `content-script.test.ts`
(page-status kind). Worker-65's files were not edited.
