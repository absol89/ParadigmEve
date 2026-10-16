# 10 — Current state and acceptance

Back to [vault index](README.md).

This page is the **2.4.1 source and acceptance guide** (2.4.1 builds on the 2.4.0 checkpoint). It records
verified source, local candidate evidence and the checks still needed before
calling a feature installed or a downloadable release ready. A Git tag, a local
installer and a live acceptance run are different evidence levels.

## Current product state

- Current source: **2.4.1** on `release/2.4.1`, onboarding fixes on top of the `v2.4.0` tag.
  `v2.4.1` is tagged after its Windows x64 candidate passes self-testing.
- Latest tag: **`v2.4.0`**, the final 2.4.0 head of `release/2.4.0` and public `main`
  (2026-10-16; the GitHub release page shows the tagged commit).
- Package version, `APP_VERSION` and Companion manifest all declare **2.4.1**.
- Bridge protocol: **15**.
- The locally installed **Windows x64 debug self-test build** was produced from
  an earlier 2.4.0 source commit with a recorded patch. Its build/packaging
  checks passed; it was installed and exercised locally. Installed app/asar and
  Vulkan engine/probe bytes were checked against the packaged build. This does
  not establish that later tagged source changes were installed.
- The `v2.4.0` tag is source provenance. Public installers/downloads depend on
  separate CI packaging, checksums and publication; the tag alone proves none
  of those completed, and local Windows acceptance does not cover other OSes.
- Windows local self-test builds here use **debug** flavor unless release policy changes.
- The shared working tree may be dirty because coordinated tasks can be in flight at once.
- Do not reset, clean, checkout, or overwrite unrelated work to manufacture a clean tree.

## Languages and localization

- The app ships in English, Svenska (`sv-SE`) and Español (Latinoamérica, `es-419`). English is the
  source text in code; `sv-SE.json` and `es-419.json` are keyed by that exact English string. A missing
  key shows English, and tests require the two catalogs to have the same keys and placeholders.
- The language is chosen in Setup or Settings → Appearance and stored as `cos.ui.language`.
- The installation's agent name (`config.mcp.connectorName`, default `Eve`) replaces `Eve` in catalog
  text, with the right possessive per language. `Eve Browser` and `Eve Plugins` never change.
- The localhost setup guide opens in the app language, has its own three-language picker, shows Eve's
  coffee cup and translates the connector description users paste into ChatGPT. Third-party UI labels
  stay in English.
- Localized spellings of the built-in names (`%utgifter`, `%gastos`, `%hur`, `%cómo`, `%organisera`,
  `%organizar`, `plan`/`planer`/`planes`) route to `%expenses`, `%how`, `%organize` and `#plans` through the
  shared resolver. An exact user-created name wins, and Eve is told the alias and, when the rest of the
  message is in the alias's language, to answer in that language.
- The Pins **`%instructions` category** contains prompted Threads with no Pins;
  it is a category label, not a guaranteed built-in `%instructions` Thread alias.
  Open an individual saved instruction using its exact `%ThreadName`. Pets can
  be renamed (display name only) and ship per-language descriptions.
- Details and the evidence checklist: [16 — Languages, localization and aliases](16-languages-localization-and-aliases.md).

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
  human/Prime Plans remain Live until explicit archive moves them to Done.
- **Plans** defaults to human-facing work (including Prime-authored Plans).
  **Eve activity** contains Plans from exact worker/helper-origin sessions, with
  worker execution checklists and Live/Done sections. The human Plans tab also
  displays expandable Verified work summaries of Eve activity.
- A completed worker Plan becomes Ready to archive after its actual work is
  done; it can auto-archive when the worker's current finish report is proven
  delivered to Prime. A mere sent/queued report cannot close it. An explicit
  cancellation preserves any incomplete checklist as cancelled history.
- Pins → Create is a local unsaved editor, not a chat. Save requires a non-empty unique name and the
  object kind follows content: Pins → Thread, prompt without Pins → Instruction, no prompt/Pins → Concept.
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

## Dynamic Skills

- Skills are reusable procedures selected by semantic relevance from a compact installed catalog;
  they are not slash commands and are not a replacement for Threads, Pins or Quilts.
- Ordinary user language is sufficient. When one Skill clearly matches, Eve loads that Skill's
  `SKILL.md` on demand and loads support files only when that procedure requires them.
- The current authored user request remains higher authority than a Skill. Explicit Thread prompts
  also remain durable authored context rather than being silently rewritten by a Skill.
- Imported/external Skills are readable but not silently rewritten. Eve-owned Skills may be revised
  and versioned through the Skills owner surface.
- The prompt carries compact metadata only. Full procedures remain lazy so a growing installed skill
  library does not consume the normal conversation budget.
- Availability depends on actually installed Skill packages and a model/client
  with the `skills` tool; an empty or filtered catalog does not establish that
  any particular request used a Skill. Source implements list/view and controlled
  Eve-owned create/update, not unrestricted rewriting of imported procedures.

## File-format broker and optional editors

- Fresh Core tool instructions direct document (DOCX), spreadsheet (XLSX), PDF
  and slide (PPTX) requests to built-in `file_action` discovery first. Local
  `inspect`/`read` works on bounded approved files without installing an editor;
  `providers` takes a **format only** when the file is a Library link or otherwise
  not available locally. It never fetches Library URLs.
- The registry advertises optional in-development **WordCraft**
  (`artcraft.wordcraft`, word documents) and **GridCraft**
  (`artcraft.gridcraft`, spreadsheets) by supported format. Discovery does not
  prove installed availability. The user must request installation and approve
  Eve's separate **native** confirmation; the official platform build is
  checked before use. Decline/Not now are honored.
- With an installed ready provider, `file_edit provider_tools` discovers
  supported operations; `edit` validates a **new copy**, and `open_visible`
  opens a copy only when a GUI and permitted Computer Use are available.
  Detected DOCX or XLSX/XLSM features that would be lost require an additional
  native feature-loss consent before broker editing. The original is never
  overwritten by this workflow.
- These contracts predate and are included in the locally installed Windows
  debug build. Provider opening observed during installed self-testing is
  narrower evidence than file-edit fidelity or a published release. See
  [MCP and tools](03-mcp-connectors-and-tools.md#file-broker-inspect-offer-edit-or-show).

## Local transcription and diarization

- The installed Windows x64 debug build includes the local transcription
  engine, embedded Python runtime and CPU/Vulkan `whisper.cpp` binaries;
  local verification matched the Vulkan binaries and probe to that package.
- First use may fetch pinned, verified FFmpeg and model payloads into the managed transcription
  runtime. After those are present, local transcription and speaker diarization run offline.
- GPU transcription is capability-driven, not assumed. `gpu-probe` distinguishes a compiled/usable
  backend from unavailable hardware/runtime state. When Vulkan is usable, local ASR may run on the
  selected GPU and records backend, device, GPU index and whether any fallback occurred.
- CPU remains a supported path. A claimed GPU run must never actually be CPU work with a GPU label.
- Speaker diarization stays local. Cloud ASR is an explicit provider choice and may upload audio;
  choosing cloud transcription does not move diarization to the cloud.
- Recording can preserve microphone and system audio as separate tracks. This matters when the user
  wears headphones: system audio is still captured even though it may never reach the room microphone.
  The two tracks are independent evidence sources and can be compared/aligned by timestamp instead of
  forcing one mixed waveform to be the only source of truth.
- A combined track can still be produced for compatibility, but production evidence fusion should
  prefer the clearer per-span source using ASR confidence, acoustic quality, timing agreement and
  diarization evidence rather than treating one track as globally authoritative.
- The Windows build's recorded source patch and GitHub `v2.4.0` tag provide a
  more specific first path: for a recorded `mix.wav` with audible mic + system
  tracks and automatic speaker count, it transcribes/diarizes each track
  independently, keeps track-specific speaker
  identities, flags simultaneous speech, and suppresses likely playback echo.
  Unit tests cover the merge contract; full automatic **three-voice overlap**
  and accurate speaker discovery in live recording remain **unverified**.
  The source-aware code was committed under the GitHub version tag after the
  Windows build, which already contained an earlier recorded patch; its installed
  pipeline/CLI/settings
  matched the tagged source on inspection, while the `sources.py` difference
  was confined to a comment. See
  [Dynamic Skills and local transcription](17-dynamic-skills-and-local-transcription.md#source-aware-pipeline-in-the-tagged-240-source).
- Completed transcript artifacts preserve local-processing/privacy and execution provenance. Native
  paths and credentials must not leak through renderer/browser-facing transcript metadata.

See [Dynamic Skills and local transcription](17-dynamic-skills-and-local-transcription.md) for the
full operating contract and current proof shape.

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

- A user who never chose a model chooses once before the first send (2.4.1); Eve must not
  invent a paid model identity, and a recommendation is never applied without the user's click. Provider-native
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
  new object, blank/duplicate names keep Save disabled, and content determines Concept/Instruction/Thread.
- Plans → Create resolves the durable Plans starter and opens a fresh conversational Plan-creation chat
  whose authored onboarding message is `Make me a 3 step plan to get started with %plans`.
- Prime `update_plan` appears under Plans, while worker/helper-origin
  `update_plan` projects under Eve activity. Confirm the worker's own checklist
  is visible there, and that only the matching delivered finish report can
  auto-archive a Ready worker Plan into Eve activity → Done.
- `%thread` and `#quilt` resolve according to the current model;
- pristine installs have the current starter Threads, and an eligible older custom-only Pins library
  receives the current starter generation without overwriting user Threads;
- the AppData Vault mirror exists and matches the installed shipped Markdown set;
- browser-backed ChatGPT can read a Workspace folder added in Settings through ParadigmEve MCP
  without Chrome receiving direct filesystem authority;
- `%how` starts from the user's question, consults the current packaged manual quietly when needed,
  uses local file tools without exposing their plumbing as the answer, and says what cannot be
  verified instead of guessing;
- `%how` can explain installed Skills and local transcription/diarization without requiring slash
  commands or stale chat memory;
- the Skills catalog remains metadata-only until one clearly matching Skill is selected, and a large
  installed catalog stays bounded without truncating the authored request;
- a packaged transcription runtime reports its real CPU/GPU capability, and a GPU proof records the
  actual backend/device/fallback state rather than inferring it from CLI flags;
- one consented real local transcription proves Whisper actually used the
  requested backend and that the completed output reports the same backend;
- mic + system-audio recording preserves separate tracks, allowing headphone-safe capture and later
  per-span comparison/fusion before or instead of mixing;
- an automatic source-aware recording identifies three genuine speakers,
  retains overlapping voices, and distinguishes playback echo from a separate
  speaker in the merged, speaker-labelled transcript;
- `file_action` correctly inspects an approved local DOCX/XLSX or reports
  providers by format for a Library link; any WordCraft/GridCraft install gets
  native confirmation, any fidelity-risk edit gets a separate native decision,
  and edits/open-visible operate on copies;
- Pin → Unpin repaints immediately and removal survives restart;
- duplicate Pin protection;
- a multi-item Plan's progress survives restart;
- a completed human checklist stays Live until Archive;
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
- Human/Prime Plans remain Live until explicit archive; a verified worker
  finish-report delivery can archive the matching Ready Eve activity Plan.
- Browser visibility is not ownership.
- Transport ACK is not semantic completion.
- Compact & Resume moves one durable session; it does not create a new job.
- A worker tab closing is not proof its turn ended.
- Connector schema refresh and Companion extension refresh are separate operations.
- Let the installer close/restart Eve during upgrades; the external controller is designed around that.
- Fix the earliest wrong authority instead of layering another watcher/fallback over it.
