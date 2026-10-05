# 2.3.6 — Interpreter → Plan → Orchestrator → Workers

Status: design, not started. Branch `release/2.3.6`, cut from `release/2.3.5` (2.3.5 is an internal
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
- One Plan per chat by default; the Plan's provenance names the chat, so later talk in the same chat
  revises the same Plan.

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

## Open questions

1. Which model interprets by default (ChatGPT Voice itself vs. a separate text model)?
2. Should the user approve each revision before the orchestrator may claim from it, or only
   revisions that change claimed steps?
3. Plan per chat, or per Thread/project?

## Tests to write first

- A Voice conversation with corrections produces one Plan revision after the turn ends, not one per
  utterance.
- A claimed step keeps its claimed revision when the interpreter publishes a newer one.
- Every step's sources resolve to archived messages.
- Legacy Plans load unchanged.
