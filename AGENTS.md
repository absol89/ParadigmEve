# ParadigmEve — bounded agent operating instructions

Read this before acting. It holds only the rules every change needs and routes to the
[engineering Vault](docs/vault/README.md), which owns the product logic and implementation
contracts. Keep this file **under 16,000 characters**, far below the app's 96,000-character
message limit, so it always reaches an agent whole. Before changing a subsystem, read its Vault
page and any `AGENTS.md` in the folders you touch, then check current code and durable state.

**QUALITY >> QUANTITY. Delete before adding.** Repair the earliest wrong identity, decision or
ownership boundary. Rewrite the affected area around its intended invariant and remove the
obsolete branches it replaces. Do not bolt on another fallback, watcher, timer, state machine
or mirrored authority.

## 0. Critical: Eve must never shut herself down

**Never initiate Eve's own quit, window close, process kill, service stop,
or standalone restart from an Eve-owned tool, script, app control or UI.**
This includes maintenance, diagnostics, release audits and recovery tests:
no WM_CLOSE, app.quit, taskkill, Stop-Process or tray Quit. Even a graceful
exit destroys the MCP/computer connection Eve needs for relaunch and proof.

**Only exception:** an explicitly authorized installer/update workflow may
stop Eve as part of installation, provided that workflow independently
owns relaunch. Verify installer identity, authorization and recovery path
first. Calling an Eve launch tool after Eve has quit is not independent
recovery.

For all other restarts, the human or a genuinely independent controller
must quit and relaunch Eve. Beforehand, record exact durable identities and
state read-only; after reconnection, compare receipts and persistence.
Without an independent restart owner, stop and mark the test NOT PROVEN.
Never replace a clean restart with a forced kill to tick a checklist box.

## 1. Priorities and shared worktree

- Reliability, exact identity, ownership, delivery/ACK and recoverability
  outrank new features. Repair the earliest wrong boundary, not by adding
  duplicate authority, fallbacks or competing timers.
- The tree is shared and often dirty. Before edits inspect branch, status,
  relevant source and diff. Never reset, checkout, clean, broadly reformat,
  overwrite or commit somebody else's drafts. Protect unrelated changes.
- Current human corrections supersede older Plans, handoffs, tests, release
  instructions and agent prose. Re-read latest messages and durable state;
  do not redo prerequisites already proven complete.
- Consent is explicit: no silent model/provider/reasoning/account changes,
  business subscription, permission approval, publication, tag or install.
  Public communications: research, verify, draft, approval, publish.
- Never claim success from a click, queued command, test label or prose.
  Preserve exact evidence and distinguish observed from inferred state.

## 2. Identities, tools and workers

- Local session, ChatGPT conversation, turn, browser tab, worker epoch and
  transport row are different owners. One meaningful fact has one durable
  authority. Titles, recency and visible tabs do not prove identity.
- Prime owns the user's requests and decisions. A maintenance heartbeat
  reviewer only reads and reports findings; it does not execute user work
  or grant itself new instructions. Delegated workers have scoped lineage.
- Check exact Companion/caller proof, approved root, capabilities, session,
  chat and epoch before execution or receipt. Recheck ownership after async
  work. Unknown or ambiguous authority fails closed; never guess keys.
- Core, Desktop, Plugins, browser Companion and Electron renderer have
  distinct scopes. A tool result proves only its actual execution owner.
  Read Vault [01](docs/vault/01-system-map.md), [03](docs/vault/03-mcp-connectors-and-tools.md),
  [05](docs/vault/05-workers-and-multi-agent.md), [08](docs/vault/08-persistence-security-and-filesystem.md)
  and [18](docs/vault/18-worker-tool-authority-and-provenance.md).

## 3. Browser, Send and heartbeat safety

- Never reload, close, navigate, retarget, replace or steal focus from the
  active ChatGPT tab. Preserve drafts, Voice, streaming, model/reasoning
  state and typing. Do not inspect personal browser history.
- Eve-owned links open in the Eve Browser profile, never personal Chrome.
  Reuse the elected tab; avoid duplicate tabs, sends and provider attempts.
- Outbox queued, composer insertion, authorized Send, provider acceptance
  and durable ACK are different states. A Send with ambiguous outcome is
  never replayed. Receipts require exact key, lineage and Plan revisions.
- A Native heartbeat may wait for Prime's next ordinary Eve tool call.
  Even a read-only tool call can offer a Native review in-band. Do not
  fabricate calls, replay offered reviews or force debt retirement.
  Read Vault [02](docs/vault/02-runtime-browser-recovery.md) and
  [04](docs/vault/04-sessions-outbox-and-continuation.md).

## 4. Files, continuity and durable user work

- Use exact approved paths. Read first, use targeted patches, verify bytes.
  Do not change credential config or protected drafts due to a warning.
- Preserve one owner for Plans, Pins, Threads, Quilts, projects, generated
  workflows and chat review receipts. An agent progress plan is not the
  durable Plan authority; ACK only the exact revision actually reviewed.
- Compact & Resume moves one durable session A to B; stale A receipts are
  rejected and uncertain sends are not repeated. Worker revival obeys
  exact lineage. Read Vault [04](docs/vault/04-sessions-outbox-and-continuation.md),
  [06](docs/vault/06-pins-quilts-and-plans.md) and [13](docs/vault/13-schedules-and-routines.md).
- The container shell and Eve's Windows shell are different computers.
  Verify tool context, completion, paths and result custody.

## 5. Tests, release and recovery

- PASS needs timestamped logs, state or exact receipts; FAIL needs a minimal
  reproduction; NOT PROVEN explains what could not be staged. No guessed
  heartbeat keys, sessions, ACKs or unobserved browser sends.
- Validate installed build hash, Electron version, source revision, clean
  tree claim and actual running state separately. Uncommitted security work
  or an installer candidate is not proof of a shipped fix.
- Do not commit, tag, publish, install or approve provider permissions
  without current explicit authority. Run `npm run verify:privacy` before
  every commit, push, tag or release.
- Startup, shutdown, worker ownership, transport, Compact & Resume and
  model selection have distinct failure modes. Under §0, an Eve-owned
  self-quit is never a valid restart test.
- Read Vault [10](docs/vault/10-current-state-and-acceptance.md),
  [11](docs/vault/11-debugging-playbooks.md) and
  [09](docs/vault/09-build-install-update-release.md).

## 6. Where the contracts live

| Area | Vault page | Folder `AGENTS.md` |
| --- | --- | --- |
| Product purpose, vocabulary, identities, renderer/IPC | [01 — System map](docs/vault/01-system-map.md) | |
| Startup, extension, models, browser, bridge recovery | [02 — Runtime, browser and recovery](docs/vault/02-runtime-browser-recovery.md) | |
| MCP surfaces, instructions, code mode, files, terminal | [03 — MCP, connectors and tools](docs/vault/03-mcp-connectors-and-tools.md) | `src/main/mcp`, `src/main/codex` |
| Input outbox, Astra finish, recording, Compact & Resume | [04 — Sessions and outbox](docs/vault/04-sessions-outbox-and-continuation.md) | `src/main/session` |
| Prime families and workers | [05 — Workers](docs/vault/05-workers-and-multi-agent.md) | |
| Plans and generated workflow | [06 — Pins, Threads, Quilts and Plans](docs/vault/06-pins-quilts-and-plans.md) | |
| Plugins, file broker, connections | [07 — Plugins](docs/vault/07-plugins-and-connector-refresh.md) | `src/main/plugins` |
| Ownership map, permissions, projects | [08 — Persistence and filesystem](docs/vault/08-persistence-security-and-filesystem.md) | |
| Build, installation, updater, release | [09 — Build and release](docs/vault/09-build-install-update-release.md) | `scripts` |
| Evidence, checked baseline, known gaps | [10 — Current state](docs/vault/10-current-state-and-acceptance.md) | |
| Debugging and tests | [11 — Debugging playbooks](docs/vault/11-debugging-playbooks.md) | `test` |
| Goal and Loop | [13 — Schedules and routines](docs/vault/13-schedules-and-routines.md) | |
| One tool call: identity, execution, delivery | [18 — Worker tool authority](docs/vault/18-worker-tool-authority-and-provenance.md) | |
| Native Desktop | [22 — Native Desktop control](docs/vault/22-native-desktop-control.md) | `src/main/computer` |

Old references to “AGENTS.md §N” resolve through the
[former-sections table](docs/vault/README.md#former-agentsmd-sections) in the Vault index.

## 7. Completion and maintaining these instructions

A change is complete when its root failure and neighboring negative case are covered, all
protocol participants agree, relevant checks pass, and the claimed evidence level is actually
demonstrated. Update model-visible contracts, user-facing behavior and their Vault page in the
same change; do not call source success a live hotfix.

Each rule lives in exactly one place. Subsystem contracts belong in their Vault page, never in
this file or a folder `AGENTS.md`; those only route. Put a rule here only when every change
needs it. Remove obsolete descriptions and resolved gaps instead of appending. Dated incidents,
worklogs, machine-specific paths and private drafts belong in task notes, release notes or
gitignored local files, not in these instructions.
