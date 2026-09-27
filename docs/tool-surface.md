# Model-facing tool surface

This is the current public reference for the tool surface. The implementation and tests are
authoritative; `src/main/mcp/surfaces.ts`, `src/main/mcp/tools-core.ts`,
`src/main/mcp/tools-desktop.ts` and `test/mcp.test.ts` should agree with this file.

## Connectors

ParadigmEve publishes one primary ChatGPT app on Windows, macOS and Linux. On Windows and macOS,
that same app can also expose Computer use when the user enables it in Setup. New installs use one
OpenAI tunnel id and one restricted tunnel API key for the whole ParadigmEve app.

An older, separate Desktop endpoint is still retained internally for migration compatibility with
existing two-app installations that already saved a second tunnel id. New setup never asks the user
to create that second app or tunnel.

| Connector | Purpose | Possible tools |
| --- | --- | --- |
| **Eve** by default (per-install name configurable, e.g. **Eva**) | Approved files, tasks, terminal, ChatGPT file saving, recorded-session lookup, Pins/Threads/Quilts, workers, plus enabled Computer use | `read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `download_artifact`, `session`, `pins`, `agents`, and platform Computer-use tools |
| **Legacy Desktop compatibility** | Existing two-app installs only; Windows/macOS screen, windows, mouse/keyboard and clipboard | Windows Window2 tools, or macOS `observe` / `computer` |

Computer use is optional on Windows/macOS and is part of the primary ParadigmEve app.
The human-facing Core connector name is stored locally per installation. The MCP server identity
stays `paradigmeve-core`, so naming a second PC `Eva` does not create a new protocol/server identity.

On a fresh current config, portable local-work permissions are enabled, along with session recording
and multi-agent mode; read-only mode is off. Computer use starts off on every host until the user
checks the optional Setup checkbox. Linux masks Computer-use permissions off at runtime while
preserving stored choices for a config later reopened on Windows or macOS. Existing configs keep
their explicit choices during upgrades; missing legacy permissions are not silently widened.

With fresh defaults, ParadigmEve advertises `read`, `view_image`, `apply_patch`, `exec_command`,
`write_stdin`, `session`, `pins`, and `agents`. Enabling file saving adds `download_artifact`.
`find` is the search fallback for a snapshot where search is enabled and command execution is
unavailable. Tool exposure is monotonic within a running connector instance, so a permission
changed mid-conversation can leave a previously exposed name listed; its handler still enforces
the current permission.

## ParadigmEve local tools

### `read`

Reads approved paths. It accepts one or more paths, lists a directory one level deep, expands
bounded globs, supports line ranges, and can return supported image content. Path resolution
and result-size limits are enforced by the app: the per-file default payload is 256 KB, which
covers an ordinary source file whole, and the aggregate payload for one call stays bounded at
512 KB. The defaults are set so that batching paths into one call and reading a file whole are
the cheap path, because the round trip costs far more than the bytes.

### `view_image`

The dedicated Codex-compatible image tool. It is a real Core tool, separate from `read`, and
is gated by the read capability. Image transport and decode checks remain bounded.

### `find`

Search fallback used when search is enabled and command execution was unavailable when the
surface snapshot was built. It covers filename/glob and text search without granting a shell.

### `apply_patch`

The text mutation primitive. It uses the V4A patch envelope and preflights a multi-file patch
before writing. Create, edit, move and delete-file permissions are checked independently.
Directory deletion and arbitrary binary writes are deliberately not hidden patch operations.

### `exec_command`

Runs a command in the host's real shell: PowerShell/cmd on Windows and the user's normal POSIX
shell on macOS/Linux. This permission is **not** confined to approved folders. Long-running
commands return an opaque `session_id` that `write_stdin` can continue.

It takes exactly one of `cmd` (a single command) or `cmds` (up to 20 commands run sequentially
in one shell session). A batch shares one process, so variables, environment changes and the
working directory carry across its items; each item gets a labeled output section and its own
exit code, an ordinary non-zero result does not stop the rest, and the call's exit code is the
first non-zero one. Batching exists to spend one connector round trip instead of several on
related checks. The `apply_patch` interception and the benign-non-zero-exit classification
apply to single-command calls only.

### `write_stdin`

Writes to or polls a live command session by `session_id`, with optional yield time and output
budget. A blank `chars` value is a poll rather than a separate process-status tool. An empty
poll returns as soon as the process produces output rather than holding the full yield window;
anything that arrives afterwards stays buffered for the next poll. A non-empty write keeps
Codex's collection-window behaviour so one interactive response is gathered whole.

### `download_artifact`

Saves a native file reference into an approved folder. The schema requests ChatGPT
injection through `_meta` `openai/fileParams`; availability requires live provider
verification. The capability starts off and the default per-file limit is 20 MiB.
Only HTTPS `files.oaiusercontent.com` sources and redirects are accepted. Destination
parents must already exist; an existing destination is refused. Directory and partial
file identity are rechecked before publication, with portable Node path I/O rather
than a directory-handle-pinned race guarantee. Signed file credentials are omitted
from recorded tool arguments.

### `session`

Available while session recording is enabled. It has exactly two actions:

- `search` lists the 30 newest recordings when `query` is omitted, or searches titles, exact
  authored messages, errors, agent messages and recorded tool arguments/results across sessions.
  Its ordinary response is bounded to roughly 3,000 estimated tokens and continues by cursor.
- `read` requires an explicit `session_id`. It returns exact user/assistant text, compact tool
  headlines with short session-local `T…` references, and selected errors/agent messages. Read
  pages and expanded tool calls are bounded to roughly 5,000 estimated tokens and continue
  losslessly by cursor; authored messages are never summarized or ellipsized.

`read` also returns an `update_cursor`. Passing that cursor later returns only activity recorded
after the reader's checkpoint. An unfinished assistant message that only grew returns its exact
new suffix; a real rewrite is labeled as a replacement. Session lookup never guesses the calling
chat and never waits for browser identity evidence. Calls to `session` itself remain durably
auditable but are omitted from this projection so reading or polling a recording cannot recursively
copy its previous transcript result into the next one.

Compact & Resume is app/browser orchestration. There is no model-visible `save_handoff` or
`resume_session` tool.

### Exact workspace contracts: Pins, Plans, schedule and source references

These names are deliberately literal. Model-facing MCP calls and renderer/preload APIs are different
surfaces; do not invent a model-facing schedule mutation tool from the app APIs below.

#### `pins` MCP tool

`pins` has exactly five actions:

| Action | Exact fields |
| --- | --- |
| `list` | `reference?: string` where an exact lookup begins with `%` for a Thread or `#` for a Quilt |
| `pin` | `thread_id: UUID`, `source: {kind:'session_event', session_id, event_seq}` or `source: {kind:'plan', plan_id}` |
| `unpin` | `pin_id: UUID` |
| `associate_quilt` | `thread_id: UUID`, `quilt_name: string`, `create_if_missing: boolean` |
| `create_thread` | `title: string`, `description?: string`, `quilt_names?: string[]` (defaults to `[]`) |

For example, pinning an exact recorded event is:

```json
{
  "action": "pin",
  "thread_id": "11111111-1111-4111-8111-111111111111",
  "source": {
    "kind": "session_event",
    "session_id": "2026-09-18-example",
    "event_seq": 824
  }
}
```

The `event_seq` number comes from the exact recorded `E<number>` event returned by `session read`.
The wire value is the integer itself, not the string `"E824"`. `create_thread` does not accept a
Thread prompt field; the model-facing create path returns a promptless Thread. `associate_quilt`
may create the named Quilt only when `create_if_missing` is explicitly `true` after that exact
creation was approved.

With no reference, `list` returns a bounded catalog of Threads, Quilts and Plans. With a reference it
accepts only `%Thread` or `#Quilt`, resolves names by normalized case-insensitive exact match, reports a
missing reference without creating anything, and refuses ambiguous durable names. Reads can succeed
without exact caller proof; every mutation requires exact current session + conversation identity.

`pin` never accepts free-form content as its source. Recorded user messages become Prompt Pins,
assistant messages become Message Pins, tool-call events become Result Pins, and an exact Plan id
becomes a Plan Pin. `unpin` removes only the Pin while preserving the recorded source and Thread.
`create_thread` may atomically create or associate only the explicitly supplied Quilt names. The tool
does not expose Thread-prompt editing or Thread deletion. `%` is the Thread sigil, `#` is the Quilt
sigil, and `@` remains reserved for plugins/connectors.

#### Plans

The model-facing execution-plan tool is `update_plan`. Its input is the complete replacement plan:

```json
{
  "explanation": "Source contracts verified",
  "plan": [
    {
      "step": "Update verified reference",
      "status": "in_progress",
      "details": "Use only fields present in the shipped schemas."
    }
  ]
}
```

`plan` contains at most 12 rows, each with `step`, `status` (`pending | in_progress | completed`)
and optional `details`; at most one row may be `in_progress`. An accepted `update_plan` is persisted
under the exact session and projected into the first-class Live Plan catalog. It does not archive a
Plan or advance queued work.

The renderer/preload first-class Plan API is separate:

| Method | IPC channel | Exact input shape |
| --- | --- | --- |
| `listPlans()` | `plans:list` | none |
| `ensureSessionPlan(id)` | `plans:ensureSession` | `{id}` |
| `createPlan(input)` | `plans:create` | `{title, items, provenance?}` |
| `updatePlan(id, patch, expectedUpdatedAt)` | `plans:update` | `{id, patch, expectedUpdatedAt}` |
| `archivePlan(id)` | `plans:archive` | `{id}` |

Plan items use `text`, `status` (`todo | in_progress | done`), optional `priority`
(`low | medium | high`) and optional `reminderAt`. Update items may also carry their existing `id`.

#### Schedule / Eve routines

Schedule editing is currently an app renderer/preload API. The model-facing Core surface exposes
`schedule_complete` only for closing one already-running scheduled chat from exact durable tool
evidence. Therefore an ordinary Eve/Eva chat currently has no schedule-specific MCP/API call to
read or mutate user availability or Eve routines directly. With Computer use enabled it can operate
the visible Schedule UI like a user, but that does not close the model-facing API gap.

The app methods and IPC channels are:

| Method | IPC channel | Exact request |
| --- | --- | --- |
| `readScheduleProjection()` | `schedule:read` | none |
| `listEveCronEntries()` | `schedule:eve:list` | none |
| `createEveCronEntry(input)` | `schedule:eve:create` | `{title, durationMinutes, trigger, work}` |
| `updateEveCronEntry(input)` | `schedule:eve:update` | `{id, expectedUpdatedAt, patch}` |
| `setEveCronEntryState(id, state, expectedUpdatedAt)` | `schedule:eve:setState` | `{id, state, expectedUpdatedAt}` |
| `getUserSchedule()` | `schedule:user:get` | none |
| `replaceUserSchedule(schedule, expectedUpdatedAt)` | `schedule:user:replace` | `{schedule, expectedUpdatedAt}` |

An Eve routine create request uses these shipped fields:

```json
{
  "title": "Weekly review",
  "durationMinutes": 30,
  "trigger": {
    "kind": "weekly",
    "weekdays": [1, 3, 5],
    "localTime": "09:00",
    "timeZone": "Europe/Stockholm"
  },
  "work": {
    "text": "Review the current project status.",
    "automation": "off"
  }
}
```

`trigger.kind` is `weekly` with `weekdays`, `localTime`, `timeZone` and optional `startsOn`, or
`once` with `localDate`, `localTime` and `timeZone`. `durationMinutes` is an integer from 1 through
1440. `work` uses `text`, `automation` (`off | goal | loop`), optional nullable `objective`, and
optional nullable `projectId`. Eve routine updates require a non-empty `patch`; pause/resume uses
`state: 'enabled' | 'paused'` and the current `expectedUpdatedAt` revision.

User availability replacement uses:

```json
{
  "schedule": {
    "baseline": {
      "timeZone": "Europe/Stockholm",
      "days": {
        "1": {"availability": "known", "windows": [{"start": "09:00", "end": "12:00"}]},
        "2": {"availability": "unknown"}
      }
    },
    "changes": []
  },
  "expectedUpdatedAt": null
}
```

The `expectedUpdatedAt` value is `null` only when creating the first user schedule; later replacements
carry the current revision. Missing weekdays are unknown. A day with `availability: 'unknown'` does
not carry free-time windows.

For a scheduled run, `schedule_complete` accepts only exact `T…` references obtained from
`session(action="read", include=["tools"])`:

```json
{
  "verification_tool_call": "T2F",
  "result_tool_call": "T2E"
}
```

`verification_tool_call` is required and must identify the successful tool result that proves the
postcondition; `result_tool_call` is optional when a different successful call holds the task result.

#### Workspace/source navigation

Renderer navigation uses a typed local state rather than guessed titles or external URLs. Exact
recorded-source jumps are `{screen:'chat', sessionId, eventSeq}`. A resolved `%Thread` opens Pins with
`{screen:'pins', quiltId:<thread UUID>}`; a resolved `#Quilt` opens Pins with
`{screen:'pins', collectionId:<quilt UUID>}`. The `quiltId`/`collectionId` names are legacy internal
storage/navigation fields; their user-facing meanings are Thread and Quilt respectively.

The same provenance split explains the two reference alphabets: `E<number>` identifies a recorded
session event and supplies the numeric `eventSeq` for Pin/source navigation, while `T…` identifies a
recorded tool call and is the evidence reference accepted by `schedule_complete`.

### `agents`

Available while multi-agent mode is enabled. It has exactly four actions:

- `spawn` creates worker chats from one shared context plus per-worker tasks. Used once per run:
  a run that needs a worker again reuses one it already has. Each worker takes an optional
  `model` slug: the worker's chat opens with `?model=<slug>` in its fresh-chat URL, so the owning agent
  on a limited model can spawn workers on a cheaper one. Omitted means the account default;
  a slug ChatGPT does not recognise opens with the default too. The model is fixed for the
  life of that conversation, including across sleep/wake reuse. Each worker also takes an
  optional `reasoning_effort`: pro, none, minimal, low, medium, high, xhigh, max or ultra,
  forwarded on the open URL independently of `model` — a level never selects or changes the
  model, and omitting either inherits the default set in app settings, or the account default
  when no setting is chosen. The vocabulary is the one in `shared/session.ts`; `pro` is the
  ChatGPT browser Power tier and is listed here because a worker is a real browser chat.
- `message` sends one message or an all-or-nothing batch. Messaging a sleeping worker is what
  wakes it, in the chat it already has.
- `status` reports the run and workers, including who is asleep and how many worker slots are free.
- `finish` is a worker's handoff to the owning agent. It reports a result and puts that worker to sleep.

Workers sleep rather than end. A worker that has reported keeps its ChatGPT conversation and
stays reusable; its worker slot is free while it sleeps, so the limit counts only workers that
are actually working. Waking one needs a free slot, reopens or refocuses that worker's own chat,
and types the owning agent's message into it as an ordinary user message. A worker becomes permanently
finished only when its chat reaches the context ceiling (400,000 tokens by the app's own session
accounting); crossing it never interrupts work in flight, it only makes the next stop the last one.
Workers never run Compact & Resume, automatically or manually: their conversation is their durable
agent identity, so the 400,000-token boundary changes only later revive eligibility and never opens
a replacement worker chat.

There is no model-supplied agent credential or `agent_key`. Worker/owner identity is bound to the
ChatGPT conversation using extension evidence; control calls fail closed when that identity cannot be
proven. The broker still uses `prime` as its internal persisted owner-role name for compatibility.

## Computer use

This section exists on Windows and macOS after the user enables the Computer use Setup checkbox.
Linux does not advertise or execute these schemas. These tools are published by the same primary
ParadigmEve app and tunnel as the local tools above.

### `observe`

Reads desktop state without moving focus: screenshots, windows and snapshot-scoped UI-control
information. Window capture tries a direct background path first and labels a visible-screen
fallback when the pixels may be occluded. Screen access is independent from mouse/keyboard
control.

### `computer`

Executes a bounded batch of desktop actions. The current action set is:
`click_ref`, `set_value`, `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`,
`focus`, `wait`, `read_clipboard`, and `write_clipboard`.

Recent screenshot frames are retained independently; a coordinate action names its frame and
the helper revalidates target-window geometry immediately before physical input. Semantic refs
address cached UI Automation or AXUIElement objects from one bounded snapshot and fail stale rather
than rescanning by a reusable native identity. Batches report completed-step and route evidence, including
the exact failing index on partial failure. An optional compact `verify` postcondition can wait
for a foreground window, window open/close, or UI control appearance/disappearance and capture
the resulting state in the same tool call.

Each step is checked against the current screen/control/clipboard permissions. Read-only mode
can keep observation available while disabling state-changing desktop actions.

## Permission and discovery invariants

- A tool call is checked against current permissions even if its schema was exposed earlier.
- The primary ParadigmEve endpoint registers local tools plus only the Computer-use tools permitted
  by the current live settings.
- The legacy Desktop compatibility endpoint still has its own secret local token and never gains
  local file/task tools.
- Read-only mode removes effective file-write, command, control and clipboard-write permissions
  without pretending the underlying configuration was changed.
- Approved filesystem roots do not sandbox command execution or desktop control.
- Tool results and validation errors are bounded; large structured or binary payloads must not
  grow without an explicit cap.

## Compatibility notes

Older conversations can retain a cached MCP schema after an upgrade. Refresh/review the app in
ChatGPT, or recreate it if your workspace requires that, then start a new conversation when the
connector's exposed tool shape changes. The current extension pairs automatically with the local
bridge; there is no pairing code to enter.

## Tests that protect the surface

`test/mcp.test.ts` checks the unified primary surface, legacy compatibility boundary, discovery-size
budgets, permission gating, retired names and schema shape. Native image parity has additional
coverage in `test/codex-view-image-parity.test.ts`.

When changing the public tool surface, update the implementation, the surface declarations,
the tests and this document together. Do not add a permanently exposed tool for a workflow
that can be expressed safely through the existing primitives.
