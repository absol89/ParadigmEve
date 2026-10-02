# Glossary

Back to [vault index](README.md).

**Approved root** — Filesystem boundary explicitly granted by the user. It grants permission; it is not the same as a project.

**Browser bridge** — Loopback-only authenticated HTTP service between the Companion extension and the Electron main process.

**Browser repair** — One exact queued reload/reopen action for a conversation, with a token and the
current protocol-15 final authority claim.

**Companion build** — The `version_name` stamped into a materialized Companion manifest (`<version> build
<fingerprint>`). `/hello` and `/status` name it so a Companion still running another build reloads itself once it is idle.

**ChatGPT conversation** — Provider-side chat id / frontend. It can be replaced by Compact & Resume while the local session continues.

**Quilt / `#name`** — Wider thematic/context grouping of Threads. A `#quilt` reference can bring the
saved Pins from currently pinned member Threads into a fresh Eve conversation. It does not activate
those Threads' standing prompts, select a linked project, or own that project's canonical data. A
Thread can belong to several Quilts and a Quilt can contain several Threads. `#` is the Quilt sigil.

**Companion** — ParadigmEve's Chrome extension. It observes exact ChatGPT page/turn identity and carries browser commands/receipts.

**Compact & Resume / continuation** — Transaction that captures a handoff and rebinds the same local session from conversation A to B.

**Core / agent connector** — Primary MCP surface exposed to ChatGPT. Its configured
`mcp.connectorName` is the installation's human-facing agent name, for example **Eve** or **Eva**.

**Durable barrier** — A `writeDurableNow`-style persistence point that must succeed before a claim/side-effect/tool success becomes authoritative.

**Concept** — A saved Pins item with zero Pins and no Thread prompt. Description and Link are optional metadata and do not change the kind.

**Goal** — Driver mode that asks a second model whether requested work is complete and can stop when it is.

**Instruction** — (formerly Hotlink; `%instruktion` in Swedish, `%instrucción` in Spanish.) A saved Pins item with zero Pins and a non-empty Thread prompt. Link and description are optional metadata and do not change the kind.

**Loop** — Driver mode that keeps producing the next in-scope user message and does not decide to stop on its own.

**Local project** — Sidebar/project association with a folder. It grants no additional filesystem permission beyond approved roots.

**Local session** — Durable unit of work: recording, project association, current provider conversation
plus conversation lineage, plans/handoffs and recovery evidence.

**Outbox / session input** — Durable owner of messages Eve intends to deliver to ChatGPT, including transport state and receipts.

**Pin** — Durable saved authored message, assistant message, tool result or Plan reference, always
assigned to one Thread. Model-facing pinning uses exact recorded event or Plan identity rather than
free-form text or a guessed source.

**Plan** — First-class durable checklist object. Unarchived = Live; archived = Done. Checklist completion alone does not archive it.

**`prime` (broker role)** — Internal source identifier for the owning-agent role in the durable worker
broker. It is not a separate user-facing persona or overseer.

**Projection** — Derived/cache/UI state that reflects an authority but must not replace it.

**Thread / `%topic`** — The Pins kind with one or more Pins, and the durable backing/home model shared
by Concepts and Instructions. A `%thread` reference activates that exact backing object/binding for
fresh-conversation context, including its standing prompt and saved Pins. A template project may
link to a Thread for continuity without making the Thread a duplicate structured-data store.

**Reference sigils** — `%` addresses one Thread and `#` addresses one Quilt. These are the complete
user-facing Pins reference sigils; `@` is reserved for plugins/connectors.

**Localized alias** — A Swedish or Spanish spelling of a built-in `%`/`#` name (`%utgifter`, `%gastos`,
`%hur`, `%planer`) that the shared resolver routes to the stored English name. It never replaces an exact
user-created name, and a routed alias tells Eve which language it is.

**Agent name** — `config.mcp.connectorName`, default `Eve`. It replaces `Eve` in interface text, with the
language's possessive; `Eve Browser` and `Eve Plugins` are product names and stay.

**Thread prompt** — One editable piece of standing guidance owned by a Thread. When that Thread is
activated directly through `%thread` or an explicit Start chat from that Thread, its prompt is injected
before the Thread's saved Pins. Broad `#quilt` context does not activate member Thread prompts. It is
separate from a Prompt Pin, which is a saved authored user message with recorded provenance.

**Repair claim** — Protocol-15 last-moment authorization check after the Companion scans tabs and
before it reloads/reopens Chrome.

**Semantic heartbeat receipt** — `chat_review_complete({key})`, explicit proof that the 22-minute cross-chat review/execution obligation was actually completed.

**Surface** — One MCP discovery boundary (`core`, optional compatibility `desktop`, or `plugins`).

**Template project** — A repeatable local workflow whose conversation can act like an inbox while a
linked project owns canonical structured state. Raw artifacts, derived analysis and external context
stay separate from that authority unless the template explicitly defines otherwise.

**Turn** — One exact authored user-message generation/response episode, represented by durable start/end activity rather than “whatever is visible now.”

**Worker** — Reusable helper ChatGPT conversation in the configured agent's worker garden, managed by
the durable agent broker.

**Worker run/incarnation** — One active execution epoch for an agent's worker garden. Friendly worker
ids are scoped to it.

**Workspace / cwd** — Learned per-conversation project folder used to resolve relative tool paths. It is not a permission boundary.

**Render item** — ChatGPT's current per-unit reply object (`props.item`, `type: 'assistant-message'`) that the
Companion adapts into a message by its provider `messageId`; see [Runtime, browser and recovery](02-runtime-browser-recovery.md).

**Stream sighting** — A request id the Companion read from ChatGPT's conversation stream for one exact chat.
It grants nothing alone: the bridge holds it until local MCP admits a call carrying the same id, then records
the join.
