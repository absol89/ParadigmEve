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
