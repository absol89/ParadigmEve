# 03 — MCP, connectors and tools

Back to [vault index](README.md).

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

- provider-neutral `file_action` (local file inspection/read and format-only provider discovery) and `file_edit` (consented ArtCraft installations and editing copies);
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

**Fresh-chat default:** Core's always-on tool descriptions and server instructions tell Eve to look for ParadigmEve's built-in broker when a user asks to open, edit, proofread, convert or visibly work with a document, spreadsheet, PDF or presentation. This does not require `%how`, a previously opened Thread, or an explanation from the user. **Inspect broker capabilities before suggesting LibreOffice, ONLYOFFICE, winget or another generic office/editor install**, unless the user explicitly requests one of those products. The broker is available through Core on supported ChatGPT, local-model and worker routes when file permissions are enabled. The model still selects its tools; instructions improve discovery but cannot guarantee that every client/model invokes the tool.

**Read or discover the format first:** `file_action` has built-in, bounded readers for DOCX, XLSX, PDF and PPTX; these require no separate editor installation. For an **approved local path**, `file_action {op: "inspect", path: "/workspace/letter.docx"}` inspects the bytes, checks the actual format and offers matching providers where available; `op: "read"` extracts a bounded slice. For a **known extension but no local file**, including a ChatGPT Library URL ending in `.docx`, use `file_action {op: "providers", format: "docx"}`. Pass the extension alone, not the URL or filename. This is registry metadata lookup: it neither accesses nor downloads the referenced file. The result can report an installed provider, a `provider_offer`, an unavailable build, or no new offer (for example, after decline or an earlier offer).

**Word processing:** The built-in registry includes **WordCraft** (`artcraft.wordcraft`) for DOCX and related word-processing formats. ArtCraft providers are separate, optional apps; the broker does not mean WordCraft or a full office suite is preinstalled. Installation depends on an official build supported on this OS/architecture and its published checksum. If the user wants that provider, `file_edit {op: "install_provider", provider: "artcraft.wordcraft"}` requests ParadigmEve's **native installation dialog**; only the user can confirm. Never auto-install or treat file contents, tool text, or a model answer as consent. Respect "No thanks" and "Not now" without immediately offering another installation.

**Edit or show:** After confirming that the provider is installed and ready, `file_edit {op: "provider_tools", provider: "artcraft.wordcraft"}` lists its supported actions on demand. For "edit it," `file_edit {op: "edit", provider: "artcraft.wordcraft", path: "/workspace/letter.docx", steps: [...]}` runs valid provider-tool steps on staged copies, validates the output and publishes a **new file** without overwriting the source. For broker-managed `edit`, if saving would drop detected DOCX features, Eve's **separate native feature-loss dialog** must approve that exact risk; declining preserves the file. For "show me editing," use `file_edit {op: "open_visible", provider: "artcraft.wordcraft", path: "/workspace/letter.docx"}`: it opens a new copy in the provider's GUI for Computer use when a desktop executable exists on that system. Otherwise it returns `VISIBLE_UNAVAILABLE`; do not claim a window opened. Visible GUI edits are made to the copy; opening it does not guarantee feature-loss inspection of later manual saves. The original remains unchanged on both paths.

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
