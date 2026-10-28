# 03 — MCP, connectors and tools

Back to [vault index](README.md).

This describes the **2.4.0 source** (`v2.4.0`). The
file-format broker implementation predates the installed Windows self-test
build, but a provider in its registry is a discoverable capability, not proof that the optional editor
executable is installed, healthy, or included in a published installer.

## Connection topology

`src/main/connection.ts` owns the lifecycle:

```text
local MCP server -> public tunnel(s) -> ChatGPT connector(s)
```

The primary ChatGPT app / tunnel is the configured Eve/Eva Core connector. Computer use is exposed
through Core when enabled. A separate internal `desktop` surface is published only when a desktop
tunnel id is already configured; external MCP plugins are published on the optional Plugins surface.

Connection transitions are serialized so Connect/Disconnect/Settings/Shutdown cannot tear down resources a newer connect just created. A generation number invalidates late tunnel reports.

## Surfaces

Defined in `src/main/mcp/surfaces.ts`:

| Surface | Role |
| --- | --- |
| `core` | **Eve** by default; configurable per install (for example **Eva**). Files, commands, sessions, Plans lifecycle tool, workers, work context, and enabled Computer use. |
| `desktop` | Optional compatibility surface for separately configured desktop-tool publication. It is not part of the normal new-setup path. |
| `plugins` | Tools from enabled external MCP servers. |

The Core MCP server name remains the stable `paradigmeve-core`. Its user-facing connector name is
stored per installation in `mcp.connectorName`, defaults to **Eve**, and may use a distinct name such
as **Eva** on another computer. Changing that display/connector name does not rename the MCP server,
the ParadigmEve product, the Companion extension or the loopback bridge.

## Core tool families

The complete possible Core family includes:

- provider-neutral `file_action` (local file inspection/read and format-only provider discovery) and `file_edit` (consented ArtCraft installations and editing copies, including WordCraft and GridCraft);
- file read/image/search;
- `apply_patch`;
- shell execution + live stdin/polling;
- saving ChatGPT file artifacts;
- recorded-session lookup;
- exact Pins / `%Thread` / `#Quilt` catalog and mutations through `pins`;
- live `update_plan` display;
- `chat_review_complete` receipt;
- unified `schedule` lifecycle for listing and conversationally changing Eve routines, plus exact completion of one running scheduled chat;
- worker broker `agents`;
- `session_finish` where enabled;
- `work_context`;
- Computer-use methods when the user enables those capabilities;
- per-surface JavaScript `exec` wrapper where available.

See [`docs/tool-surface.md`](../tool-surface.md) for schemas and permission details.

### File broker: inspect, offer, edit or show

**Fresh-chat default:** Core's always-on tool descriptions and server instructions tell Eve to look for ParadigmEve's built-in broker when a user asks to open, edit, proofread, convert or visibly work with a document, spreadsheet, PDF or presentation. This does not require `%how`, a previously opened Thread, or an explanation from the user. **Inspect broker capabilities before suggesting a generic office/editor installation**, unless the user explicitly requests that product. The broker is available through Core on supported ChatGPT, local-model and worker routes when file permissions are enabled. The model still selects its tools; instructions improve discovery but cannot guarantee that every client/model invokes the tool.

**Read or discover the format first:** `file_action` has built-in, bounded readers for DOCX, XLSX, PDF and PPTX; these require no separate editor installation. For an **approved local path**, `file_action {op: "inspect", path: "/workspace/letter.docx"}` inspects the bytes, checks the actual format and offers matching providers where available; `op: "read"` extracts a bounded slice. For a **known extension but no local file**, including a ChatGPT Library URL ending in `.docx`, use `file_action {op: "providers", format: "docx"}`. Pass the extension alone, not the URL or filename. This is registry metadata lookup: it neither accesses nor downloads the referenced file. The result can report an installed provider, a `provider_offer`, an unavailable build, or no new offer (for example, after decline or an earlier offer).

**Available registry matches:** **WordCraft** (`artcraft.wordcraft`) covers DOCX, DOCM, DOTX, DOTM, RTF and ODT. **GridCraft** (`artcraft.gridcraft`) covers XLSX, XLSM, CSV and TSV. Both are registered as **in-development** optional ArtCraft providers, separately installable from official platform releases where available. DOCX/XLSX can still be inspected and read through the built-in broker without either app. For a local spreadsheet, inspect its real bytes; for a Library link with only a known extension, `file_action {op: "providers", format: "xlsx"}` discovers GridCraft without reading that link. A registry match or successful `providers` response does not mean the provider was installed or opened.

**Provider installation and consent:** If the user wants the offered editor, `file_edit {op: "install_provider", provider: "artcraft.wordcraft"}` or the corresponding `artcraft.gridcraft` id requests ParadigmEve's **native installation dialog**. Installation requires both an authorized user request and confirmation by the person at the computer. The download is bound to an official release asset and its published checksum; it must pass the readiness check. Respect **Decline** and **Not now** without immediately reoffering. No file content, tool response or model assertion counts as native approval. A separate native feature-loss confirmation is required for a broker-managed edit that would drop detected features. For example, WordCraft's DOCX preflight detects charts, SmartArt, shapes and equations; GridCraft's XLSX/XLSM preflight detects slicers, timelines, data models, external links and embedded objects. These are detected-risk checks, not a guarantee that every feature of every file round-trips.

**Edit or show:** After verifying the selected WordCraft/GridCraft provider is installed and ready, `file_edit {op: "provider_tools", provider: "artcraft.gridcraft"}` (or `artcraft.wordcraft`) lists that provider's actions on demand. `file_edit {op: "edit", provider: "artcraft.gridcraft", path: "/workspace/book.xlsx", steps: [...]}` drives the installed provider on a staged copy, validates the result and publishes a **new file** (by default `book (Eve edit).xlsx`); it never overwrites the source. For "show me editing," `file_edit {op: "open_visible", provider: "artcraft.wordcraft", path: "/workspace/letter.docx"}` opens a **copy** in the provider's GUI for authorized Computer Use when a desktop executable exists. Otherwise it returns `VISIBLE_UNAVAILABLE`; an opened GUI does not itself prove an edit or guarantee feature-loss detection on later manual saves. The original remains unchanged on both paths.

**Library file boundary:** A ChatGPT Library link is **not** a path under an approved local root and cannot be sent directly to `file_action inspect/read` or `file_edit edit/open_visible`. When the conversation exposes the file's native attachment value, `download_artifact` may save it to an approved local destination without overwriting; otherwise first obtain an accessible local copy. Only then inspect/edit that real file. Neither `providers` lookup nor an install request proves that the linked document was read, edited or even retrieved. If the broker provider is unavailable or declined, state that and discuss other apps only if the user wants alternatives.

## Schedule workspace versus Core MCP

Schedule is the durable workspace for the user's availability (`%schedule`) and Eve's routines
(`%evecron`). Its `#schedule` (also `#schedules`), `#myweek`, and `#routines` chat shortcuts are ordinary Quilt
references when those Quilts exist; they are context, not schedule authority. User availability
read/edit operations belong to the desktop preload/IPC API. Eve-routine state can also be listed and
changed conversationally through Core MCP's unified `schedule` tool when exact current chat identity
is proven. That tool binds source session/conversation identity itself and persists a bounded
continuation capsule with the routine. Using either API does not activate either Thread's standing
prompt; explicit `%schedule` or `%evecron` Thread opening remains a separate context action.

The same `schedule` tool owns exact running-chat completion through `action="complete"` and durable
`T…` evidence. It does not mutate the user's availability document directly. See
[Schedule workspace and Eve routines](13-schedules-and-routines.md) for the current API, availability,
duration and Started/Done evidence contract.

## The MCP kernel

`src/main/mcp/kernel.ts` is the shared execution layer underneath surface-specific registration. It owns:

- exact caller/request correlation;
- call context;
- capability enforcement;
- sandbox/workspace resolution;
- tool result formatting and safe errors;
- recording of calls and outcomes;
- worker lifecycle notices/messages;
- session input offers/acknowledgement;
- blocked-chat / continuation fences.

Tool names being visible is not itself execution authority.

### Pins / Threads / Quilts API

When session tools are exposed, Core also registers `pins`. `list` may read the durable catalog without
caller identity and can resolve only an exact `%Thread` or `#Quilt`; missing references remain missing
and ambiguous names fail closed. Mutations require exact current session + conversation identity.

`pin` targets a durable Thread id and accepts only an exact recorded session event or Plan id as its
source. `session read` supplies the recorded `E<number>` event reference used as `event_seq`; the Pins
tool does not infer a source from prose, title, or timestamp. `unpin` removes only the Pin.
`create_thread` creates one promptless durable Thread-shaped backing object plus any explicitly named
Quilts in the same durable operation. With zero Pins and no prompt, that object is presented as a
Concept until Pins are added. `create_concept` creates or reuses one exact zero-Pin, promptless
same-name backing Thread and sets its description; an existing same-name Quilt, prompted object or
Pins-bearing Thread fails closed instead of being reinterpreted. `set_quilt_description` updates one
exact wider Quilt after the user approved that enrichment. `associate_quilt` links an exact Thread to
an exact Quilt name, and may create that Quilt only when `create_if_missing=true` after the user
approved creating that exact Quilt. `%` is the Thread sigil, `#` is the Quilt sigil, and `@` remains
reserved for plugins/connectors.

## Monotonic schema exposure

ChatGPT caches connector tool snapshots. Removing a tool name from a running endpoint when the user changes permissions can turn a normal permission change into `UNKNOWN_TOOL` against a stale ChatGPT snapshot.

Therefore exposure is monotonic for the lifetime of an MCP endpoint:

- if a tool was already registered, its name may remain visible;
- the live handler rechecks current permission;
- revoked capability returns a controlled `TOOL_DISABLED`-style rejection instead of executing.

Likewise, `find` versus shell execution is decided carefully because their availability is mutually exclusive in one snapshot.

## Caller identity

The model does not get to assert “I am worker-2” or “this call belongs to chat X.” Authority comes from request/browser/session evidence collected outside tool arguments.

When exact identity is unavailable, behavior should narrow:

- relative workspace paths can be refused;
- worker-only mutations can be refused;
- browser actions cannot target a guessed chat;
- recorded data can still be read where safe, but cannot be silently rebound.

## Filesystem versus shell authority

Filesystem tools are constrained to approved roots through `sandbox.ts`.

The shell is intentionally different: when command execution is enabled, it runs with the user's OS privileges and is **not** confined to approved filesystem roots. This is why command execution is the highest-power local capability and should never be described as “sandboxed to the approved folder.”

### Browser/local resource boundary

The Core filesystem tools are how a ChatGPT conversation asks Eve to inspect approved local files;
the Companion bridge is not a second filesystem surface. Chrome owns browser state, while Electron's
main process owns local paths and resource preparation. Do not add bridge routes that accept arbitrary
paths or generically read/list/open local files.

When one browser operation legitimately needs local bytes, its main-process owner may use the shared
`browser-resource.ts` seam or an equivalent purpose-bound store. Electron resolves or snapshots the
source, keeps the path private, and exposes only opaque resource identity/metadata and bounded bytes.
The feature must prove its exact operation/document ownership before transfer. This is the same model
used by native input attachments: a staged opaque attachment id can cross the browser boundary; its
source path cannot.

## Computer use

Computer-use tools are capability gated and, for stateful/indexed input, rely on exact browser/conversation evidence. Desktop screenshots and native UI actions are main-process/native-helper operations, not arbitrary renderer powers.

Browser recovery is not implemented by giving the model a generic Chrome debugging session. Eve uses its native computer layer and Companion protocol for its own dedicated browser surface.

## Tunnels

Connection supports the configured tunnel backend and publishes per-surface MCP paths.

- Core is required.
- Plugins is optional.
- The separate `desktop` surface is surfaced only when `desktopTunnelId` is configured.
- On whole-origin tunnel modes, multiple surfaces can share the public origin at distinct local paths.
- On OpenAI Secure Tunnels, optional independent surfaces need their own tunnel id.

The API key is read from encrypted secrets; the renderer cannot read it back.

---

> **Implementation contracts.** The sections below moved here unchanged from the former single-file
> `AGENTS.md` map. Their § numbers are kept so references such as “§14” still resolve; the
> [Vault index](README.md#former-agentsmd-sections) lists where each section lives.

## 6. MCP surfaces, instructions and code mode

**Intent:** ChatGPT discovers capabilities in three comprehensible groups and every invocation
still checks live policy. Schema visibility is never the security boundary.

| Surface | Advertised operations under current eligibility |
| --- | --- |
| Core — `paradigmeve-core` | `read`, `view_image`, `find` when command execution is off, `apply_patch`, `exec_command`/`write_stdin`, `download_artifact`, recorded `session`, `update_plan`, exact-source `pins`, `agents`, `lan`, guarded `self_settings`, `move_eve_here`, `session_finish`, `work_context`, `expenses`, code-mode `exec`. |
| Desktop — `paradigmeve-desktop` | Windows: 13 Window2 operations, separately permissioned `read_clipboard`/`write_clipboard`, and `exec` with `sky`. macOS: `observe`, `computer`, `exec`. Relevant live capabilities are required. |
| Plugins — `paradigmeve-plugins` | Enabled external tools with their upstream names and schemas, plus code-mode `exec` when that composition name is available. |

`read` needs read/browse/metadata as appropriate; images need read; patch checks each hunk's
create/edit/move/delete permission; command controls both terminal tools; downloads need
`saveArtifact`. Recording controls `session`, `update_plan` and model-facing `pins`; multi-agent controls `agents`;
the finish setting controls `session_finish`. Windows publishes four observation methods under
screen access, nine input/launch methods under control, and clipboard methods under their own
permissions. Multiline `type_text` additionally requires clipboard write. macOS `computer`
registration can exist for control or clipboard access; each action rechecks its own permission.

ChatGPT may cache one surface's complete tool list. Core/Desktop exposure is monotonic for an
endpoint lifetime: a previously exposed schema can remain while a revoked handler returns
`TOOL_DISABLED`. The `find` vs terminal choice freezes at discovery. Reconnect establishes a
new clean shape; current config still governs every call. Each registrar refuses foreign names;
there is no merged hidden dispatch. Plugin exposure follows its separate dynamic manager.

`tool-declarations.ts` caches immutable declarations/JSON conversion. SDK servers and handler
closures remain request-local, and child calls obtain a fresh live context. Avoid caching the
permission decision alongside a cached schema.

### Instructions must actually reach the executor

MCP initialize advertises `instructions`; successful initialize does not prove the host showed
all of them to the model. Only the first normal message of a new chat and the first bootstrap
of a newly spawned worker use `session/prompt.ts` to freeze the complete current Core instructions
plus the explicitly linked project's root `AGENTS.md` inside the existing `PARADIGMEVE_CONTEXT` frame. Legacy `COS_CONTEXT` frames remain readable for older sessions.
Before that normal fresh-chat framing, an authored opening input may explicitly select durable Pins
context: user-facing `#quilt` is broad pinned context across a Quilt's pinned Threads and never
activates member Thread descriptions/prompts, while `%thread` activates one specific durable Thread/work-context
binding. Starting a chat explicitly from a Thread uses that same activated-Thread behavior. The
parser/storage still use legacy Quilt field names internally for Thread identity and legacy Collection
field names internally for Quilt grouping. `%thread` and `#quilt` are not interchangeable. `#` is the
Quilt sigil; do not teach “tag” as product syntax or pair it with `@`, which is reserved for plugins.
An activated Thread contributes its durable description first, then its optional editable Thread prompt,
then its saved Pins; a **Prompt** Pin is instead one saved authored user message. A zero-Pin, promptless
Thread is a Concept regardless of description or Link: only when no exact same-name wider Quilt exists,
`#name` may resolve to that backing Thread and load any description without prompt semantics.
A wider Quilt may contribute its own durable description; if it is missing, Eve may offer to fill it from
related durable chats or web sources, but waits for the user's choice before writing. The current authored
request remains last and wins over older Thread guidance or pinned context.
Renderer navigation is deliberately different from context activation: a uniquely resolved, exact
`%ThreadName` reference, including an item in the `%instructions` category, is one-link/one-destination
navigation. Its default destination is that Thread's existing
edit/detail view; an authored safe destination link overrides that default. A uniquely resolved Concept
`#name` opens the Concepts overview instead of the single Thread detail, with that exact Concept as the
only active filter. The Concepts overview always exposes the available `#Quilt` pills, and Quilt filters
are additive: selecting more pills expands the visible Concept set by union so the many-to-many
Concept↔Quilt relationships are visible rather than hidden behind one replacement filter.
Overview membership is a projection, not the same thing as Concept classification: with no Quilt
filter the surface shows native Concept Threads; an active Quilt filter may additionally admit any
non-archived member Thread, including a Thread that is otherwise an Instruction or has no description.
It must not silently expand to every Thread. Descriptionless admitted cards keep the normal
description-slot height and offer the localized Generate-description action rather than blank space.
The Thread-start composer shows the selected Thread and offers an editable getting-started request
when no draft exists. Existing drafts, including deliberately emptied drafts, survive navigation.
Send carries the durable Thread id; main resolves its current prompt and Pins at opening preparation,
including prompt-only starter Threads with zero Pins. A click alone is not a delivery receipt.
`main/pins-context.ts` keeps the old material clearly delimited before the current authored request;
an unresolved typed reference is not an admission failure and an ordinary hashtag is not creation
intent. For a clearly product-scoped missing `#Quilt`, recovery is deterministic: exact lookup,
surface the exact unmatched reference, search durable session history, reuse an appropriate existing
Thread or obtain approval before creating one, Pin only exact recorded sources, associate the approved
Quilt, verify the exact catalog result, then continue the original request. No fuzzy routing or silent
creation is allowed; association to an existing Thread is one strict durable mutation.
this is prompt preparation, not an MCP tool or a second session-history authority.
The opening outbox input / new-worker command owns this eligibility; no history scan or extra
sent flag decides it. Existing-chat messages, Goal/Loop continuations, plan checkpoints, worker
revivals, compaction requests and resumed-chat bootstraps receive no appended setup block.
Decision/planner helpers keep their separate role-specific contract. Selecting Goal/Loop for
a normal new executor chat does not turn it into a helper. Direct user sends in Chrome are
not intercepted.

`mcp/coding-instructions.ts` contains adapted upstream collaboration prose with provenance;
`mcp/instructions.ts` adds currently available local-tool guidance and the user's bounded
standing additions. There is no extra instructions tool or per-chat “already sent prompt” flag.

The whole message has a **96,000 UTF-16-character ceiling**, plus the input transport's UTF-8
byte envelope. For eligible openings, authored work and complete Core instructions are mandatory;
only AGENTS content spends remaining room. Read it as a bounded UTF-8 prefix, validate the same project/root/read
permission after the await, and cut with an in-context instruction to read the remainder.
Only strict framing is hidden in the local/native display. Original bytes, receipt comparison,
recording and token accounting keep the complete delivered text. `userMessageSource()` supplies
native source text; rendered Markdown whitespace alone cannot prove a send. Local and native prompt
presentation, including worker messages without outbox receipts, ignores provider-added whitespace before the frame, then validates its exact
internal length and closing boundary; authored whitespace after the frame remains intact.

### `exec({code})` composes tools; it is not a shell

Code mode offers top-level await, `tools.<name>(args)`, `Promise.all`, `text(...)` and `image(...)`
within one surface. Exact request/conversation/durable-session proof is required before evaluation.
QuickJS runs in a disposable Node Worker with no ambient Node, filesystem or network API.
Children reuse the same registrar, validation, handler and dispatcher, inherit exact caller proof
and recheck live permissions/roots. Each child records fresh evidence; only the outer response
owns input, agent inbox and automatic terminal-result delivery. Finish signals remain direct.
A script that calls `tools.<name>` for a name this surface does not offer (a feature check such
as `typeof tools.x` does not count) gets one extra `UNKNOWN_TOOL_NAMES` text item at the end of
its result. It names the connector that owns the tool, says when Core declares it but it is not enabled,
and, when two connectors share a Secure Tunnel ID, says that ChatGPT can then send a script to the
wrong connector. It changes neither `isError` nor what the script ran.

Only explicitly emitted text/images enter the result, except Windows Desktop's `sky.get_window_state`
adapter automatically forwards its native MCP image blocks. Its returned value contains only
screenshot metadata, so `text(state)` cannot duplicate pixels into the text budget. `sky` calls the same registered tools,
unwraps `structuredContent.value` and throws tool failures; `nodeRepl.write` aliases `text`.
It adds no persistent Node runtime or independent execution authority. Image emissions are decoded/validated by
the same authority as `view_image`. Plugin output keeps manager redaction. Runtime limits are
centralized in `CODE_MODE_LIMITS` (code, CPU, wall time, memory, calls, concurrency and all result
representations). There is no yield/resume pragma or persistent JavaScript session. Termination
stops new admission, but cannot undo accepted external actions; those keep their normal
execution/recording lifetime. Never add another executor or delivery queue to compensate.
Failure responses report the number of dispatched child calls so a later script/refresh error
does not invite replaying successful input. Unemitted values and arbitrary exception text stay
private. Timers such as `setTimeout` are unavailable, including through the Windows `sky` adapter.

## 10. Files, terminal, patches, images and downloads

**Intent:** provide a predictable coding loop without requiring a Codex installation or launching
a Codex model. The TypeScript ports reuse selected upstream behavior; the app adds permissions,
identity, evidence and host-specific integration around them.

### Reading, searching and patching

`read` batches paths, lists directories, handles globs and returns numbered bounded text.
`tools-core.ts` owns its contract; `codex/read-backend.ts` owns listing/decoding semantics;
`codex/filesystem.ts` is primitives; `sandbox.ts` is authorization. Do not push policy into
low-level primitives and assume every public caller became safe. Search uses bundled-first
ripgrep when commands are allowed, or `find` with `search.ts` when they are not.

`apply_patch` accepts Codex V4A in the MCP `patch` string. Its parser, grammar, hunk matching,
text/line-ending representation and replacement application live in `codex/apply-patch/*`.
The wrapper separately checks each hunk's create/edit/move/delete permission, paths and workspace,
then records changes. Ordered exact/whitespace/limited-Unicode content matching never relaxes
path authority. Shell-style `apply_patch` interception lives above the parser; quoting, `cd`
and shell control flow are invocation problems, not grammar fixes.

Partial multi-file failure uses bounded rollback snapshots. Restore only a path still matching
what **this patch produced**; a concurrent external edit must never be overwritten. Preserve
the port's explicit line-ending mode and readable parse/match failures.

### Terminal execution and custody

One app-lifetime `codex/manager.ts` owns `UnifiedExecProcessManager`. `exec_command` runs a shell,
returns output or a process `session_id`; `write_stdin` continues that same process, sends input
or drains output. Caller isolation is in `ownership.ts`, not separate managers per request.

The owner is the **durable local session principal** established by correlation. A→B compaction
keeps that principal, so B can continue A's live terminal without an adoption/move fallback.
Another session/worker cannot poll or write it. Anonymous process custody is non-adoptable.

`env.ts` is the shared child-environment authority: Windows key names are case-insensitive,
so use its accessors rather than creating both `Path` and `PATH`. Preserve inherited values.
`toolchain.ts` fills missing/unreachable Windows JDK/Go configuration conservatively; never
override an explicit reachable toolchain. `exec-hints.ts` repairs only provable narrow shell
mismatches and otherwise abstains. Ambiguous globs/control flow keep original command semantics.
Search exit 1 can mean no matches; git/build/mutation failure must not be relabeled success.
ChatGPT gives the model a tool's structured result rather than its text, so `exec_command`'s
advisory `Note:` lines (batch exit codes, benign exits, recovery hints, a still-running identical
command from the same chat and folder) also travel in structured `supplemental_context`, and the
kernel appends delivery's own app context (input, inbox, background output) there after them.
A still-running identical command is only noted; the new launch is never refused.

`cmds` runs sequential sections in **one shell**, preserving cwd/environment. Continue after
ordinary nonzero exits and report section exits plus the first nonzero aggregate status. Random
framing markers stay internal, including across chunk/poll boundaries. A later failure must not
invite repeating earlier successful mutations. PowerShell/Bash behavior is explicit and tested.

Collection and response budgets differ. Head/tail buffering retains a bounded stable head and
rolling tail with omission counts; UTF-8/token serialization separately bounds returned output.
The connector accepts legacy `max_output_tokens` but enforces its fixed response ceiling.
Never solve a display overflow by silently discarding durable/owed data.

Completed background output is still owned data. The manager does not evict exited unread
sessions to free capacity. Four unread completed results block another spawn for that owner
with `EXEC_RESULTS_UNREAD` before a process starts. Running servers/tails do not consume that
completed-result limit and are not auto-killed or polled.

Completed results can follow automatically in later exact-owner **outer** tool responses,
one bounded UTF-8-safe page within remaining response space. An offer does not drain bytes.
Successful local publication followed by a later exact-owner invocation acknowledges the page,
even if both calls share a generation request id; older concurrent calls cannot. Failed
publication reoffers it. Explicit `write_stdin` can drain the remaining unacknowledged suffix.
After 120 seconds without attendance, a running process can contribute one owner-scoped
reminder; reading diagnostic state does not consume it. Blocked/compacting/superseded sources
and nested code-mode calls do not receive or acknowledge these automatic pages.

### Images and ChatGPT artifacts

`view_image` accepts PNG/JPEG/GIF/WebP under an 8 MiB raw bound and explicit decoded-pixel/memory
limits. Structural checks plus actual Sharp/libvips pixel decoding precede an MCP image block.
Metadata parsing alone is insufficient. Return one native image copy, not duplicate base64 in
structured output. Its validator also owns code-mode emitted-image admission.

`download_artifact` saves a native ChatGPT/user-supplied file reference into an approved
destination. `artifact-fetch.ts` validates the allowed HTTPS source and every redirect;
`artifact-download.ts` bounds streaming, timeout and cleanup; `artifact-target.ts` owns the
exclusive partial file, file identity and no-overwrite publication. Recheck bytes/target at
publication. Do not put signed URLs/file objects/base64 into shell text or regenerate a user's
file as a substitute. The default file cap comes from `config.ts::DEFAULT_ARTIFACTS` (20 MiB).
