# ParadigmEve: full feature maturity audit and copy-best-bits specification

Status: audit/design only; no port or installation authorized by this document.
Owner: Eve Prime. Concurrency: exactly four read-only audit workers per active wave, never nested delegation.
Companion documents: [26 October 2026 comparison ledger and phased plan](best-bits-audit-ledger-2026-10-26.md), [eight native subagent reports, billing limits and receipt accounting](native-subagents-evidence-2026-10-26.md), and [hosted native subagent integration boundary and experiment design](native-chatgpt-subagents-design-2026-10-26.md).

## 1. Objective and decision rule

Compare **every product feature and cross-cutting subsystem** against the latest available mature reference implementation, initially Chat On Steroids (CoS), while preserving what makes Eve different. Produce an evidence-backed list of *small, testable improvements* rather than a blanket upstream merge. Extend the reference set only when a precise candidate needs an official provider standard or another public upstream; name each source/version.

For each feature answer: What user job does it serve? What is the authoritative owner? How do CoS and Eve implement it? Which is more reliable, useful, accessible or maintainable? Which behavior should Eve keep, adapt, copy or reject? What is the smallest safe port and how do we prove it?

Do not mistake a larger feature count or a passing unit test for greater maturity. Weigh real installed-runtime outcomes, negative tests, recoverability, ownership correctness and user value. A proven Eve capability wins over an upstream refactor that would remove it.

## 2. Five protected Eve pillars: hard acceptance gates

1. **Plans, checklists and Eve bookkeeping.** Keep first-class Plan IDs, exact source conversation/session provenance, revision-checked edits, visible step state, Plans-versus-Eve-activity classification, and semantic review debt. A worker finishing or reporting is not a user checklist step.
2. **Schedule and habit formation.** Keep user-authored Schedule, Evecron/routine recurrence, timezone and occurrence identity, exact delivery evidence, Started/Done semantics, and a human-facing habit loop. Never dispatch the same uncertain occurrence twice.
3. **Local archive, audit trail and memories.** Preserve recorded sessions, provenance of tool activity, searchable local memory, Pins/Threads/Quilts and recording opt-out. Turning recording off stops new capture without erasing old archives, Plans, Pins, receipts or audit logs. Do not confuse optional ChatGPT-side worker-chat archiving with Eve's local archive.
4. **File broker that can learn to install apps.** Preserve file-action discovery, explicit provider offers, consented install/update decisions, approved-root checks, format-fidelity tests, provider provenance and the ability to add external document/app handlers. No silent installers or entitlement expansion.
5. **UI and onboarding in chosen languages.** Preserve Eve's distinct navigation and setup pedagogy, language-specific aliases and complete Swedish, Spanish and other chosen-language text. New settings, failure messages, cards and permissions must be localized and tested; do not overwrite Eve semantics with CoS labels.

**Port veto:** Any candidate that breaks one of the five pillars, Prime-only coordination, user model/reasoning choice, local ownership/audit, or browser safety is blocked until redesigned. A test that only confirms the new upstream feature is insufficient.

## 3. Invariants shared by every proposed port

- Preserve the user's existing c17 installed application, sessions, source recordings, pending messages, receipts, Plans, archive, Pins, model selections and schedule state during this audit.
- Do not close, reload, navigate away from, retarget, focus-steal or duplicate an active ChatGPT tab. Do not inspect ChatGPT browser history. Eve-owned links use the dedicated Eve Browser/profile.
- Prime remains sole coordinator. Worker tools execute only within current Eve user-configured permissions. A ChatGPT-host approval card is an upstream boundary, not evidence of an Eve permission denial.
- Only the user-facing picker changes ChatGPT model or reasoning. Free/Go uses the provider's native default. A saved model must be confirmed against account-observed options; no invented model IDs or silent model switch.
- GPT Chat and GPT Work are distinct execution paths. The existing GPT Work placeholder must be completed in its own right; do not build another broker/provider picker. No separately billed API-key fallback or unapproved budget/credential changes. OpenAI plan sharing, if used, requires explicit sign-in and entitlement/limit checks.
- Keep **visible, browser-backed ChatGPT worker chats as the default auditable lane**. Evaluate Prime-owned tabless in-conversation subagents only as an explicitly selected experimental lane for bounded, preferably read-only parallel work. They need not open a ChatGPT browser tab per child, but that does not prove separate Eve identity, durable tool traces, subscription entitlement, free usage or absence of provider approvals. Do not invent those guarantees.
- One owner per fact: exact session, run incarnation, caller and capability proof, browser document/navigation epoch, durable outbox entry and ACK must agree. Do not retry ambiguous browser sends or uncertain tool actions.
- No material port, build, install, public push/tag/release, browser experiment or user-data change is authorized by *performing the audit*.

## 4. Exhaustive feature inventory and wave coverage

Every row below requires at least a source-level result; no feature family is dropped because CoS lacks an equivalent. Split broad rows into concrete feature cards as discovery proceeds.

| Group | Feature families to inventory | CoS/Eve owner or source entry point |
| --- | --- | --- |
| A1 | Browser choice, Firefox, dedicated browser, profile/session ownership, startup and sign-in | browser, browser-startup, browser preferences, built-in browser |
| A2 | Extension pairing/upgrade, MV3/Firefox lifecycle, tab election, no-reload recovery, DOM/Fiber/usage evidence | bridge, extension background/content/DOM |
| A3 | Native account model/effort catalog, worker default, Free/Go, new-chat composer, existing-chat preservation | chat-models, renderer chat-models, worker admission |
| A4 | Browser-facing approvals, user focus, consent, model-facing connector instructions | approval-wait, MCP instructions, renderer |
| B1 | MCP surfaces, setup profiles, exact caller proof, tools, code mode, root/capability policy | MCP kernel, registrars, connection |
| B2 | Agent family ownership, admission/capacity, worker slots, durable runs, sleeping/revival, inbox receipts | agents, admission, swarm snapshot |
| B3 | Worker isolation/worktrees, project context, broker workspace, direct local work | worktrees, workspace, local-agent tools |
| B4 | GPT Chat/Work and local/external backends; budget, usage and no-billed-fallback rules | agent-backends, local execution, model transport |
| B5 | Tabless in-run subagents, child identity/capability/audit ledger, hosted collaboration, cost/limit mode | documented OpenAI multi-agent/Codex app-server; Eve broker and kernel |
| C1 | Sessions, recording, timeline, audit, chronology, search/export and local archive | session store/recorder/search, archive |
| C2 | Composer drafts, attachments, outbox, one-send claims, ACK/restart reconciliation | session input, renderer drafts, bridge receipts |
| C3 | Recovery, long-turn rotation, Compact & Resume, lifecycle ownership | session continuation, recovery, rotation |
| C4 | Goal/Loop/Astra, Plans/checklists, heartbeat, worker reports and scheduling | goal, plans, chat-review-heartbeat, evecron |
| C5 | Pins, Threads, Quilts, prompt/context activation and memory | pins, references, context selection |
| D1 | Workspace UX, onboarding/settings, accessibility, focus, navigation and layout | renderer, setup, i18n/locales |
| D2 | Files, file broker, document handlers/app installation, downloads/attachments | file-action/file-edit broker, providers, rawfs |
| D3 | Projects/git/worktrees, terminal/process manager, editor, desktop/computer input | projects, codex, computer |
| D4 | Skills, plugins, connectors, authorization, secrets/redaction, privacy | skills, plugins, secrets, kernel |
| D5 | Usage/limits/cost presentation, diagnostics, activity, notifications/phone, pet/voice/transcription | usage, diagnostics, renderer, transcription |
| D6 | Configuration migration, backup/export/import, update/install, packaging and release safety | config, settings, updater, scripts/tests |
| X | Cross-feature integration: all five protected pillars through restart, compaction, worker work and locale changes | exact end-to-end contract + tests |

## 5. Worker waves: four at a time

Prime is the only owner of scope, ledger reconciliation, ranking, spec changes and future implementation. Workers inspect independently, read-only. A running audit wave has no more than four workers, each owning a disjoint family, with no nested delegation:

- **Wave 1 (completed 26 October):** A browser/models; B worker/permissions; C sessions/automation/memory; D UI/security/platform.
- **Wave 2 (completed 26 October):** Protected Eve pillars and their negative tests; native child identity/permissions; UI/settings/locale/onboarding; File Broker/project/diagnostics/browser resource costs.
- **Wave 3:** Four integration reviews: Plan+heartbeat+worker; Schedule+occurrence+notifications; Archive+Pins+opt-out; file broker+providers+localized onboarding.
- **Wave 4:** Four adversarial acceptance designs: model/approval/limits; browser crash and no duplicate send; cross-platform packaging; user-facing journey in every chosen language.
- **Wave 5 (architecture decision):** Four bounded traces of a real tabless delegation: subagent identity and local tool custody; stream/receipts and archive visibility; subscription entitlement and no billable fallback; concurrent cancellation/restart/recovery. Perform only after a supported route and explicit user consent exist; do not spend API credits as an exploratory shortcut.
- **Later waves:** Continue with four workers per wave until every ledger row and its subfeatures have evidence and either a decision or explicit blocker. Never silently declare an area complete from a partial search.

Each worker's brief freezes both repository commits, its bounded owner files, protected-pillar interactions, tests and expected result. Worker outputs are hypotheses: Prime verifies consequential claims before promotion into the plan. No worker changes source, state, browser, provider permissions or a running job.

## 6. Required per-feature evidence card

Each inventoried feature uses this schema:

| Field | Required evidence |
| --- | --- |
| ID / user job | Stable audit ID, precise expected human outcome |
| Owners | CoS and Eve file paths, functions and line ranges, evidence date/commit |
| Status | CoS stronger / Eve stronger / parity / intentionally divergent / absent / unverified |
| Contract | Original Eve behavior and five-pillar dependencies to preserve |
| Proof levels | Source; tests; build; package; installed payload; live signed-in runtime (mark missing separately) |
| Comparison | Reliability, capability, UX/language, costs/limits, security/consent, migration, maintainability |
| Choice | Copy adapted, repair Eve owner, keep Eve, reject, or research |
| Port slice | Smallest authoritative change; modules/tests touched; upstream commit/author attribution |
| Negative tests | Denied/stale/wrong owner/restart/ambiguous-send/no-entitlement/locale cases |
| Acceptance | Reproducible source/test and required live operator checks; rollback/flag |

Never infer a feature's absence from one filename search; inspect its owner and UI/IPC/API behavior. Cite exact relevant lines, not a whole repository. A release note is a lead, not runtime proof.

## 7. Ranking and implementation gates

**Priority:** P0 data loss/security/unauthorized actions/active-tab violation; P1 recurring blocked work or material user friction; P2 worthwhile usability/reliability; P3 polish. For each candidate score demonstrated impact, evidence confidence, dependency depth, compatibility with the five pillars, risk of migration/data loss, complexity, maintenance/license obligation and time-to-live-verification. High benefit does not outrank a hard veto.

**Port rules:** inspect current Eve diff (including the unfinished GPT Work research draft), identify original author/license and current upstream commit, and prove the exact contract to keep. Characterize old Eve behavior before editing. Adapt at the single authority owner; do not copy its whole surrounding architecture or duplicate state machines. Keep clear Git checkpoints and provenance. Gate one bounded set of edits with owner unit + neighboring negative tests, TypeScript, diff check, then isolated installed/runtime acceptance. A new candidate or public release requires separate explicit authority.

**Human confirmation:** anything that would replace a protected Eve workflow, materially change browser policy, incur API billing, change models, migrate user storage, install external software or change provider consent requires a separate user decision before implementation.

### Tabless delegation proof obligations

**User decision (26 October, newer than the initial preferred-tabless proposal):** Ordinary Eve ChatGPT worker chats stay the default because the user can inspect child content and host approvals. Native ChatGPT subagents are opt-in experimental, labeled **Prime-mediated: individual subagent tool audit unavailable** until verified. Their eight completed reports are preserved in [the per-child evidence appendix](native-subagents-evidence-2026-10-26.md). The fact that October 26 subagents were sparse or absent in the user's Analytics chart is not proof of unmetered computation or zero credit use.

**Settings decision and present implementation boundary (26 October):** Keep a single prominent worker route selector: **ChatGPT chats (visible and auditable, default)** or explicitly configured **Ollama/OpenRouter**. Show the signed-in account's observed ChatGPT worker model and reasoning choices next to it; preserve Free/Go's native default and never force a model/reasoning change. The human chooses **Chat** or **Work** when opening a ChatGPT conversation, not by entering an OpenAI inference API key or selecting an Eve billing route. Keep the existing restricted OpenAI tunnel key only for Companion tool connectivity, clearly distinguished from inference billing. Goal/Loop may still use an explicitly configured non-ChatGPT provider. Collapse compatibility/legacy worker fields in Settings, retain their IDs and stored values, and do not silently migrate existing runs. This c17-source Settings simplification does **not** implement native collaboration subagent dispatch: do not expose a selectable tabless driver before Eve can genuinely start and manage those children with truthful Prime-mediated evidence and permission limits.

The currently observed native in-ChatGPT subagents have separate contexts and do not require four local browser tabs, but their work is not automatically represented as four Eve-owned conversation records. A subscription-backed tabless WORK backend should reuse the existing Prime worker broker, with a **separate agent/run ID and durable app-owned activity ledger** covering admission, model and reasoning chosen by the user, approved capabilities, tool call and result IDs, provenance, timestamps, completion, token/usage observations, and cancellation or uncertain outcome. A provider-supplied agent ID is not by itself permission to act: the trusted execution boundary must bind it to the exact Prime family and capability envelope. Never allow a worker to manufacture Prime identity from text.

**Evidence from Wave 2 (Prime cross-checked):** A child agent's Eve work_context showed the **same exact Companion conversationId and sessionId as Prime's own call**, with no separate native collaboration child/parent delegation ID. Eve agents.ts currently resolves only run-owned Prime/registered worker conversations or internal local principals. Hence these in-ChatGPT subagent requests currently appear to Eve as **Prime-originated** calls; no tabless child's separate Eve permissions or lifecycle should be inferred from a valid Companion conversation alone. Native children can be useful as Prime-mediated read-only researchers today; the future broker needs unforgeable delegated admission, worker-to-provider-thread binding, per-effect receipts and explicit denial on unproved lineage.

If the host does not expose verifiable child-tool attribution, label it honestly as Prime-mediated work instead of inventing a worker receipt. Keep experimental tasks read-only by intent, and disclose that Prime-equivalent connector permissions cannot be narrowed to the child using an unverified self-asserted name: instruction-only restrictions are not an enforceable independent child permission boundary. Return any effectful action to the visible auditable Prime/ordinary worker route for human review. Archive recording opt-out applies to new subagent chat/tool recording too; do not silently expand data capture. A user needs a clear Eve Activity view of each subagent's *Prime-reported* status and report, and tool events only when attribution is truly verified. A completed summary alone is not a full audit trail.

**Resource-evidence gate:** Eve's dedicated Chrome runner explicitly trades additional memory/CPU for reliable background ChatGPT workers by disabling some throttling. Measure four real browser workers against four supported tabless workers under comparable task loads: count browser tabs/processes, CPU time, idle and peak/private RSS, completion, approval stalls, Plan/Schedule side effects, total model usage and receipts. A screenshot showing native subagents under one parent tab motivates this benchmark but cannot establish quantitative savings.

OpenAI documents multi-agent execution through both Agents and Responses APIs, but those normal API runtimes are separately billed; the ChatGPT plan-sharing preview forbids the top-level multi_agent field. The documented Codex app-server configuration can coordinate local child agents with the user's explicitly granted plan token, subject to its preview limits and model/entitlement checks. Investigate this existing runtime before implementing any custom response parser or adding a billed provider. The source audit cannot claim that plan-backed child agents have passed live acceptance.

- https://developers.openai.com/api/docs/guides/agents-api/multi-agent
- https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

## 8. Done means

1. Every feature family in section 4 is decomposed and marked with evidence, not an unqualified checkmark.
2. The ledger distinguishes upstream-best and Eve-best features, and documents five-pillar protection for every port.
3. Each selected port has owner, upstream source and attribution, dependency order, acceptance/negative tests, risk, rollback and honest live-evidence status.
4. All four concurrent workers from each completed wave have been reconciled; unresolved conflicts stay open.
5. The phased copy-best-bits plan is ready for explicit implementation authorization; no untested source candidate is called installed or accepted.

## Source pointers

- Eve product contracts: ../AGENTS.md and [engineering vault](vault/README.md), especially 03–08, 13, 16, 18 and 21.
- CoS contracts: /projects/chat-on-steroids/AGENTS.md; its current source and tests take precedence over changelog claims.
- Official OpenAI plan-sharing specification: https://developers.openai.com/siwc/token-sharing-open-source
