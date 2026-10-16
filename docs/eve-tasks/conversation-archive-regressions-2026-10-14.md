# Conversation logging / archive regressions — 2026-10-14

Status: confirmed investigation notes. No production fix is included in this document.

## Scope

This note records two related regressions observed while self-testing the installed ParadigmEve 2.4.0 development build:

1. ChatGPT can visibly finish an assistant reply while the Eve recorder never commits the corresponding canonical `assistant_message`, so Eve later marks the turn interrupted and cannot present that reply.
2. The rebuildable archive can remain behind the canonical session transcript when projection stops at a mutable frontier row and no later retry reaches the stable rows behind it.

The checks below were performed read-only against the installed ParadigmEve AppData and the current `release/2.4.0` source. Browser tabs were observed only; no ChatGPT tab was reloaded, navigated, closed, retargeted, or focused away from the user's active work.

## Issue A — ChatGPT final reply visible, but no canonical assistant row in Eve

### Confirmed current conversation

- Session: `2026-10-12-18b48655`
- Current ChatGPT conversation: `6acf0357-6008-83ed-bfbc-5b4f22522af5`
- User message: `05b65cf1-ee91-4328-bff8-abf680c1f0f5`
- User message seq/time: `5305`, `2026-10-14T04:28:06.346Z`
- Request: `ok can you clean up and archive our plans that are done?`

ChatGPT.com visibly contained the completed assistant reply beginning with the plan-cleanup result and ending with the verification summary (`f37889ae...`, the single non-reproducing Ollama Skills test, and no push/tag/merge/build/install/publish). The same browser observation also showed the next user message below that completed reply.

The Eve canonical message store does **not** contain an `assistant_message` between user seq `5305` and the next user message seq `5336` (`c8fb1eca-2a58-44fa-b3d9-e3dc3f5e16c1`). The raw lifecycle journal instead ends the older turn at seq `5337` as:

`outcome: interrupted`, detail: `a new user message replaced the unfinished turn`.

This is therefore upstream of archive HTML rendering: the reply never became a canonical assistant-message shard at all. Eve's current UI observation likewise did not show that reply while the ChatGPT page did.

### Earlier October 14 same-signature case

- User message: `afa846c1-40a7-4c18-a846-31197d4e9ca7`
- Seq/time: `4076`, `2026-10-14T00:51:39.763Z`
- Request: try GPU transcription on ~20 seconds of Stereo Mix audio.
- Turn start: seq `4077`, `g-1tahju455b98y-0-2`
- Next user message: `3548921d-a602-44a6-b059-b9cb86109a9d` at seq `4090`: `ok thanks for being honest...`
- Recorder turn end: seq `4091`, `interrupted`, same `a new user message replaced the unfinished turn` detail.
- Canonical transcript: no assistant-message shard between seq `4076` and `4090`.

The next user message strongly indicates an assistant response was visible, but this older ChatGPT segment was not navigated to during the audit because active-tab preservation is a hard safety rule. Treat this as a high-confidence second occurrence, not as the same level of direct browser proof as the plan-cleanup case.

### Likely recorder surface

The failure signature is in the browser-recorder/finalization path rather than the archive projector:

- `extension/content.js` emits the fallback interrupted boundary (`a new user message replaced the unfinished turn`).
- assistant final detection and `assistant_message` emission live in the same extension recorder path.
- `src/main/bridge.ts` persists assistant observations only after the extension sends them.

A fix should prove this sequence explicitly: ChatGPT final becomes visible -> canonical final assistant row is durably committed -> only then may a later user message close/start the next turn. A later user message must not downgrade an already-visible final into `interrupted` merely because the final observation was missed/delayed.

## Issue B — Archive projection can stop before stable tail messages

An independent worker audit plus Prime-level raw AppData reconciliation compared canonical `sessions/<id>/messages/*.json` evidence with `archive/sessions/<id>/events.jsonl` for all `2026-10-13-*` sessions.

### Settled, confirmed stale archive: worker-3

- Session: `2026-10-13-cd51e516`
- Conversation: `6acda309-2c00-83ed-8d54-078ecf02e67d`
- Canonical transcript: 28 messages (10 user / 18 assistant)
- Archive transcript: 24 messages (10 user / 14 assistant)
- Session meta events: 236
- Archive manifest `eventCount`: 204
- Archive `captureState`: `partial`
- Archive was last updated at `2026-10-13T23:26:45.595Z`, after the missing final reply existed canonically.

Missing assistant rows:

| Seq | Message id | State | Approx chars |
| ---: | --- | --- | ---: |
| 371 | `62066d95-29d6-4ece-b648-392391b46260` | streaming | 264 |
| 372 | `df795ccc-e657-48d8-a687-7770b86f4474` | streaming | 429 |
| 373 | `bd6c6edd-9fb0-41c8-81c1-a2b614b4d3b8` | streaming | 277 |
| 374 | `67d2fffd-02de-4acf-88a6-f6f102196201` | final | 1315 |

The omitted final begins `## C1 independent integration QA — complete` and contains the worker's completed QA result. This is not a live-tail timing artifact; the session had ended and the archive still stopped before these rows.

### Other October 13 session-id audits

`2026-10-13-b0e8e7d6` / conversation `6aceab5a-c748-83eb-a539-e7df12f4b7cc`:

- canonical 14 messages (5 user / 9 assistant)
- archive 12 (5 user / 7 assistant)
- missing assistant seq `194` (`37a4bd22-f638-49dd-9c64-466b3eff08aa`, streaming) and seq `195` (`1ff9c5b7-9142-4b47-b85a-e37325ebbd5b`, final)
- session is currently active, so this one may include ordinary current-tail timing in addition to the underlying frontier behavior.

`2026-10-13-ef0b48e5` / conversation `6aceab59-eaf8-83ed-a8bb-18b94011f069`:

- canonical 20 messages (7 user / 13 assistant)
- archive 17 (6 user / 11 assistant)
- missing user seq `168` (`1f504f41-9139-437c-9a3d-8837a8d41857`), assistant seq `203` streaming (`ea40b522-5fe9-4882-a086-716ee31207eb`), and assistant seq `204` final (`69ba416e-f8da-4b8a-8224-23ba54f98591`)
- session is currently active; treat the missing tail as a live example of the same retry/frontier concern, not proof that every active archive must be synchronous.

`2026-10-13-4944061a` / conversation `6acdaa08-43c8-83eb-8227-0de83e82f31e`:

- canonical/archive message parity: 14/14 (8 user / 6 assistant)
- no missing message ids, no duplicate ids, no truncation mismatch
- one same-id immutable text revision differs: canonical first user message retains Markdown backticks while the archive kept the earlier text without them.

`2026-10-13-a0ffc855`:

- unattributed activity, no conversation id
- zero canonical user/assistant transcript rows and zero archived user/assistant rows
- no transcript omission to report.

Across the October 13 audit there were no duplicate canonical/archive message ids and no truncation-flag mismatches.

## Likely archive mechanism

Relevant code: `src/main/archive/archive-runtime.ts`.

`knownMutableEvent()` intentionally classifies:

- a non-final assistant row as mutable;
- a fresh extension-authored user row without its app `inputId` receipt as mutable for `PAGE_USER_RECEIPT_GRACE_MS` (90 seconds).

`projectCurrentSession()` marks the projection partial and **breaks** when the current frontier row is mutable (except for a historical interrupted assistant before a later user message). That protects append-only archive evidence from publishing a provisional row too early, but it also blocks every stable row behind that frontier.

This becomes a correctness bug when no later source commit/reconcile is guaranteed after the provisional condition resolves. The worker-3 archive demonstrates the settled form: the archive ends at the final turn's start and never reaches four canonical assistant rows behind it, including the stable final.

The fresh-user grace path has the same structural risk: projection may break for up to 90 seconds, but the archive runtime does not schedule a retry specifically for grace expiry.

There is a separate expected/known behavior for same-id canonical revisions: once an archive event is published, `projectCurrentSession()` preserves the immutable archived bytes and marks the session partial rather than rewriting evidence. That explains the two text-revision mismatches but not the missing-message tails.

## Required regression coverage before a fix is accepted

1. Browser recorder: a final assistant answer visible before the next user message must be durably recorded even if final observation and turn-end signals race or arrive in separate batches.
2. Browser recorder: a later user message must not turn a previously completed visible answer into an interrupted/no-assistant transcript.
3. Archive projector: streaming assistant row followed by a distinct stable final row, with no subsequent source commit, must eventually publish the final row without rewriting provisional evidence.
4. Archive projector: a fresh extension user row held for `PAGE_USER_RECEIPT_GRACE_MS` must receive a guaranteed reconcile after grace expiry even if no new event arrives.
5. Settled-session acceptance: after a worker/session reaches its terminal boundary and archive reconciliation drains, canonical user/assistant message ids must be a subset-equal match in the archive (subject only to documented immutable same-id revisions, never missing final rows).
6. Restart/offline acceptance: the reconciled archive must retain those final rows across app restart without requiring the ChatGPT page to remain available.

## Current disposition

- The October 14 missing finalization is confirmed in the current Prime conversation and is a recorder/canonical-ingestion regression.
- The October 13 worker-3 stale archive is confirmed and is an archive reconciliation/projection regression.
- The two active worker tails provide additional live examples but should not be over-interpreted as settled-session failures until their sessions are idle/ended and reconciliation has drained.
- The initial investigation made no production source changes. A later selective upstream review of Chat On Steroids `v2.1.36` produced the bounded ports below.

## Selective Chat On Steroids 2.1.36 review

Upstream release/tag reviewed: `totec448-spec/chat-on-steroids` `v2.1.36`, tag commit
`816b5993e7014edca6bbd37365ab643f7bb8162c`.

The release is a large, 185-commit delta and was deliberately **not** merged wholesale. Eve has
substantial independent provider, archive, worker, input-delivery, UI, and link behavior that must
remain authoritative.

### Ported

- **Adopted-turn answer boundary:** when an adopted/reloaded generation and the next user question
  hydrate in one observation, only assistant sections before the new question may close the old
  turn. This is the relevant upstream 2.1.36 boundary behavior, adapted to Eve's existing durable
  turn adoption rather than importing upstream's whole chronology/request-ownership subsystem.
- **Exact old-turn final refresh at the next-user boundary:** Eve-specific addition prompted by the
  October 14 evidence. The recorder asks Fiber for the exact old page turn before lifecycle teardown,
  so a visible final that landed in the same observer interval cannot disappear merely because the
  next user message was already present. It intentionally does not enable a whole-page final scan.
- **Wake recovery grace:** ported the 2.1.36 90-second grace after a >2-minute recovery-sweep gap,
  preventing a resumed machine from immediately classifying every previously working chat as silent.
- **Archive mutable-frontier recovery:** Eve-specific. A stable final of the same exact turn now
  proves preceding distinct streaming rows historical, allowing the stable archive tail through;
  and the 90-second page-user receipt hold now schedules its own reconcile when the grace expires.

### Already present / superseded in Eve

- GPT-6 nested interim/Fiber capture was already present.
- The 2.1.36 transport-error recovery that preserves a page for Stop + Continue rather than blindly
  reloading it is already superseded by Eve's stricter browser-repair protection and
  `preserved`/`resumed` repair actions.

### Intentionally not ported

- The complete upstream `#1301` continued-request chronology/request-owner subsystem. Eve's current
  session/provider architecture has diverged substantially, so copying that subsystem would replace
  established Eve semantics rather than make a bounded regression fix.
- Broad 2.1.36 UI, setup, dictation, proxy, worktree, plugin wording, and renderer changes unrelated
  to this regression.
- **Link rendering/normalization changes.** Eve's own link representation remains unchanged. In
  particular, the later upstream change that turns ChatGPT link cards into ordinary Markdown links
  is outside 2.1.36 and was explicitly excluded. No Eve link-format source file was changed by this
  port.
