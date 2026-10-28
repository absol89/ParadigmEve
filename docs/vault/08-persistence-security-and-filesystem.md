# 08 — Persistence, security and filesystem

Back to [vault index](README.md).

## userData is the local durable root

Electron's userData directory holds several classes of state with different safety rules.

Conceptual layout:

```text
userData/
  config.json
  secrets.bin
  state/
    swarm.json
    retired-workers.json
    continuations.json
    session-input.json
    pins.json
    plans.json
    plugin-refresh.json
    plugins.json
    ...
  docs/
    vault/                 # managed mirror of the shipped current manual
  sessions/
  archive/
    archive-manifest.json
    sessions/              # append-only semantic archive evidence
    blobs/                 # SHA-256-addressed retained bytes
    site/                  # rebuildable static HTML recovery browser
  plugins/
  private-updates/
  updates/
  setup-browser-profile/
  RECOVERY.md
  RECOVERY-RUNNING.json
  app.log
```

Exact platform path is Electron-controlled; code should use `app.getPath('userData')` rather than hard-code it.

## Durable JSON store

`src/main/durable.ts` owns small state documents under `state/`.

Writes use temp-file + atomic rename. Two write modes are important:

- `writeDurableSoon` — coalesced background projection for state that can safely lag briefly;
- `writeDurableNow` — immediate generation barrier for an acceptance/ownership transition that must land before an external side effect or tool success is published.

Cross-file transaction order is still the caller's responsibility. `durable.ts` cannot make two different JSON documents atomic together.

### Fail-soft versus strict reads

- `readDurable` can return null on corrupt operational cache state after logging the problem.
- `readDurableStrict` treats malformed personal/authored state as a hard error.

Pins/Threads/Quilts and Plans use the strict path because “corrupt” must not mean “empty, safe to overwrite.”

## Config

`src/main/config.ts` validates `config.json` on every load.

Config contains non-secret choices:

- approved roots;
- capabilities/read-only mode;
- tunnel ids/settings;
- UI preferences;
- recording/retention/compaction;
- multi-agent settings;
- Goal/Loop settings;
- MCP instruction text.

**Local chat archive opt-out (2.4.2):** Recording remains on by default for governance and
auditability. The same `sessions.record` permission is exposed at the top of Workspace's
Permissions and as a checkbox alongside Rebuild/Open in Archive Browser. Setup and
Settings → Browser & history link to the Workspace permission. Switching it off prevents
new session messages and local tool results from being recorded, and disables features
that require recording, such as Goal/Loop and the session tool; it is not a global
privacy/erasure switch. Previously saved sessions, archive projections and static copies
remain readable, and archive rebuilding can still process earlier stored evidence.
Pins, Plans, logs, separate feature outputs and ChatGPT's own history have independent
storage or retention. The configured recording-retention window handles old session files;
turning recording off does not erase earlier content.

A corrupt config falls back conservatively rather than silently receiving fresh-install permissive defaults.

Settings mutation is serialized and published only after the new config is atomically written.

## Secrets

`src/main/secrets.ts` owns `secrets.bin` using Electron `safeStorage`:

- DPAPI on Windows;
- Keychain on macOS;
- Secret Service/keyring on Linux.

Linux's insecure hard-coded-key fallback is explicitly rejected.

Examples stored here:

- OpenAI tunnel key;
- Companion bridge token;
- Goal/OpenRouter/custom-provider keys;
- external plugin credentials.

The renderer cannot read them.

## Filesystem sandbox

`src/main/sandbox.ts` maps model-facing paths to approved roots.

Model-facing files look like:

```text
/project/src/main/index.ts
```

The sandbox can also accept a native absolute path copied from command output **only if** it resolves back inside an approved root.

Containment uses real/canonical paths to defend against:

- symlinks;
- Windows junctions/reparse points;
- root directories replaced after approval;
- lexical traversal (`..`);
- Windows device names / ADS / invalid path forms.

The boundary is enforced in code, not prompts.

Two app-owned namespaces are deliberately **not** stored as ordinary approved Workspace roots:

- `/appdata` — ParadigmEve's current userData folder (`%APPDATA%\ParadigmEve` on Windows);
- `/paradigmeve` — the directory containing the running packaged ParadigmEve executable, including a custom installer-selected location.

These are runtime-managed self-maintenance roots. The Companion must prove the exact current Eve/Eva
owner conversation before either namespace resolves. That owner may inspect `/appdata` through
read-only file tools under the normal read permissions without enabling settings authority. Any
mutating or command access to `/appdata`, and any access to `/paradigmeve`, requires
`eveAuthority.changeSettings`. Workers, unrelated chats and unattributed calls do not inherit these
roots. Ordinary user-approved roots remain independent and keep their normal permissions.

`exec_command` remains shell-equivalent after the user grants Command permission: its **starting
cwd** is still resolved through the same root/identity gate, but a spawned shell is not an OS
sandbox. Managed roots therefore prevent accidental capability inheritance; they are not a claim
that arbitrary shell code is filesystem-confined.

The packaged current manual is a third special namespace, `/paradigmeve-manual`. It is read-only,
contains only the shipped top-level Markdown pages, and never becomes a generic writable root. The
packaged/repository Vault remains canonical; startup also synchronizes those Markdown pages into the
managed physical mirror `userData/docs/vault` (`%APPDATA%\ParadigmEve\docs\vault` on the normal
Windows install). That mirror is not a second authoring source. The exact Eve/Eva owner can inspect it
through `/appdata/docs/vault`; browser ChatGPT still reaches it by making ParadigmEve perform the read,
not by giving Chrome ambient filesystem access.

Selective `userData` materialization does not change that boundary. ParadigmEve also mirrors the
packaged Companion into `userData/extension` so the selected Chrome profile can load that exact
extension payload through Chrome's native extension mechanism. The Vault mirror and extension mirror
remain app-owned folders with fixed purposes; neither makes `userData` browseable from the browser.
For any browser feature that needs other local bytes, Electron keeps the path and permission decision,
snapshots/materializes only the allowed resource, and transfers it under an opaque purpose-bound id
after the exact browser operation proves ownership. A generic bridge file-read/list/open route is
forbidden because it would move filesystem authority from Eve into Chrome.

## Durable chat archive

The archive under `userData/archive` (introduced in 2.2.4) is ParadigmEve-owned durable conversation evidence, not
a cache of provider pages. Canonical archive truth is the append-only/versioned event stream plus
content-addressed SHA-256 blobs for bytes ParadigmEve actually captured. Search indexes, memory
projections and `archive/site` are derived and may be rebuilt from that canonical evidence.

The static site is intentionally useful by itself: it is a local `file://` recovery browser with a
conversation list, scrollable transcripts and local retained assets. It does not fetch signed
provider URLs to fill gaps. If native/generated image bytes were never captured, the archive keeps an
explicit provider-only, metadata-only, missing or capture-error state rather than presenting the
asset as retained.

Static Archive Browser generation is local Node.js/filesystem work, not a model request; it does
not spend ChatGPT tokens. Canonical sessions reconcile when they become dirty, independently of
the disposable HTML site. An already-published site is refreshed in the background no more than
once every 30 minutes, to avoid competing with live user work. Opening the Archive requests an
immediate site-only refresh. That refresh reuses hash-verified search fragments and bounded HTML
segments for unchanged chats, and reads only their validated manifests; changed chats are rendered
from their canonical events. A changed chat-token map (for example a newly inserted chat), missing
or modified cached fragments, or an explicit full Rebuild falls back to event scanning as required
to preserve correct cross-chat anchors and repair tampered disposable output. The full Rebuild also
verifies event-file integrity and refreshes the separate local search index. No worker or external
AI is invoked by any of these archive-maintenance operations.

Its conversation list defaults to newer-first using each archive session's canonical `updatedAt`.
The compact order control switches between `Newer first` and `Older first`; a Swedish browser uses
`Nyare först` and `Äldre först`. Reordering only moves sidebar links: chat hash tokens, the active
conversation and the current search filter stay intact. The sidebar search hides non-matching chats with
the `hidden` attribute, which only works while the generated CSS keeps `.chat-link[hidden]{display:none}`
after the `.chat-link` rule. The app can open this same recovery view from
the Archive workspace or View menu (**Open Archive Browser**, shown as **Opening Archive Browser…** while it
rebuilds and opens) without exposing its filesystem path to the renderer. The main process hands the verified
file to the dedicated Eve Browser profile, not the system's default/personal browser.
This avoids putting locally retained conversation history in another account's browser profile;
the launcher does not search for or force-focus a personal Chrome window.

An unfinished historical assistant row remains honest evidence. Once a later authored user message
proves that interrupted row is no longer the live streaming frontier, the archive can retain that
exact partial snapshot and continue with later stable events. The row is still immutable and the
session remains partial; a later source-store rewrite must not silently replace what was published.
If the source later discovers an older provider event whose logical chronology belongs before evidence
that is already published, the archive preserves the published suffix in place, marks the session
partial, and keeps scanning. New source events that were never published are still appended, so one
late-recorded event cannot freeze the archive at that point or hide everything recorded afterwards.
By contrast, a currently streaming assistant row and a recoverable native-image capture remain
deferred because publishing them early could freeze mutable evidence or discard pixels that can
still become locally durable.

Archive filesystem operations use an app-owned containment fence that rejects lexical traversal and
symlink/junction/reparse escapes. Renderer IPC exposes bounded path-free archive DTOs; the renderer
does not receive arbitrary archive paths or raw filesystem errors. Explicit user session deletion
retires the corresponding archive evidence rather than leaving a stale chat visible.

## Approved roots versus projects

These are different concepts:

- **approved root** = permission boundary;
- **local project** = organization/working-folder association inside that permission boundary.

Adding a project never widens filesystem permission.

## Learned workspace / cwd

`src/main/workspace.ts` learns a per-conversation project root from successful **absolute** path use. It searches upward for project markers such as `.git`, `package.json`, `pyproject.toml`, etc., without leaving the approved root.

After that, relative paths can resolve against the exact caller conversation's workspace.

If exact caller identity is missing, there is **no fallback cwd**. Relative paths are refused rather than resolved against another chat's workspace.

Compact & Resume moves the workspace from chat A to B only after the durable session rebind succeeds.

## Renderer security

The Electron renderer gets:

- strict CSP;
- all permission requests denied;
- fixed preload IPC only.

It does not receive Node APIs or direct secrets/filesystem/process access.

## Data ownership principle

When debugging state loss, first identify whether the data is:

1. authored durable state (strict, preserve bytes);
2. transactional operational state (durable barrier before side effect);
3. derived/rebuildable projection (can be recomputed);
4. ephemeral browser/process liveness (must not be restored as if current).

Confusing those categories produces the hardest recovery bugs.

---

> **Implementation contracts.** The sections below moved here unchanged from the former single-file
> `AGENTS.md` map. Their § numbers are kept so references such as “§14” still resolve; the
> [Vault index](README.md#former-agentsmd-sections) lists where each section lives.

## 4. Ownership map

Paths in this section are repository-relative. Most mechanisms have `main`, `shared` and
`renderer` halves; follow the authoritative main/shared owner before changing presentation.

| Area | Files and responsibility |
| --- | --- |
| App shell | `src/main/index.ts`, `window-lifecycle.ts`, `window-layout.ts`, `window-icon.ts`, `tray-image.ts`, `shutdown.ts`: bootstrap, activation, geometry, tray and bounded exit. |
| Config/security | `src/main/config.ts`, `platform.ts`, `secrets.ts`, `sandbox.ts`, `redaction.ts`; `src/shared/types.ts`, `capabilities.ts`: permission and host projection, secrets, approved paths. |
| Publication | `src/main/connection.ts`, `mcp/server.ts`, `mcp/surfaces.ts`, `tunnel/{index,health,locate}.ts`, `diagnostics.ts`: endpoint/tunnel generation and truthful status. |
| Tool dispatch | `src/main/mcp/{tools,kernel,inbound,call-context,tool-declarations}.ts`, `tools-core.ts`, `tools-desktop.ts`, `tools-plugins.ts`: declarations, exact caller, live guards and evidence. |
| Code composition | `src/main/mcp/code-mode-{tool,runtime,worker}.ts`: surface-scoped `exec`, QuickJS admission, limits and explicit emissions. |
| Instructions/plan | `src/main/mcp/{instructions,coding-instructions,plan-tool}.ts`, `src/shared/agent-plan.ts`, `src/renderer/agent-plan.ts`: executor contract and displayed progress plan. |
| Local files/processes | `src/main/{rawfs,fsops,search,ripgrep,env,toolchain,exec,exec-hints,text-match,diffstat}.ts`, `src/main/codex/*`: bounded filesystem/shell implementation. |
| Terminal custody | `src/main/codex/{manager,ownership,unified-exec,unified-exec-constants,shell,command-batch,head-tail-buffer,truncate,exec-output}.ts`. |
| Patching/images | `src/main/codex/apply-patch/*`, `codex/{filesystem,read-backend,view-image}.ts`. |
| ChatGPT downloads | `src/main/mcp/artifact-{download,fetch,target}.ts`: validate native file reference, bounded fetch, exclusive destination publication. |
| Projects/cwd | `src/main/projects.ts`, `workspace.ts`, `src/shared/projects.ts`: explicit local folder catalog, session binding, inherited/learned workspaces. |
| Desktop pets | `src/main/pet-library.ts` (the only package authority: validation, import, bundled `resources/pets`), `pet-overlay.ts` (transparent click-through window, activity projection, hit regions), `src/preload/pet-overlay.ts`, `src/renderer/{pet-overlay,pet-machine,pet-choreography,pet,pets}.ts`, `src/shared/{pets,pet-activity,session-activity}.ts`. Packages are three data files, never code; the format contract is Vault page 15. For the proven visual-generation workflow (Astra Medium, UV-bounded 160 px cells, stable face scale and shared ground baseline), see `docs/eve-tasks/bundled-pets-art-redo.md`; do not replace approved character art with a structurally-valid scripted approximation. |
| Template projects / Expenses | `src/main/expenses-project.ts`, `expenses-ledger.ts`, `mcp/expenses-tool.ts`; `src/shared/{expenses,expenses-template}.ts`: recurring inbox/project binding, canonical structured local ledger, provenance/corrections and optional retained evidence. |
| Durable history | `src/main/session/{store,recorder,correlation,retention,summarize,progress}.ts`, `src/shared/{session,chronology}.ts`: canonical messages, tool truth, chronology and indexes. |
| Cross-chat semantic review | `src/main/chat-review-heartbeat.ts`, `src/main/session/input.ts`: durable 22-minute review debt/receipt, exact coordinator selection, browser-only attention and coalescing with other internal attention. |
| Model history reads | `src/main/mcp/session-tool.ts`: explicit-session search/read and snapshot/update/detail cursors. |
| Input | `src/main/session/{input,start-input,input-history,input-attachments,input-images,prompt}.ts`, `src/shared/{input,user-prompt}.ts`: outbox, native files, prompt frame and receipts. |
| Browser-bound local resources | `src/main/browser-resource.ts` plus the owning feature: purpose-specific app-owned snapshots, opaque browser descriptors and bounded byte transfer after exact operation/document ownership. |
| Finish/planning | `src/main/session/finish.ts`, `task-request.ts`, `goal.ts`, `src/shared/{finish,task-progress}.ts`: held turn, decision/plan invocation and cancellation. |
| Pins / Threads / Quilts | `src/main/pins.ts`, `src/shared/{pins,default-threads}.ts`, `src/renderer/{pins-quilts,workspace-library}.ts`: durable Pins catalog and pristine-install starter Threads; user-facing Threads are mandatory Pin destinations and user-facing Quilts group Threads. Internal legacy `Collection`/`collectionId` names remain compatibility implementation details. |
| Dynamic Skills | `src/main/skills.ts`, `src/main/mcp/skill-tool.ts`, `src/main/mcp/instructions.ts`, `src/main/session/ollama-chat.ts`: bounded metadata catalog, lazy package reads, ownership/versioning and provider/tool-capability-aware selection guidance. |
| Local transcription / diarization | `src/main/transcription-runner.ts`, `src/shared/transcription.ts`, `src/renderer/{transcription-settings,transcription-jobs}.ts`, packaged `transcription-engine/`: capture, first-use components, truthful CPU/Vulkan ASR execution, local diarization, cancellation, transcript artifacts and provenance. |
| App Plans | `src/main/plans.ts`, `src/shared/plans.ts`, `src/renderer/{plans-library,workspace-library}.ts`: durable Live/Done Plans catalog, checklist revisions, explicit archive and accepted session-plan projection. |
| Continuation | `src/main/session/{continuation,resume-gate,handoff,handoff-prompt}.ts`: A→B transaction, send ambiguity and exact brief. |
| Automation | `src/main/goal.ts`, `src/shared/{goal,goal-templates}.ts`: objectives, switches, obligations, provider/helper decisions. |
| Agents | `src/main/agents.ts`, `src/renderer/{agent-panel,agent-communication}.ts`: independent prime families, staged mutations and addressed messages. |
| Browser orchestration | `src/main/bridge.ts`, `browser.ts`, `browser-startup.ts`, `browser-wake.ts`, `browser-window-layout.ts`, `browser-preferences.ts`; `src/shared/browser-preferences.ts`. |
| Extension | `extension/{manifest.json,chatgpt-dom.js,content.js,fiber.js,background.js,usage.js,overlay.css,popup.html,popup.css,popup.js}`: injection worlds, native observations/actions, journal and UI. |
| Models/usage | `src/main/chat-models.ts`, `session/usage.ts`; `src/shared/{chat-models,usage}.ts`; `src/renderer/{chat-models,context-meter,usage}.ts`: account observations vs local estimates. |
| External plugins | `src/main/plugins/{catalog,installer,manager,exposure,oauth}.ts`, `plugins-ipc.ts`, `plugin-refresh.ts`, `src/shared/{plugins,plugin-refresh}.ts`, `src/renderer/plugins.ts`. |
| Renderer boundary | `src/main/ipc.ts`, `edit-context-menu.ts`, `src/preload/index.ts`; `src/renderer/{main,chat,dom,tool-result,timeline-scroll,sidebar-resize,browser-preferences,i18n}.ts`, `locales/sv-SE.json`, `index.html`, `styles.css`. |
| Native Desktop | `src/main/computer/{index,helper,browser-chords,windows-api,windows-capture,windows-apps,windows-keys}.ts`, `src/shared/windows-computer.ts`, `mcp/tools-desktop-{windows,macos}.ts`, `native/macos-desktop-helper/*`, `native/macos-desktop-addon/*`. |
| Delivery/build | `src/main/{update,extension-path,version,logger,durable}.ts`, `electron.vite.config.ts`, `electron-builder.yml`, `scripts/*`, `.github/workflows/*`, `vitest.config.ts`. |

### One durable fact, one authoritative owner

| Fact | Owner / storage | Publication rule |
| --- | --- | --- |
| Permissions and settings | `config.ts` / `config.json` | Validate every load/save; enforce effective current capabilities at use. |
| Credentials | `secrets.ts` / encrypted `secrets.bin`; plugin OAuth's encrypted installation store | Main process only; publish updated cache after the encrypted write. |
| Session/current chat/project | `store.ts` / `sessions/<id>/meta.json` | Rebind is the semantic A→B commit. |
| Exact request ownership | `correlation.ts` / `state/request-correlations.json` plus recorded proof | First exact proof wins; retain local session epoch; reconcile from history on startup. |
| Authored message | `store.ts` / canonical message shard | Replace by stable identity, preserving origin chronology. |
| Agent progress plan | `store.ts::updateSessionPlan` / `sessions/<id>/plan.json` | Exact caller/session and invocation ordering; atomically replace the whole plan. |
| Pins / Threads / Quilts catalog | `pins.ts` / `state/pins.json`; selector/injection in `shared/pins-context.ts` + `main/pins-context.ts` | Strict read, serialized durable publication; every Pin names exactly one explicit Thread (legacy internal `quiltId`) and Quilts group Threads. `#quilt` is broad pinned-context scope; `%thread` is one specific durable Thread/work-context activation. A Thread may belong to multiple Quilts, so Pins inherit multiple wider Quilt associations through their Thread; never duplicate one source Pin into several Threads to model that many-to-many relationship. Authored user-message Pins are classified as **Prompt** and stay first in Thread covers/content while assistant replies remain **Message**; Prompt and legacy Message classifications share the same stable message-source identity so one authored row cannot be pinned twice by relabeling it. A Prompt, Message, or Plan Pin may carry a Thread-local Heart/`sticky` emphasis bit. It is toggled from that Pin's row inside its owning Thread or by the model-facing `pins` `set_pin_sticky` action on that exact Pin id, affects preview ordering/composition only, and never creates, moves or changes ownership of a Pin. The same tool may create a Thread with its user-approved standing prompt (a zero-Pin Instruction in one atomic write) and set or clear one exact Thread's prompt through `setQuiltPrompt`, the Thread editor's own state owner, which also makes a shipped starter prompt user-owned; it never writes `pins.json` directly. A pinned Plan renders its full current checklist in the Thread; a sticky Plan's promoted copy renders the same full Plan rather than a title/progress snapshot. Prompt/Message Pins may retain one locator-only image descriptor; session assets/source-event attachment previews continue to own the bytes, and Thread views resolve only bounded local thumbnails with an explicit unavailable state. Activated Threads contribute their durable description before optional prompt and Pins. A wider Quilt may contribute its own description but never activates member Thread descriptions/prompts. Pins-object type is content-derived: Pins > 0 means Thread; zero Pins + prompt means Instruction; zero Pins + no prompt means Concept. Link and description do not choose the type. Only when no exact same-name wider Quilt exists may `#name` fall through to a Concept backing Thread, activating any description with prompt semantics suppressed. A validated external Link may exist on a zero-Pin object and must open through the main-process safe-link route. Renderer prose may turn a uniquely resolved `%thread`, `#quilt`, or Concept alias into a local workspace link backed by the exact durable id; missing or ambiguous names stay inert text. Exact source links use recorded `sessionId + eventSeq`, never title/timestamp guessing or an external URL scheme. Concept-card presentation settings live in validated UI config: Quilt-pill rows, Pin-preview density `1/2/3/4`, and description/prompt size + row clamps. The per-card eye is a separate renderer-local privacy preference keyed only by Thread id; it may hide Prompt/Message preview text and tooltips while leaving an allowed image thumbnail visible, and it must never persist Pin text or provenance into that preference. |
| Installed Skills | app-owned userData `skills/`, `skills.ts`, and per-Eve-owned `.eve/metadata.json`/history | Catalog reads only bounded frontmatter metadata. Full bodies/support files are read only after a clear selection. External imports cannot smuggle Eve ownership; only the exact owner chat may create/update Eve-owned Skills. |
| Transcript execution/artifact | `transcription-runner.ts` + packaged engine output, then session/archive attachment/event pathways | Actual backend/device/fallback/model/privacy provenance comes from the completed runtime result, never a requested setting alone. Audio/transcript statements are evidence, not authorization to execute unrelated actions. |
| App Plans catalog | `plans.ts` / `state/plans.json` | Strict read and serialized mutation; accepted session plans project only after the session stale-call fence, renderer edits carry an expected revision, and only explicit archive moves a completed Plan from Live to Done; explicit cancel moves any Live Plan to Done with `cancelledAt` equal to `archivedAt` and its checklist unchanged (the one archived state allowed to be incomplete). The catalog holds 5,000 Plans, live and archived together; archived Plans are the user's history and are never removed automatically. A full catalog refuses new Plans with `Plan catalog limit reached`. It is one file rewritten per change and the Plans surface renders every archived card, so growing past this needs per-Plan storage and paging, not a larger constant. |
| Input and checkpoints | `input.ts` / `state/session-input.json` | Serialized acceptance, frozen payload, exclusive claim and receipt; stages belong here. |
| Chat-review heartbeat debt | `chat-review-heartbeat.ts` / `state/chat-review-heartbeat.json` | Persist the exact review debt before worker dispatch. Advance `lastCompletedAt` and clear debt only after direct `chat_review_complete` by the authorized exact review-lane worker with matching debt key and lineage. Browser ACK/final prose never closes debt. Missing/corrupt auxiliary state cannot grant source identity or bypass review-lane checks. |
| Native upload originals | `input-attachments.ts` / `input-attachments/` | Immutable bytes, opaque ids; outbox owns membership and retention. |
| Project catalog | `projects.ts` / `state/projects.json` | Serialized catalog mutation; session metadata owns association. |
| Expenses canonical records | linked project `data/ledger.json` via `expenses-ledger.ts` | Structured records remain authoritative; exact source provenance and audited corrections are preserved. `expenses_read` only reads and never binds a session or activates the write playbook. The separate `expenses` mutation surface may bind an unbound exact chat through its explicit `%expenses` reference; Start-from-Thread binds through normal input preparation. A fresh unbound send containing plain `#expenses` binds the chat to the canonical Expenses project (so the conversation can later record or correct entries without restarting as `%expenses` and losing context) but never activates the Thread prompt/playbook; it never rebinds an already-bound chat and yields to a real same-name Quilt. Existing bound continuations retain their authority; workers/helpers cannot mutate. Raw receipt copies are optional user-chosen evidence, and Thread/chat summaries are never a second ledger. |
| Browser commands/results | `bridge.ts` / `state/bridge-commands.json`; extension ACK outbox | Intent and exact lease before text; receipt durable before ACK custody is retired. |
| Workers and inboxes | `agents.ts` / swarm snapshot and retired-worker fences | Stage → critical durable snapshot → publish/open/report. |
| Compaction | `continuation.ts` / continuation WAL + session metadata | Disk ownership decides restart outcome; transport phase alone does not. |
| Goal control | `goal.ts` / `goal-objectives`, `goal-switches`, `goal-replies` | Objective, mode and reply debt are separate concepts; draft memory is disposable. See §21 for remaining atomicity gaps. |
| Stop/block/finish | Stop command; `blocked-chats.ts` durable set; finish facts in recorded progress/session projection | Each names exact chat/turn; no false terminal event. |
| Browser repair | `bridge.ts` process-memory episodes | Re-earn from live evidence; never restore an old reload token as action authority. |
| Catalog/usage | Saved successful `chat-models`; derived `usage-cache`; live usage snapshot | Catalog is observation, not a send receipt; estimates are not provider billing. |
| Connector refresh | `plugin-refresh.ts` / `state/plugin-refresh.json` | Exact installed app id + schema fingerprint, claimed before Refresh, verified after. |

## 8. Filesystem permissions and path resolution

**Intent:** a model can read or edit only paths approved for the relevant filesystem tool.
Native and virtual spellings must reach the same decision.

`sandbox.ts` owns root selection, virtual/native normalization, reserved names, traversal and
invalid host-path rejection, symlink/junction/reparse checks, canonical existing targets and
the deepest existing ancestor for a missing target. Every model-supplied filesystem path reaches
that authority or an already-validated wrapper. Revalidate at actual use when the target can
change during an await. Error text must not leak hidden physical root paths.

An approved `/workspace` may contain `projects/app`; it does not promise `/workspace/src`.
Read the root for one-level discovery, preserve every real intermediate folder, and never
repair a wrong path by guessing a missing project segment. Relative paths need a trustworthy
workspace; an unresolved swarm caller must not fall back to the first approved root.

`/appdata` and `/paradigmeve` are reserved runtime-managed self-maintenance roots, not entries in
ordinary `config.roots`. They map respectively to this install's userData and actual running install
directory. The exact current Eve/Eva conversation may inspect `/appdata` through read-only file
tools under the normal read permissions without settings authority. Mutating/command access to
`/appdata`, and any access to `/paradigmeve`, requires `eveAuthority.changeSettings=true`.
Workers, unrelated chats and unattributed calls must fail closed. `/paradigmeve-manual` is an
app-owned read-only namespace for packaged current Vault Markdown and must never be widened into a
generic write root.

**Shell permission is broader.** `exec_command` runs arbitrary code as the logged-in user.
Its initial cwd is approved, but the shell program is not confined to those roots. Read-only
therefore disables command execution. External plugin servers likewise retain their own OS or
service authority; the local file sandbox does not contain them. User-selected native upload
staging is a separate explicit-input boundary, not general model filesystem permission.

Negative cases matter: accepted virtual/native in-root paths, rejected traversal and symlink
escapes, live revocation during an await, and preserving an unrelated user's newer file edit.

## 9. Projects, workspaces and project instructions

**Intent:** a chat consistently works in its selected local folder, and workers/resumed chats
retain that choice. Sidebar organization must not destroy work or grant access.

`projects.ts` owns a bounded catalog of canonical absolute local folders with stable UUIDs.
Adding uses the native folder selection/approved-root flow, resolves the real directory and
deduplicates it. Session metadata owns `projectId`. Before send/use, `projectWorkspace()` and
`getSessionProject()` re-resolve it under current roots and reject moved/unavailable folders.
Null means no project; a broken explicit binding is an error, not a reason to infer a new cwd.

Removing a project marks the catalog row `ungrouped`. Existing and unloaded sessions, pending
inputs and workers keep their durable project association; their chats return to the ordinary
sidebar list. Adding that same folder again restores grouping. It does not delete files,
sessions or the approved root. A local project is distinct from a ChatGPT project route.

`workspace.ts` is convenient learned/inherited cwd, keyed to proven chat/family/agent identity.
Explicit session project binding takes precedence at kernel entry. Workers inherit only their
exact prime's project/workspace. Different primes may each own `worker-1` in different folders.
Compaction keeps local session/project identity and moves frontend workspace projection. A
relative path without trusted ownership fails; a workspace never grants permission by itself.

Project instruction injection reads **only the selected folder's `AGENTS.md`**, not a recursive
scan, guessed cwd, parent tree or cached copy. Existing-session scope comes from its durable
binding; an opening input may name its explicit project; workers inherit through the exact
prime. Resume retains the same project binding without reinjecting its instructions. Unfiled
chats receive no project file. Missing AGENTS is fine; an unsafe/unreadable/binary file fails
preparation visibly. Full prompt budgeting and
hidden framing are described in §6.

### Template projects keep evidence, records and interpretation separate

Inbox-shaped template projects should give the user one obvious recurring entry point while a
linked local project owns the durable structured state. The conversation is an intake/review surface,
not the database. A stored `%thread` may be the specific durable context/binding for that project;
`#quilt` remains broader Quilt discovery/context scope and must not silently choose a project. The linked
durable id remains the legacy internal `quiltId` until a separate storage migration is deliberately done.

Normalize supported facts into the template's canonical local model with exact source provenance.
Corrections update current structured facts while preserving an audit trail; similar/repeated inputs
are duplicate candidates until exact evidence proves otherwise. Raw artifacts are a separate evidence
lifecycle: keep them only when the template needs them and the user has chosen the applicable
retention, and make later opt-out target only the exact feature-owned copy.

Interpretive context must never rewrite source facts. When an analysis needs outside economic or
household context, fetch only the context relevant to the user's question and keep publisher/source,
observation or release date, retrieval date, geography, units/base/method and uncertainty sufficient
to reproduce the comparison. CPI/inflation, category price movement, wages/income, interest, rent,
energy and household benchmarks are possible context, not the user's own facts. Label observation
versus interpretation explicitly; never silently rebase old ledger values or overwrite raw records
to fit a benchmark. See [Feature Spec Template](../product/feature-spec-template.md) for the generic
design questions and [Expenses inbox specification](../product/expenses.md) for the self-testing model.
