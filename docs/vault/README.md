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
Vault is the canonical human-readable operational manual. [`AGENTS.md`](../../AGENTS.md) supplies the agent/developer
bootstrap and implementation contracts. These notes explain **who owns what, how data moves, where
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
4. Read the corresponding source file and `AGENTS.md` section before editing.
5. Preserve the central rule: **repair the earliest wrong identity / ownership / durability boundary instead of adding a second authority.**

## Vault map

| Note | What it answers |
| --- | --- |
| [01 — System map](01-system-map.md) | What are the major processes and how do they communicate? |
| [02 — Runtime, browser and recovery](02-runtime-browser-recovery.md) | How does Eve start, pair with Chrome, recover tabs, and survive restart/update? |
| [03 — MCP, connectors and tools](03-mcp-connectors-and-tools.md) | How does ChatGPT discover tools, what is Core vs Plugins, and where is tool authority checked? |
| [04 — Sessions, outbox and Compact & Resume](04-sessions-outbox-and-continuation.md) | What is the durable session, how are messages/inputs recorded, and how does chat A become chat B? |
| [05 — Workers and multi-agent](05-workers-and-multi-agent.md) | How does the configured agent use her worker garden, sleeping reuse, durable messaging and revival? |
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
| [Release-visual design and evaluation](release-visual-design.md) | How can Eve or any connected model make an accessible, actionable release explainer rather than an overloaded infographic, and evaluate candidates without inventing a feature? |
| [Glossary](glossary.md) | Exact meanings of session, conversation, turn, worker, Thread, Quilt, Plan, repair, etc. |

## Existing deep references

Do not duplicate these when they already answer the narrow question well:

- [`AGENTS.md`](../../AGENTS.md) — full product logic, evidence hierarchy and feature contracts.
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
