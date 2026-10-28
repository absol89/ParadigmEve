# ParadigmEve engineering vault

> Not in an engineering mood? Start with the local [Eve HTML tour](../readme/index.html):
> human problems first, tiny interactive demos, technical details only when you ask for them.

> **Current source/manual line:** 2.4.4 development candidate on `release/2.4.4`; this is not a public `v2.4.4` release tag.
> **Bridge protocol:** 15
> **Release evidence:** private Windows 2.4.4 c2 was hash-verified in the installed app and incremental archive reuse was observed; this does not establish full acceptance or installation of the new c3 delivery controls. Only assets actually listed on [GitHub Releases](https://github.com/absol89/ParadigmEve/releases) are public downloads.

This folder is the fast, linked operational manual for how the current ParadigmEve source fits together. It is
the current manual, not a changelog or nomenclature history. Rewrite it when the product changes so
the Vault always teaches the behavior, names and operating model that are true now.

The [2.4.4 candidate notes](../release-notes/v2.4.4.md) distinguish the
c1 transcription/updater changes, c2 archive/`%how` improvements, and c3
failed-message action rail. The current pre-Send pickup timeout recovery is
**Force Send only when the original user outbox row is provably untouched**;
an ambiguous browser claim offers manual composer restoration instead.
Neither path permits automatic duplicate Send. Startup full archive indexing
and Prime page-evidence/Request Trail attribution remain open reliability work.

Current source/tests and first-hand runtime evidence remain authoritative for what exists today; the
Vault is the canonical human-readable operational manual and holds the implementation contracts; the short
[`AGENTS.md`](../../AGENTS.md) is only the agent/developer bootstrap that routes here. These notes explain **who owns what, how data moves, where
state lives, and what to check when something breaks**. See [Self-reliant AI and the manual](12-self-reliant-ai-and-the-manual.md).

## Historical 2.4.1 / 2.4.0 acceptance snapshot — not the current release

The entries below describe earlier tagged source and Windows self-testing. Do not present them as evidence that a current 2.4.4 installation has passed live acceptance. Check the running app version and current release notes instead.

- **2.4.1 source:** `package.json` and the Companion manifest declare `2.4.1` on `release/2.4.1`: onboarding fixes on top of 2.4.0 (see [2.4.1 notes](../release-notes/v2.4.1.md)). Tagged `v2.4.1` on `main` after Windows x64 self-testing.
- **Tagged source:** tag `v2.4.0` marks the final 2.4.0 commit. This identifies source, **not** the state of a user's installed application or a published installer.
- **Installed Windows self-testing:** the locally installed x64 debug build was checked for heartbeat, Compact & Resume and wake, controlled Force Send, transcription and diarization, a usable Vulkan compute probe, and opening WordCraft/GridCraft. That build came from an earlier 2.4.0 source commit **plus a recorded patch** including source-aware microphone/system-audio processing and narrow-screen Pins CSS. Those changes were packaged, but reliable automatic speaker discovery, overlapping speech and the merged output still require specific live acceptance. Fresh-chat broker discovery is in that build's source baseline; later worker-Plan prompting changes included in the `v2.4.0` tag are not automatically present in the installed build. Successful editor opening does not establish document fidelity.
- **Public downloads:** publishing is a separate workflow; inspect the [release assets](https://github.com/absol89/ParadigmEve/releases) and their checksums rather than treating a GitHub version tag, CI artifact, or local self-test build as a published installer. Platform packages and tests do not imply equal live acceptance on macOS, Linux or Windows ARM64. See [2.4.0 release evidence](../release-notes/v2.4.0.md).

## Current ownership boundaries

- **Plans versus Eve activity:** `src/main/plans.ts` projects Plans from an ordinary/main Prime conversation into **Plans**, even when Eve authored them. A Plan whose source traces to a **worker/helper** session (including Compact & Resume ancestry) appears under **Eve activity**. Both show Live and Done, and checklist completion is distinct from archiving. A worker reporting or handing off to Prime is lifecycle evidence, not a Plan step. See [Pins, Threads, Quilts and Plans](06-pins-quilts-and-plans.md) and [Workers](05-workers-and-multi-agent.md).
- **Heartbeat:** the 22-minute semantic review is assigned to an app-owned, **read/review-only worker**. It checks locally recorded session requests and at most four Live Plans per review batch, follows exact provenance, and acknowledges reviewed Plans using the current key/revisions. It must **not** inspect ChatGPT browser history, execute user tasks, change other Plans, delegate, or treat browser delivery as semantic completion. Prime owns execution and receives findings; missing identity, stale review keys, and foreign worker lineage fail closed. See [heartbeat implementation](../chat-review-heartbeat-implementation.md).
- **Transcription and speakers:** `Settings → Transcription` offers CPU/local speech recognition, Vulkan GPU only after a usable engine/device compute probe, and explicitly selected Groq or OpenAI cloud ASR. Diarization runs locally, including after cloud speech recognition; cloud ASR uploads audio. Local-first capture can preserve microphone and system audio separately. First use can download verified models and tools. A tagged source with GPU support does **not** imply every packaged build includes the Vulkan engine; default/CI packaging can be CPU-only. Read [Dynamic Skills and local transcription](17-dynamic-skills-and-local-transcription.md).
- **File broker:** Core's `file_action` can inspect/read approved local DOCX/XLSX/PDF/PPTX files and discover provider offers without opening a file. `file_edit` handles consented provider installs and copy-based edits/open-visible workflows. **WordCraft** (`artcraft.wordcraft`) and **GridCraft** (`artcraft.gridcraft`) are separately installed, in-development providers; real format-fidelity risks and native approval matter. A ChatGPT Library URL is not an approved local file. Automatic fresh-chat broker guidance predates the installed Windows self-test build; its presence does not prove that a given provider is installed or an edit succeeded. Read [MCP and file broker](03-mcp-connectors-and-tools.md).

## Start here

1. Read [System map](01-system-map.md) for the whole architecture in one pass.
2. Read [Current state and acceptance](10-current-state-and-acceptance.md) before changing anything.
3. Open the subsystem page for the work you are about to touch.
4. Read the page's implementation contracts and the corresponding source file before editing.
5. Preserve the central rule: **repair the earliest wrong identity / ownership / durability boundary instead of adding a second authority.**

## Vault map

| Note | What it answers |
| --- | --- |
| [01 — System map](01-system-map.md) | What are the major processes and how do they communicate? |
| [02 — Runtime, browser and recovery](02-runtime-browser-recovery.md) | How does Eve start, pair with Chrome, recover tabs, and survive restart/update? |
| [03 — MCP, connectors and tools](03-mcp-connectors-and-tools.md) | How does ChatGPT discover tools, what is Core vs Plugins, and where is tool authority checked? |
| [04 — Sessions, outbox and Compact & Resume](04-sessions-outbox-and-continuation.md) | What is the durable session, how are messages/inputs recorded, and how does chat A become chat B? |
| [05 — Workers and multi-agent](05-workers-and-multi-agent.md) | How does the configured agent use her worker garden, sleeping reuse, durable messaging and revival? See also the [native-subagent eight-lane evidence and experimental mode decision](../native-subagents-evidence-2026-10-26.md). |
| [06 — Pins, Threads, Quilts and Plans](06-pins-quilts-and-plans.md) | What is the knowledge/work model and what are its persistence rules? |
| [07 — Plugins and connector refresh](07-plugins-and-connector-refresh.md) | How do external MCP integrations run and how does ChatGPT schema refresh stay safe? |
| [08 — Persistence, security and filesystem](08-persistence-security-and-filesystem.md) | Where does state live, how does the durable chat archive work, what is encrypted, and how are filesystem/tool boundaries enforced? |
| [09 — Build, install, update and release](09-build-install-update-release.md) | How does a source tree become a package and how is a private build applied? |
| [10 — Current state and acceptance](10-current-state-and-acceptance.md) | What must be verified before treating tagged source, a candidate or published package as accepted? Recheck dated statements against source and live evidence. |
| [11 — Debugging playbooks](11-debugging-playbooks.md) | What evidence should be collected first for the recurring hard failure classes? |
| [12 — Self-reliant AI and the manual](12-self-reliant-ai-and-the-manual.md) | How should Eve use the manual and current evidence without exposing internal documentation mechanics unless they help? |
| [13 — Schedule workspace and Eve routines](13-schedules-and-routines.md) | How do Schedule, `#schedule`, `#myweek`, `#routines`, `%schedule`, `%evecron` and evidence-backed Started/Done fit together? |
| [14 — Coding skills](14-coding-skills.md) | Which checklist should Eve open for a code review, a bug, a refactor, security, performance, a dependency upgrade, docs, accessibility or SQL? |
| [15 — Desktop pets and Eve avatars](15-desktop-pets-and-avatars.md) | How does Eve make a desktop pet or a human avatar of herself that the user can import on the Pets page? |
| [16 — Languages, localization and aliases](16-languages-localization-and-aliases.md) | How do the three app languages, the agent's own name, the setup guide and localized `%`/`#` names work? |
| [17 — Dynamic Skills and local transcription](17-dynamic-skills-and-local-transcription.md) | How are reusable Skills selected, and how do local CPU/GPU or cloud speech recognition, microphone/system capture and local diarization work? |
| [18 — Worker tool authority and provenance](18-worker-tool-authority-and-provenance.md) | How will durable Eve-local grants, independent worker tools, exact chat attribution and approval-block recovery be implemented and tested? This is an implementation spec, not an installed feature. |
| [22 — Native Desktop control](22-native-desktop-control.md) | How do Windows and macOS desktop tools observe and act on native apps, and what keeps that control safe? |
| [Full feature maturity and copy-best-bits audit spec](../best-bits-audit-spec.md) | How do four concurrent read-only auditors compare every CoS/Eve feature without orphaning Plans, Schedule, the archive, the file broker or localized onboarding? |
| [26 October 2026 comparison ledger and phased plan](../best-bits-audit-ledger-2026-10-26.md) | Which source-backed features are stronger in CoS or Eve, what is worth adapting, and what remains unverified before any implementation? |
| [Native ChatGPT subagents: supported boundary and Eve design](../native-chatgpt-subagents-design-2026-10-26.md) | What can Eve genuinely control in hosted Work subagents, what remains Prime-mediated, and what prevents an unsafe c17-derived install? |
| [Release-visual design and evaluation](release-visual-design.md) | How can Eve or any connected model make an accessible, actionable release explainer rather than an overloaded infographic, and evaluate candidates without inventing a feature? |
| [Glossary](glossary.md) | Exact meanings of session, conversation, turn, worker, Thread, Quilt, Plan, repair, etc. |

## Former AGENTS.md sections

The single-file `AGENTS.md` map was split into these pages with its section numbers kept, so a
reference such as “§14” in a page, task note or commit still points somewhere:

| § | Section | Page |
| --- | --- | --- |
| 1–2 | Product purpose, vocabulary, invariants; runtime model and identities | [01](01-system-map.md) |
| 3, 21 | Intent, evidence and checked baseline; known implementation gaps | [10](10-current-state-and-acceptance.md) |
| 4, 8, 9 | Ownership map; filesystem permissions; projects and project instructions | [08](08-persistence-security-and-filesystem.md) |
| 5, 13, 14 | Startup and shutdown; extension, models and browser; bridge and recovery | [02](02-runtime-browser-recovery.md) |
| 6, 10 | MCP surfaces and code mode; files, terminal, patches and images | [03](03-mcp-connectors-and-tools.md) |
| 7 | One tool call: identity, execution and delivery | [18](18-worker-tool-authority-and-provenance.md) |
| 11, 12, 15 | Input queue, attachments and Astra finish; recording and usage; Compact & Resume | [04](04-sessions-outbox-and-continuation.md) |
| 11 (generated workflow) | Generated workflow vs the agent's displayed plan | [06](06-pins-quilts-and-plans.md) |
| 16 | Multiple prime families and reusable workers | [05](05-workers-and-multi-agent.md) |
| 17 | Goal and Loop | [13](13-schedules-and-routines.md) |
| 18 | Renderer and IPC → [01](01-system-map.md); plugins, file broker, connections → [07](07-plugins-and-connector-refresh.md); Native Desktop → [22](22-native-desktop-control.md) | |
| 19 | Debugging, tests and working here | [11](11-debugging-playbooks.md) |
| 20 | Build, installation, updater and release | [09](09-build-install-update-release.md) |
| 22 | Completion and maintenance | root [`AGENTS.md`](../../AGENTS.md) |

## Existing deep references

Do not duplicate these when they already answer the narrow question well:

- [`docs/tool-surface.md`](../tool-surface.md) — model-facing tool surface and permission behavior.
- [`docs/plugins.md`](../plugins.md) — external MCP plugin usage and lifecycle.
- [`docs/chat-review-heartbeat-implementation.md`](../chat-review-heartbeat-implementation.md) — 22-minute semantic review owner.
- [`docs/quilt-discovery-tutorials.md`](../quilt-discovery-tutorials.md) — product acceptance shape for the first Thread/Quilt experiences.
- [`docs/product/feature-spec-template.md`](../product/feature-spec-template.md) — generic template-project authority, retention, provenance and external-context questions.
- [`docs/product/expenses.md`](../product/expenses.md) — Expenses local self-testing contract for recurring intake, canonical structured data and optional raw evidence.
- [`docs/release-notes/v2.2.2.md`](../release-notes/v2.2.2.md) — release notes for the stable Angel release.
- [`docs/release-notes/v2.4.0.md`](../release-notes/v2.4.0.md) — GitHub version-tag status, installed Windows self-testing and release/platform caveats.
- [`docs/release-notes/v2.3.9.md`](../release-notes/v2.3.9.md) — earlier delivery/recovery source-line notes.
- [`docs/release-notes/v2.3.7.md`](../release-notes/v2.3.7.md) — earlier published beta and first-user walkthrough.
- [`docs/release-notes/v2.3.6.md`](../release-notes/v2.3.6.md) — historical release notes.
- [`docs/release-notes/v2.3.4.md`](../release-notes/v2.3.4.md) — historical release notes.
- [`docs/release-notes/v2.3.3.md`](../release-notes/v2.3.3.md) — release notes for the 2.3.3 source line.
- [`docs/product/README.md`](../product/README.md) — product direction and human goals.

## Reading convention

Each subsystem note uses three labels:

- **Authority** — the module/data that is allowed to decide the fact.
- **Projection** — UI/cache/transport state derived from that authority.
- **Fail closed** — what happens when exact identity or durable evidence is missing.

That vocabulary matters because most hard ParadigmEve bugs come from a projection being mistaken for authority: a visible tab used as ownership, a browser ACK used as semantic completion, imported Plan state used as newer Plan truth, or a connector presentation label used as proof of the current schema.
