# 07 — Plugins and connector refresh

Back to [vault index](README.md).

There are two different things that are easy to call “plugins”:

1. **External MCP plugins installed in ParadigmEve** — Blender, Memory, remote services, custom MCP servers, etc.
2. **ChatGPT connector schema refresh** — keeping ChatGPT's cached connector tool declaration synchronized with the local tool surface.

They have different authorities.

## External plugin runtime

`src/main/plugins/manager.ts` owns installed records and runtime connections.

Supported source families include:

- pinned npm recipes;
- pinned Python recipes;
- explicit local executable + args;
- MCPB bundles;
- HTTPS/loopback Streamable HTTP servers;
- reviewed GitHub recipe mappings;
- OAuth remote integrations.

Reviewed catalog recipes live in `src/main/plugins/catalog.ts`.

Installed metadata is durable under the `plugins` state; per-plugin files live in the app's userData plugin area. Credentials are referenced by key and stored only through `secrets.ts`.

## Plugin safety boundaries

- Plugin config refuses secret-looking keys; credentials go to secure credential fields.
- Remote HTTP responses are bounded.
- Discovery/schema cardinality is bounded.
- Result text/metadata is credential-redacted before leaving the manager.
- Tool-name conflicts are excluded rather than silently renamed.
- Read-only mode refuses external plugin execution because ParadigmEve cannot prove an arbitrary upstream process is non-mutating.
- Plugin subprocesses have normal user OS authority; they do **not** inherit ParadigmEve's approved-root filesystem sandbox.

See [`docs/plugins.md`](../plugins.md) for user/setup details.

## ChatGPT schema publication

`src/main/connection.ts` publishes the live declarations for Core/Desktop/Plugins. `src/main/plugin-refresh.ts` tracks what ChatGPT has been proven to know about each surface.

The schema id is a SHA-256 hash over canonical tool **name + description + input schema**. A changed visible contract can require ChatGPT refresh; local version strings alone do not.

Schema changes debounce for 20 seconds after an already-live declaration changes so settings edits do not open maintenance for every intermediate shape.

## Exact connector identity

Refresh records track the ChatGPT app id (`asdk_app_...`) once the browser has proven it. That id belongs to one installed connector identity.

If the connector is renamed, the prior app-id mapping is dropped rather than being carried forward as if it still proved identity.

At the same time, a **name-only** change does not justify hijacking the user's active chat by opening Plugins settings. A later real schema change can rediscover exact identity.

## Identity-only refresh rows

An identity-only row with no proven app id, no attempted refresh click and no completed schema proof
cannot justify repeatedly reopening Plugins settings. The current refresh owner marks that unchanged
generation **deferred** instead. A later declaration change can create real new refresh work.

## Claim before click

When automatic refresh will click ChatGPT's Refresh control:

1. browser proves connector name/app id/tool declaration;
2. `claimPluginRefresh` validates it against the exact pending generation;
3. durable row records `attempted = true` **before the click**;
4. browser performs the external side effect;
5. a matching post-refresh tool declaration closes the row via `completePluginRefresh`.

An ambiguous post-click result is never automatically retried as though nothing happened.

If the provider surface cannot be refreshed safely in place, `requireManualPluginRefresh` records that state and stops automatic browser maintenance from repeatedly reopening settings.

## Reinstall versus connector refresh

Companion extension recovery and ChatGPT connector refresh are intentionally separate.

Reinstall recovery may reload the unpacked Chrome Companion, but that does **not** prove a ChatGPT connector's cached MCP schema changed. `index.ts` explicitly avoids opening ChatGPT Plugins settings merely because the Companion was reloaded.

This separation prevents upgrade recovery from stealing the user's active chat for unrelated connector identity maintenance.

---

> **Implementation contracts.** The sections below moved here unchanged from the former single-file
> `AGENTS.md` map. Their § numbers are kept so references such as “§14” still resolve; the
> [Vault index](README.md#former-agentsmd-sections) lists where each section lives.

## 18. Plugins, file broker and connections

### Plugins: installation, execution and connector refresh

The optional Plugins connector proxies installed enabled MCP servers. `catalog.ts` describes
reviewed entries; `installer.ts` owns installation/package materialization; `manager.ts` owns
stdio/remote clients; `exposure.ts` owns accepted live tools; `oauth.ts` owns authorization.
Local npm/Python/MCPB packages and remote endpoints have different setup needs. Editor plugins
such as Blender also need the editor-side addon and a successful readiness probe.

Enabled installations restore/connect in the background and remain available while idle; there
is no idle-eviction/restart loop. Disable/uninstall revokes exposure synchronously before slow
shutdown. Accept bounded validated schemas (up to 64 tools, bounded schema bytes), preserve
upstream names, and fail closed on collisions, including retained disabled-name claims. A
cached unauthorized schema is not live exposure. External servers retain their own OS/account
permissions; the app's approved-path wrapper is not an OS sandbox around a third-party process.

Remote OAuth uses endpoint-scoped encrypted credentials and SDK registration/PKCE/refresh.
Only explicit sign-in opens the browser/loopback authorization flow; ordinary reconnect does
not auto-register or open login pages. Local status/probe, installed, enabled, authenticated,
editor-ready and published are distinct states. Do not repeat an ambiguous mutating tool call
just because a remote connection dropped. Sanitize returned/logged credentials at the boundary
without silently changing authored tool arguments or corrupting opaque image bytes.
Official npm Playwright defaults to upstream `PLAYWRIGHT_MCP_CODEGEN=none`; explicit launch
configuration takes precedence. Redaction covers recognizable credentials in results, recorded
arguments and overflow assets; manager and dispatcher must not repeatedly sanitize the same body.

The Plugins UI keeps an unconfigured setup card prominent and projects a compact setup row
once saved tunnel identity or a live endpoint exists, including offline restarts. It persistently
explains that ChatGPT must refresh its connector after installation/tool changes. Checking local
status cannot refresh ChatGPT's cached declarations.

`plugin-refresh.ts` applies to Core, Desktop and Plugins. Its fingerprint includes names,
descriptions and input schemas, not app-version/instruction churn. Changes debounce for 20s.
Refresh targets the exact account-observed installed app id, durably claims before clicking,
and completes only after observed declarations fully match. Automatic refresh is opt-in;
unsupported/manual-required stays visible instead of opening more helper tabs.

### File broker and ArtCraft file apps

**Always-on discovery contract:** An ordinary fresh, unfiled ChatGPT/Eve conversation must
discover the built-in file broker for natural-language document work without `%how`, a selected
Thread, prior chat memory, or this repository's project-scoped `AGENTS.md`. The Core connector's
pre-discovery description (`src/main/mcp/surfaces.ts`) must advertise the capability; its delivered
instructions (`src/main/mcp/instructions.ts`, including `src/main/session/prompt.ts` fresh-chat framing) must direct
`file_action` provider lookup first. For an approved local path use `inspect`; for only an extension
or ChatGPT Library link use format-only `providers` without pretending the Library URL is a local
path. Prefer ready ArtCraft providers to generic installer searches; `file_edit` uses a separate
new copy, discovered provider tools, explicit native installation/feature-loss consent and
actual Computer Use for visible editing. Keep the detailed workflow in
`docs/vault/03-mcp-connectors-and-tools.md`, not duplicated here.

`file_action` (read-only: `inspect`, bounded `read`, format-only `providers`) and `file_edit` (changes) are the only Core
file-broker tools on every chat route (ChatGPT, local Ollama/OpenRouter chats and workers). Built-in
XLSX/DOCX/PDF/PPTX readers are the zero-install fallback; PDF.js runs in a killable worker. Results
are bounded before they reach a model, labelled as data, and `contentRecipient` records the route
that received them. `file-capabilities.ts` is data only: the 13 ArtCraft apps, their formats,
official repos and per-OS/arch asset templates. Nothing is bundled or preinstalled. A matching file
yields a `provider_offer` (once per conversation for built-in formats); `file_edit install_provider`
only opens `file-provider-consent.ts`'s native dialog, which the model and file content cannot
answer. On yes, `file-provider-install.ts` reads the latest stable release, requires its published
SHA-256 for this machine's single asset, verifies the bytes, extracts through the plugin installer's
validated unzip and installs per-user as an `artcraft` PluginManager row. Those rows never publish
or claim names on any connector; only `pluginManager.call(..., { broker })` reaches them. "No
thanks" is durable per app until reset in Plugins. Craft-app edits never modify the source file:
`file_edit edit` (`file-edit-transaction.ts`) refuses a source another program has open (Office
owner file, LibreOffice lock, EBUSY), refuses documented feature loss (`unpreserved` in the
registry) unless `allow_feature_loss`, runs the app's own tools (listed on demand by
`provider_tools`) against a staged copy with `{{input}}`/`{{output}}` as the only file names any
argument may carry, re-validates the output with the built-in reader, reports a bounded
structural diff, and publishes a new file by hard link (it must not exist). A failed publish keeps
the staged result beside the destination and reports it. Edits run one at a time per app.
"Just do it" is `edit` (headless MCP); "show me / teach me" is `open_visible`, which makes the same
kind of new copy and opens it in the app's own window (its desktop executable, found in the private
install) for the model to drive with Desktop/Computer-use tools. The op the model chose from the
user's request is the only router; no file content selects a mode. A macOS install has only the
CLI, so `open_visible` says no window is available there.

### Connections, tunnels and diagnostics

`connection.ts` serializes endpoint/tunnel generations and publishes only live eligible surfaces.
Approved-root requirements are surface/capability decisions, not whether the extension paired.
Separate local listener health, public tunnel reachability, ChatGPT connector configuration and
browser attachment in both status and diagnosis. Stale connect/disconnect results cannot replace
a newer endpoint. Secret paths/tokens are not public diagnostics.

`tunnel/*` owns pinned-client discovery, child lifetime, health metrics and confirmed outages;
`diagnostics.ts` tests the chain hop by hop. Transient health evidence must not produce repeated
replacement tunnels or claim a broken provider was repaired. Update checks (§20), browser wake
and MCP connection have separate lifecycles.
