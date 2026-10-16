# 04 — Sessions, outbox and Compact & Resume

Back to [vault index](README.md).

## Local session is the continuity object

A local session is not “one browser tab.” It owns the durable work history while ChatGPT conversation ids are replaceable frontends.

`src/main/session/store.ts` persists each session under userData:

```text
sessions/<session-id>/
  meta.json
  events.jsonl
  messages/
    <canonical-message-shards>.json
  assets/
  handoffs/
```

### What each piece means

- `events.jsonl` — append-only structured tool/turn/error/activity journal.
- `messages/*.json` — one atomically replaceable shard per stable ChatGPT message identity; streaming updates replace that logical message instead of appending duplicates.
- `meta.json` — durable summary/checkpoint projection.
- `assets/` — large text/screenshots/binaries that should not bloat the journal.
- `handoffs/` — Compact & Resume briefs.
- `plan.json` — the exact session's current `update_plan` checklist when it has one; the
  app-wide first-class catalog is projected only after an accepted plan update.

The store never decides two messages are the same because their text looks alike. Stable identity comes from the page/Fiber producer.

## Recording is more than a transcript

Session recording supplies evidence for:

- exact tool attribution;
- current conversation ownership and durable conversation lineage;
- turn boundaries and outcomes;
- recovery candidates;
- workers and their owning agent association;
- Compact & Resume;
- activity/timeline UI;
- 22-minute review history;
- session-plan projection into the first-class Plans catalog.

This is why “just scrape the visible ChatGPT DOM later” cannot replace the recorder.

## Durable session input outbox

`src/main/session/input.ts` is the single durable owner for authored/automated messages that Eve owes ChatGPT.

An entry tracks more than text:

- exact session / conversation when known;
- desired model + reasoning;
- delivery mode (`auto`, `after-turn`, `finish`);
- transport intent / ownership;
- browser/tool claim state;
- stable message id / delivery receipt;
- images and native attachments;
- Goal/finish ownership;
- internal attention payloads such as worker reports and Prime findings returned by heartbeat review.

### Delivery states are intentionally distinct

```text
queued -> browser/tool custody -> sent / cancelled / failed
```

“Put in composer”, “offered in a tool result”, and “ChatGPT accepted it” are not interchangeable.

Critical retry rule:

- **tool-delivered** text can be re-offered under the same stable identity until a later request proves receipt;
- **browser send claimed but missing ACK** is ambiguous and is **not** automatically resent because ChatGPT may already have accepted it.

The outbox is written through `writeDurableNow` before publication to live state.

### Exact request identity and the send boundary

`src/main/session/input.ts`, `src/main/session/start-input.ts` and the Companion keep an authored
outbox row's stable id, session, exact ChatGPT conversation/lineage and owner through browser/tool
handoff. A queue offer, browser claim, Send authorization and provider acceptance are separate
evidence boundaries. A page may claim an offered message only for the same valid target and
current page state; model/reasoning selection, blocked/superseded status and local-only restrictions
still apply. A send that may have reached ChatGPT is **not** automatically replayed because a
reply or browser ACK was lost.

The user's **Force Send** control is a narrow recovery of the **same original, unclaimed user
row**, typically when a restart left a stale open-turn inference. It does not manufacture another
message id or grant a second Send after a browser/tool offer, claim, Send authorization or delivery
receipt. `forceBrowserInput` requires current session ownership, a valid exact target (including a
proven Compact & Resume successor), unchanged selected model family **and reasoning effort** if
specified, and no competing user input or browser Send in that session. Internal app attention,
such as a queued heartbeat finding, is not by itself a Force Send blocker. A changed model, draft
or voice ownership can still refuse the browser's final Send. The UI can display a refusal reason;
the queued original remains reviewable. See the [Force Send playbook](11-debugging-playbooks.md).

Direct-send admission belongs to each durable session. A queued restart wake or ambiguous receipt
in another conversation cannot occupy Eve's composer. New-chat openings with no session retain
one shared composer slot. This does not cancel old messages, relax exact target checks, or replay
uncertain sends; browser/tool custody still excludes competing deliveries within the same session.

## Steering a running turn

The outbox/session input policy can choose among:

- join an eligible MCP/tool response;
- interrupt a proven direct non-Pro tool-free turn;
- wait until finish;
- browser-send once no active work remains.

Those choices are evidence based. A stale durable `activeTurnId` after restart is not enough to authorize a stop/send by itself.

If ChatGPT does not accept a worker's bootstrap Send, the command fails without replaying a possible
click. The Companion clears only its own unchanged bootstrap draft; any text the user changed stays.

## Heartbeat worker findings and Prime attention

The current 22-minute heartbeat sends its **review work to a bounded worker** tied to an exact
Prime session; it no longer delivers the review prompt into Prime's browser composer. That worker
may read locally recorded sessions and Plan sources, classify them, and send a provenance-bound
finding to Prime. It cannot perform the user's requested work or mutate a user Plan. Its review
epoch closes only on an accepted direct `chat_review_complete` receipt, after direct
`chat_review_plan` acknowledgements for every selected Plan.

Returning a finding is a separate durable delivery to Prime's own outbox. Exact session and
conversation ownership still govern that handoff across A → B Compact & Resume and coordinator
changes. A browser Send authorization with missing receipt stays ambiguous; the heartbeat stores
bounded `uncertainFindings`/pending delivery evidence instead of replaying a possibly accepted
message or holding up future reviews. See [runtime heartbeat](02-runtime-browser-recovery.md).

## Compact & Resume

`src/main/session/continuation.ts` is a transaction, not a summary convenience.

Chat A and chat B are provider frontends. The session, project, workspace, recordings and the agent's
worker garden continue.

### Transaction states

```text
awaiting-summary -> awaiting-chat -> claimed -> committing -> committed
                                           \-> aborted
```

The sequence is deliberately ordered:

1. **open** — pin/freeze relevant ownership; session still belongs to chat A.
2. **summary** — capture the exact final compaction answer as handoff context.
3. **claim** — exactly one replacement chat gets the continuation.
4. **preflight** — ask every component that could refuse (especially worker-garden owner transfer) before durable rebind.
5. **durable commit** — atomically move session conversation binding A -> B.
6. **publish** — move in-memory recorder mapping, workspace, Goal state and the broker's internal `prime` owner binding.
7. **abort on failure** — chat A remains owner.

The model handoff brief is context only. It is never used as application state reconstruction.

### What remains attached across the handoff

The transaction carries durable **session, project, chat lineage, outbox, checkpoint and worker
garden** identity; old chat A becomes a readable historical frontend, and new chat B receives
the current authority only after the commit. A queued exact restart wake or Prime finding follows
the session's proven successor. Nothing authorizes typing it back into superseded A. A worker
cannot self-compact; source code rejects worker Compact & Resume and applies eligibility checks
before automatic compaction. Installed Windows x64 self-testing included a successful Compact &
Resume path, which is useful acceptance evidence for that exact build, but does not prove every
interrupted-send or crash boundary or the bytes of a different installed or publicly released build.

## Send checkpoints

Continuation prompts use a four-position checkpoint model:

- `not-attempted`
- `attempted-unresolved`
- `dispatched-unresolved`
- `sent`

The key distinction is whether a retry is provably safe. Once dispatch may have happened, the app refuses to replay merely because it lacks acceptance evidence.

The destination half has explicit browser checkpoints around the actual Send action. The replacement
page first takes `destinationAttempt`, then `destinationDispatch` immediately before clicking Send. If
the page can prove the armed draft disappeared while the replacement still has no conversation id,
`destinationLost` releases that claim so the same handoff can be offered to a fresh replacement chat.
Once dispatch may have happened, ambiguity remains fenced instead of retyping the brief.

Manual Force Send is not a shortcut around these continuation checkpoints: it only re-offers an
eligible, untouched original user outbox row and still follows the exact current chat lineage.

The tab opened for a continuation is owned by that continuation while it carries the app command marker.
It is not eligible for ordinary chat reuse even before `destinationAttempt`; reusing it could move the
page away and strand the handoff. The same ownership also blocks incompatible Companion reloads once a
destination attempt has begun.

The Companion must preserve an actively used ChatGPT page: do not retarget an unrelated tab,
overwrite a user-edited draft, silently change the model, steal focus from a focused ChatGPT
window or create duplicate sends to recover an uncertain handoff. Browser maintenance uses
exact route/marker and fresh interaction evidence; see [runtime browser safety](02-runtime-browser-recovery.md).

Automatic compaction gives an already-running local tool call up to **six minutes** to settle after the
turn is stopped. A call still running beyond that bound causes the automatic source handoff to be
refused rather than treating an unknown machine state as safe to compact.

## Workspace continuity

The per-chat learned cwd in `workspace.ts` moves as part of the successful continuation publish. Chat A's workspace key is removed, so a stale old tab cannot continue resolving relative paths against a session that moved to B.
