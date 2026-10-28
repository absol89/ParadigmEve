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

**2.4.4 c3 delivery-row controls:** A browser pickup timeout after 60 seconds
is a *definite pre-Send failure* only if the original user outbox row still has
no owner, offer, native Send authorization, message id or delivery receipt.
Such a failed `auto` row shows **Force Send + Dismiss**, with native checks
still authoritative. It does not simultaneously show generic Retry, which
restores text to the composer rather than re-offering the original row. A
claimed or potentially sent failure shows **Restore to composer + Dismiss**
instead of Force Send; no automatic re-send is permitted. Recovery buttons
share a separated flex action rail, not overlapping absolute coordinates.
Dismiss hides the visible notice without modifying a possible receipt.
This UI correction does **not** change the browser pickup timeout itself.

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

Heartbeat maintenance also reconciles *exact-key* redundant notifications in the local outbox:
an untouched queued copy is retired only when the same session/finding key has a confirmed or
possibly authorized Send, or an explicit **Remove queued task** dismissal. Dismissing an unsent
finding is durable, so the heartbeat advances its matching retry-spool cursor instead of
re-creating the notification after Compact & Resume. Definite transport failures remain
retryable. Different findings, claims or uncertain Sends are never deleted based on age,
similar-looking text or total queue length; the reviewer/Prime must resolve their meaning.

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

---

> **Implementation contracts.** The sections below moved here unchanged from the former single-file
> `AGENTS.md` map. Their § numbers are kept so references such as “§14” still resolve; the
> [Vault index](README.md#former-agentsmd-sections) lists where each section lives.

## 11. Composer, input queue, generated plans and Astra finish

**Intent:** the user can send, correct, schedule and inspect work without losing authored text
or duplicating a message after an ambiguous browser outcome. One outbox owns all delivery.

### Input from composition to receipt

The desktop composer uses native CSS content sizing, bounded at 220px. Layout owns its
height across draft changes, hidden panels and width changes; do not persist a measured
`scrollHeight` as an inline height. Empty and fitting input must not overflow; longer text
remains scrollable at the cap. `scripts/verify-composer-layout.cjs` checks real Electron layout.

`session/start-input.ts` brings up the existing connection/bridge owners for an explicit send,
waits for actual connector readiness, then calls `input.ts`. Pre-publication cancellation owns
an AbortController; after enqueue, durable outbox state owns it. Browser startup failure leaves
a clearly queued input and an explicit retry action, not a fake unsent/sent result.

An input contains stable UUID, session/project, authored text, automation/objective, requested
model/effort, due time, optional stages and attachments. `input.ts` serializes mutation and
publishes a new ledger only after its write. Reusing an id with different content is rejected.
Direct-send admission is scoped to the durable session; an unresolved delivery in another chat
must never block writing to Eve. Null-session openings share the new-chat composer slot. Exact
same-session browser/tool claims still exclude competing delivery and retain ambiguous receipts.
The frozen `deliveryText` includes executor setup only for a new-chat opening at claim time; displayed authored
text remains separate. A failed write cannot later become a successful hidden enqueue.

| Delivery choice | Eligibility and behavior |
| --- | --- |
| Immediate / `auto` | In an exact active non-Pro turn before its first MCP call, show **Send directly**: claim that original turn, stop its native generation, then use normal browser Send. After the first MCP call, show **Inject now** and deliver in an eligible outer MCP result. Pro (including Astra) keeps injection throughout. A new turn resets eligibility; old tool history does not count. For a proven idle chat/New Chat, elect the normal browser send. Unknown model/turn identity grants no interruption. |
| After turn | Existing-session FIFO spends one distinct verified completed `turn_end` per browser claim. Replays/restart cannot drain the next entry. Does not block an otherwise eligible immediate tool injection. |
| Finish checkpoint | Waits for a successful finish-tool boundary; ordinary eligible chats can deliver after verified completion. Astra's separate after-turn opt-in remains explicit. Checkpoints inherit the current chat model. |
| Native attachment | Browser upload/send only. A file-bearing active-chat input waits for the browser-safe boundary; it never becomes a tool-result file reference. |
| Decision/planner | Role-specific request through the same claim/receipt infrastructure, with its own result consumer and cancellation. |

Browser delivery elects one exact tab/document/epoch and checks the right existing conversation
or fresh-chat ownership. New-chat reuse requires a visible composer before election and after
native preparation; unavailable surfaces are skipped so the first send can open one clean chat.
A failed native preparation can grant the existing pre-send fallback, before marking readiness.
Before claiming an input it waits for a visible composer; a mounted
editor hidden behind a dialog leaves the input queued in its elected tab. It confirms
model/effort, inserts the full text, uploads native files,
rechecks composer and attachment nodes, crosses app authorization, then **rechecks again after
every await before Send**. Native stable user-message and conversation identity establish
acceptance. Composer insertion, button disappearance and a local “sent” variable do not.

Direct active-turn corrections freeze `directTurn` in the same outbox entry. The existing
turn-start and last-tool evidence plus in-flight MCP custody decide eligibility; no separate
tool-seen flag owns it. Recheck the exact claim before native interruption and before Send.
Navigation, a newer question, an occupied draft or a first MCP call during preparation can
revoke delivery. A claimed browser correction never also enters a tool result. After-turn
entries retain their verified-completion policy and never acquire interruption authority.

Treat visible user composition as user-owned state. Never paste, replace, append, submit or
otherwise mutate a composer/input that contains unsent user text unless that exact draft is the
explicit target of the user's request. Before any browser text insertion, recheck that the user
is not actively typing and that no new unsent text, selection, attachment or editor change has
appeared since preparation; if any has, leave Eve's input queued instead of stealing the draft.
Do not move focus, switch tabs/windows or activate another app while the user is actively typing.
Resume only after a fresh observation proves the user is no longer composing and the intended
target still owns the action. When typing activity or draft ownership is ambiguous, fail closed.

Prepared text enters the native editor in one native `execCommand('insertHTML')` operation,
with inline text nodes and BR line breaks, without an extra outer paragraph. Select the replacement/append range and
recheck editor, focus and selection ownership before insertion. Synthetic clipboard events can
be consumed without inserting into a cold editor; per-line `insertText` freezes large project
frames and plain-text paste can turn them into file attachments. Verify the same editor's
normalized text after insertion; do not add a second bootstrap insertion attempt.
Provider paragraph normalization alone does not revoke the draft lease; trusted edits, changed
editor/route identity and attachment changes still do.

The witnessed Send receipt captures the pre-send assistant baseline. If app identity or native
message source arrives after a fast reply has rendered, that question still owns its reply and
exact final marker. A later observation must not classify its own answer as old history.
While an exact send receipt still has a bounded evidence reader, the existing observation also
requests canonical MAIN-world text even after native generation stops. Rendered Markdown can
remove submitted bytes; recognizing the generation must not be a prerequisite for reading the
source needed to recognize its Send. Route, epoch and stable message identity still decide acceptance.

Page-reply waits are bounded: reuse/close observations get three seconds; New Chat preparation
gets fifteen seconds. Missing preparation replies retain the elected tab and grant no fallback.
Only fresh same-document/epoch idle proof allows preparing that elected tab again. Final input
offers do not block maintenance; the content busy slot and durable app claim/authorization own
delivery. A due repair defers that same conversation's input to the next status pass.

A claimed/authorized ambiguous browser send is never automatically resent. Pre-send preparation
failure and post-click uncertainty have different error text and retry authority. Late exact
receipts may settle a cancelled wait; that does not authorize a second message. Receipt custody
and history publication are independent: a recorder failure retries canonical history, not
transport. Queued unclaimed input follows its durable session to the successor; already handed
claims keep their original exact document until their outcome resolves.

Tool input is offered in queue order within one bounded response. Emit one user-instruction
heading, each authored message followed by its normalized images, then one batch reminder.
UUIDs remain internal receipts, not decorative text for the model. A later exact-owner
invocation that started after publication acknowledges it. Immediate inputs may batch;
after-turn and finish entries each retain their own boundary policy. Tool intent has no
arbitrary claim-age expiry. Only positively settled, never-offered eligible input may change
transport; receipt loss cannot justify switching to browser Send.

### Attachments have one staging owner

`input-attachments.ts` stages immutable originals selected by file picker, drop or clipboard.
Renderer/browser receive opaque ids, names, sizes, MIME and bounded previews, never source paths.
Up to 20 files and 512 MiB total per message are locally admitted; provider limits can still
reject an upload. Staging has a 2 GiB quota, serialized pruning/admission, and preserves outbox-
retained bytes. Thumbnails do not modify originals or prove provider upload success.

Bridge chunks are bounded to 512 KiB and require the exact pre-send claimed input and attachment
membership. Native upload completion and final provider submission are separate checks. Legacy
normalized tool images live in `input-images.ts`; do not confuse them with arbitrary native
files. Never send a path/reference while implying its bytes reached ChatGPT.

### Astra's finish boundary

`shared/chat-models.ts` recognizes exact Astra/Pro identities; substring guesses are forbidden.
`session_finish` is exposed by the finish setting and requested in executor prompts only under
the applicable Astra policy. Workers still use `agents action=finish`.

`shared/finish.ts::finishInstruction()` is the single prompt for browser and tool delivery:
complete implementation first, call when roughly the configured 3/5 minutes of final checking
remain, and complete newly delivered work. It is not a progress tool or a way to collect all
checkpoints in a loop. Hidden reminder framing never removes original recorded bytes.

`session/finish.ts` validates exact active session/conversation/turn and invocation start.
The turn's recorded finish authority owns held/released/notified/decision state. Pending user
instructions and checkpoints take priority. A successful finish response can deliver one
checkpoint; empty holds can wait without inventing new work. “End turn” durably releases the
hold so ChatGPT may finish; it does not pretend native generation has stopped.

For Astra, **both Goal and Loop use the Loop decision path at the finish boundary** and inject
the resulting instruction through tools. A completed final answer does not automatically send
another browser message. `automaticFinishEnabled()` is shared by generation and queued-input
validity: armed Goal/Loop suppresses Notify even if the global finish action is Notify.

Finish decision generation deduplicates by actual recorded work/input revision, not a new
request timestamp or repeated hold call. User input, changed settings, turn release, block or
replacement invalidates the old attempt. Progress uses the existing mutable timeline row;
notifications are scoped to that exact turn and may be suppressed when the app is open.
Old periodic **finish/checkpoint generation** rows remain retired. The one deliberate periodic
exception is the 22-minute **chat-review heartbeat** owned by `chat-review-heartbeat.ts`. It does
not generate continuation work from a stale turn. It persists one bounded review debt and uses
the explicitly selected lane: **Auditable chat** dispatches to the existing read/review-only
heartbeat worker; **Native Subagent** queues the review for the next authenticated Prime Eve tool
result, never opens another ChatGPT worker chat or sends an unattended browser message. With no
Prime tool call the native review remains pending; neither a background model turn nor hosted
subagent capability is invented. Hosted child execution still requires a real available native
delegation primitive; without it Prime reports the review blocked. These reviews use exact
locally recorded sessions and source-backed Plan snapshots, never
ChatGPT browser history or speculative cross-device work. Its own `update_plan` is allowed only
for recording the worker's review checklist under Eve activity; no user Plan may be mutated by
that permission. The worker may not execute, delegate, install, send user work, or navigate the
browser. Unfinished findings are reported durably to Prime, which decides independently whether
the underlying request still needs execution. Each debt has a distinct key and exact Prime/worker
lineage. A browser send ACK, assistant final, or worker prose is not a heartbeat completion receipt.
Provider tool permissions are not bypassed by this transport; live unattended acceptance must
still prove Prime receives and processes the in-band instruction with existing authorization.
A Settings mode change archives the old lane's debt (`chat-review-superseded-*`) without advancing
coverage. Pre-Send transport is cancelled outright. A prompt that may have reached Prime (a Native
review offered in a tool result counts) holds the debt only while recent: once every row for that
key has been quiet a full cadence and Prime is not mid-turn with recent work, selecting the other
lane closes that transport and archives it as `mode-changed-after-possible-send`, so an idle Prime
cannot stall Auditable reviews forever. OFF never ends the hold. Likewise, once Native is no longer
selected, a still-untouched finding queued for a Prime tool result becomes an ordinary after-turn
browser message; one already offered in a tool result is never re-sent. Native review prompts and
findings never use the composer, so they neither hold nor wait for its one-message slot; they ride
Prime's next tool result together. Pending ticks report
`awaiting-prime-tool-call`, `awaiting-native-receipt`, `awaiting-worker-receipt` or
`mode-change-held`; a Native wait past one cadence logs `heartbeat-native-idle-wait`.

Every **new** heartbeat epoch also owns a durable Live-Plan pass. Select from `listPlans()` in stable
Live order, human-facing Plans first, and freeze at most **four** exact targets. Keep those selected ids
inside `planSweep.remainingPlanIds` until the final accepted receipt; new Plans may wait for the next
cycle. Each target carries exact id, revision and source provenance plus a bounded display snapshot.
The rendered heartbeat must fit the real browser message cap; truncate only item display text and mark
it explicitly, never ids/status/revision/provenance. Follow Plan → exact Source before deciding whether
stored checklist state is stale or work is still TBD.

Each selected Plan requires direct `chat_review_plan` before `chat_review_complete`. The lifecycle
classification is one of `ready-to-archive`, `tbd`, `blocked`, `superseded`, `awaiting-user`. Optional
`completed_item_ids` is not authorized in the read-only heartbeat review lane. The Plans owner
revalidates exact revision and **full durable provenance** before accepting a classification;
this review cannot complete items or archive human Plans. Replayed acknowledgements are
idempotent for the same exact classification; changed inputs fail closed.
For Eve/worker Plans, reporting or handing off to Prime is lifecycle evidence, not a Plan checklist
step. Do not create `Report to Prime`, `Hand off to Prime`, or equivalent handoff-only Plan items.
For legacy Plans that still contain one trailing report-only item after the substantive work is done,
the last real task plus the archive boundary represents the handoff when explicit report proof is
unavailable; do not let report-only debt keep completed Eve Activity live. Explicit report delivery
remains useful metadata when it is available, but it is not an archive prerequisite.
Retries/transfer preserve partial acks and omit already-acknowledged snapshots so unattended work is
not duplicated. A changed live revision/source clears that Plan's stale ack and requires re-review.
If the review worker stalls, the broker may retry/reassign only under its bounded, exact
debt-key/Prime-lineage rules, never from recency, title or a quiet browser tab. Only after the
read-only recent-request review and exact selected-Plan acknowledgements may the **authorized
heartbeat worker** call direct `chat_review_complete` with the current key. The tool derives
authenticated worker/Prime lineage from caller context, rejecting legacy Prime/other worker
receipts and ambiguous ownership. It reports `completed` for no remaining actionable work,
or `dispatched`/`blocked`/`failed` with a concrete finding for Prime where warranted.
For Plan-bearing debt, final receipt requires one current ack per target and revalidates live targets
under a Plans-owner fence held through the heartbeat-state commit (lock order heartbeat → Plans); a
later authoritative archive is acceptable. The receipt is idempotent and cannot be called through
code mode. A heartbeat with nothing still owed closes without invented work or findings.

## 12. Recording, history, context and usage

**Intent:** preserve what the user and model actually said and what local tools actually did,
then show it in stable chronological order at a bounded rendering cost.

Two producers are necessary: MCP/app evidence supplies exact tool args/results/outcome/files,
while browser observations supply native messages, progress, terminal state and page identity.
Neither can substitute for the other. Recording is local; explicit Goal/API/plugin/model tool
use can transmit the data described by those features. Do not call all product traffic local.

The recorder coalesces identical `chat_error` notices within 30 seconds against a bounded
committed error tail, including concurrent tab reports and replay after restart. Page-wide
access limits ignore document-local turn ids; other errors retain their turn scope. Different
text, another session or a later occurrence remains visible. This controls transcript noise,
not the bridge's independent recovery/blocking evidence.

```text
userData/sessions/<local-id>/
  events.jsonl          append-oriented tool/turn/error/progress evidence
  messages/*.json       one atomically replaceable shard per logical native message
  messages.json         legacy map, read during lazy migration
  meta.json             recoverable projection plus durable ownership/project facts
  meta.backup.json      last validated metadata checkpoint
  plan.json             current agent-maintained plan
  assets/               bounded binary and overflow material
  handoffs/             exact captured briefs and provenance
```

The store has three write semantics. Structured events serialize sequence assignment → complete
append → memory projection, sealing torn final JSONL lines before later append. Canonical messages
replace stable identities by temp→rename, never regress final to streaming, and retain original
chronological anchors across revisions. Metadata coalesces ordinary updates but writes immediately
at ownership boundaries; it can rebuild history-derived fields without inventing an empty session
when recovery lacks proof. Legacy files overlay lazily rather than triggering a whole-history rewrite.

Native image-only user messages keep their exact message identity, empty authored text and
bounded attachment metadata. They participate in the same turn/receipt chronology as text and
render an attachment placeholder immediately. Native metadata grants no local file custody;
later browser observations must preserve an app outbox's staged attachment ids and previews.

The exchange render-item reader preserves explicit image attachment ids and MIME metadata,
including image-only user items, and keeps the exchange's user before mixed model/rendered replies.
Native pixels bind only by exact provider file id to a same-origin estuary image; DOM URLs never
supply identity. Both sediment `file_` and file-service `file-` pointers are accepted end to end.
A bounded valid page preview may precede its text: the recorder creates the empty canonical user
row under the exact provider message id, then text enriches it without moving its origin. App
receipts still replace page previews with staged originals. `page_image_trace` carries bounded
field names/counts only through the existing journal to app.log; it is never conversation data.
The recorder logs unavailable/invalid/duplicate/app-input outcomes rather than silently dropping them.

Reads join only the relevant session's committed queue. `readActivityEvents()` does not flush
every dirty metadata row. A reopened session hydrates a bounded journal tail; append tail and
canonical map serve revisions/cursors. `tailFrom` states proven coverage and cannot be lowered
by an older canonical message across a missing journal range.

`shared/chronology.ts` orders by canonical origin before revision sequence. `foldProgress`
updates one namespaced progress/message identity in its original place. A HTML refresh of an
old worker final must not put a revived worker to sleep. Unknown identity is never folded by
similar text, time or display position. Recovery messages use this same projection mechanism.

Unattributed is a first-class recorded state. Late exact proof repairs only matching call ids
to the proved session epoch, copying assets first and rewriting only the scanned source prefix
while retaining concurrent appends. Restore/repair uses the uncapped catalog and a bounded
derived bucket cache. A superseded-source refusal remains terminally isolated from live B.

Native tab closure does not synthesize a completed turn. Reload recovery can close a durable
open turn only from an exact final for that turn, using the canonical message's stored owner
even when the reloaded page loses or replaces its turn id. The store-owned `finalContentSeq`
advances only for final text/state changes; HTML, timestamps and other metadata cannot turn an
old final into a new completion. Legacy rows retain their first anchor until fresh final content.
That content revision must follow the latest recorded work boundary, with no running local tool
or newer user/turn overriding it, independently of observation order within a browser batch.
Replay lifecycle boundaries in publication sequence; display chronology must not erase an
app-authored reopen after an earlier completed end. A same-request call that **starts after** a
reported completed end can prove the page ended it falsely; recorder reopens that turn and
retires the corresponding Goal attempt. A call started before the end, a new request or a
manual Stop cannot be used as that proof. This reopen evidence is process-local.

Large text has distinct inline/overflow/asset/read/render limits. Do not silently shorten
authored history to fix the UI. Asset quotas and explicit overflow ceilings remain enforced;
if earlier recording already lost content, expose that loss. Retention runs once on startup
and every six hours using current settings, even when new recording is Off.

### Two history consumers

The model's `session` tool has exactly `search` and `read`, with explicit local `session_id`.
Cross-chat and concurrent-worker reads are supported. Snapshot cursors pin sequence boundaries;
update cursors carry unfinished assistant-prefix checkpoints and report replacement when the
prefix changed; `T…` detail cursors page exact tool args/results with a pinned hash. Budget
cursor/footer space first and never truncate a cursor or silently skip authored text. Self-reads
are recorded for audit but omitted from this tool's own history/search projection.

Startup, navigation and live refreshes share one in-flight session-list read so slow history can
publish. Project decoration loads independently and cannot block that history. Failed pagination
preserves existing rows and waits for a deliberate retry rather than looping in microtasks.

Desktop session lists use stable `(updatedAt,id)` pagination. Timeline first loads a recent
tail, pages older/newer on deliberate scrolling, keeps a bounded 160-row window and viewport
anchor, and offers Back to latest. Historical browsing does not silently evict the user's
place on live updates; controls remain live. Selection generation fences every async page.
Expanded tool arguments/results and Compact & Resume content use the chat pane's vertical
scrolling, without nested vertical text scrollers. Streaming compaction revisions retain the
disclosure and unchanged sections; the timeline owner preserves the visible row or follows
the bottom only when the reader was already there. Collapsed bodies leave layout entirely.

### Context pressure and Usage are different measurements

Session `contextTokens` estimates current frontend pressure and resets at durable A→B rebind.
Lifetime `estimatedTokens` retains historical work. These are app estimates, not ChatGPT's
private context meter; the composer ring must say so. Exact Pro has a static pressure display
and is excluded from automatic compaction; manual compaction remains a separate action.

`extension/usage.js` observes bounded allowed account-usage responses in MAIN world, including
already available state; it does not retain raw account payloads. App `session/usage.ts` accepts
one fresh validated snapshot, replaces rather than merges accounts/tabs, and distinguishes
model, shared and feature pools. Missing/expired values mean unreported, never zero/full.

Daily work/cost charts use a **local estimate**, currently final frontend-context size / 2 per
unique recorded tool call, with editable divisor, multiplier and per-model comparison rates.
Model changes affect attribution; compaction starts another frontend segment. Duplicate call
ids do not count twice. Historical rows without model proof carry an explicitly assumed legacy
model. Canonical revision/timezone-keyed `usage-cache` avoids rereading unchanged transcripts;
formula changes only project cached totals. These charts are not a provider invoice, exact
token consumption or proof of current prices/entitlements.

## 15. Compact & Resume: same session, new frontend

**Intent:** preserve one local session S, its project, history, input queue, prime/worker family
and terminal custody while changing the provider binding **S: A → B**. Compaction is not a new
task and must not turn source A into an independently recoverable chat.

`session/continuation.ts` owns the transaction; `handoff.ts` validates the brief; `bridge.ts`
and the extension transport it. `resume-gate.ts` is a short pre-commit admission gate, not a
second continuation owner. The ledger phases are:

```text
awaiting-summary -> awaiting-chat -> claimed -> committing -> committed
       \------------------- pre-commit cancellation ------------> aborted
```

1. **Reserve A.** Persist an exact continuation token and source/session identity. Automatic
   compaction is level-based: current estimated context exceeds the threshold **and** the
   chat has live work. Idle old history does not start it. Workers and exact Pro are excluded
   from automatic compaction; workers do not self-compact, and Pro may compact manually.
2. **Ask for a brief safely.** Wait for running local tools, not the recorder's attribution
   tail. The source-tool fence prevents work continuing on A after handoff. Mark send attempt
   before clicking; attempted/dispatched/sent checkpoints are not interchangeable. Retry a
   known pre-dispatch failure, but never click again merely because the receipt is missing.
3. **Capture exact provenance.** Match the authored handoff request and assistant brief by
   token/message/turn identity. Enforce minimum and bounded brief content; do not capture the
   latest convenient assistant text. Preparing a brief does not yet publish a rebind.
4. **Elect B and commit.** Destination creation/claim has one opening owner. B must present
   the exact continuation context; early B observations are gated to prevent a shadow local
   session. Persist the committing decision, rebind S's metadata, then publish projections.
   **Durable metadata rebind is the point of no return.** Before it, failure leaves A current;
   after it, repair B's projections idempotently, never roll S back to A.
5. **Publish the same work.** Preserve project/cwd, broker role/family, history and queued
   input. Terminal custody already uses S, so no process-owner migration or adoption is
   needed. Move the objective and chat switch, retire A's execution authority, then retire
   its browser document only with fresh safe-close proof. B's first answer belongs to the
   exact resumed input, not to an old final from A.

**Reopening from a saved summary (Chat On Steroids #1215).** A run abandoned after its brief was
captured keeps its handoff on disk. `sessions:resumeFromHandoff` (preload `resumeFromHandoff`,
bridge `resumeFromSavedSummary`) starts a new run from it through `reopenWithHandoffNow`, only
when that handoff is still the session's `lastHandoffId`, no continuation is open, and its
provenance source is the session's current chat. The new run is an ordinary transaction: it
reserves A again with the abandoned run's project, records the source request as already sent
(nothing is asked of ChatGPT), and `attachSummary` writes a fresh handoff with the same brief
(minus the stored plan notice) bound to the new token. A failed attach aborts the new run. The
reuse button appears only on the newest Compact & Resume row. ParadigmEve's timeline binds a
handoff to the open compaction block, so the reopened run's own row does not show the summary.

Restart restoration must converge on that same committed projection. A persisted send attempt
can outlive a transport command; expiration releases transport, not permission for another
blind Send. Automatic tickets can wait indefinitely before the request was sent and retain a
six-hour sent-request window; manual transport is shorter (ten minutes). Pickup budgets depend
on phase: unsent 2m×5, writing 5m×3, opening 15m×3. These are bounded recovery of one obligation,
not fresh compaction attempts. Re-observe the exact page before advancing its state.
The writing pickup is **not** permission to reload a source whose recorded answer turn is
still open. An assistant brief that looks complete in the session recording does not replace
ChatGPT's terminal answer proof; without it, retain the awaiting-summary fence and preserve
the page rather than destroying the live stream on a five-minute timer. Manual cancellation
or exact later reconciliation remains possible without replaying the source Send.

Before a pickup can Stop the original answer, refresh the ticket's source-send checkpoint.
An already dispatched or sent summary request can only be observed, never stopped by another
pickup. Keep the original user-message/turn identity across that await; repeated presses
must not revoke the operation already in flight.

The timeline keeps one Compact & Resume card for the marked token across late or refused
source calls. Later activity is not evidence that summary writing, saving or destination
opening failed. The exact summary turn's stopped/failed outcome interrupts its writing status;
recorded abandonment reports transaction failure. A saved handoff or matching resume supersedes
the earlier summary interruption. Commentary with another turn identity stays outside the summary.
The browser says writing only with current generation proof for the marked summary question;
a sent checkpoint alone means waiting. Bootstrap folds require the app's exact recorded opening
message id plus current route/epoch. Retired folds unwrap all native children and controls.

Native ChatGPT Project destinations enter through the source chat's exact native Project link.
The header alone is not readiness: `chatgpt-dom.js::enterProject` waits for the source editor
to be mounted, empty, idle and attachment-free before its one click. Source readiness and
replacement-editor navigation each have a bounded 12-second phase using the same observer/timer.
Destination proof requires the exact Project home, a different connected editor and no source
turns. User interaction, cancellation or a foreign route revokes the attempt; no extra tab or
second click compensates for a missing result.

The brief includes the original task, accepted steering, current result, remaining checks and
relevant durable ids. Linked project instructions and current executor settings still apply.
Goal context can use a committed handoff as a provenance anchor; aborted/stale/legacy text is
not one. A source reply obligation must be superseded when its work has moved, rather than
mistaken for B's completed turn (§21 records the remaining ledger gap).

Legacy shadow repair requires exact old continuation proof. It may repair missing projections;
it must not guess a new rebind, delete history or become the path for new continuations.
