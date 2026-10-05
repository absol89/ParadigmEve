# 2.3.6 — Interpreter → Plan → Orchestrator → Workers

Status: design agreed. Step 1 (Plan model) done; steps 2–4 not started. Branch `release/2.3.6`, cut from `release/2.3.5` (2.3.5 is an internal
dogfood build and will not be released; 2.3.6 replaces it publicly).

Reviewers: Eve (design review), the user (scope). Implementation: Claude.

## Why

Executing models work best when they do not have to absorb the user's live corrections and
half-sentences while they work. ChatGPT Voice (or typing) is the conversation; a separate step turns
finished conversation into a durable **Plan**; the orchestrator executes the Plan and delegates
bounded steps to workers. The conversation stays available as evidence, never as a stream of
interrupts.

```
You ⇄ Voice / composer ──finished turns──▶ Interpreter ──Plan revision N──▶ Orchestrator ──step──▶ Workers
                                                 ▲                              │                      │
                                                 └── chat archive (background intel, read on demand) ◀─┴── results update step state
```

## Roles

| Role | Input | Output | Must not |
|---|---|---|---|
| Interpreter | Finished turns of one chat (Voice or typed), the chat's current Plan | A new Plan revision for that chat | Execute anything; publish from unfinished turns |
| Orchestrator | One claimed step at one revision; the step's sources; the archive as background | Worker tasks; step status and evidence | Turn unrelated conversation into new work |
| Worker | One bounded task from the orchestrator | A result | See or react to the live conversation |

Any provider may fill a role (ChatGPT, Ollama, later Claude) using the 2.3.5 per-turn provider
switch and Ollama workers. Prime stays in ChatGPT unless decided otherwise.

## Plan model changes (`src/shared/plans.ts`)

Today: title; up to 100 flat steps with text (1,000), details (2,000), fixed priority, status,
reminder; one `in_progress` step; provenance on the Plan only.

Add:

1. **Revisions.** `revision: number` on the Plan, incremented by every interpreter publish. Each
   revision is kept (bounded history) so a claimed step can be read exactly as it was claimed.
2. **Per-step sources.** `sources: Array<{ sessionId, messageId, kind: 'voice' | 'typed' }>` —
   the exact turns that created or changed the step.
3. **Hierarchy.** `parentId?: string` and an `order` within the parent; priority applies within a
   level. Render as nested checkboxes.
4. **Intent and constraints.** `intent?: string`, `constraints?: string[]` as fields, so they
   survive rewording of the step text.
5. **Claims.** `claim?: { by: string; revision: number; at: number }`. A claimed step is executed
   from its claimed revision; later revisions mark it `superseded-pending` instead of mutating it.
6. **Limits.** Keep 100 per level; allow nested levels (depth cap e.g. 4). Keep one `in_progress`
   per orchestrator rather than per Plan.

Legacy Plans (no revision/sources/parent) stay readable unchanged.

## When the interpreter runs

- Only on committed turns: a `turn_end` for the turn (Voice turns end correctly since the 2.3.5
  Voice fixes). Never on streaming or provisional text.
- Debounced: a burst of short turns produces one revision.
- One active Plan per chat; its provenance names the chat, so later talk in that chat revises the same
  Plan. Only once it is completed or cancelled may the interpreter start a new Plan there, and the chat
  then shows the new one only.
- A revision waits for the user's **Send to orchestrator** unless auto-send is on (Advanced settings).

## Workers get their own chat and Plan

When the orchestrator delegates a claimed step, the worker runs in its own sub-chat (a GPT Chat
worker chat, or an Ollama worker), never in the main chat. That keeps the main chat about the user's
focused Plan instead of filling it with execution detail.

- The worker chat starts with the **shared Eve context** (Vault, pinned context, the step's intent and
  constraints), not the main chat's transcript.
- It gets **its own Plan**, created from the claimed step: `provenance.sourcePlanId` = the main Plan,
  plus a source link to the exact step id and revision it came from. The one-active-Plan-per-chat rule
  applies to the worker chat too.
- The worker may read the step's sources and the archive as background, like the orchestrator.
- Its result and evidence update the parent step's state; the main chat sees one status change on its
  Plan, not the worker's working turns. The worker chat stays inspectable from that step.

## Orchestrator contract (prompt sketch)

> Act on Plan "<title>" step <id> at revision <n>. Its sources are messages <ids>; read them and the
> current chat history only as background intelligence. Do not create work that is not in this step.
> Report status and evidence for this step. If the step is unclear, ask through the Plan (mark it
> `needs-input` with a question), not by inventing scope.

## Changes during execution

When a new revision touches a claimed step, Eve decides by the size of the change:

- wording only → no action;
- constraint or scope change → mark `superseded-pending`, notify the orchestrator at its next
  checkpoint;
- explicit cancel ("stop that") → cancel the claim.

## Decisions (the user, 2026-10-05)

1. **Default interpreter: the ChatGPT model the account can use.** It has the broadest language and
   Voice recognition training. Other providers can be chosen per chat, as in 2.3.5.
   - **New requirement — early archive.** ParadigmEve imports the account's existing ChatGPT chats
     automatically at the start, so the interpreter (and every later provider) has the user's
     context from day one. Exception: a user who switches to another provider before starting any
     chat is not imported. *Not built yet:* today a chat's history is recorded only when that chat
     is opened and observed. Needs: list the account's conversations from the Eve Browser session,
     read each one, write it into the session store as archived (not live) sessions, bounded and
     resumable, with visible progress and a stop control.
2. **Approval before the orchestrator sees a revision: on by default.** The Plan card in the Eve chat
   gets a **Send to orchestrator** button for each new revision. Settings → Advanced has a switch;
   turned off, every new revision goes to the orchestrator immediately.
3. **One active Plan per chat.** It gets revisions, and ends as completed or cancelled. After that, a
   new Plan may start in the same chat, but only one Plan is ever visible in the chat at a time: the
   chat iterates on its focused Plan instead of mixing projects and brainstorming. Earlier finished
   Plans stay in the Plans library with their sources. A Thread can hold
   several Plans from several sources, because each pinned object keeps its own source. A Project is
   a context scope: it limits (or opens) how much broader ChatGPT/archive context reaches its chats,
   so a long-running project's chats do not drift after compaction or get polluted by unrelated
   history.

## Tests to write first

- A Voice conversation with corrections produces one Plan revision after the turn ends, not one per
  utterance.
- A claimed step keeps its claimed revision when the interpreter publishes a newer one.
- Every step's sources resolve to archived messages.
- Legacy Plans load unchanged.
- With approval on, the orchestrator cannot claim from an unsent revision; with it off, it can at once.
- A delegated step opens a worker chat whose Plan has `sourcePlanId` and a step/revision link back;
  the worker's turns never appear in the main chat, and its result updates the parent step.
- A chat's Plan revisions stay one Plan; a second Plan cannot open while the first is active, and after
  it ends the chat shows only the new one. A Thread lists Plans from several chats with their sources.
- The early archive import is resumable, skips chats already recorded, and is skipped when the
  user switched provider before their first chat.
