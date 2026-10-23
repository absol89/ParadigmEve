# 11 — Debugging playbooks

Back to [vault index](README.md).

These are **evidence collection orders**, not permission to apply broad repairs. The recurring rule is: identify the earliest false fact, then fix its owner. Do not add a downstream retry/watchdog to compensate for an upstream identity or durability bug.

## Wrong chat was touched

Collect in this order:

1. exact ChatGPT conversation id(s), not sidebar title;
2. local session id and `meta.json` current chat plus conversation lineage;
3. request-id attribution around the action in `events.jsonl`;
4. current block/supersession state;
5. any browser repair token/reason/claim in app logs;
6. whether Compact & Resume had already moved A -> B.

Inspect:

- `src/main/mcp/call-context.ts`
- `src/main/session/correlation.ts`
- `src/main/session/store.ts`
- `src/main/bridge.ts`
- `src/main/session/continuation.ts`

Do **not** select the intended chat from title, newest timestamp or visible foreground tab.

Before any repair/reload, prove the target is still the same registered document and not a
focused human ChatGPT tab with an active draft, voice, typing or pending navigation. A pinned
or newly retargeted tab is not disposable recovery capacity. See
[browser repair custody](02-runtime-browser-recovery.md).

## Message was duplicated, lost or appeared in the wrong transport

Start with the durable `session-input` row, not the browser composer.

Questions:

- Was the row still `queued`, claimed by `tool`, claimed by `browser`, or `sent`?
- Was `offeredAt` present?
- Was browser Send authorized?
- Is there a stable `messageId` / `deliveredAt`?
- Was a later exact request seen that proves tool receipt?
- Did a positive terminal turn allow route transition?
- Is the entry a user instruction, Goal/finish debt, worker/Prime finding, restart wake or
  legacy heartbeat attention? The current 22-minute review itself runs in a worker.

Never automatically replay an ambiguous browser send.

For a red **“Not sent: the browser did not pick up this message within 60
seconds”** row, distinguish the original queue record from what the browser
actually observed. If the row is still owned by nobody and has no offer,
Send authorization, message id or receipt, the 2.4.4 c3 UI should show one
**Force Send** action and **Dismiss**, in separate non-overlapping positions.
If any browser claim or uncertain Send exists, **Force Send must disappear**;
only manual **Restore to composer** and **Dismiss** are appropriate. Preserve
the current composer draft, do not force-click a send to debug the row, and
do not treat disappearance of an Activity warning as proof of delivery.
See `test/renderer-timeline.test.ts` and `test/session-input.test.ts`.

### Force Send seems unavailable or refuses to send

Check `src/main/session/input.ts::forceBrowserInput`, `forceSendRefusal`,
`forceBrowserContextValid` and `src/main/session/start-input.ts::forceSendDesktopInput`:

1. Locate the **original** durable user row by id. Confirm it is queued or has the specific
   pre-pickup browser-start failure, with no tool/browser owner, offer, Send authorization,
   delivered message id or receipt. A cancelled ambiguous send is ineligible.
2. Check exact local session and conversation lineage after Compact & Resume, Block/privacy
   status, and any selected model **family and reasoning effort**. A `-thinking`/`-instant`
   observed lane suffix may be equivalent to its selected model family; distinct models are not.
3. Identify a same-session competing **user** queue row or browser Send. **Queued** app-owned
   findings and attention rows alone must not block the author's untouched row; a different chat's
   pending wake likewise must not occupy this composer.
4. At final browser admission, inspect current target route, human draft/voice activity and
   native Send evidence. A successful Force Send is still one attempted transport, not proof
   ChatGPT accepted it; never manually type a duplicate to make the queue look empty.

The 2026-10-16 source includes regression tests for same-session blocker filtering and the
exact GPT-6 model-family comparison (`test/session-input.test.ts`). A local acceptance result
for one forced message does not prove every privacy/duplicate edge has been exercised.

## Worker appears dead

Check broker state before opening/replacing anything:

- active run id and owning agent conversation (the broker records this as `prime` internally);
- worker state (`active`, `detached`, `sleeping`, `waking`, terminal);
- exact worker conversation id;
- browser tab census / worker revival command status;
- latest first-hand tool/turn liveness;
- whether the chat is blocked or superseded.

A closed tab only proves **detached**, not finished. A browser revival ACK only proves message acceptance, not active worker liveness.

For a heartbeat review worker, inspect the app-owned debt key and broker's actual assigned
review task before reviving it. A silent review worker can be slept and reused with bounded
backoff, but its missing `chat_review_complete` receipt means the epoch is still pending.

## Plan went backward after restart

Compare:

1. first-class durable `plans` state;
2. the session's `plan.json` projection;
3. Plan provenance session id/checklist steps;
4. archive state and `updatedAt`.

Current contract: session-plan data is import-only once a matching first-class Plan exists. If a stale
session projection overwrites newer first-class progress, that is a regression in `plans.ts`, not a
reason to manually edit AppData.

## Worker completed work but Eve activity shows only one Done Plan

Separate **worker run history**, **session-local Plan** and **first-class Plan catalog** before
changing filters. In order:

1. Inspect the worker broker's exact run/worker conversation and its recorded `update_plan`
   calls. If a worker never called `update_plan`, there is no worker Plan to display; tool activity,
   completion prose and `agents action=finish` do not create a backfilled checklist.
2. If a Plan exists, follow `provenance.sessionId` through `origin.kind=worker` (or the
   `resume.fromSessionId` chain); `plans.ts::planAudience` assigns it to Eve activity from this
   **durable ancestry**, not the worker name or sidebar title. A missing/ambiguous source cannot
   safely be guessed into the worker category.
3. Check the first-class `plans` catalog, session `plan.json` revision, and section (`live` or
   `done`). A completed checklist can be Live/Ready to archive before its actual archive. For
   worker Plans, exact delivered finish-report evidence can trigger automatic archive; inspect
   `archiveWorkerPlansForDeliveredReport` and worker `reportMessageId` when a completed Plan is
   unexpectedly still Live. Human Plans require the user's archive action.
4. Compare Eve activity and human-facing Plans/Verified work projections with these same
   source records. A missing visible Plan after a proven worker `update_plan` is a projection/
   attribution issue; a missing Plan without such a call is a worker workflow gap. A trailing
   "Report to Prime" checkbox on an older worker Plan is not substantive unfinished work.

The current broker asks the **heartbeat review worker** explicitly to create its own Plan.
For other multi-step workers, provide that requirement in the assignment and verify the real
`update_plan` receipt; do not describe historical workers as though they all have Plans.

## Pin points to the wrong recorded source conversation

Determine whether the source has a stable message/call identity and whether the session crossed Compact & Resume.

The correct fallback is a **saved Pin without a false live link**, not “link it to the session's newest conversation.” Inspect:

- `src/main/pins.ts`
- `src/renderer/pin-provenance.ts`
- session `chatIds` lineage.

## Tool calls land in Unattributed activity

Symptom: `request attribution: no page evidence for <id> within 20000ms`, `identity_ms=20000`, and
`work_context` reporting `shared-eve`. All calls of one assistant turn share one request id.

1. Compare the failing request id with the turn: did the turn start before the current app process
   (`app started`) or before the tab's last reload? ChatGPT announces the id only when the turn starts,
   so a turn spanning an install needs the reconnect re-offer; test attribution with a **fresh user
   turn** instead.
2. In the Eve tab, check `performance.timeOrigin` against the install time. A page loaded before the
   Companion update still runs the old `usage.js`.
3. Arm a read-only stream probe (wrap `fetch`, record only event types and the key paths of
   `request_id` / `conversation_id` in `/backend-api/f/conversation`, plus `cos-request-origin`
   posts). If the stream shape moved, fix `usage.js`; if the id was forwarded, follow it through
   `/correlations` in the bridge.
4. A healthy join logs `attributed to <conversation> from its earlier stream sighting`.

Inspect `extension/usage.js`, `extension/content.js` (`flushStreamRequestOrigins`,
`currentStreamSightings`), `src/main/bridge.ts` (`/correlations`, `completeEarlySighting`) and
`src/main/mcp/inbound.ts`.

## Eve replies are missing from an app chat

Symptom: user messages record but no `assistant_message` appears, turns stall at "No visible progress
for ten minutes", and queued app messages wait behind a turn that never ends.

1. Search the session's `messages/` and `events.jsonl` for `assistant_message` across sessions; a
   global absence starting on one date points at a ChatGPT page change, not one chat.
2. Confirm the running Companion build (manifest `version_name`) matches the installed one.
3. In the live tab, ask the installed `fiber.js` for one scan (`clf-fiber-ask` → `clf-fiber-reply`) and
   inspect `turns[].messages`. Empty turns with visible replies mean the page model moved: walk the
   exchange's React fibers for where the reply's provider id now lives (props, hook state, context)
   and report only structure, never text.
4. Build the regression fixture from that probed shape, and run the shipped `fiber.js` + `content.js`
   together end to end; hand-written descriptors hid this class of break twice.

If ChatGPT instead displays a bare transport-error notice without a native Retry control or
alert role, inspect `extension/chatgpt-dom.js` error detection before diagnosing the whole
assistant stream as empty. Read current source and build a fixture for the exact rendered shape;
do not reload a healthy, actively generating page just to collect evidence.

## Stale "Still working" request toasts

A Request Trail record stays `running` after admission. A toast must still need live proof (see
[Current state](10-current-state-and-acceptance.md)): compare the record's origin session `endedAt`,
`activeTurnId` and `finishTurn.startedAt`, and whether a newer record exists for the same session.
Inspect `src/main/request-trail-checkins.ts` (`liveRequestTurns`) before touching the notifier.

## Eve says connected but Companion is not usable

Separate these facts:

- MCP tunnel connected?
- Companion token paired?
- Companion authenticated traffic present recently?
- exact ChatGPT tab census nonzero?
- a **current-version / protocol-15 document** registered after this app process started?

For reinstall, inspect the chosen controller log and `app.log`. The current controller's readiness
fence is protocol 15; a successful fence means a current Companion document is registered, not merely
that the Electron process relaunched.

## Upgrade/reinstall seems to stall

Do not pre-close Eve/Chrome. Check:

1. only one package builder owns `release/`;
2. installer timestamp/hash actually changed after build completion;
3. external `windows-self-reinstall.ps1` process is alive;
4. installer log shows the app-running prompt and accepted close;
5. installed Eve process comes back;
6. `/recovery` current document proof reports bridge 15 and `ready=true`;
7. installed `app.asar` matches the package before declaring success.

For a debug-flavor rehearsal, also verify Settings -> Agents & automation reports `Build channel: debug` and use `-InstallerPath .\release\ParadigmEve-Windows-x64-debug.exe` rather than the controller's canonical shipping default.

## Plugins settings keeps opening

Inspect durable `plugin-refresh` rows:

- surface;
- schema id versus completed schema id;
- connector name;
- exact app id;
- `attempted`, `required`, `manual`, `deferred`.

Name-only identity change should not create perpetual browser maintenance. An identity-only row with
no app/attempt/completion proof should become deferred until a real declaration change creates new work.

Companion extension update is not connector schema refresh.

## Relative path resolved incorrectly

Check exact caller conversation identity and `workspace.ts` first. A workspace belongs to `chat:<conversation-id>`, learned from prior absolute paths.

If there is no exact caller identity, relative resolution should be refused. Never add a global cwd fallback.

Then verify the path still passes `sandbox.ts` realpath containment; workspace convenience never widens permission.

## Heartbeat keeps reappearing

Inspect the bounded durable `state/chat-review-heartbeat.json` debt, its `reviewLane`, exact
key, `planBatch`/`planAcks`, the worker broker task and its source session records. Read only
the debt's locally recorded session window and selected Plan provenance. **Do not inspect
ChatGPT browser history** to fill a missing source. The worker's permitted review calls and
Prime delivery are separate timelines.

Ask:

- Did the authorized **worker**, with this exact key, record direct `chat_review_plan`
  acknowledgements for every selected Plan and an accepted `chat_review_complete` receipt?
- Did the Prime source session move A → B via Compact & Resume or an exact owner transfer?
  Check lineage rather than assigning by recency.
- Did a worker turn end without that receipt? Check stale-worker revival/backoff before
  sending another identical task every minute.
- Was the finding sent to Prime, still pending, or preserved in `uncertainFindings` because
  a browser Send may already have happened? Never resend an ambiguous finding.

The review worker is **read-only** and can report a still-valid task; Prime decides whether to
execute it. A completed review does not imply that Prime executed any finding. The current
code tests worker-key authority, Plan revision fences, uncertain finding custody and broker
backoff; failed or blocked review remains reportable and may keep a durable debt.

## Compact & Resume or restart wake targets the wrong chat

Compare the exact session id, `chatIds` lineage, source A and successor B, pending recovery
input id/turn id, and continuation WAL stage before attempting any delivery. A durable startup
wake belongs to one interrupted turn and cannot be copied to a new guessed conversation; the
active Compact & Resume transaction prevents ordinary messages entering superseded A.
Destination `attempt` and `dispatch` checkpoints are distinct. A click with no acceptance
receipt may already have sent the handoff, so preserve its ambiguity. Browser repair must not
reuse the continuation command tab or overwrite a human-edited draft. Inspect
`src/main/session/recovery-memory.ts`, `src/main/session/continuation.ts`,
`extension/background.js` and `extension/content.js` before any corrective navigation.

## A failure after a tool/browser side effect

Before retrying, classify the boundary:

- **pre-claim failure** — usually safe to retry if current authority still agrees;
- **claim durable, side effect not attempted** — retry policy depends on that subsystem's checkpoint;
- **side effect may have happened, receipt missing** — ambiguous; inspect state, do not blindly replay;
- **receipt confirmed** — advance/close the obligation, do not redo it.

That pattern is shared by browser sends, plugin refresh clicks, worker delivery, continuation prompts and browser repairs.
