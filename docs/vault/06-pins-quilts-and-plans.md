# 06 — Pins, Threads, Quilts and Plans

Back to [vault index](README.md).

ParadigmEve keeps a durable knowledge/work layer above individual chats.

The product idea is:

```text
Chat = harvest/review surface
Pins = durable saved moments/results/plans
Concepts = promptless zero-Pin labels/objects
Hotlinks = prompted zero-Pin shortcuts
Threads = one-or-more-Pin work/context fabrics and mandatory homes for Pins
Quilts = broad thematic/context organization of Threads, addressed with #quilt
Plans = live first-class work objects independent of the source chat
```

## Workspace navigation

The renderer presents **View / Pins / Plans** as peers and keeps the same session sidebar visible. The user can review work without remembering which source chat contains it.
Pins, Plans and Schedule also use one matched-size header-icon family while keeping distinct identities:
pin for Pins, three-dot/step motif for Plans, and calendar/timeline motif for Schedule.

## Pins

`src/main/pins.ts` + `src/shared/pins.ts` own the library.

A Pin is one of:

- Prompt — an authored user message;
- Message — an assistant reply;
- local result/tool output;
- Plan.

Prompt Pins are presentation-priority context: when a Thread contains one, Prompt Pins stay at the
top of its cover mosaic and content list while the selected saved/sent/context ordering continues
to order the Prompt group and the remaining Pins. Prompt and Message classifications use the
same stable recorded-message source identity, so changing classification cannot duplicate one source.

A Thread can also have one editable **Thread prompt** used as standing opening guidance when a chat
starts from that Thread. That field belongs to the Thread itself; it is deliberately separate from a
Prompt Pin, which is a saved authored user message with exact message provenance.

On a pristine install, ParadigmEve creates five empty starter Threads with Thread prompts and no Pins:

- `%how` — question-first product help that consults the packaged current manual as needed, grouped in the `#Eve` Quilt;
- `%appdata%` — ParadigmEve state, install location, startup and self-maintenance, grouped in the `#Eve` Quilt;

- `%expenses` helps with receipts, spending, budgets and practical savings. Before a local Expenses
  project exists it can guide setup; after the project is linked, the project's structured ledger stays
  authoritative. Its prompt also teaches Eve to Pin durable preferences, classification rules and useful
  findings while leaving raw receipts and transaction history in the ledger.
- `%organize` asks what the user wants help organizing, suggests Desktop or Downloads when they are
  unsure, and can teach **Settings → Workspace → Folders → Add** before inspecting a shared folder. Its
  prompt teaches Eve to Pin reusable filing preferences, naming rules and useful visual examples instead
  of transient file listings or every completed move.
- `%plans` is the durable starter behind **Plans → Create**. Its short description is
  **“Create and refine durable Plans with Eve. The plan stays near this app's chat window too.”**
  Create opens that Thread with the concrete onboarding request **“Make me a 3 step plan to get
  started with %plans”**, so the first conversation demonstrates the durable Plan workflow instead
  of asking the user to invent an outcome before they have seen it.

Starter reconciliation uses a durable ownership ledger keyed by stable starter id. It remembers the
concrete Thread id, the last app-owned prompt fingerprint, and whether the user explicitly saved a
custom prompt. If an owned starter Thread is missing, startup recreates the current shipped starter;
if the same starter was renamed, startup follows its durable id instead of undoing that rename. An
untouched app-owned prompt advances to the current bundled text, while a user-saved prompt is never
overwritten. Legacy installs are adopted conservatively from exact starter references or other unique
shipped evidence. The one shipped title migration is the old `%organizer` starter: when that exact
legacy title is still app-owned, the same durable Thread row may migrate to `%organize` while keeping
its id, Pins, Quilt links, and state.

The shipped `%how` prompt starts from the user's question. If activation arrives without one, Eve asks
what they would like to know or do in ParadigmEve. It keeps the product tour out of the way unless a
Thread, Quilt, setting, or other product term is actually relevant to that question.

`%how` consults the packaged current manual quietly when needed and uses ParadigmEve's local file
tools to read the relevant manual page. If the current manual is unavailable in the chat, Eve says
what cannot be verified instead of guessing or pretending it was read.

Every Pin **must** have exactly one Thread destination. The current internal persistence field for
that Thread id is `quiltId`; there is intentionally no global junk drawer.

The Pin chooser therefore has only two meaningful destinations:

1. choose an existing pinned Thread;
2. create a new Thread and optionally attach it to Quilts.

### Pins Create and content-derived kinds

In the current source line, the top-level **Pins → Create** action is a real local edit view, not a
conversation. It starts with an unsaved draft and does not create a placeholder durable object. Back
or Cancel therefore leaves no half-created Thread behind.

The saved kind is derived from content, not from Link or description:

```text
one or more Pins        -> Thread
zero Pins + prompt      -> Hotlink
zero Pins + no prompt   -> Concept
```

Archive state is orthogonal. Description and Link are optional metadata and do not change the kind.
The durable backing row is still the Thread-shaped Pins object, which is why exact identity,
provenance and Quilt membership rules remain shared.

Creation requires a non-empty unique Thread name. An empty/whitespace name disables and dims Save as
**Save requires name** / **Spara kräver namn**. A duplicate reference disables it as
**Requires unique name** / **Kräver unikt namn**. Duplicate comparison is the same user-facing
reference identity used by the backend: surrounding whitespace is ignored, a leading `%` is ignored,
Unicode is normalized, and comparison is case-insensitive. The backend duplicate refusal remains the
final race-safe authority.

Once name validation passes, Save wording follows the content kind: **Save Thread**, **Save Hotlink**
or **Save Concept**. First save is one atomic durable write for name, description, prompt, safe Link
and Quilt associations; there is no create-then-patch partial object.

Quilt membership remains a lightweight selector/tag-like grouping surface in the current line. Quilt is still the
product concept and `#` remains its reference sigil; this slice does not introduce a separate heavy
Quilt creator/editor workflow.

### Model-facing `pins` API

The Core `pins` tool is the model-facing catalog/mutation API when session recording is enabled. Its
wire actions are deliberately narrow:

- `list` reads the catalog or resolves one exact `%Thread` / `#Quilt`. Name matching is Unicode-normalized
  and case-insensitive; missing references return an explicit missing result and ambiguous legacy names
  fail instead of picking one. Catalog reads do not require current-chat identity proof.
- `pin` requires a durable `thread_id` plus either an exact recorded session event
  (`session_id + event_seq`, where `session read` exposes the event as `E<number>`) or an exact Plan id.
  User messages become Prompt Pins, assistant messages become Message Pins, tool calls become Result
  Pins, and Plans become Plan Pins. Arbitrary prose, timestamps, titles, or fuzzy chat matches are not
  Pin sources.
- `unpin` requires the exact `pin_id`. It removes only the Pin; the recorded source and owning Thread
  remain.
- `create_thread` creates one promptless durable Thread-shaped backing object and may create/associate
  only the explicitly supplied Quilt names. With no Pins or prompt it is presented as a Concept until
  Pins are added. Those names are user-facing Quilts even though legacy persistence calls them collections.
- `create_concept` creates or reuses one exact zero-Pin, promptless same-name backing Thread and sets
  its description. A same-name Quilt, prompted object, Pins-bearing Thread or ambiguous legacy name
  fails closed rather than being silently reclassified.
- `set_quilt_description` updates the description of one exact wider Quilt after user-approved
  enrichment.
- `associate_quilt` links an exact `thread_id` to one Quilt name. `create_if_missing=false` leaves a
  missing Quilt untouched; `create_if_missing=true` is reserved for the exact Quilt the user approved
  creating.

Every mutating action requires exact current session + conversation identity. The model-facing tool
does not expose Thread-prompt editing or Thread deletion; those remain separate app/UI operations.

## Threads and Quilts

- A Thread is one specific durable work/context fabric and Pin home. In direct context references,
  `%architecture` means activate that exact Thread/binding: its Thread prompt comes first, followed by its Pins.
- Quilts group Threads broadly by theme/context. In direct context references, `#eve` means the wider Quilt
  and expands only the saved Pins across its currently pinned Threads. It does not activate member Thread prompts.
- The built-in Expenses workflow has one narrow convenience alias: `#expenses` activates the linked
  Expenses Thread and project when no real Quilt named `#expenses` exists. A user-created `#expenses`
  Quilt shadows that alias and retains normal data-only Quilt behavior. This exception is resolved from
  the durable Expenses binding and does not make `#name` a general Thread-activation syntax.
- A Thread can belong to several Quilts, and one Quilt can contain several Threads. **Quilt** is the operational
  product name and `#` is its user-facing sigil. Thread references use `%`. These keyboard-safe sigils
  are the complete user-facing reference syntax; `@` remains reserved for plugins/connectors.
- Pins are owned by Threads, not directly by Quilts. Because a Thread can belong to several Quilts, the same Pin can
  be discoverable through several Quilt contexts without duplicating its durable source or ownership.
- Empty Threads are preserved; removing their last Pin does not imply the user wants the organizational object deleted.
- A Pin can be removed directly from its Thread detail view. Unpin removes only that Pin and deliberately leaves an empty Thread in place.
- A Thread can be explicitly deleted from its Thread detail view. Explicit deletion removes that Thread and every Pin it owns in one serialized durable-library mutation, while Quilts are preserved as independent broader groupings.
- Archived Threads are not implicit destinations; they must be repinned/reopened first.

The library currently bounds itself to 2,000 Threads, 10,000 Pins and 200 Quilts. The persisted schema still uses
legacy `collections`/`collectionIds` field names internally; those names are implementation compatibility, not UI language.

## Direct context references

Fresh Eve conversations can explicitly bring durable Pins context forward from the library:

```text
#eve             -> the Eve Quilt, across its pinned Threads
%architecture    -> activate the one specific Architecture Thread/work-context binding
```

The sigils are callout syntax; the stored display names may remain plain `Eve` and `Architecture`.
Matching is Unicode-normalized and case-insensitive. A reference must resolve deterministically;
ambiguous matches are ignored rather than guessed. Combining a Quilt and one of its Threads is
safe because selected Pins are deduplicated. In that combined case, only the explicitly named
`%thread` contributes its Thread prompt; the `#quilt` reference remains a context-only bag of saved Pins.

Recorded assistant prose can make those same uniquely resolved references clickable inside the app.
`%thread` opens that exact durable Thread in Pins; `#quilt` opens the Pins overview with that exact
Quilt filter selected. The renderer resolves to durable ids before creating a local workspace action.
A missing or duplicate legacy name stays ordinary text. Existing Markdown links and code are left
alone, and these app links never introduce an external navigation scheme.

This distinction is deliberate: `%thread` is a compact reusable procedure/context activation, while
`#quilt` gives the current authored request room to decide what to do with a wider Quilt. The
special packaged-manual context belonging to `%how` follows the same activation rule; mentioning a
Quilt that happens to contain How does not silently inject the How prompt or manual.

Quilt scope follows the library's active/pinned view: archived Threads are omitted from
`#quilt`. A direct `%thread` is an explicit callout and may still select that Thread even when it
is archived; that narrower request is treated as intentional rather than rediscovery.

The two sigils are therefore not generally interchangeable. A template project may persist one Thread
id as its specific continuity/binding, as Expenses does with `%expenses`. Starting a chat from that exact
Thread may select the linked project because the durable id is already the project binding. The built-in
`#expenses` convenience alias may select the same binding only while no real same-name Quilt shadows it;
other broad `#quilt` references cannot select projects. The Thread can carry preferences, Pins and useful
findings while canonical structured project data remains in its own local authority. See the
[Expenses specification](../product/expenses.md).

Starting a chat explicitly from a Thread in the Pins workspace also activates that Thread prompt,
matching `%thread`. This is opening-message preparation, not an MCP tool and not renderer-owned state.
The composer names the selected Thread and offers “Help me get started with %organize” (or the
selected Thread's name) when there is no existing draft. The user can edit it before Send; navigation
preserves authored drafts, including an intentionally empty draft. The durable Thread id travels
with Send, and a starter Thread's prompt is included even when it has no Pins. A new chat without
a selected model can leave ChatGPT's native choice unchanged, so unavailable model discovery does
not block the tutorial. This is separate from ChatGPT accepting the message.
`src/shared/pins-context.ts` selects references from the durable Pins snapshot;
`src/main/pins-context.ts` loads exact recorded message text where possible and builds the bounded
context block; `src/main/ipc.ts` injects that block only for the opening user input before normal
fresh-session prompt preparation. The current authored request stays last and wins over conflicting
instructions inside older Pins.

Prompt and Message Pins prefer exact recorded text, including overflow text, with saved excerpt/title
as a fallback. Result and Plan Pins currently contribute their saved title/excerpt. The Pins block is
bounded to 48,000 characters / 72,000 UTF-8 bytes and also obeys the outer prompt budget.

## Duplicate and provenance rules

Stable source identity prevents duplicate Pins:

- Prompt / Message: stable message id when available, otherwise exact session/event evidence;
- result: tool call id when available, otherwise exact session/event evidence;
- Plan: first-class Plan id.

Authored-message provenance is deliberately fail-closed after Compact & Resume. If the exact source
conversation cannot be proven, the saved Pin remains useful, but Eve does **not** pretend replacement
chat B authored a message from chat A.

## Pin source navigation

A Pin source link is an exact recorded-source jump, not a best-effort text or timestamp search. Message/result provenance carries the local `sessionId` plus durable `eventSeq`; the Pins workspace passes both into Chat navigation.

The same `sessionId + eventSeq` workspace target is reusable by request/result surfaces that already
hold exact recorded provenance, including notification UI added by another owner. The navigation
layer does not create notification state or infer a source from request text.

When a source is opened, Chat must:

- select the recorded local session when it differs from the current chat;
- preserve the requested recorded boundary while that session is first loaded;
- explicitly load a bounded history window containing the target `eventSeq` when the row is not already present;
- switch to the Timeline view and clear any agent filter that could hide the requested row;
- open containing collapsed activity groups as needed, center the exact recorded row, and briefly highlight it;
- perform the same exact-row reveal when the source session is already selected.

This navigation uses durable event identity and remains subject to the provenance rule above. Compact & Resume never licenses attributing a source row to a replacement ChatGPT conversation when that exact origin cannot be proven.

## Strict durable library behavior

Pins/Threads/Quilts are personal authored state, so they use strict durable reads. Malformed/corrupt bytes are not interpreted as “empty library,” because that would allow the next write to erase the user's real data.

Schema validation also rejects orphan Pins, duplicate ids and invalid Quilt membership references rather than repairing them into guessed state.

## Plans

`src/main/plans.ts` + `src/shared/plans.ts` own first-class Plans.

A Plan contains:

- title/description;
- ordered checklist items;
- each item state: `todo | in_progress | done`;
- optional priority and reminder;
- source/session provenance where known;
- revision/update timestamp;
- optional archive timestamp.

At most one checklist item can be `in_progress`.

### Plans Create

Plans is intentionally the one Create flow that remains conversational. The header
**Create / Skapa** action resolves the shipped Plans starter by durable starter id `plans`, not by
its visible title, then opens a fresh exact Thread chat. A renamed starter therefore keeps working.

The renderer sends one transient authored onboarding opening (`Make me a 3 step plan to get started
with %plans`) through the normal audited user-send path; it is deliberately not stored in browser
history state. Because that opening already provides a concrete outcome, the starter prompt can create
the real three-step durable Plan immediately. If `%plans` is activated some other way without a clear
outcome, the prompt may still ask one short question. A true editable Plans Create form remains
deferred beyond this source line.

## Live and Done are lifecycle sections

There are exactly two product sections:

- **Live** — all unarchived Plans, including a Plan whose checklist is 100% done;
- **Done** — explicitly archived Plans.

Finishing every checkbox only makes a Plan **ready to archive**. It stays Live until the user/Eve explicitly archives it. That prevents “the checklist completed itself and vanished” from being treated as workflow completion.

## Revision fence

First-class Plan edits use `expectedUpdatedAt`. A stale UI/editor receives “Plan changed; refresh…” instead of overwriting a newer change.

Archived Plans cannot be edited.

## Session `update_plan` projection

`update_plan` is the live execution-plan tool used by a session/agent. An **accepted** session plan
update projects into the corresponding first-class Live Plan only after the session
ownership/staleness checks accept the tool call.

The order is important:

```text
exact session stale/owner fence
        ↓
persist session plan update
        ↓
project to first-class Plan
```

The first-class library does not become an alternate way around session ownership.

## Session-plan import and restart safety

A session-local `plan.json` can seed a missing first-class Plan. Once a matching first-class Plan
exists, that session document is import-only and cannot overwrite newer progress, revision or archive
state.

Current behavior:

- a session plan can seed a missing first-class Plan;
- an existing first-class Plan wins thereafter;
- archive state wins over a stale session-plan projection;
- a Compact & Resume session with multiple chat ids does not invent an exact current conversation for
  source provenance.

If an archived/done checklist later reappears as active todo/in-progress work, it becomes a new Live projection instead of being hidden behind the existing Done object.

## Renderer ownership

Relevant renderer modules:

- `src/renderer/workspace-library.ts`
- `src/renderer/pins-quilts.ts`
- `src/renderer/plans-library.ts`
- `src/renderer/pin-provenance.ts`
- `src/renderer/agent-plan.ts`

The UI should be thought of as a projection of the durable libraries. Repaint bugs must be fixed by refreshing/projecting the authoritative state, not by creating a second browser-local Pin/Plan truth.
