# Native ChatGPT subagents — eight-lane evidence and experimental-mode decision

Date: 26 October 2026. Scope: read-only source audit and design, not an installed feature or a live worker benchmark. Prime owns the record. See [audit specification](best-bits-audit-spec.md) and [comparison ledger](best-bits-audit-ledger-2026-10-26.md).

## Decision at a glance

**Default remains Eve's visible, browser-backed ChatGPT worker chats.** The user can inspect individual chat content and ChatGPT-host approval cards; Eve's existing worker broker supplies its own durable run/inbox and tool evidence where exact provenance is established. Do not switch old jobs or change model/reasoning/permissions.

**Native ChatGPT Work subagents are an explicit opt-in experiment** for bounded, preferably read-only parallel research. The observed mechanism was in-conversation `collaboration.spawn_agent`, not an Eve API worker and not an extra browser tab per child. It returned useful findings to Prime, but current Eve Companion attribution was to the parent conversation, without trusted child lineage. Show the warning **"Prime-mediated: individual subagent tool audit unavailable"**. Do not advertise independent Eve worker identity, worker-only permissions, individual receipts, guaranteed provider approval behavior or measurable resource savings.

The current GPT Work backend in `src/shared/agent-backends.ts` is not an accepted installed tabless runtime. A documented plan-authenticated Codex app-server route is a separate integration candidate, **not a claim that Eve can call ChatGPT's internal `collaboration.spawn_agent` facility via a public API**. ChatGPT-native delegation can presently be requested inside an eligible parent ChatGPT Work conversation; automated broker admission remains unimplemented.

## What was actually recovered

- Eight ChatGPT-native comparison subagents returned findings to Prime in **two waves of four**. The four Wave-1 and four Wave-2 lane names below are parent-collaboration labels, not verified Eve principals. No repeat of those jobs was needed for this document.
- The earlier Prime consolidated their source findings into the committed ledger at `fd18d423`, corrected child/parent attribution at `eb701530`, and left the c17 application and pre-existing GPT Work draft unchanged. The present appendix is a **lane-by-lane reconstruction from that completed consolidation and the compaction handoff**, not eight verbatim exported subagent transcripts. Raw per-child event streams, independently signed reports and token records were not recovered.
- The user's separate conversation `6adfc588-70f8-83ed-9f29-b51b89672c4b` was located through Eve's locally recorded session `2026-10-26-7ae24ae8` (`Check Subagent Billing`), without inspecting browser history or navigating a live ChatGPT tab. The user reported an October 23 Battle Art / desktop-app usage spike and a smaller October 26 Astra spike, with other Eve activity not visible in the chart. This is **user-reported chart interpretation**, not a provider billing or token ledger.
- The screenshot and in-conversation launches support **no extra browser worker tabs for the native delegation itself**. Neither OS memory measurements nor total hosted compute/token cost was taken.

### Common evidence/receipt fields for all eight

| Field | Result | Meaning |
| --- | --- | --- |
| Native child work report returned to Prime | **Yes, eight of eight** | Usable research output; sidebar may omit the detailed report |
| Identifiable collaboration lane label | **Yes** | Name assigned in ChatGPT's parent workflow, not an Eve-authenticated caller |
| Source paths and conclusions | **Recorded below** | Source-level comparisons; no new live validation implied |
| Prime-level synthesis | **Committed** | Comparison ledger and protected-pillar audit spec |
| Native child ID bound to an Eve worker run | **Not established** | The exact Companion identity shown in the identity lane was Prime's conversation |
| Per-child Eve tool admission/result/denial receipt | **Not established** | Do not reconstruct from claimed child names, timestamps, or parent tool calls |
| Per-child model, reasoning, token use, credits or cost | **Not measured/verified** | Do not claim eight free runs or eight billable API charges |
| Separate browser tab per child | **No, for observed native delegation** | Not a four-worker Windows RSS or CPU benchmark |

## Wave 1 — four returned research reports

### 1. `/root/browser_models` — browser and model handling

**Returned finding:** CoS has Firefox/XPI support, selected-browser ownership ideas, clearer human approval-card handling and unique display-label resolution for stale worker model defaults. Eve's dedicated Eve Browser, exact Companion ownership and explicit user model/reasoning choice remain hard invariants; no automatic browser-engine port or model fallback.

**Sources in committed ledger:** `A01–A08`; CoS `src/shared/firefox-addon.ts`, `src/main/bridge.ts`, `src/main/chat-models.ts`, `src/renderer/chat-models.ts`, `extension/background.js`, `approval-wait.ts`; Eve `src/main/chat-models.ts`, `src/main/agents.ts`, `src/shared/types.ts`, dedicated-link/browser setup.

**Action / negative gate:** Investigate guarded display-label resolution only after account-observed exact model support. Ensure no model/reasoning alteration, active ChatGPT tab navigation, lost draft/Voice, or cross-browser ownership. Source evidence only; no installed Firefox or live model switch was tested.

### 2. `/root/workers_permissions` — worker broker and permissions

**Returned finding:** CoS has an optional global worker cap, isolated Git worktrees, setup/profile fences and human-facing approval card tokens. Eve's durable worker model, exact run ownership, local Core capability authority and receipts should not be replaced. Ordinary API-backed browser worker creation does not resolve ChatGPT-host approval cards.

**Sources:** `B01–B08`; CoS `src/main/agents.ts`, `src/main/agent-admission.ts`, `src/main/worktrees/*`, `src/main/control-workers.ts`; Eve `src/main/agents.ts`, `src/main/local-agent-tools.ts`, `src/main/mcp/kernel.ts`.

**Action / negative gate:** Optional cap and worktree isolation are candidates, preserving existing worker snapshots, approved roots and staged admission. A delegated worker must never acquire Prime rights from an asserted name, and provider cards must never be automatically approved.

### 3. `/root/sessions_automation` — sessions, Goals, routines and memory

**Returned finding:** CoS restart-persistent composer drafts, optional human review of Goal completion, configurable handoff brief size and focused exports are candidates. Eve is stronger in first-class Plans, exact checklists, Evecron occurrence custody, archive and Pins/Threads/Quilts. CoS's optional Stop rotation and browser chat archive are not replacements for these.

**Sources:** `C01–C11`; CoS `src/renderer/composer-drafts.ts`, `src/main/session/finish.ts`, `src/shared/handoff.ts`, `src/main/worker-archive.ts`; Eve `src/main/plans.ts`, `src/main/schedule.ts`, `src/main/evecron-runner.ts`, `src/main/session/recorder.ts`, `src/main/pins.ts`.

**Action / negative gate:** Adapt bounded durable drafts independently; never mark a Plan or scheduled occurrence complete from worker termination or a handoff. Do not Stop or reload an active user chat.

### 4. `/root/ui_security_platform` — UI, security and platform

**Returned finding:** CoS centrally scrubs model-facing tool results, previews safe settings backup/import, exposes guarded Git Review/Commit, adds accessibility presets and in-chat code Wrap/Save controls. Eve retains its guided-language setup, native File Broker and dedicated browsing rules.

**Sources:** `D01–D12`; CoS `src/main/secrets-shield.ts`, `src/main/settings-backup.ts`, `src/main/project-commit.ts`, `src/shared/appearance.ts`, code-file/renderer paths; Eve `src/main/redaction.ts`, setup/i18n, File Broker owner files.

**Action / negative gate:** Prioritize a centrally tested outgoing secrets shield and field-level import without replacing durable Plans, archive, browser/account identity or stored provider approvals. Code Save must use native dialogs and approved root checks.

## Wave 2 — four returned deep reports

### 5. `/root/pillars_deep` — the five Eve pillars

**Returned finding:** CoS session agent-plan is not Eve's revision-controlled user Plan; CoS provider chat archive is not Eve's local evidence archive. No equivalent was identified for Evecron exact occurrence receipts, Eve File Broker's consented `file_action`/`file_edit` lifecycle, or Pins/Quilts. Eve's English, Swedish and es-419 onboarding needs explicit preservation.

**Sources:** Ledger `P1–P5` and Wave-2 section; Eve `plans.ts`, `mcp/plan-tool.ts`, `schedule.ts`, `evecron-runner.ts`, `archive/*`, `pins.ts`, `file-provider-*`, renderer locales. Inspected regression suites include `plans-review-reconciliation.test.ts`, `plan-tool-authority.test.ts`, `evecron-execution.test.ts`, `archive-store.test.ts`, `file-provider-broker.test.ts`, `renderer-i18n.test.ts` (not rerun here).

**Action / negative gate:** A single cross-pillar fixture must seed human/worker Plans, a pending Evecron occurrence, archive assets, Pins/Quilts, denied File Broker install and sv-SE/es-419 setup, then prove restart/import/worker completion cannot corrupt any unrelated record.

### 6. `/root/identity_tabless` — native child provenance and tabless execution

**Returned finding:** An Eve `work_context` call from this native child returned `callerIdentity: proven` and `callerProof.kind: exact_companion`, but its `conversationId: 6adfb0ac-f910-83eb-8f91-7790572d3fad` and `sessionId: 2026-10-15-88246b67` were **exactly the same** as a separate Prime call at that time. The initial suggestion that it was a distinct child conversation was corrected. The connector proved the parent ChatGPT document, **not the child collaborator**.

**Sources:** Ledger `B09` and corrected identity paragraph; Eve `src/main/agents.ts:282–291,793–801,997–1019`, `src/main/mcp/work-context.ts:21–38,73–93`, `src/main/mcp/kernel.ts:803–832`, `src/main/session/recorder.ts:1270–1380`.

**Action / negative gate:** A child-reported name is not a capability. Require trusted broker-issued `(runId, workerId, delegationId, capability policy, actual provider child thread)` binding and each tool-event receipt for audited mode. Until then show Prime-mediated/auditless at child level and do not claim enforceable child-only permissions. An instruction telling children to avoid writes is **not itself a security boundary**.

### 7. `/root/settings_locale_deep` — settings, drafts, locale and onboarding

**Returned finding:** CoS has accent-folded settings search with keyboard navigation, bounded persistent composer drafts, an import preview/stale-revision flow and accessibility options. Its broader locale catalog does not contain a drop-in equivalent of Eve's Swedish and Latin American Spanish guided setup; broad provider-approval instructions are unsuitable.

**Sources:** Ledger `D02,D04,D06,D13,D14`; CoS `src/renderer/settings-search.ts`, `src/renderer/composer-drafts.ts`, `src/main/settings-backup.ts`, `src/renderer/i18n.ts`; Eve `src/main/setup-assistant.ts`, `src/main/setup-guide-i18n.ts`, `src/renderer/locales`.

**Action / negative gate:** Field-by-field settings import must not widen permissions or overwrite account/host identity, Plans, schedules, receipts, recording opt-out or the user's model/reasoning. Localize every experimental-worker status and warning in en/sv-SE/es-419.

### 8. `/root/files_platform_deep` — File Broker, project files and resource costs

**Returned finding:** Eve's consented, checksummed provider installation and copy-based edits are stronger than CoS's generic project utilities, but its built-in provider registry is bounded and arbitrary app learning is not implemented. CoS offers useful project-parent revalidation before publish and per-process memory diagnostics. Eve's Chrome worker runner deliberately spends extra CPU/RAM to keep background chats alive; native tabless delegation may reduce *local browser* overhead, not proven hosted cost.

**Sources:** Ledger `D15–D18` and Wave-2 section; Eve `src/main/file-capabilities.ts`, `file-provider-consent.ts`, `file-provider-install.ts`, `mcp/file-edit.ts`, `browser.ts`, `diagnostics-support.ts`; CoS `project-files.ts`, `diagnostics-report.ts`, `diagnostics-facts.ts`.

**Action / negative gate:** Test junction/symlink parent swap, stale consent/checksum, interrupted install and rollback; measure four browser workers against four tabless children with CPU, private RSS, completion, approval stalls, token/usage observations and receipts before asserting speed or efficiency.

## Billing and model availability evidence — separate from Eve receipts

1. These eight were initiated through ChatGPT-native collaboration, with no recorded deliberate use of an API key or Eve external-provider worker. This is **not a transaction-level audit of the user's OpenAI billing account**.
2. OpenAI's ChatGPT Work subagent documentation says each child performs model/tool work and consumes more tokens than an equivalent single-agent run. ChatGPT Work Plus cloud and local tasks share the plan allowance; active work may continue at an exhausted displayed allowance, and purchased credits may be a separate plan mechanism. Therefore a sparse Analytics chart or an observed 0% remaining bar must **not** be construed as free/unmetered execution.
3. The user's linked conversation reported low Oct-26 chart activity versus the eight visible completed subagents. No raw account invoice, independently attributed child token usage or definitive analytics event breakdown has been established. Do not write `0 API cost verified` or `free` on that basis.
4. Official ChatGPT Work model docs list **GPT-6 Luna (`gpt-6-luna`)** for focused repeated tasks and **GPT-6.1 Terra (`gpt-6.1-terra`)** for efficient visual/computer-use and writing tasks. Terra's 26-Oct announcement says availability on Plus and other eligible Work plans; actual selected-account model entitlement still requires a live observed picker/completed run. These names are already understood by ChatGPT Work, not proof that the c17 Eve worker picker currently offers both. Do not use API price-list estimates as ChatGPT subscription charges.

Official sources consulted 26-Oct-2026:

- https://learn.chatgpt.com/docs/agent-configuration/subagents
- https://learn.chatgpt.com/docs/models
- https://learn.chatgpt.com/docs/pricing
- https://learn.chatgpt.com/docs/whats-new/october-26-30-2026
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

## Future acceptance contract

1. **Default auditable ChatGPT chats:** Keep current broker, visible child chats, human-observed approvals, exact run/worker inboxes, activity and safe browser ownership. Do not promise no provider prompt; a host approval belongs to ChatGPT and may block unattended work. Do not auto-click it.
2. **Explicit experimental native subagents:** User opts in per task/run; Prime requests up to four bounded children within the hosted chat when available. Capture assignment and returned report under Prime ownership, with each child report visible in Eve's local documentation or Activity as **Prime-reported**, not signed child trace. On missing report, mark unknown rather than success. Preserve normal ChatGPT model selection/inheritance; no automatic cheaper-model switch or extra provider selector. If no supported delegation, refuse gracefully or offer the default auditable mode after user choice.
3. **Effect boundary:** Until trusted child identity exists, do not promise independent child tool permissions or side-effect receipts. Restrict the experiment to analysis/read-only tasks by design and tell the user this is not an enforceable per-child connector boundary when children inherit Prime's tool access. Avoid effectful tools entirely during the trial; any required mutation must return to the visible, auditable Prime/ordinary Eve worker workflow for human review. No automatic approval, silent API fallback, replay or cross-run privilege borrowing.
4. **Auditable future GPT Work adapter:** Only after supported plan-authenticated transport, exact account model/effort and entitlement checks, broker-issued child principal, provider-thread binding, per-call admitted/denied/unknown receipts, limits and restart/cancellation tests. A Codex app-server child is not automatically the same implementation as native ChatGPT collaboration.
5. **Benchmark and rollout:** Compare four children against four ordinary browser workers on the same bounded prompts with independent task quality, OS resources, wall time, provider approvals, per-child visibility, usage observability, and interruption safety. Keep feature off by default and the previous worker backend unchanged throughout rollback.

No source implementation, installed c17 runtime behavior or provider charges are changed by this document.
