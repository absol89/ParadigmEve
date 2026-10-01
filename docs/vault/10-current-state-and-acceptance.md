# 10 — Current state and acceptance

Back to [vault index](README.md).

This page is the current development operating checkpoint. It records what must be true in the
2.3.3 source line and the acceptance gates to use before packaging, installing, or calling a change
complete. Public release or installed-runtime status needs its own release/runtime evidence; source
version alone does not prove either one.

## Current product state

- Current source package/app line: **2.3.3**.
- The earlier **App + Companion 2.2.2** Angel checkpoint remains historical release context.
- Bridge protocol: **15**.
- A 2.3.3 package is not coherent until `package.json`, `APP_VERSION`, and the Companion manifest
  agree; do not mistake a dirty development tree for a shipped 2.3.3 runtime.
- Laptop builds are **debug** builds unless the release policy explicitly changes.
- The shared working tree may be dirty because coordinated tasks can be in flight at once.
- Do not reset, clean, checkout, or overwrite unrelated work to manufacture a clean tree.

## Knowledge and work model

- Every Pin belongs to exactly one **Thread**.
- `%thread` activates one bounded Thread, including its standing Thread prompt and saved Pins.
- Starting a chat explicitly from a Thread uses the same prompt + Pins activation.
- `#quilt` selects saved Pins from a wider Quilt of Threads, without activating member Thread prompts.
- `#` is the Quilt sigil and `%` is the Thread sigil. Do not teach another Quilt sigil.
- A Thread may belong to several Quilts and a Quilt may contain several Threads.
- Threads own editable standing prompts, distinct from Prompt Pins.
- Current authored user text remains the final instruction boundary.
- Plans are first-class durable objects. Completing checklist items does not archive a Plan;
  explicit archive moves it from Live to Done.
- Pins → Create is a local unsaved editor, not a chat. Save requires a non-empty unique name and the
  object kind follows content: Pins → Thread, prompt without Pins → Hotlink, no prompt/Pins → Concept.
  Link and description do not classify the object.
- Plans → Create is conversational: it resolves the durable `plans` starter identity, opens
  a fresh Thread chat, and starts with `Make me a 3 step plan to get started with %plans` so the user
  sees the durable Plan workflow immediately. A true editable Plans Create form remains deferred
  beyond this source line.
- Starter Threads use a one-time migration generation. A legacy library with none of the current
  shipped starter references receives that generation; existing starter references and later user
  edits/deletions remain authoritative.
- The shipped Vault remains canonical and is synchronized on startup to the physical AppData mirror
  `%APPDATA%\ParadigmEve\docs\vault`.
- The local Archive is first-class durable evidence: append-only semantic events plus SHA-256 retained
  blobs are canonical; search/memory/static HTML are rebuildable projections. Provider-only or missing
  bytes stay explicit. A historical interrupted assistant snapshot may be preserved once a later user
  turn proves it is no longer the live frontier, allowing later stable evidence to remain visible
  while the session still reports partial capture.

## Session, agent, and continuation identity

- One local session can span multiple ChatGPT conversations through Compact & Resume.
- Exact durable conversation/session identity, never a title or visible tab, decides ownership.
- The installation's configured human-facing agent identity, for example Eve or Eva, moves across
  the exact A→B continuation commit.
- Worker chats remain worker-owned conversations and are not silently converted into ordinary chats.
- A browser transport ACK is not semantic completion.

## Browser and restart recovery

- Bridge protocol 15 is the current browser/app contract.
- Recovery preserves and reuses the existing ChatGPT session when exact identity proves it.
- Recovery and connector-schema refresh are separate operations.
- A final repair claim is checked immediately before browser mutation so Block, Stop,
  supersession, or ownership changes can revoke stale work.
- Installer-driven restart uses the normal foreground recovery path. Windows login startup may
  remain intentionally quiet through its separate background registration.

## ChatGPT page evidence and attribution

See [Runtime, browser and recovery](02-runtime-browser-recovery.md#page-evidence-on-chatgpts-current-renderer-and-stream)
for the mechanics.

- Assistant replies are captured from ChatGPT's render items (`assistant-message`) by provider id;
  final only on `final_answer` + `completed` + a non-streaming context. No identity comes from text.
- Tool calls are attributed from the stream's request-id sighting. The bridge holds a pending sighting
  until local MCP admits the same id; the page re-offers its sightings on recorder reconnect after an app
  restart. Browser evidence alone never creates local traffic or overwrites a correlation.
- An unattributed-activity repair never reloads a streaming page.
- The running Companion must be the installed build: the folder is materialized before any browser
  launch, and a Companion loaded from another build reloads itself once, never under a running tool
  call, bridge command or busy ChatGPT page.
- A pending restart wake for the pinned agent conversation is delivered before automatic Compact &
  Resume may begin a new handoff. If a handoff is already in progress, queued input is fenced from the
  source chat and follows the durable session to the successor after commit.
- A silent install relaunches ParadigmEve only when it closed a running instance itself.
- A previous turn's final answer cannot close a newly submitted turn merely because ChatGPT remounts
  that old assistant section around Send; current-generation ownership must be proved first.

### Known gaps in the current line

- `usage.js` is not re-injected into ChatGPT tabs that stay open across a Companion update; such a tab
  keeps the previous stream reader until it is reloaded while idle.
- Replies backfilled from older exchanges carry no provider time on the render-item page and are timed
  when recorded, so they can appear after later user messages.
- Attribution recovery for a turn that spans an app restart is regression-tested but not yet proven in
  an installed self-test.
- Request Trail `running` is still written once at admission; nothing closes a finished Plan-creation
  request, so such records stay `running` (they no longer toast — see below).

## Plugins and connector behavior

- The connector/display name is per installation and may be Eve, Eva, or another user choice.
- Presentation names are not ownership evidence.
- Schema refresh only runs when the current declaration requires it; stale maintenance work must
  not reopen settings forever.
- Model/plugin helper maintenance yields to a durable input only when that maintenance pass actually
  spends browser placement/delivery authority for the input. A stale listed input whose elected
  document is gone must not starve an unrelated connector-schema refresh indefinitely.

## Current development gates

- A genuinely fresh unselected ChatGPT chat may keep `model=null` and `reasoningEffort=null`; Eve
  must not invent a paid model identity when the account catalogue is absent or stale. Provider-native
  Free/Go surfaces expose only **ChatGPT Default** in Eve: the thinking-effort slider is hidden and
  no Free-account Think mode is offered by the app.
- Connector request/discovery and recognized tool invocation are separate evidence. Durable onboarding
  requires both on every required non-optional surface; app self-tests, tunnel probes, and broker-owned
  local workers cannot satisfy the external ChatGPT first-tool proof.
- A safely refused recognized external tool call may prove routing for onboarding, but release self-test
  separately requires one harmless Eve tool to actually succeed.
- Fresh installs keep `roots=[]` and Computer Use off. Filesystem access requires an explicit approved
  root; screen/control/clipboard permissions remain explicit opt-ins.
- Windows Computer Use keeps exact native identity, reports zero/all-excluded discovery truthfully,
  retires stale observation authority on close/restart/permission transitions, and requires fresh
  observation before new input. There is no process-name fallback.
- ChatGPT Free/Eva is the primary provider acceptance baseline for this release. If the provider UI
  blocks the custom connector, record that exact provider boundary rather than substituting Plus.
- `%schedule` / `%evecron` availability, duration, editing, and overlap remain backend-truthful:
  unknown availability is not free and missing duration fails closed.
- Scheduled installation-agent work never reuses the active human chat. Started requires exact
  browser/session delivery evidence and Done requires task-specific durable verification; queue/claim,
  prose, elapsed time, browser state, Plans, Pins, and Threads are not completion authority.
- Accepted long-running `%requests` work gains one durable Request Trail from exact accepted Plan/user
  event identity, with restart-safe check-ins and exact origin/Thread/Plan/result/test/review links.
  A "Still working" check-in needs live proof, not the admission state: the origin session has not
  ended, its open turn's recorded start is within ChatGPT's per-turn ceiling, and the request is the
  newest from that session. The claim names that exact turn.
- When a Request Trail owns an exact Thread, the Plan Source opens that Thread. Historical source chat
  remains evidence/fallback and normal continuation starts a fresh Thread-context chat.
- Finishing the high-level Plan checklist means implementation complete / Ready to archive. The user
  remains the final high-level Plan signoffer; `update_plan` must not archive or manufacture signoff.

## Before packaging or installing

### 1. Establish one serialized build owner

```powershell
git status --short
git log -3 --oneline
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match 'scripts/package\.mjs|electron-builder\\out\\cli|makensis'
}
```

Do not start a second builder if one is already using `release/`.

### 2. Reconfirm protocol readiness if installer or recovery code changed

Check `src/main/version.ts`, the self-reinstall controller, and the focused packaging/window/recovery
tests. Run the relevant focused test plus typecheck before packaging.

### 3. Build exactly once

Windows x64:

```powershell
npm.cmd run dist:x64 -- --flavor debug
```

Wait for a successful process exit and the final artifact timestamp. Do not infer completion from a
partially written installer appearing early.

### 4. Let the installer own shutdown and restart

Use the repo's self-reinstall controller with Eve and Chrome still running. Do not pre-close them as
an upgrade ritual.

### 5. Verify installed bytes and live behavior

Prove the installed package contains the current main/renderer bundle and packaged Vault, then self-test:

- Eve/Companion current-version handshake;
- View / Pins / Plans visible;
- Pin opens the mandatory Thread chooser;
- Pins → Create opens the local blank editor without creating a durable placeholder; Back leaves no
  new object, blank/duplicate names keep Save disabled, and content determines Concept/Hotlink/Thread.
- Plans → Create resolves the durable Plans starter and opens a fresh conversational Plan-creation chat
  whose authored onboarding message is `Make me a 3 step plan to get started with %plans`.
- `%thread` and `#quilt` resolve according to the current model;
- pristine installs have the current starter Threads, and an eligible older custom-only Pins library
  receives the current starter generation without overwriting user Threads;
- the AppData Vault mirror exists and matches the installed shipped Markdown set;
- browser-backed ChatGPT can read a Workspace folder added in Settings through ParadigmEve MCP
  without Chrome receiving direct filesystem authority;
- `%how` starts from the user's question, consults the current packaged manual quietly when needed,
  uses local file tools without exposing their plumbing as the answer, and says what cannot be
  verified instead of guessing;
- Pin → Unpin repaints immediately and removal survives restart;
- duplicate Pin protection;
- a multi-item Plan's progress survives restart;
- completed checklist stays Live until Archive;
- archived Plan lands in Done;
- no obsolete settings-refresh flow steals the active chat;
- exact recovery returns Chrome to the owed ChatGPT conversation.
- Archive rebuild/open succeeds without provider access; an old interrupted chat keeps its partial
  marker while later user/tool/final evidence remains visible, and locally retained generated-image
  bytes survive app restart/reboot/offline.
- on Eva/ChatGPT Free, the Eve model menu offers only ChatGPT Default with no thinking-effort slider,
  connector discovery is followed by one harmless successful Eve tool, and only then optional
  Computer Use is enabled for list → observe → input → close/relist/restart recovery checks.

### 6. Close Plans only from current evidence

Plans should reflect evidence, not optimism. Archive work only when current source/runtime proves it complete.

## Where to begin by problem type

| Symptom | Read first |
| --- | --- |
| “wrong chat got touched” | [Runtime/browser/recovery](02-runtime-browser-recovery.md), `bridge.ts`, request/session identity in `AGENTS.md` |
| “message duplicated/lost” | [Sessions/outbox](04-sessions-outbox-and-continuation.md), `session/input.ts` |
| “worker vanished / wrong worker” | [Workers](05-workers-and-multi-agent.md), `agents.ts` |
| “Plan went backward after restart” | [Pins/Threads/Quilts/Plans](06-pins-quilts-and-plans.md), `plans.ts` |
| “Pin points at wrong source chat” | [Pins/Threads/Quilts/Plans](06-pins-quilts-and-plans.md), `pin-provenance.ts` |
| “Plugins page keeps opening” | [Plugins/refresh](07-plugins-and-connector-refresh.md), `plugin-refresh.ts` |
| “installer succeeded but controller says recovery failed” | this page + [Runtime/browser/recovery](02-runtime-browser-recovery.md) |
| “relative path uses wrong project” | [Persistence/filesystem](08-persistence-security-and-filesystem.md), `workspace.ts` |

For a fuller evidence-first checklist, see [Debugging playbooks](11-debugging-playbooks.md).

## Current design decisions to preserve

- Chat is a harvesting/review surface, not the durable home of Plans.
- Every Pin chooses one Thread destination.
- Plans remain Live until explicit archive.
- Browser visibility is not ownership.
- Transport ACK is not semantic completion.
- Compact & Resume moves one durable session; it does not create a new job.
- A worker tab closing is not proof its turn ended.
- Connector schema refresh and Companion extension refresh are separate operations.
- Let the installer close/restart Eve during upgrades; the external controller is designed around that.
- Fix the earliest wrong authority instead of layering another watcher/fallback over it.
