# 13 — Schedule workspace and Eve routines

Back to [vault index](README.md).

## One workspace, two schedule authorities

Schedule is ParadigmEve's first-class workspace for the user's availability (`%schedule`) and Eve's
recurring/one-time routines (`%evecron`). Its chat shortcuts use normal Quilt syntax:
`#myweek` for the user's week, `#routines` for Eve's routine context, and `#schedule` (also written
`#schedules`) for the broader combined topic. Each also has Swedish and Spanish spellings (`#schema`/`#scheman`,
`#minvecka`, `#rutiner`; `#agenda`/`#agendas`, `#mi-semana`, `#rutinas`) that the app routes to the same shortcut,
so the localized "Chat about" chips mean the same thing to Eve in every language; see
[16 — Languages, localization and aliases](16-languages-localization-and-aliases.md). Those Quilts contribute saved Pins context when they exist; they do not
replace durable schedule state or activate either Thread's standing prompt. Explicitly opening
`%schedule`, `%evecron`, or starting a chat from either Thread is a separate Thread activation.

Current durable schedule state is authority. Chat prose, Pins, Thread prompts and Plans can explain
intent or provenance, but they do not override current availability, routine state, execution receipts
or completion evidence.

## What the visible Schedule surfaces mean

The Schedule screen is the neutral operational workspace. It is intentionally not a disguised Thread
activation and it should be understandable without knowing the storage model first.

| Visible surface | Meaning | What it may change |
| --- | --- | --- |
| **Today** | A two-lane view of today's user schedule and Eve schedule, plus backend-resolved shared-free time. | Nothing by itself; this is a projection. |
| **Usual week** | The recurring weekly pattern. | Nothing by itself; selecting a day only changes the view. |
| **Next 7 days** | The dated near-term projection, including temporary changes. | Nothing by itself; selecting a day only changes the view. |
| **Edit your availability** | The explicit mutation path for the user's availability. | `%schedule` durable availability through the revision-fenced Schedule API. |
| **Edit Eve's routines** | The explicit mutation path for Eve's recurring and one-time routines. | `%evecron` routine definitions/state through the authorized Schedule API. |
| **Chat about `#myweek`** | Human-facing context for “what does my week look like?” | Starts/prepares a contextual chat only; it does not edit schedule state. |
| **Chat about `#schedule`** | Broader context for the scheduling domain: user schedule + Eve routines + related saved context. | Starts/prepares a contextual chat only; it does not edit schedule state. |
| **Chat about `#routines`** | Context focused on Eve's routines. | Starts/prepares a contextual chat only; it does not edit schedule state. |

The mental model is therefore: **`#myweek` is what the user experiences; `#schedule` is the broader
scheduling domain; `%schedule` and `%evecron` are specialized Thread contexts; the Schedule workspace
is where the current durable state is viewed and explicitly edited.** Quilts remain context, not
mutation authority.

For Eve/Computer Use, prefer the visible edit controls for mutations rather than inferring that a
chat shortcut is writable. After a save, verify the resulting Schedule projection or editor state;
do not treat clicking Save, sending prose, or opening a Quilt as proof that durable schedule state
changed. This distinction is especially important when the UI exposes more information than Core MCP:
the desktop Schedule API owns general schedule edits, while Core MCP remains limited to the exact
schedule-owned execution lifecycle described below.

| Fact | Authority | Current read/edit surface |
| --- | --- | --- |
| User weekly availability and one-date replacements | `src/main/user-schedule-store.ts` | `readScheduleProjection()`, `getUserSchedule()`, `replaceUserSchedule()` |
| Eve routine definition, recurrence, duration and enabled/paused state | `src/main/schedule.ts` | `readScheduleProjection()`, `listEveCronEntries()`, create/update/state APIs |
| User-authorized Eve routine edits | `src/main/schedule-mutations.ts` | `createEveCronEntry()`, `updateEveCronEntry()`, `setEveCronEntryState()` |
| Started/Done execution evidence | schedule core + `src/main/evecron-execution.ts` | projection receipts; running chat closes with Core MCP `schedule` action `complete` |

The exact preload methods, IPC channels and request shapes are listed in
[`docs/tool-surface.md`](../tool-surface.md#schedule--eve-routines).

## Inspect the projection before reasoning about free time or execution

Use the Schedule projection for questions such as “when are we both free?”, “what is Eve doing
Friday?”, or “did that routine actually run?” `readScheduleProjection()` is read-only: it previews a
bounded recurrence horizon and combines user availability, Eve occurrences and evidence-backed
receipts without materializing, claiming or starting work.

Availability and overlap are deliberately fail-closed:

- a missing weekday or `availability: unknown` means **unknown**, never free;
- `availability: known` with no windows means there is no free time in that day;
- a one-date change replaces the usual availability for that date rather than adding to it;
- cross-midnight availability is represented as explicit windows on each local date;
- shared-free overlap uses only known user windows and explicit Eve busy durations;
- a relevant Eve occurrence with no stored duration makes overlap `unresolved-eve-duration`; do not
  estimate an end time or manufacture `nextOverlap` from task prose/history.

The renderer consumes this projection. It must not independently derive duration, free time,
Started/Done state or overlap.

## Edit `%schedule` through the Schedule API

The **Your availability** editor reads `getUserSchedule()` and writes the whole editable document with
`replaceUserSchedule(schedule, expectedUpdatedAt)`.

Each weekday is either known or unknown. A known day contains zero or more explicit free windows;
unknown days carry no windows. The editor also supports one-date replacements for the next seven local
calendar days. Removing one restores the weekly baseline for that date.

Writes use optimistic revision control. Pass the `updatedAt` from the record that was read; pass
`null` only when creating the first record. If the schedule changed elsewhere, refresh and reapply the
edit to the current revision rather than overwriting concurrent work.

## Create, edit, pause and resume `%evecron` through the Schedule API

The **Eve routines** editor uses:

- `listEveCronEntries()` to inspect editable routines;
- `createEveCronEntry(input)` to create an enabled routine;
- `updateEveCronEntry({ id, expectedUpdatedAt, patch })` to edit it;
- `setEveCronEntryState(id, 'paused' | 'enabled', expectedUpdatedAt)` to pause or resume it.

Creation requires title, task text, trigger, IANA time zone and an explicit integer duration from
1 through 1440 minutes. Triggers are weekly (one or more weekdays, local time, time zone, optional
`startsOn`) or one-time (local date, local time, time zone). Work may run as one task, Goal or Loop,
with optional objective and project id.

Saving task text is also an explicit user-authorization seam: `schedule-mutations.ts` creates fresh
`ui-user` authority bound to the exact executable payload. Renderer callers cannot inject a target,
authority or provenance object. Conversational schedule changes use the Core `schedule` tool instead:
it requires exact current session/conversation identity, binds that source itself, and re-authorizes
the executable payload on every accepted amendment. A Plan, Pin, Thread prompt or old chat sentence is
context, not authority to manufacture executable scheduled work.

### Conversation-backed schedule context

When a reminder or routine depends on the conversation that created it, its frozen work may carry a
bounded `context` capsule alongside the task text:

- `purpose` and `desiredOutcome`;
- optional completion criteria, decisions, observations, constraints and requested format;
- exact source session/conversation references (with bounded message ids where available);
- optional `instructionRefs` for exact `%Thread` / `%Instruction` activations;
- optional `contextRefs` for exact `#Quilt` / `#Concept` data-only context.

The app binds source identities; a model never supplies them. Conversational amendments merge the new
exact source into the capsule, compacting repeated messages from the same conversation and keeping a
bounded set of distinct source conversations. The capsule is part of the executable payload hash.

At execution, the fresh schedule-owned chat receives this capsule before normal Pins-context
injection. `%` references may activate their reusable instructions; `#` references remain untrusted
context/data and do not authorize instructions or side effects. In particular `#expenses` alone never
authorizes receipt filing or ledger writes. The running chat should re-read materially relevant newer
source messages/current state before acting and say so if a needed source is unavailable rather than
inventing continuity.

Edits and pause/resume use the entry's `updatedAt` revision. If it is stale, refresh first. Pausing
changes future unclaimed occurrences to skipped/paused; it does not rewrite an already claimed,
running or terminal occurrence. Resuming before a future slot is due makes that slot schedulable again.

## Started means exact accepted delivery

A due Eve occurrence is admitted into a **fresh schedule-owned chat**. It does not reuse the active
human conversation.

Materialized, queued or claimed work is still Scheduled. The occurrence becomes Started only after
the exact scheduled input has durable browser/session delivery evidence: sent outbox state, native
message id, exact conversation id, delivery time and a local session bound to that same conversation.
The runner records that receipt and only then advances the occurrence to running.

Do not infer Started from a timer firing, a browser window opening, an outbox claim, visible assistant
prose, a Plan, a Pin or a Thread.

## Done requires task-specific durable verification

The unified Core MCP `schedule` tool uses `action="complete"` inside the exact running
schedule-owned chat. Completion remains lifecycle-only for that occurrence even though the same tool
also exposes list/create/update/set_state to ordinary exact-identity Eve/Eva chats.

Before calling it, read the recorded session with `session(action="read", include=["tools"])` and
identify durable successful `T…` tool results after the scheduled input anchor. Pass
`verification_tool_call` for the tool result that proves the requested postcondition and, when the
task result is a different call, pass `result_tool_call` too.

Completion fails closed for evidence from the wrong session/conversation, evidence before the
scheduled input, failed tool calls, and lifecycle/context-only tools. Final prose, elapsed time,
browser state, `session_finish`, Plans, Pins and Threads do not prove Done. Verified completion is
recorded before the schedule core publishes Done, keeping restart/replay idempotent.

## Current MCP/API boundary

The desktop Schedule workspace has the general read/edit API through preload/IPC. Core MCP additionally
publishes one compact `schedule` tool with these actions:

- `list` — read Eve routine entries and their frozen context;
- `create` — create an enabled routine from an exact current chat;
- `update` — revision-fenced amendment while preserving/merging conversation context;
- `set_state` — pause or resume with a revision fence and conversational provenance;
- `complete` — close the exact running scheduled occurrence from durable successful `T…` evidence.

The published schema is intentionally compact (`action` plus `payload`); action-specific payloads are
strictly validated inside the handler. Create/update accept task, duration, trigger, automation,
optional objective/project and the context fields described above, but never caller-supplied source
session/conversation ids.

Core still does **not** mutate the user's `%schedule` availability document directly. Use the
Schedule workspace/API for availability edits. When Computer Use is enabled and app self-window
control is authorized, Eve may operate that same visible Schedule editor as a UI action. Do not bypass
the APIs by writing durable schedule JSON directly with file or shell tools.

This is why `%how` is not a prerequisite for schedule work: Core instructions identify the Schedule
and its two underlying schedule concerns, while this packaged Vault page carries the operational
details. `%how` remains a separate Thread activation for broader product guidance.

## Source and acceptance map

- `src/shared/user-schedule.ts` — availability knowledge, windows, date replacements and intersection.
- `src/shared/schedule.ts` — routine/occurrence schemas, duration, recurrence, pause and durable state.
- `src/main/schedule-projection.ts` — read-only projection and backend-owned overlap.
- `src/main/schedule-mutations.ts` — user-authorized routine create/edit/pause/resume seam.
- `src/main/mcp/schedule-tool.ts` — exact-chat conversational list/create/update/state/complete seam and source binding.
- `src/main/user-schedule-store.ts` — revision-fenced `%schedule` replacement.
- `src/main/evecron-runner.ts` and `src/shared/evecron-execution.ts` — fresh-chat admission,
  Started evidence and verified Done lifecycle.
- `src/renderer/schedule-workspace.ts` and `src/renderer/schedule-editor.ts` — workspace and explicit
  user edit flow; the editor deliberately does not activate Thread prompts.
- `test/schedule-acceptance-*.test.ts`, `test/schedule-projection.test.ts`,
  `test/schedule-mutations.test.ts`, `test/user-schedule.test.ts` and
  `test/schedule-editor-renderer.test.ts` — acceptance coverage for these boundaries.
