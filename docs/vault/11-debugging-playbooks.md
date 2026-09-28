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

## Message was duplicated, lost or appeared in the wrong transport

Start with the durable `session-input` row, not the browser composer.

Questions:

- Was the row still `queued`, claimed by `tool`, claimed by `browser`, or `sent`?
- Was `offeredAt` present?
- Was browser Send authorized?
- Is there a stable `messageId` / `deliveredAt`?
- Was a later exact request seen that proves tool receipt?
- Did a positive terminal turn allow route transition?
- Is the entry user input, Goal/finish debt, worker attention or heartbeat attention?

Never automatically replay an ambiguous browser send.

## Worker appears dead

Check broker state before opening/replacing anything:

- active run id and owning agent conversation (the broker records this as `prime` internally);
- worker state (`active`, `detached`, `sleeping`, `waking`, terminal);
- exact worker conversation id;
- browser tab census / worker revival command status;
- latest first-hand tool/turn liveness;
- whether the chat is blocked or superseded.

A closed tab only proves **detached**, not finished. A browser revival ACK only proves message acceptance, not active worker liveness.

## Plan went backward after restart

Compare:

1. first-class durable `plans` state;
2. the session's `plan.json` projection;
3. Plan provenance session id/checklist steps;
4. archive state and `updatedAt`.

Current contract: session-plan data is import-only once a matching first-class Plan exists. If a stale
session projection overwrites newer first-class progress, that is a regression in `plans.ts`, not a
reason to manually edit AppData.

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

Look at durable `chat-review-heartbeat` debt and the exact target's session input rows.

Ask:

- was the semantic `chat_review_complete({key})` receipt ever accepted?
- did the target move A -> B via Compact & Resume?
- did the owner canonically stall and transfer?
- did a confirmed send finish a turn without the receipt?

Repeated presentation after a completed turn with no semantic receipt can be intentional. Repeated concurrent/ambiguous browser sends are not.

## A failure after a tool/browser side effect

Before retrying, classify the boundary:

- **pre-claim failure** — usually safe to retry if current authority still agrees;
- **claim durable, side effect not attempted** — retry policy depends on that subsystem's checkpoint;
- **side effect may have happened, receipt missing** — ambiguous; inspect state, do not blindly replay;
- **receipt confirmed** — advance/close the obligation, do not redo it.

That pattern is shared by browser sends, plugin refresh clicks, worker delivery, continuation prompts and browser repairs.
