# ParadigmEve 2.3.1 black-box test checklist

**Owners:** Eve (Computer Use, real UI) · Claude (code, automation, fixes) · the user (decisions, release)
**Source:** Eve's 2.3.1 black-box test plan, turned into a shared checklist · **Written:** 2026-09-28

The release question: can Eve reliably start, observe, act, delegate, finish, recover, and stay attached to the right
ChatGPT conversation and project in normal use? 2.3.1 is not promoted from dogfood until every applicable gate
below is green on the installed build.

**Division of work.** Eve tests the experience; Claude tests the implementation around whatever Eve proves
fragile. A synthetic test that passes never closes a failed real-user flow.

## How to use this file

- Tick a box only when it is done **on the current candidate** (see the Candidate log). Put evidence after it: a
  commit, a test name, a screenshot or log path, or a one-line result.
- Mark items as `[x]` done, `[ ]` open, `[~]` in progress, `[-]` not applicable or deferred, with the reason.
- A failure becomes a row in the Bug log, not an unticked box with a comment.
- After a candidate rebuild:
  - untick the Core smoke set and the phases the fix touched;
  - leave everything else ticked.

## Status board

| Phase | Eve (real UI) | Claude (automation) | Gate |
| --- | --- | --- | --- |
| 0 Freeze candidate | — | Done | Green (`ae4be915`) |
| 1 Install & startup | Open | Open | Open |
| 2 Turn lifecycle / Goal / finish | Open | Done for ported fixes | Open |
| 3 Composer & attachments | Open | Done for ported fixes | Open |
| 4 Chat & Project identity | Open | Partly done | Open |
| 5 Workers & completion | Open | Open | Open |
| 6 Model behavior | Open | Done for ported fixes | Open |
| 7 Writing blocks | Open | Done | Open |
| 8 Safety refusal & recovery | Open | Done for ported fixes | Open |
| 9 Tab lifecycle | Open | Blocked on decision | Open |
| 10 Localization & onboarding | Blocked on i18n phase | Blocked on i18n phase | Open |
| 11 Long-running dogfood | Open | Open | Open |
| Final release gate | — | — | Open |

## Decisions from the user

- [x] **First candidate scope:** priority 1 (ChatGPT page fixes) plus priority 2 (Goal/Loop) only. Localization,
  Usage, avatar and Workspace docks come in later candidates; Phase 10 waits until localization lands.
- [x] **Eve closing a prime tab:** Eve tidying away her own tab must not mean the user ended the run. Keep the
  current behavior documented as a known gap until the distinction is implemented and tested.
- [x] **ChatGPT alternate "app shell" layout:** leave it as a known gap for 2.3.1 until an account or trusted
  captured fixture exposes that layout well enough for real black-box validation.

---

## Phase 0 — Freeze the candidate

**Claude**

- [x] Priority 1 ChatGPT page fixes ported — commit `59aed60`, full suite 5,177 passed.
- [x] Priority 2 Goal/Loop ports, in the candidate commit (see Candidate log):
  - [x] Goal helper sees per-turn tool-call counts — `test/goal.test.ts` "tells the helper how many Eve tool calls
    a turn made".
  - [x] Finish no longer held forever after tool-only work (upstream #558) — `test/session-finish.test.ts` "decides
    again after a delivered continuation was worked through with tools only".
  - [x] Goal/Loop keep working when the saved helper model is gone (upstream `b384512`, `ebea1da`) —
    `test/goal-helper-model.test.ts`. GPT-5.6 Sol keeps its shipped handle.
  - [x] A saved worker default the account does not offer is dropped with a note; explicit requests stay strict
    (`dc0c7e2`) — `test/agents.test.ts`. `2c96b01` does not apply: ParadigmEve's agent panel does not read
    `selectedModel`.
  - [x] Goal helper chats stay out of the chat list (`570150a`) — `test/content-script.test.ts` "does not correlate
    requests from a Goal helper temporary chat". The Fiber half of `6b5558f` has no ParadigmEve counterpart.
  - [x] Helper tabs close after ChatGPT moves them (`fe507c6`) — `test/desktop-input-maintenance.test.ts` "closes a
    finished planner that ChatGPT moved…" and "never closes an ordinary chat…".
  - [x] Transient safety refusal retried once; finish tool offered to any model (`9d6f654`) —
    `test/mcp-user-instructions.test.ts`.
- [-] No further ports: the user set the first candidate to priorities 1 and 2 only.
- [x] On `ae4be915`: full suite 5,191 passed (plus `computer` 20 and `mcp-shutdown` 2), `npm run typecheck`,
  `npm run verify:privacy` and `npm run verify:notices` pass. This head includes the reproduced Compact & Resume
  provider-id race fix, deterministic owned Windows capture fixture, and CI-sized timeout adjustments.
- [x] Candidate commit recorded in the Candidate log.
- [x] Windows x64 debug installer built from that exact commit into
  `ParadigmEve-installers\2.3.1\c2\ParadigmEve-2.3.1-windows-x64-debug.exe`, with `.sha`, `.blockmap`, and
  `COMMIT.txt`; c1 remains preserved separately.

**Gate:** candidate frozen. The branch changes only to fix a confirmed failure. No tag or publish is part of this plan.

## Candidate promotion ladder

Every 2.3.1 candidate moves through these environments in order. Do not risk Eve's main installed copy until the
candidate has passed the cheaper and more isolated layers first.

1. **Claude automated tests — code-level gate.** Claude finishes the agreed candidate scope, runs the full automated
   suite and release checks, and fixes deterministic failures before any real install is promoted.
2. **%docker clean-room smoke — basic-integrity gate.** ParadigmEve 2.3.0 Eve remains the trusted host/orchestrator
   while the exact 2.3.1 candidate runs in a disposable Docker environment. Use this lane for startup, configuration,
   state/migration behavior, MCP/tool plumbing, Goal/Loop logic, worker/report semantics, persistence and obvious
   crashes. A basic failure here is fixed before either Windows install is touched. Docker is an additional test lane,
   not a substitute for Windows/native desktop testing.
3. **Eva Windows candidate — first native Windows gate.** Install the packaged candidate on Eva before Eve. Exercise
   the real Electron/browser path, native Windows behavior, restart/update behavior, ChatGPT interaction, input and
   capture. Eva is the first real Windows victim so a bad candidate does not break Eve's trusted 2.3.0 environment.
4. **Eve Windows upgrade/dogfood — final real-user gate.** Only after Claude, %docker and Eva are green, install the
   candidate over Eve's main copy and run the applicable black-box phases plus long-running dogfood.
5. **User release decision.** Tag/publish/latest promotion happens only after the user explicitly decides to release.

Failure localization is part of the value of this ladder:

- Docker failure usually points to portable application/state logic or candidate packaging assumptions.
- Docker green + Eva failure points toward Windows/native packaging, Electron or desktop/browser integration.
- Docker + Eva green + Eve-only failure points toward upgrade/migration or accumulated real-user state.

**Gate:** a candidate advances only when the previous layer is green. A fix creates a new candidate and follows the
same ladder again, while only the Core smoke set and phases touched by the fix are re-opened per the checklist rules.

## Phase 1 — Installation and startup smoke

**Eve**, from the packaged installer only, never the development tree:

- [ ] Install over the current 2.3.0 dogfood build.
- [ ] App starts normally.
- [ ] Settings survive the upgrade.
- [ ] Threads, Quilts, Pins, Plans, archive, schedules and project mappings are all still visible.
- [ ] Companion reconnects. After the upgrade from 2.3.0 it should reload itself once no chat is busy, with no
  visit to the Extensions page.
- [ ] Existing ChatGPT tabs stay usable, and no duplicate ChatGPT tabs open.
- [ ] Eve identifies the current conversation.
- [ ] Restart ParadigmEve: Eve resumes without stealing focus or corrupting the current draft.
- [ ] Restart the ChatGPT/browser connection: same.

**Claude**

- [x] Packaging smoke on `b19ab11`: resources and native runtimes verified for 2.3.1, 16 Vault pages verified inside
  the NSIS installer.
- [x] Version agreement (package, lock, manifest, `APP_VERSION`) — `test/packaging.test.ts` on `b19ab11`.
- [ ] Migration check and log scan after Eve's install run.

**Gate:** no startup crash, migration loss, duplicated state or broken reconnect.

## Phase 2 — Core turn lifecycle (highest risk)

**Eve** runs each case in a real conversation:

- [ ] Plain text question.
- [ ] One tool call.
- [ ] Several tool calls.
- [ ] Tool-only work with no prose in between.
- [ ] Worker delegation.
- [ ] Delayed worker result.
- [ ] Failed tool call, then recovery.
- [ ] User interrupts midway.
- [ ] User sends again immediately after Eve finishes.
- [ ] User sends again while Eve is still working.

For every case above, check:

- [ ] The new message starts a new turn.
- [ ] The previous answer does not close the new turn.
- [ ] Eve does not redo completed work.
- [ ] Goal does not repeat the same request.
- [ ] `session_finish` is never held forever.
- [ ] Eve does not finish before pending worker results arrive.
- [ ] Eve does not claim delegated work is complete while review is pending.
- [ ] The next message after finishing starts cleanly.
- [ ] Repeat the three riskiest cases (Eve picks them) at least three times each.

**Claude**, with deterministic fixtures:

- [x] Goal context hashing and per-turn tool counts — `test/goal.test.ts` "tells the helper how many Eve tool calls
  a turn made".
- [x] Tool-only turn regression (#558) — `test/session-finish.test.ts`.
- [x] Repeated finish decisions and hold calls not counted as work — same #558 test, plus the existing "ignores its
  own empty wait output but reconsiders real tool results and delivered app input".
- [ ] Pending-worker completion cases.
- [x] Safety-refusal retry instruction — `test/mcp-user-instructions.test.ts`.
- [x] Saved-model fallback — `test/goal-helper-model.test.ts`, `test/agents.test.ts`.
- [x] Finish offered to any model — `test/mcp-user-instructions.test.ts` (no "Astra only" wording).
- [ ] Malformed or interrupted event sequences.
- [x] Previous answer remounted above the question does not close the new turn — `test/content-script.test.ts`
  "does not close a new turn with the previous answer remounted above its question" (`59aed60`).

**Gate:** no stuck turn, premature finish, duplicate finish, repeated Goal work or wrong turn association.

## Phase 3 — Composer, attachments and send

**Eve**, on the real ChatGPT page:

- [ ] Plain text.
- [ ] One image.
- [ ] Several images.
- [ ] A normal file.
- [ ] Text + image.
- [ ] Text + file.
- [ ] Replace or remove an attachment before sending.
- [ ] Another message immediately after.
- [ ] All of the above in a normal chat.
- [ ] Repeat in a ChatGPT Project.
- [ ] After the Companion reloads or re-injects its page code.

For every send, check:

- [ ] The attachment appears in the composer.
- [ ] The right files are sent.
- [ ] Nothing stale leaks into the next turn.
- [ ] The send is recorded exactly once.
- [ ] The response belongs to the right turn.
- [ ] No send is marked complete immediately.
- [ ] No old answer is mistaken for the new one.

**Claude**

- [x] New composer upload selectors and the image tile receipt — `test/chatgpt-dom-input.test.ts` (4 ported tests,
  `59aed60`).
- [x] Recorder replacement stops send capture — `test/content-script.test.ts` "retires native send capture…"
  (`59aed60`).
- [x] Section-position logic — see Phase 2.
- [ ] Send/answer matching and cleanup between turns, for any failure Eve finds.

**Gate:** ten consecutive mixed text/attachment sends with nothing missed, duplicated, stale or wrongly finished.

## Phase 4 — Chat and Project identity

**Eve**

ChatGPT → Eve:

- [ ] A normal chat created on chatgpt.com shows up in Eve.
- [ ] A chat created inside a ChatGPT Project shows up in Eve under the right project.

Eve → ChatGPT:

- [ ] A normal chat started from Eve appears in the right place on chatgpt.com.
- [ ] A chat started from an Eve project appears in the linked ChatGPT Project.
- [ ] Mapping survives a refresh and an app restart.

Also:

- [ ] The title comes from the actual request.
- [ ] No "ChatGPT - <project>" titles.
- [ ] Switching between two projects.
- [ ] Moving between existing tabs.
- [ ] Archive, then restore.
- [ ] Nothing maps to an adjacent chat.

**Claude**

- [x] Title from the request; stored instruction titles repaired; project page titles ignored — `test/session.test.ts`,
  `test/content-script.test.ts` (`59aed60`).
- [ ] For each Eve failure: inspect the persisted mapping and add a regression test at the earliest wrong transition.
- [ ] Repeatable cases for browser conversation id, Eve session id, project id, title, reload/restore, and
  app-created vs site-created chats.

**Gate:** mapping works both ways repeatedly without manual repair.

## Phase 5 — Workers and completion

**Eve**

- [ ] One worker.
- [ ] Several workers in parallel.
- [ ] A quick worker.
- [ ] A slow worker.
- [ ] A worker that fails.
- [ ] A worker that finishes after Prime's own work.
- [ ] Sleeping worker reused.
- [ ] New worker spawned.
- [ ] User message while workers are active.

Verify:

- [ ] Reports land in the right Prime.
- [ ] Pending reports are collected once.
- [ ] No claim that checks passed before the results were seen.
- [ ] The final answer reflects each worker outcome.
- [ ] No duplicate reports.
- [ ] No report attached to the next user turn.
- [ ] Finish waits only when it should.
- [ ] Prime stays the owner.

**Claude**

- [x] Prime instruction: collect pending reports once and say review is pending — `src/main/mcp/instructions.ts`
  (`59aed60`).
- [ ] Stress tests:
  - [ ] report arrival order;
  - [ ] late reports;
  - [ ] duplicate delivery;
  - [ ] sleep and revive;
  - [ ] finish with pending reports;
  - [ ] worker error paths.

**Gate:** a real multi-worker run completes correctly three times in a row.

## Phase 6 — Model behavior

**Eve**, where available:

- [ ] ChatGPT default model.
- [ ] Eve's GPT-5.6 Sol configuration.
- [ ] Free/Luna path on Eva, if convenient.
- [ ] One external or worker runtime, if it is in the candidate.

For each: a new conversation, an existing one, the saved model restored after restart, an unavailable saved model,
a model change mid-session, and Goal/finish after the switch.

- [ ] No silent fallback to an invalid model.
- [ ] No model-specific inability to finish.

**Claude**

- [x] Fallback permutations and unavailable-model cases — `test/goal-helper-model.test.ts` (offered, retired model,
  missing reasoning level, Sol handle, unobserved catalog, progress label) and `test/agents.test.ts`.

**Gate:** restoring or falling back never traps a conversation or silently corrupts state.

## Phase 7 — Writing blocks and rich responses

**Eve** generates each of these, then immediately sends another message:

- [ ] Normal prose.
- [ ] Headings.
- [ ] Code blocks.
- [ ] A `:::writing` email.
- [ ] A `:::writing` document.
- [ ] Several sections around a writing block.
- [ ] Tool activity before the writing block.

Verify:

- [ ] Each writing block shows as a titled quote.
- [ ] Surrounding text is intact.
- [ ] The next turn is detected normally.

**Claude**

- [x] Parser coverage: titled quote, inner Markdown, escaped title, unterminated directive left as text —
  `test/renderer-html.test.ts` (`59aed60`).
- [ ] Add fixtures for any arrangement Eve finds broken.

**Gate:** rich responses break neither rendering nor completion detection.

## Phase 8 — Safety refusal and recovery

**Eve**, with benign permission-disabled scenarios rather than unsafe prompts:

- [ ] Cause a refusal or unavailable action, then continue with a valid alternative.
- [ ] Eve does not loop on the refusal.
- [ ] Goal reconsiders after the state changes.
- [ ] The conversation still finishes normally.
- [ ] The next turn is unaffected.

**Claude**

- [x] Transient-refusal instruction ported (`9d6f654`) — `test/mcp-user-instructions.test.ts`.
- [ ] Refusal fixtures for any loop Eve finds in real use.

**Gate:** a refusal is a recoverable state, not a loop.

## Phase 9 — Tab lifecycle

**Eve** records what happens to the run in each case, without redefining desired behavior:

- [ ] User closes a Prime tab.
- [ ] User closes a worker tab.
- [ ] Eve switches away from a tab.
- [ ] Eve tidies or closes a tab, if the current build does.
- [ ] The browser closes unexpectedly.
- [ ] The browser restarts.

**Claude**

- [-] No tests for Eve-closing-a-prime-tab until the user decides the semantics (see Decisions).

**Gate:** user-close behavior is correct. Eve-close behavior may stay a documented 2.3.1 known gap.

## Phase 10 — Localization and onboarding (after the i18n phase lands)

**Eve** spot-checks English, Swedish, German and Portuguese, focusing on:

- [ ] Setup.
- [ ] Permissions.
- [ ] ChatGPT app setup (Plugins → Add → Create MCP App; Developer mode only as the older-ChatGPT fallback).
- [ ] Errors.
- [ ] Important action buttons.

Look for broken labels, missing keys, overflow, misleading steps, or mixed languages in a critical flow.

**Claude**

- [x] English and Swedish setup/health wording for Create MCP App — `59aed60`.
- [ ] Catalog checks:
  - [ ] missing keys;
  - [ ] stale keys;
  - [ ] placeholder mismatches;
  - [ ] untranslated strings;
  - [ ] formatting variables;
  - [ ] duplicate keys.
- [ ] Hand Eve the German/Portuguese review task file once the catalogs exist.

**Gate:** no functional UI broken by localization.

## Phase 11 — Long-running dogfood

**Eve** does one real multi-step ParadigmEve task that includes:

- [ ] An existing conversation.
- [ ] Computer Use.
- [ ] At least one file or image.
- [ ] One or more workers.
- [ ] A project-associated chat, if possible.
- [ ] An interruption or follow-up.
- [ ] A restart or reconnect during the run.

**Claude**

- [ ] Review the logs afterwards and investigate anomalies, without guiding Eve during the task.

**Gate:** no unexplained state repair or manual intervention in ordinary use.

---

## Core smoke set (rerun after every candidate rebuild)

- [ ] App starts and reconnects.
- [ ] One plain ChatGPT turn.
- [ ] One tool-using turn.
- [ ] One attachment turn.
- [ ] One worker turn.
- [ ] One ChatGPT Project mapping round-trip.
- [ ] One restart/resume.
- [ ] One Goal/finish path.

If a fix touches any of these areas, expand testing to that whole phase.

## Final release gate (all required)

- [ ] Full automated suite passes on the exact candidate commit.
- [ ] Packaging and install tests pass.
- [ ] Every applicable phase above is green.
- [ ] Deferred behavior is listed under Known gaps, not left untested by accident.
- [ ] No known high-severity regression remains.
- [ ] The installed candidate survives a realistic dogfood session.
- [ ] Tag and publish wait for the user's explicit release decision.

## Candidate log

| Candidate | Commit | Installer SHA-256 | Built by | Date | Notes |
| --- | --- | --- | --- | --- | --- |
| 2.3.1-c1 | `b19ab11` | `546129c30f2e155ffd793004b40558ceb8e1b9d8aa6c8fe8c5b833776b2f42a3` | Claude | 2026-09-28 | Priorities 1 and 2. Later commits that touch only this checklist do not change the candidate. |
| 2.3.1-c2 | `ae4be915` | `f0732069bcf6498aec70583ce447bbd357334c0172fa8be88bdf1cccce08daf7` | Eve | 2026-09-28 | Rebuild after the Compact & Resume race fix, deterministic Windows WGC fixture, and fresh CI-timeout fixes. Exact head passed `npm run verify`; packaged runtime and NSIS Vault smoke passed. |

## Bug log

Eve preserves the exact user-visible repro and evidence, then hands it to Claude. Claude diagnoses, patches and adds
the cheapest deterministic regression test, and a new candidate is built. Eve reruns the original repro first, then
the affected phase, then the Core smoke set. A bug closes only when the original real-UI repro passes.

| # | Phase | Found by | Repro and evidence | Fix commit and test | Candidate | Eve re-verified |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | — |

## Known gaps (explicitly deferred, not untested)

- ChatGPT alternate "app shell" layout and image-only answer completion (AGENTS.md §21).
- Eve closing a prime tab ends its run like a user close (AGENTS.md §21). The user decided Eve's own tidying must not
  count as the user ending the run; it stays a known gap until that distinction is implemented and tested.
