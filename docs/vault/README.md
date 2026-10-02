# ParadigmEve engineering vault

> Not in an engineering mood? Start with the local [Eve HTML tour](../readme/index.html):
> human problems first, tiny interactive demos, technical details only when you ask for them.

> **Current source/manual line:** 2.3.4
> **Bridge protocol:** 15

This folder is the fast, linked operational manual for how the current ParadigmEve source fits together. It is
the current manual, not a changelog or nomenclature history. Rewrite it when the product changes so
the Vault always teaches the behavior, names and operating model that are true now.

Current source/tests and first-hand runtime evidence remain authoritative for what exists today; the
Vault is the canonical human-readable operational manual. [`AGENTS.md`](../../AGENTS.md) supplies the agent/developer
bootstrap and implementation contracts. These notes explain **who owns what, how data moves, where
state lives, and what to check when something breaks**. See [Self-reliant AI and the manual](12-self-reliant-ai-and-the-manual.md).

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
| [10 — Current state and acceptance](10-current-state-and-acceptance.md) | What is true in the current 2.3.4 source, and what must be proved before packaging or calling a change complete? |
| [11 — Debugging playbooks](11-debugging-playbooks.md) | What evidence should be collected first for the recurring hard failure classes? |
| [12 — Self-reliant AI and the manual](12-self-reliant-ai-and-the-manual.md) | How should Eve use the manual and current evidence without exposing internal documentation mechanics unless they help? |
| [13 — Schedule workspace and Eve routines](13-schedules-and-routines.md) | How do Schedule, `#schedules`, `#myweek`, `#routines`, `%schedule`, `%evecron` and evidence-backed Started/Done fit together? |
| [14 — Coding skills](14-coding-skills.md) | Which checklist should Eve open for a code review, a bug, a refactor, security, performance, a dependency upgrade, docs, accessibility or SQL? |
| [15 — Desktop pets and Eve avatars](15-desktop-pets-and-avatars.md) | How does Eve make a desktop pet or a human avatar of herself that the user can import on the Pets page? |
| [16 — Languages, localization and aliases](16-languages-localization-and-aliases.md) | How do the three app languages, the agent's own name, the setup guide and localized `%`/`#` names work? |
| [Glossary](glossary.md) | Exact meanings of session, conversation, turn, worker, Thread, Quilt, Plan, repair, etc. |

## Existing deep references

Do not duplicate these when they already answer the narrow question well:

- [`AGENTS.md`](../../AGENTS.md) — full product logic, evidence hierarchy and feature contracts.
- [`docs/tool-surface.md`](../tool-surface.md) — model-facing tool surface and permission behavior.
- [`docs/plugins.md`](../plugins.md) — external MCP plugin usage and lifecycle.
- [`docs/chat-review-heartbeat-implementation.md`](../chat-review-heartbeat-implementation.md) — 22-minute semantic review owner.
- [`docs/quilt-discovery-tutorials.md`](../quilt-discovery-tutorials.md) — product acceptance shape for the first Thread/Quilt experiences.
- [`docs/product/feature-spec-template.md`](../product/feature-spec-template.md) — generic template-project authority, retention, provenance and external-context questions.
- [`docs/product/expenses.md`](../product/expenses.md) — Expenses dogfood contract for recurring intake, canonical structured data and optional raw evidence.
- [`docs/release-notes/v2.2.2.md`](../release-notes/v2.2.2.md) — release notes for the stable Angel release.
- [`docs/release-notes/v2.3.4.md`](../release-notes/v2.3.4.md) — release notes for the 2.3.4 source line.
- [`docs/release-notes/v2.3.3.md`](../release-notes/v2.3.3.md) — release notes for the 2.3.3 source line.
- [`docs/product/README.md`](../product/README.md) — product direction and human goals.

## Reading convention

Each subsystem note uses three labels:

- **Authority** — the module/data that is allowed to decide the fact.
- **Projection** — UI/cache/transport state derived from that authority.
- **Fail closed** — what happens when exact identity or durable evidence is missing.

That vocabulary matters because most hard ParadigmEve bugs come from a projection being mistaken for authority: a visible tab used as ownership, a browser ACK used as semantic completion, imported Plan state used as newer Plan truth, or a connector presentation label used as proof of the current schema.
