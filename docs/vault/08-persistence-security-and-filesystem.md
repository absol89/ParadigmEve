# 08 — Persistence, security and filesystem

Back to [vault index](README.md).

## userData is the local durable root

Electron's userData directory holds several classes of state with different safety rules.

Conceptual layout:

```text
userData/
  config.json
  secrets.bin
  state/
    swarm.json
    retired-workers.json
    continuations.json
    session-input.json
    pins.json
    plans.json
    plugin-refresh.json
    plugins.json
    ...
  docs/
    vault/                 # managed mirror of the shipped current manual
  sessions/
  archive/
    archive-manifest.json
    sessions/              # append-only semantic archive evidence
    blobs/                 # SHA-256-addressed retained bytes
    site/                  # rebuildable static HTML recovery browser
  plugins/
  private-updates/
  updates/
  setup-browser-profile/
  RECOVERY.md
  RECOVERY-RUNNING.json
  app.log
```

Exact platform path is Electron-controlled; code should use `app.getPath('userData')` rather than hard-code it.

## Durable JSON store

`src/main/durable.ts` owns small state documents under `state/`.

Writes use temp-file + atomic rename. Two write modes are important:

- `writeDurableSoon` — coalesced background projection for state that can safely lag briefly;
- `writeDurableNow` — immediate generation barrier for an acceptance/ownership transition that must land before an external side effect or tool success is published.

Cross-file transaction order is still the caller's responsibility. `durable.ts` cannot make two different JSON documents atomic together.

### Fail-soft versus strict reads

- `readDurable` can return null on corrupt operational cache state after logging the problem.
- `readDurableStrict` treats malformed personal/authored state as a hard error.

Pins/Threads/Quilts and Plans use the strict path because “corrupt” must not mean “empty, safe to overwrite.”

## Config

`src/main/config.ts` validates `config.json` on every load.

Config contains non-secret choices:

- approved roots;
- capabilities/read-only mode;
- tunnel ids/settings;
- UI preferences;
- recording/retention/compaction;
- multi-agent settings;
- Goal/Loop settings;
- MCP instruction text.

A corrupt config falls back conservatively rather than silently receiving fresh-install permissive defaults.

Settings mutation is serialized and published only after the new config is atomically written.

## Secrets

`src/main/secrets.ts` owns `secrets.bin` using Electron `safeStorage`:

- DPAPI on Windows;
- Keychain on macOS;
- Secret Service/keyring on Linux.

Linux's insecure hard-coded-key fallback is explicitly rejected.

Examples stored here:

- OpenAI tunnel key;
- Companion bridge token;
- Goal/OpenRouter/custom-provider keys;
- external plugin credentials.

The renderer cannot read them.

## Filesystem sandbox

`src/main/sandbox.ts` maps model-facing paths to approved roots.

Model-facing files look like:

```text
/project/src/main/index.ts
```

The sandbox can also accept a native absolute path copied from command output **only if** it resolves back inside an approved root.

Containment uses real/canonical paths to defend against:

- symlinks;
- Windows junctions/reparse points;
- root directories replaced after approval;
- lexical traversal (`..`);
- Windows device names / ADS / invalid path forms.

The boundary is enforced in code, not prompts.

Two app-owned namespaces are deliberately **not** stored as ordinary approved Workspace roots:

- `/appdata` — ParadigmEve's current userData folder (`%APPDATA%\ParadigmEve` on Windows);
- `/paradigmeve` — the directory containing the running packaged ParadigmEve executable, including a custom installer-selected location.

These are runtime-managed self-maintenance roots. The Companion must prove the exact current Eve/Eva
owner conversation before either namespace resolves. That owner may inspect `/appdata` through
read-only file tools under the normal read permissions without enabling settings authority. Any
mutating or command access to `/appdata`, and any access to `/paradigmeve`, requires
`eveAuthority.changeSettings`. Workers, unrelated chats and unattributed calls do not inherit these
roots. Ordinary user-approved roots remain independent and keep their normal permissions.

`exec_command` remains shell-equivalent after the user grants Command permission: its **starting
cwd** is still resolved through the same root/identity gate, but a spawned shell is not an OS
sandbox. Managed roots therefore prevent accidental capability inheritance; they are not a claim
that arbitrary shell code is filesystem-confined.

The packaged current manual is a third special namespace, `/paradigmeve-manual`. It is read-only,
contains only the shipped top-level Markdown pages, and never becomes a generic writable root. The
packaged/repository Vault remains canonical; startup also synchronizes those Markdown pages into the
managed physical mirror `userData/docs/vault` (`%APPDATA%\ParadigmEve\docs\vault` on the normal
Windows install). That mirror is not a second authoring source. The exact Eve/Eva owner can inspect it
through `/appdata/docs/vault`; browser ChatGPT still reaches it by making ParadigmEve perform the read,
not by giving Chrome ambient filesystem access.

Selective `userData` materialization does not change that boundary. ParadigmEve also mirrors the
packaged Companion into `userData/extension` so the selected Chrome profile can load that exact
extension payload through Chrome's native extension mechanism. The Vault mirror and extension mirror
remain app-owned folders with fixed purposes; neither makes `userData` browseable from the browser.
For any browser feature that needs other local bytes, Electron keeps the path and permission decision,
snapshots/materializes only the allowed resource, and transfers it under an opaque purpose-bound id
after the exact browser operation proves ownership. A generic bridge file-read/list/open route is
forbidden because it would move filesystem authority from Eve into Chrome.

## Durable chat archive

The archive under `userData/archive` (introduced in 2.2.4) is ParadigmEve-owned durable conversation evidence, not
a cache of provider pages. Canonical archive truth is the append-only/versioned event stream plus
content-addressed SHA-256 blobs for bytes ParadigmEve actually captured. Search indexes, memory
projections and `archive/site` are derived and may be rebuilt from that canonical evidence.

The static site is intentionally useful by itself: it is a local `file://` recovery browser with a
conversation list, scrollable transcripts and local retained assets. It does not fetch signed
provider URLs to fill gaps. If native/generated image bytes were never captured, the archive keeps an
explicit provider-only, metadata-only, missing or capture-error state rather than presenting the
asset as retained.

Its conversation list defaults to newer-first using each archive session's canonical `updatedAt`.
The compact order control switches between `Newer first` and `Older first`; a Swedish browser uses
`Nyare först` and `Äldre först`. Reordering only moves sidebar links: chat hash tokens, the active
conversation and the current search filter stay intact. The app can open this same recovery view from
the Archive workspace or View menu without exposing its filesystem path to the renderer.

An unfinished historical assistant row remains honest evidence. Once a later authored user message
proves that interrupted row is no longer the live streaming frontier, the archive can retain that
exact partial snapshot and continue with later stable events. The row is still immutable and the
session remains partial; a later source-store rewrite must not silently replace what was published.
By contrast, a currently streaming assistant row and a recoverable native-image capture remain
deferred because publishing them early could freeze mutable evidence or discard pixels that can
still become locally durable.

Archive filesystem operations use an app-owned containment fence that rejects lexical traversal and
symlink/junction/reparse escapes. Renderer IPC exposes bounded path-free archive DTOs; the renderer
does not receive arbitrary archive paths or raw filesystem errors. Explicit user session deletion
retires the corresponding archive evidence rather than leaving a stale chat visible.

## Approved roots versus projects

These are different concepts:

- **approved root** = permission boundary;
- **local project** = organization/working-folder association inside that permission boundary.

Adding a project never widens filesystem permission.

## Learned workspace / cwd

`src/main/workspace.ts` learns a per-conversation project root from successful **absolute** path use. It searches upward for project markers such as `.git`, `package.json`, `pyproject.toml`, etc., without leaving the approved root.

After that, relative paths can resolve against the exact caller conversation's workspace.

If exact caller identity is missing, there is **no fallback cwd**. Relative paths are refused rather than resolved against another chat's workspace.

Compact & Resume moves the workspace from chat A to B only after the durable session rebind succeeds.

## Renderer security

The Electron renderer gets:

- strict CSP;
- all permission requests denied;
- fixed preload IPC only.

It does not receive Node APIs or direct secrets/filesystem/process access.

## Data ownership principle

When debugging state loss, first identify whether the data is:

1. authored durable state (strict, preserve bytes);
2. transactional operational state (durable barrier before side effect);
3. derived/rebuildable projection (can be recomputed);
4. ephemeral browser/process liveness (must not be restored as if current).

Confusing those categories produces the hardest recovery bugs.
