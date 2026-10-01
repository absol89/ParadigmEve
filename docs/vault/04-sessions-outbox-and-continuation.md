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
- internal attention payloads such as worker reports or heartbeat review.

### Delivery states are intentionally distinct

```text
queued -> browser/tool custody -> sent / cancelled / failed
```

“Put in composer”, “offered in a tool result”, and “ChatGPT accepted it” are not interchangeable.

Critical retry rule:

- **tool-delivered** text can be re-offered under the same stable identity until a later request proves receipt;
- **browser send claimed but missing ACK** is ambiguous and is **not** automatically resent because ChatGPT may already have accepted it.

The outbox is written through `writeDurableNow` before publication to live state.

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

## Heartbeat attention transport

Semantic heartbeat debt has one stable key, but transport idempotency is scoped to the **exact session + conversation target**, not globally to that key.

That matters when:

- Compact & Resume moves the same session from conversation A to B;
- a canonically stalled coordinator transfers the same review debt to a new exact coordinator.

A confirmed browser send can also be re-presented after its exact coordinator positively completes a turn without the semantic `chat_review_complete` receipt. Active/ambiguous sends remain deduped.

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

The tab opened for a continuation is owned by that continuation while it carries the app command marker.
It is not eligible for ordinary chat reuse even before `destinationAttempt`; reusing it could move the
page away and strand the handoff. The same ownership also blocks incompatible Companion reloads once a
destination attempt has begun.

Automatic compaction gives an already-running local tool call up to **six minutes** to settle after the
turn is stopped. A call still running beyond that bound causes the automatic source handoff to be
refused rather than treating an unknown machine state as safe to compact.

## Workspace continuity

The per-chat learned cwd in `workspace.ts` moves as part of the successful continuation publish. Chat A's workspace key is removed, so a stale old tab cannot continue resolving relative paths against a session that moved to B.
