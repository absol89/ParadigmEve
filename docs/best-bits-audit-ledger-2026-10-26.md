# Copy the best bits — source comparison, feature ledger and port plan

Audit started 26 October 2026. Status: **eight read-only comparison lanes completed in two four-worker waves; exhaustive integration/adversarial waves and live acceptance pending**. A lane's completion does not certify all subfeatures in that lane.

Companions: [audit specification, worker waves and preservation gates](best-bits-audit-spec.md) and [eight individual native subagent findings with receipt status](native-subagents-evidence-2026-10-26.md).

## Baselines and evidence grade

- CoS: /projects/chat-on-steroids, clean main at 2ae1afb852758948ec56eeea1cafa8db5b3b3f51 after a fast-forward of 599 commits; its 2.1.45–2.1.46 release notes supplied leads, not proof of Eve behavior.
- Eve: /projects/ParadigmEve-2.4.5, release/2.4.5 at f5b23904592b76a38d7f2e7cb3c48964cd228208, with uncommitted GPT Work auth/transport research in package-lock.json, package.json, local-agent-runtime.ts, gpt-work-auth.ts and gpt-work-responses.ts. This audit did not change, install or use that draft.
- Running Eve: c17 installed earlier. **No comparative live worker run, native approval intervention, authenticated Work-lane task, model change, restart or reinstall occurred in this audit.**
- Two waves of four audit workers used the parent ChatGPT run's collaboration facility, with no separate ChatGPT worker tabs. Their read-only Eve tool calls and reports are **not** proof that Eve has independent durable subagent worker identities. That mismatch is an audit candidate below.
- Findings are source comparisons; individual ports remain research or proposed until reproduced, implemented, tested, packaged and installed in distinct stages.

## Protected Eve pillars — retain before copying

| Pillar | Eve authority/evidence | Required negative case |
| --- | --- | --- |
| P1 Plans/checklists/bookkeeping | src/main/plans.ts; mcp/plan-tool.ts; chat-review-heartbeat.ts; docs/vault/06-pins-quilts-and-plans.md | Worker-generated progress never overwrites an exact user Plan revision or marks a checklist completed without source evidence |
| P2 Schedule/habits | src/main/schedule.ts; evecron-runner.ts; docs/vault/13-schedules-and-routines.md | Restart, Compact & Resume, or worker switch never duplicates a scheduled occurrence or seizes a human chat |
| P3 Local archive/audit/memories | src/main/archive; session/recorder.ts; pins.ts; docs/vault/08-persistence-security-and-filesystem.md | Opt-out stops only new recording; previous sessions, Pins, Plans, receipts and audit remain |
| P4 File broker/app installation | src/main/file-provider-consent.ts; file-provider-install.ts; mcp/file-edit.ts | Unknown provider, unapproved root, stale checksum, missing consent and changed installer all fail without side effects |
| P5 Chosen-language UI/onboarding | src/main/setup-assistant.ts; setup-guide-i18n.ts; renderer/locales; docs/vault/16-languages-localization-and-aliases.md | Swedish/Spanish/English flows do not lose draft, language choice or setup state when a new port introduces UI or errors |

## Wave 1 feature maturity ledger

Status legend: **CoS+** = narrower source-proven improvement, **Eve+** = protected Eve advantage, **≈** = broad parity requiring tests, **Different** = competing architectures, **Unknown** = more research. The columns intentionally distinguish current source from proposed changes.

| Audit ID | Feature | Relative maturity | Precise comparison and next decision |
| --- | --- | --- | --- |
| A01 | Firefox browser/add-on/update | CoS+ | CoS src/shared/firefox-addon.ts, src/main/bridge.ts, extension/background.js; Eve src/shared/types.ts Chromium choices. Large optional isolated-profile investigation; not an automatic port. |
| A02 | Built-in ChatGPT browser vs dedicated Eve Browser | Different | CoS src/main/cos-browser/* vs Eve eve-browser-links.ts/browser setup. Preserve Eve Browser as the sole Eve-owned URL destination; never use personal/default fallback. |
| A03 | Multiple companions and selected-browser claim fences | CoS+ hypothesis | CoS AGENTS.md §13 and bridge; Eve exact Companion proof. Probe without retargeting tabs or stealing ownership. |
| A04 | Account-observed model/reasoning picker | ≈ / Eve+ | CoS src/main/chat-models.ts, renderer/chat-models.ts; Eve model discovery + first human model confirmation and Free/Go native default. Do not overwrite Eve user-intent policy. |
| A05 | Stale worker default display-label resolution | CoS+ | CoS agents.ts:1889–1925 unique label/alias resolution; Eve agents.ts worker model logic. Adapt exact-only match without silent model/reasoning downgrade. |
| A06 | Exact human approval-card display and answer | CoS+ | CoS approval-wait.ts, IPC, renderer; Eve c17 notification/tab focus. Only Prime/active human UI may send a user-click decision. |
| A07 | Connector wording and false provider approval | CoS+ hypothesis | CoS mcp/instructions.ts:112–119 and test/mcp-user-instructions.test.ts; Eve mcp/instructions.ts:90–119. Separate factual tool description from user/product guidance; preserve all five pillars. |
| A08 | Background focused-rendering protection | Unknown | CoS extension/active-tabs.js lease; Eve Chromium process flags. Measure CPU/RAM and provider behavior before even considering debugger attachments. |
| B01 | Durable reusable worker runs/inboxes | ≈ | CoS agents.ts v7; Eve agents.ts v6 plus heartbeat, exact Prime provenance. Characterize only focused differences. |
| B02 | Global across-family worker cap | CoS+ | CoS agents.ts:1536–1559,2256–2265. Optional cap, staged reservations, cap-off backwards compatibility. |
| B03 | Optional isolated worker Git worktrees | CoS+ | CoS agent-admission.ts:85–199, worktrees/*; Eve existing project/worker cwd. Preserve file broker and approved root rules. |
| B04 | Setup profile/local owner worker fences | Different | CoS agents.ts:798–862; Eve work-context exact Companion proof. Add narrow provenance fence only after cross-machine threat model. |
| B05 | Human-facing tool approvals | CoS+ | CoS cardId/token/result CAS; Eve native notification. Never autoanswer a card or equate TOOL_REJECTED to human Deny. |
| B06 | Independent local API starts browser workers | Not a Work-lane substitute | CoS control-workers.ts starts ChatGPT tabs. It does not bypass ChatGPT-host MCP approval. |
| B07 | Eve Core-tool principals for local workers | Eve+ | Eve local-agent-tools.ts, ollama-worker-executor.ts, agents.ts. Keep Eve's capability authority rather than replacing it with upstream browser control. |
| B08 | GPT Work execution backend | Eve placeholder, unimplemented | Eve shared/agent-backends.ts:134–142; CoS has no gpt-work backend. Finish via supported plan-authenticated transport and independent worker auditability, not a new provider/settings system. |
| B09 | **Tabless in-run subagents** | Promising, unverified in Eve | Four present-turn audit subagents needed no separate worker browser tabs. Explore Codex app-server documented child agents, signed Prime-owned delegation identity, tool permissions, worker activity ledger and subscription limits; see architecture decision. |
| C01 | Session recording, exact outbox, compaction | ≈ | Both mature, with distinct provenance and ACK contracts. No wholesale port. Compare focused races before candidate selection. |
| C02 | Restart-persistent composer drafts | CoS+ | CoS renderer/composer-drafts.ts:1–90, test/composer-drafts.test.ts; Eve renderer/chat.ts:180–204 in-memory drafts. High-value focused adaptation. |
| C03 | Optional human review of Goal completion | CoS+ | CoS session/finish.ts:179–199; Eve corresponding finish path. Must never mark durable Plans done. |
| C04 | Handoff brief sizes | CoS+ UX | CoS shared/handoff.ts:43–67; Eve handoff-prompt.ts. Add only if no loss of user instructions, Plan/schedule debt or exact marker/provenance. |
| C05 | Long-turn Stop fallback | Reject without separate user decision | CoS rotation-fence.ts; Eve strict no-interference rule. An automatic Stop can interrupt active work. |
| C06 | Browser-side archive/unarchive of settled worker chats | Conditional | CoS worker-archive.ts; Eve **local archive is different**. Opt-in after wake and pin/draft protection proof. |
| C07 | Usage CSV and stand-alone HTML chat export | CoS+ limited | CoS session/usage-export.ts, page-export.ts; Eve richer archive. Only thin exporters from Eve canonical data. |
| C08 | Pins/Threads/Quilts and context library | Eve+ | Eve pins.ts/reference aliases; upstream bookmarks/groups are not replacements. |
| C09 | First-class Plans/checklists, heartbeat review | Eve+ | Eve plans.ts, chat-review-heartbeat.ts; CoS agent plan lacks these durable user semantics. |
| C10 | Schedule/Evecron and occurrence ledger | Eve+ | Eve schedule.ts, evecron-runner.ts; not replaceable by Goal/Loop. |
| C11 | Searchable independent local archive and opt-out | Eve+ | Eve archive/*, recorder; CoS session history/native worker archive differs. |
| D01 | Model-facing tool-result secrets shield | CoS+ | CoS secrets-shield.ts:120–173, mcp/kernel.ts:503–528; Eve redaction.ts but no equivalent central outgoing result shield. |
| D02 | Selective settings backup/import | CoS+ | CoS settings-backup.ts:98–278 and dialog; Eve no matching full settings backup. Preserve host identity and all five pillars. |
| D03 | Graphical Git Review guarded commit | CoS+ | CoS project-commit.ts:128–268, project-git.ts, commit-dialog.ts; Eve has tools but not same UI. Preserve existing staged index. |
| D04 | High contrast, line spacing, accessible presets | CoS+ | CoS shared/appearance.ts, renderer/appearance.ts; Eve own theme/language identity. |
| D05 | Chat code-block Wrap/Save | CoS+ | CoS code-file.ts and code renderer; Eve lacks equivalent in-chat controls. Use fixed IPC/native dialog, no generic file path from HTML. |
| D06 | Language catalog breadth vs Eve guided setup | Different | CoS 12 translations plus English; Eve English/Swedish/Latin American Spanish with more focused guided onboarding. Extend translations deliberately, never replace localized flows. |
| D07 | File broker/app provider lifecycle | Eve+ | Eve file-provider-consent.ts/file-provider-install.ts/file-edit.ts; no matching CoS file_action or file_edit. |
| D08 | Phone notifications/quiet-hour suppression | CoS+ algorithm, overlap | CoS phone-push.ts; Eve own cloud/phone integrations. Extract suppression logic only after proving user value; no duplicate service by default. |
| D09 | Opt-in sound cues | CoS+ optional | CoS sound-cues.ts. P3 accessibility/polish after higher-value work. |
| D10 | Logging/diagnostics | ≈ / Different | Both have bounded logger queues; CoS scrubbed support export, Eve strong live Companion diagnostics. No blind logger replacement. |
| D11 | Plugin/tool permission and setup | ≈ / Eve+ | Eve has file broker/ArtCraft layers beyond CoS; compare plugin edge cases separately. |
| D12 | Installer/update and Firefox distribution | Different | CoS signed Gecko add-on, Eve current Chromium packaging. Browser-engine decision precedes any packaging port. |
| D13 | Searchable and navigable settings | CoS+ | CoS renderer/settings-search.ts:1-105 supports bounded accent-folded localized search, hidden-field exclusion and keyboard focus. Adapt Eve-specific destinations without executing controls on search. |
| D14 | OS-locale choice and broader setup illustrations | Conditional | CoS renderer/i18n.ts detects OS language, but its 12 catalogs do not include Eve's Swedish or es-419, and its setup guide tells users to grant broad provider approvals. Keep Eve's six-step localized setup; only consider supported-locale first-run detection and redacted dedicated-browser illustrations. |
| D15 | Quantified browser/worker diagnostic report | CoS+ measurable pattern | CoS diagnostics-report.ts:76-113 counts memory per process, diagnostics-facts.ts gives scrubbed support report. Eve diagnostics-support.ts has better Companion and worker liveness; add per-worker memory/CPU counters and privacy-safe export rather than replacing its Health. |
| D16 | File staging and publish-path race checks | CoS+ narrow hardening | CoS project-files.ts:27-59,157-212 revalidates project parent and symlink/junction boundaries at use. Run Eve broker-specific parent-swap race tests before adapting; never bypass original consent, checksum, approved root or no-clobber rules. |
| D17 | Local GPU/cloud transcription and diarization | Eve+ | Eve transcription-runner.ts:27-119,197-303 records backend provenance and local diarization. Preserve existing GPU/local/approved-cloud choice; don't replace with a generic upstream recorder. |
| D18 | Local usage summaries and export | Different | CoS provider-usage.ts:30-180 and usage-export.ts support local log estimates and export; Eve session/usage.ts has its own accounting. A report must distinguish ChatGPT plan allowance from billable API charges; do not introduce new metering assumptions. |

## Architecture decision first: why these four subagents matter

Today's four read-only comparison agents performed independent work under one ChatGPT Prime run, without adding four persistent browser tabs. This is a real **local browser resource advantage**, but it is not yet an Eve runtime feature or a measured overall cost comparison.

**Updated user decision:** the existing visible, browser-backed GPT Chat worker adapter remains the **default auditable lane**. A Prime-owned native ChatGPT Work/subagent adapter is **explicit opt-in experimental**, initially for bounded read-only tasks with parent-mediated reports and a visible warning that independent child tool receipts/permissions are unavailable. It must not be silently selected for local/tool work. Selecting one adapter must not migrate or replay existing jobs. No automatic model change or separately billed API fallback. ChatGPT's internal native collaboration mechanism is not documented as an externally callable Eve API; the plan-backed Codex app-server candidate is distinct.

Required before choosing a tabless adapter:

1. Document actual OpenAI plan-sharing entitlement, model and reasoning picker behavior, limits, errors and independent auth. Normal Agents/Responses API multi-agent requests are billed, while the ChatGPT plan-sharing preview rejects top-level multi_agent; OpenAI's documented Codex app-server can orchestrate local child agents using function/custom tools. The latter is a **candidate**, not a proven Eve implementation.
2. Bind child agent ID to an exact Prime/run and Eve capability principal. If tool provenance cannot be independently verified, fail closed on worker-only mutations or report as Prime-mediated rather than lying about worker identity.
3. For a future independently auditable child runtime, record each child assignment, user-selected model/effort, tool call/result/denial, receipts, report, cancellation, usage and error in the **Eve activity** timeline, respecting local recording opt-out. The current native experimental lane may show only Prime-reported assignment/status/results; it must label missing child-level tools/usage as unavailable, not infer them from the parent summary.
4. Adversarially test simultaneous read calls, denied writes, cancellation, interrupted streams, no-entitlement, limit exhaustion and an app restart while a child is active. Zero duplicated side effects or schedule/Plan acknowledgments.
5. Measure actual Windows tab/renderer process RAM and CPU against four browser-backed workers on comparable tasks; record latency, budget/usage and quality without assuming the in-run mechanism is unlimited or free of provider prompts.

**Wave-2 exact identity finding (corrected after Prime cross-check):** A native child audit agent's read-only Eve work_context returned callerIdentity proven and exact_companion, but its conversationId `6adfb0ac-f910-83eb-8f91-7790572d3fad` and sessionId `2026-10-15-88246b67` were **identical** to a fresh Prime work_context call and to the parent's visible ChatGPT URL. The child's separate collaboration identity was **not** present in the Eve response. Eve agents.ts:282-291,793-801,997-1019 maps callers to Prime, registered worker conversations or broker-issued local principals; mcp/work-context.ts:21-38,73-93 has no subagent-parent fields. Current kernel/recorder effect receipts distinguish chatgpt from local-agent principals, not in-conversation subagent lineage (mcp/kernel.ts:803-832; session/recorder.ts:1270-1380). Thus the current connector attributes these subagent Eve tool calls to the **Prime conversation**, not a separately admitted Eve worker. A broker-owned signed admission/capability binding and independently verified tool-event mapping are blockers for separate worker permissions; until then label activity Prime-mediated and deny worker-only side effects. This is source/live-read evidence, not a production Work runtime acceptance.

References: https://developers.openai.com/api/docs/guides/agents-api/multi-agent ; https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server ; https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations .

## Proposed phased copy-best-bits plan

This is a proposal, not an implementation authorization or candidate release. IDs map to the ledger.

| Phase | Candidate slices | Dependency and proof gate |
| --- | --- | --- |
| 0 — Complete audits | Four-at-a-time waves 2–5, exact feature card inventory | All five pillars have tests/owner mapping; resolve unknowns and disagreements. No source ports yet. |
| 1 — Reduce stalls / protect data | A07 factual connector instructions; D01 secrets shield; C02 durable drafts; D15 bounded worker/tab diagnostics | Reproduce approval symptom, prove user guidance preserved, output masks only secrets, draft isolated through restart; measure resources and approvals with privacy-safe output. |
| 2 — Broker quality | B02 optional global cap; B03 isolated worktrees; targeted B04 profile fences | Staged atomic admission and approved roots, broker v6 migration protection, no lost jobs/Plans. |
| 3 — User control and retention | A06 human approval view; C03 Goal-completion review; D02 settings backup | Prime/human-only approvals, revision checked human review, import preview never rewrites durable personal data. |
| 4 — Model/Work execution architecture | B08 + B09 GPT Work and tabless worker evaluation; A05 stale model resolution | Select exact account model in UI; subscription-only entitlement; durable child audit; no billed fallback or automatic switch. |
| 5 — Selected UX improvements | D04 accessibility, D05 code Save/Wrap, D03 Git guarded commit, C04 brief choices | User-tested, localized settings, file broker/root and draft protection, no broad UI overwrite. |
| 6 — Conditional browser and peripheral choices | A01 Firefox; A08 background leases; C06 browser worker archive; D08 notifications | Separate quantified user need and browser safety/design decision; no automatic active-chat Stop/reload/focus. |

Within a phase, candidates are separately checkpointed PR-sized changes. Order can change with verified severity and user priorities; scope and risk never auto-expand from a source comparison.

## Required acceptance ledger for every future candidate

- Exact source line and upstream author/commit; code/asset license and notices.
- Current Eve behavior and protected-pillar contracts.
- Reproducer and negative test that fails before port.
- Small owner-centered change; no duplicated state authority.
- Neighboring tests, typecheck, lint/diff check, and full subsystem gates when implementation begins.
- For source/broker/extension changes, app+extension protocol tests plus installed live dogfood only if separately authorized.
- Artifact provenance: branch/HEAD, candidate number, clean or dirty build manifest, hashes, installed-byte match, live result.
- Honest state: researched / specified / implemented / source-tested / packaged / installed / live accepted; never collapse these.
- Rollback/kill switch that preserves old records and pending work without ambiguous replay.

## Wave 2 and remaining completeness debt

The first comparison crossed major owners but **did not complete exhaustive component-level inventory**. The second four-worker wave completed these focused read-only lanes:

1. Eve-specific pillars end-to-end (Plans, Schedule, archive/memory and first-run preservation).
2. Exact tool/secret/identity boundary (including provider approval wording and traceability of tabless subagents).
3. UI/settings/language/onboarding migration, a11y and field round-trip.
4. Files/Git/file-provider installation, browser/process lifecycle and packaging.

Wave 2 returned all four reports; their source-level findings and gaps are recorded below. Next run wave 3 protected-pillar integration and wave 4 adversarial acceptance design as specified in the companion spec. Split remaining large categories again rather than declaring them covered by a filename search. At most four parallel audit agents per wave; Prime reconciles and keeps all findings in this local document.

### Wave-2 protected-pillar and settings results (read-only source evidence)

- **Pillars:** CoS's agent-plan.ts is a session checklist, not Eve's revision/provenance-governed Plan. CoS worker-archive.ts archives the provider's chat, not Eve's append-only evidence. No CoS equivalent was found for Evecron occurrence identity, the File Broker's file_action/file_edit capability, or Pins/Quilts. Strong Eve regression suites already exist: plans-review-reconciliation.test.ts, plan-tool-authority.test.ts, schedule-acceptance-main.test.ts, evecron-execution.test.ts, archive-store.test.ts, archive-reboot-offline-acceptance.test.ts, file-provider-broker.test.ts and renderer-i18n.test.ts. These tests were inspected, **not rerun** in this audit.
- **Cross-pillar fixture missing:** For each selected port, seed a human Plan and a worker Plan, outstanding Evecron occurrence, previously archived offline assets, Pins/Quilts, a refused file-provider installation and Swedish/es-419 guided setup state. Exercise worker completion, restart, settings import and denied action, then assert no changes to canonical old records except explicitly authorized receipts, no false Plan/Evecron acknowledgment, no changed model/reasoning/tool permissions and no loss of archive opt-out.
- **Settings and drafts:** CoS persistent composer text is bounded to 100 keys / 1M characters with debounce and unload flush (renderer/composer-drafts.ts). Eve's chat.ts drafts remain in-memory. Searchable settings (D13) and optional accessibility are independently attractive, but must preserve disabled/hidden controls, focus and translation across Eve panels. CoS settings-backup.ts adds permission-widening previews, stale-revision refusal and optional passphrase encryption; only adapt a field-by-field Eve import that excludes host identity, Plans, Schedule, receipts, archive, provider registrations and user-selected models unless individually authorized.
- **Localization veto:** CoS's setup-guide.ts broad provider permission language is unsuitable for Eve's Prime/human-only approval policy. Its locale breadth does not replace Eve's en/sv-SE/es-419 parity tests and six-step setup. New worker Work-lane admission, limits, denial, cancellation and audit states need translations, not fallback English-only cards.
- **File broker scope:** Eve's current file-capabilities.ts:141-164 has a bounded built-in provider registry; its user-authorized, checksum-verified installation workflow is valuable but does not yet mean arbitrary external app discovery. Any expansion of the registry needs signed or canonical provenance, human-reviewed provider identity/permission, rollback and revocation. Add negative tests for symlink/junction parent substitution between root check and edit/publish, interrupted installation and stale consent; never treat a model's proposed app as sufficient install authority.
- **Measured tab cost:** Eve browser.ts:12-25 explicitly documents an extra CPU/RAM tradeoff for dedicated Chrome and disables several background renderer throttles to preserve worker liveness. The attached screenshot shows four in-ChatGPT subagents in one parent browser tab, rather than four extra Eve worker browser tabs. Those facts motivate the tabless benchmark but do **not** quantify savings or prove the Eve broker has per-child audit. CoS's diagnostic-report.ts:76-113 offers a source pattern for per-process memory reporting; compare idle/busy private bytes, CPU, time-to-completion and blocked provider approvals in installed Windows before selecting a default.

## No-port and unresolved decisions

- Do not port CoS browser engine or its ordinary-link behavior over Eve's dedicated Eve Browser.
- Do not port CoS bookmark/group UI as a replacement for Pins/Threads/Quilts, or CoS agent plans as a replacement for Eve Plans.
- Do not use CoS native worker-chat archive as Eve local archive; it is a separate opt-in browser presentation behavior.
- Do not autoanswer ChatGPT provider cards, bypass human approvals or turn on an additional Computer Use permission gate.
- Do not use separately billed API keys to satisfy GPT Work, and do not promise ChatGPT Plus is unlimited.
- Do not apply CoS's stale-model fallback if it changes a user-selected model or reasoning silently.
- Do not port the experimental Stop-based turn rotation without explicit safety acceptance.
- Do not modify the user's unrelated OpenClaw update, background worker state or persisted schedules during an audit.

## Next evidence checkpoint

The first two four-worker source-comparison waves are complete, with each of the eight reports now itemized in the companion evidence appendix and the five protected Eve pillars retained. The native subagent identity gap is source-supported; official docs establish GPT-6 Luna and GPT-6.1 Terra as ChatGPT Work options, but their appearance in the specific c17 account picker and a completed inference are not independently verified. Account/plan transport is a candidate, not native collaboration API access. Remaining work is cross-pillar integration, adversarial acceptance design and a separately authorized live worker/resource benchmark. Existing c17 remains installed and unmodified; proposed improvements have not passed Eve runtime acceptance.
