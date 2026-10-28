# 09 — Build, install, update and release

Back to [vault index](README.md).

## Version authorities

For a build to be coherent, these declarations must agree:

- `package.json`
- `src/main/version.ts::APP_VERSION`
- `extension/manifest.json`

Tests enforce agreement.

The current **2.4.4 source-release preparation line** is `release/2.4.4`,
cumulative over public `v2.4.3`. Tag, main integration and remote push require
independent verification; neither a planned tag nor an installed c7 candidate
proves public installers. The earlier **App + Companion 2.2.2** Angel checkpoint remains
part of the release history, and the current bridge protocol is **15**. A package is not coherent
until all three version declarations above agree. App version and bridge protocol are separate
authorities and must not be inferred from each other. This tagged *source* checkpoint is not
itself a published installer or proof of live operation on every target platform.

The 2.4.4 c2 Windows x64 debug candidate was later installed locally and its
installed app bundle hash matched the packaged c2 source. Its incremental
static-site refresh reused 34 of 35 chats, but a full startup archive index
scan still reached about 921 MiB RSS. Candidate 3 adds the delivery-icon and
recovery-action-state source fix; its installer and installed acceptance are
separate evidence, never inferred from the c2 hash. Read
[2.4.4 candidate notes](../release-notes/v2.4.4.md) for the exact scope.

## Git provenance for cumulative release lines

The `v2.4.0` tag marks the final 2.4.0 head shared by public `main` and
`release/2.4.0`. The GitHub CI matrices for both branches run Windows x64, macOS
arm64, Linux x64, and Linux with Swedish locale; check the run for the tagged
commit rather than trusting a hash written here. This is source verification; it does **not** build and publish
the release assets or prove real installation on all those platforms. The public
GitHub Release/publish workflow is separately and manually dispatched at a tag.

Installed **Windows x64 debug self-testing** confirmed heartbeat, Compact & Resume,
wake, transcription/diarization, WordCraft/GridCraft opening, and controlled
Force Send on that local build. Its recorded build manifest (`COMMIT.txt`) and
source patch (`uncommitted.patch`) show that the track-separated transcription
and responsive Pins changes were **included in the installed artifact**. Reliable
automatic multi-speaker/overlapping-voice behavior still requires specific live
acceptance; packaging evidence alone cannot establish that. Later worker/heartbeat
Plan prompt edits were checkpointed under GitHub source tag `v2.4.0` after that
Windows build was packaged; a newer installer is needed before those changes can
be claimed as installed. See [2.4.0 release notes](../release-notes/v2.4.0.md).

Version metadata is not ancestry proof. For a cumulative candidate such as 2.2.2 carrying the full
2.2.1 baseline, inspect the current branch, working-tree status, recent history and tracked release
notes before packaging. The settled cumulative source must be committed on the target-version branch
before the installer is treated as a release candidate. Required release-note files must be tracked in
that checkpoint. Do not branch from stale HEAD and leave the real cumulative release only as dirty
working-tree state. If accepted source changes after packaging, checkpoint again and rebuild so the
artifact can be tied to one exact commit.

During active integration a shared dirty tree is normal. Describe it as work in progress rather than
immutable release provenance. Release evidence should name the exact checkpoint commit, then layer
package hashes, installed bytes and live-runtime acceptance on top of it.

`scripts/package.mjs` checks this boundary before doing packaging work. By default it requires a clean
Git tree, a branch whose name carries the package version (or a detached exact `vX.Y.Z` tag), and the
current `docs/release-notes/vX.Y.Z.md` tracked by Git. `--allow-uncheckpointed` exists only for an
explicit development package. Its warning is part of the contract: that artifact is not a release
candidate and must not be used as immutable provenance.

## Packaging pipeline

`scripts/package.mjs` is the build owner used by `npm run dist:*`.

For each target it:

1. regenerates third-party notices;
2. generates app/extension icons;
3. generates Windows installer artwork when applicable;
4. builds Electron main/preload/renderer with electron-vite;
5. fetches and checksum-verifies pinned tunnel client;
6. fetches and checksum-verifies pinned ripgrep;
7. prepares exact target native dependencies;
8. prepares macOS desktop helper where applicable;
9. runs electron-builder with publishing disabled.

`electron-builder.yml` controls packaging. The output directory is `release/`.

Important policy: generated native/resources are outputs. Change their source/pin/script and regenerate; do not hand-edit staged binaries.

## Windows package

Windows uses assisted NSIS (`oneClick: false`, per-user by default). The installer includes app/extension/native runtime resources.

The current engineering Vault is part of that installer payload as `resources\docs\vault\*.md` under the chosen installation directory. `scripts/smoke-packaged-runtime.mjs` compares the packaged Markdown page set and every page's bytes against the source `docs/vault/*.md` before a candidate is accepted. On first and later app startup, `syncVaultManualMirror()` then mirrors that installed canonical set to `%APPDATA%\ParadigmEve\docs\vault`, replacing current Markdown byte-for-byte and removing stale managed Markdown without touching unrelated neighboring files.

The installer is designed to handle a running Eve. For an upgrade, **do not manually close Eve/Chrome first** just to help it. The external self-reinstall controller exists specifically so the installer may close/restart the app while the controller survives.

### Who starts the installed app afterwards

The launch decision lives in `scripts/windows-installer-acl.nsh` (`customInit` / `customInstall`):

- An **interactive** install always launches the installed app from the installer's own shortcut,
  then auto-closes its completion page. An update launch passes `--recover-companion-browser`
  (plus `--updated` for the private updater); a fresh install passes nothing, so it follows the
  saved auto-connect preference.
- A **silent** install (`/S`, for example run by Eve from inside the app) launches the installed app
  only if **it closed a running ParadigmEve itself**: `customInit` records whether the exact installed
  executable was running before `CHECK_APP_RUNNING` closed it. Without that, an agent-run silent
  reinstall killed its own caller and nothing brought the app back.
- A silent install never launches for the private updater's quit-and-install handoff (`--updated`),
  which already decided whether to relaunch, and leaves `--force-run` to electron-builder's own path,
  so the app is never started twice.

## Self-reinstall flow

`scripts/windows-self-reinstall.ps1`:

1. launches the assisted installer visibly by default; a specifically requested
   `-SilentNoFocus` update instead runs signed-off NSIS `/S` with no wizard,
   preserving the user's active ChatGPT window focus;
2. accepts only known forward/default actions;
3. accepts the installer's “ParadigmEve is running” request and lets it close the app;
4. has a bounded force-stop fallback only if the requested close never retires the app;
5. finishes the installer;
6. resolves the executable from `%APPDATA%\ParadigmEve\install-path.txt`, which the NSIS install
   writes from its final `$INSTDIR`; an older install with no marker may fall back once to the
   historical `%LOCALAPPDATA%\Programs\ParadigmEve\ParadigmEve.exe` location;
7. for 2.4.5 c3 updates, starts/signals Eve in the background with one-shot
   connection and `--preserve-chatgpt-tabs`, leaving the user's foreground work alone;
8. materializes the packaged Companion into the stable unpacked-extension folder.
   Chrome's running extension refreshes itself at its existing idle fence, without
   a browser-profile or ChatGPT-tab restart;
9. preserves drafts, Voice, streaming, selected model and existing tab/window
   state while the extension's in-place recorder re-injection is pending;
10. polls `/recovery` for a current-generation protocol-15 Companion document.
    If an active page prevents immediate refresh, the install may complete with
    Companion proof explicitly deferred, never by forcibly reloading that page.

ParadigmEve installs in one place only: `%LOCALAPPDATA%\Programs\ParadigmEve`. The wizard offers no
folder choice, and the installer overrides `/D=` and any remembered custom path, so updates and
candidate builds always replace the same install instead of leaving copies behind. Because the
uninstaller deletes its whole install folder, both sides refuse a folder that is, contains or sits
inside the data folder `%APPDATA%\paradigmeve`, or that holds `state`, `sessions` or `archive`: the
installer forgets such an old registration (its stray files stay, nothing is deleted) and the
uninstaller quits without removing anything. The install-path marker records the executable path
only; AppData remains a separate state/config location.

The controller's recovery readiness fence is regression-tested against the current bridge protocol
so a successful modern reconnect is not misreported as a failed reinstall.

For a local debug self-test build, pass the suffixed installer explicitly; the controller's no-argument default deliberately remains the canonical shipping filename:

```powershell
npm.cmd run dist:x64 -- --flavor debug

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-self-reinstall.ps1 `
  -InstallerPath .\release\ParadigmEve-Windows-x64-debug.exe -SilentNoFocus
```

Do not rename a debug artifact to the canonical shipping filename just to satisfy the default. Artifact identity is part of the build-flavor safety boundary.

### One canonical debug artifact per version

A local self-test build is published once per version as
`ParadigmEve-<version>-windows-x64-debug.exe` in that version's folder of the local installer
directory, with a `.sha` (SHA-256) and `.blockmap` beside it. Self-testing runs only that exact artifact,
never a repo `release/` output, a temp copy or an old install path. A fix to a version that has not
yet passed self-test replaces its artifact; once a version has passed, its artifact stays untouched and
new work goes to the next version. After installing, verify the running executable path and version and
the Companion `version_name` build before judging behaviour.

## “Build succeeded” is not live acceptance

`AGENTS.md` explicitly requires more for “install newest”:

- build the current authorized tree;
- compare installed payload hashes to the package where relevant;
- verify the installed runtime's actual feature flow.

An installer exit code or version label alone is insufficient.

For the current source line, live acceptance includes checks such as:

- View/Pins/Plans surfaces render;
- mandatory Thread chooser works;
- Pins → Create is local/non-conversational, persists nothing before Save, rejects blank/duplicate
  names, and classifies saved objects from Pins/prompt rather than Link/description;
- Plans → Create resolves the durable `plans` starter identity and starts a fresh conversational
  Plan-creation chat; an editable Plans Create form remains deferred beyond this source line;
- Pin/Unpin updates repaint and persist;
- duplicate Pins do not accumulate;
- first-class Plan progress survives restart;
- completed Plans remain Live until explicit archive;
- Archive rebuild/open works from the app-owned local archive, the static `file://` browser shows
  later stable evidence after a historical interrupted assistant row without pretending that row was
  complete, retained native/generated images do not depend on provider URLs after reboot/offline, and
  the static newer/older toggle preserves hash selection/search in English and Swedish;
- the desktop sidebar starts at the measured 188px default while the 205px narrow fallback and
  resize/reset persistence still work; the ParadigmEve brand opens the project GitHub through the safe
  external-link path, and View opens the static archive through the existing zero-payload action;
- `%schedule` availability and `%evecron` duration/edit/pause state survive restart without inventing
  shared-free time from unknown availability or missing duration;
- a due `%evecron` occurrence opens in a fresh schedule-owned chat, becomes Started only from the exact
  browser/session delivery evidence, and becomes Done only from durable task verification without
  duplicating admission or receipts after restart;
- accepted long-running `%requests` work preserves its exact originating request, owning Thread, Plan,
  result/tests, and review state across restart;
- an owning `%thread` is the Plan's primary Source when present, while the completed high-level Plan
  remains Ready to archive until the user explicitly archives it;
- no obsolete connector-maintenance page hijacks the active chat;
- Companion/browser reconnect proves the current build.

For a 2.4.4 c3 acceptance, also inspect a failed user-authored browser
pickup timeout: one **Force Send** action and one **Dismiss**, with no icon
overlap at the actual window width; a browser-claimed/possibly delivered row
must instead offer manual composer restoration, never Force Send. Exercise
guarded Force Send only on a fresh, intentionally created *provably unclaimed*
test message, preserving current human drafts, voice and tab focus. Confirm
no duplicate send and that the original durable row retains its identity.
Measure app memory/CPU and archive write activity across startup, shutdown,
dirty-chat refresh and Archive opening; note that full startup/shutdown
indexing is still a known issue. Check Prime attribution and Request Trail
on real tool calls before treating c3 as an acceptable main-branch candidate.

## Runtime updater

`src/main/update.ts` checks two bounded authorities and chooses the higher newer version; the
local feed wins a tie:

1. a local private feed:

```text
<private-update-root>/<version>/SHA256SUMS.txt
<private-update-root>/<version>/<fixed platform artifact>
```

2. the release marked **Latest** in the fixed public repository
   `absol89/ParadigmEve`. Drafts and pre-releases are never offered, and GitHub is checked at most
   every six hours. Publishing a pre-release therefore does not distribute it to installed apps;
   the maintainer's separate Latest promotion is the distribution gate.

The updater:

- accepts only direct version directories;
- rejects symlink/junction authority;
- chooses artifact candidates from current platform/arch/build flavor, never a remote manifest;
- on Windows, checks checksum authority for
  `ParadigmEve-Windows-<arch><flavor>.exe` first and the legacy
  `ParadigmEve-Setup-<arch><flavor>.exe` second. Since 2.3.0 the packages and public release use
  the `Windows` name; 2.2.9 was the bridge release that taught the updater it, so 2.2.8 and older
  installations must update through 2.2.9 or install 2.3.0 manually;
- verifies SHA-256 before staging;
- rehashes staged bytes before install handoff;
- never lets a missing/broken update replace the current app.

On packaged Windows, a staged private installer can be applied automatically at orderly quit. macOS/DEB use supported manual paths; AppImage can self-replace where applicable.

## Public release workflow

The repository's release pipeline builds/smokes supported OS/architecture targets and assembles
installers, the extension ZIP, checksums and native-source/legal artifacts. Public release additionally
uses privacy/history and “do not overwrite existing release” gates. Local laptop development and
current release CI both use the `debug` flavor explicitly, so public candidate filenames retain
`-debug`. macOS ZIPs may remain CI/test artifacts, but the public release and public
`SHA256SUMS.txt` expose the DMGs instead. `dev` still requires the build wrapper to prove a public
GitHub repository.

## Concurrency warning

Do not run two packagers against the same `release/` directory at once. electron-builder and the packaging preparation steps own shared output paths; overlapping builds can remove or replace each other's `win-unpacked`/installer state and leave an artifact whose provenance is unclear.

Before a coordinated package/install pass, check for existing `scripts/package.mjs` / electron-builder / makensis processes and serialize the build.

---

> **Implementation contracts.** The sections below moved here unchanged from the former single-file
> `AGENTS.md` map. Their § numbers are kept so references such as “§14” still resolve; the
> [Vault index](README.md#former-agentsmd-sections) lists where each section lives.

## 20. Build, installation, updater and release

Source, bundle, package, installed bytes and live behavior are separate gates (§3). The app id
is `com.paradigmeve.app`. Native release targets are Windows x64/arm64 NSIS, macOS x64/arm64
DMG+ZIP and Linux x64/arm64 AppImage+DEB. Windows is per-user-capable and `asInvoker`; replacing
the package preserves userData. Synchronize package/main/extension versions deliberately.

`electron-vite` builds main/preload/renderer into `out/`; extension files ship directly without
a bundler. `electron-builder.yml` puts executable tunnel/rg, extension and required native
payloads outside asar. `extension-path.ts` transactionally mirrors the packaged extension to
stable `userData/extension`, never an ephemeral AppImage mount.

On Windows, every install, update and candidate goes to the one per-user folder
`%LOCALAPPDATA%\Programs\ParadigmEve`: the wizard has no folder page, and `customInit` overrides
`/D=` and a remembered custom path. Never install a candidate anywhere else. The stock uninstaller
deletes its whole install folder, so `ParadigmEveUnsafeDir` refuses any folder that is, contains or
sits inside `%APPDATA%\paradigmeve`, or that holds `state`, `sessions` or `archive`: the installer
forgets such an old registration instead of running its old uninstaller there, and the uninstaller
quits without removing anything (2026-10-12: an install that had landed in the data folder let a
2.3.9 candidate's update wipe archive, docs and attachments). NSIS still writes the executable path
to `%APPDATA%\ParadigmEve\install-path.txt`; the external self-reinstall controller reads and
validates that marker before relaunch, with the LocalAppData Programs path as the fallback for an
older install that has not yet written it.

Build flavor is compile-time product authority, not a runtime preference. Local `npm run dev`,
`npm run build` and `scripts/package.mjs` default to **debug**. A **dev** build is admitted only
after the build wrapper proves that at least one configured GitHub remote resolves anonymously to
a public repository; inherited proof is discarded and re-established for each invocation. Release
CI currently sets **debug** explicitly, so every published artifact carries the `-debug` suffix, and
`publish.yml` always creates the GitHub release as a **pre-release**; promoting one to Latest is a
manual maintainer step. Vite compiles the resulting flavor literal into main, preload and
renderer, so changing a runtime environment variable cannot unlock a driver excluded from an
installed build. Non-shipping packages append `-debug` or `-dev` to their artifact name; shipping
keeps the canonical public filenames used by release/update flows.

For the locally installed **2.4.0** Windows self-testing build, packaging used **x64 debug**
so the GPT Chat agent lane remains available. The public v2.4.0 source tag and green
cross-platform source CI do not mean downloadable installers have been published. Preserve
prior installed-build evidence. The locally installed Windows build's recorded source snapshot **did**
include track-separated transcription and responsive Pins files; inclusion is
not proof that their harder live multi-speaker/overlap cases were accepted.
Worker/heartbeat Plan-prompt edits made after that Windows build was packaged remain source-only.
A private Angel display copy may omit `-debug`
only when its filename remains visibly non-canonical (for example
`ParadigmEve-2.2.4-x64-Angel-<hash>.exe`) and its recorded provenance still says the compiled
flavor is debug. Never rename those bytes to the canonical shipping/update filename.
Public arm64 artifacts are a separate release workflow and must never be substituted for
the local debug artifact.

The **2.4.0 source checkpoint is cumulative over earlier public releases**. Git provenance
must say that plainly. Before packaging or claiming a 2.4.0 candidate, inspect
`git branch --show-current`, `git status`, recent history and the tracked release notes. A final
release checkpoint must contain the accepted cumulative 2.4.0 work over that ancestry; package/version
declarations or a stale directory name do not prove ancestry. Do not create/switch a release
branch from stale HEAD while leaving the real cumulative work only in the working tree.
`docs/release-notes/v2.4.0.md` belongs in that cumulative checkpoint. If source changes after a package is built, rebuild before calling the later artifact
current. A dirty worktree is allowed during active integration, but it is not immutable release
evidence and must be described honestly until checkpointed. `scripts/package.mjs` enforces this by
default: packaging requires a clean target-version branch (or exact version tag) and tracked current
release notes. `--allow-uncheckpointed` is an explicit escape hatch for a development package only;
an artifact built through that escape hatch must never be described as the current release candidate.

| Build flavor | Agent drivers included in the product surface |
| --- | --- |
| `debug` | GPT Chat, GPT Work, Ollama, custom OpenAI-compatible |
| `dev` | GPT Work, Ollama, custom OpenAI-compatible |
| `shipping` | GPT Work, Ollama |

Inclusion is not execution-readiness proof. GPT Chat remains the implemented orchestrator and
browser-backed worker executor. Ollama is implemented as a worker-only, one-shot executor: admission
requires an explicit valid endpoint and model, the broker issues exact run/worker authority, the
bounded model/tool loop uses only the authorized Core surface, and the final result returns to Prime.
Ollama workers are terminal after one bounded task and are not revived from a fabricated transcript
after completion or restart. GPT Work and custom remain unavailable as agent executors. Fresh debug config defaults Prime/Worker to GPT Chat; fresh
dev/shipping config defaults them to GPT Work so a build is never born with an excluded default.
The debug-only worker execution experiment uses `multiAgent.workerRuntime` (`chatgpt` control or
`api`) and an explicitly enabled `experimentalApiWorkers` provider/model selection. An absent
mode retains the existing `execution.worker` setting for migrated installs. API mode reuses the
existing one-shot Ollama/OpenRouter execution principal, Core permissions and durable broker;
it never alters Prime's model or migrates active jobs. Missing explicit opt-in/model fails before
worker admission. A provider approval card seen in an exact delegated ChatGPT worker is recorded
in both that worker session and its owning Prime session, with the native notification directed
to Prime. The provider card itself cannot be moved or silently accepted. No uncertain call is
automatically replayed; these provider approvals still require live acceptance testing.
Recognized saved ids are preserved across build flavors for visibility and explicit repair rather
than rewritten to a fallback.

| Build owner | Contract |
| --- | --- |
| `scripts/build-flavor.mjs`, `scripts/build.mjs`, `src/shared/build-flavor.ts` | Validate/inject `debug | dev | shipping`; public-GitHub admission for dev; compile-time runtime projection. |
| `scripts/package.mjs` | Icons → bundle → explicit target resources/native staging → builder with publishing disabled. |
| `packaging-targets.mjs`, `packaging-versions.mjs` | Supported OS/arch vocabulary and pinned target checksums; fetchers share these authorities. |
| `prepare-packaging-native.mjs` | Exact target node-pty/Sharp/tree-sitter from verified package material; host leftovers cannot win. |
| `prepare-macos-desktop-helper.mjs` | Thin target Swift dylib + matching N-API addon; packaged in-process permission identity. |
| `smoke-packaged-runtime.mjs`, `smoke-macos-{bundle,gui}.mjs` | In-place resource/native-stack checks, Mac bundle/seal and real GUI startup evidence. |
| `generate-third-party-notices.mjs`, `package-native-sources.mjs` | Production notices and corresponding native source inventory/archive; exact lockfile/catalog provenance. |
| `verify-public-history.mjs`, `check-release-absent.mjs` | Public-history/privacy gate and positive proof that publishing will not overwrite a release. |

Generated resources are outputs; change their pin/source/script and regenerate instead of
hand-editing staged binaries. Native and editor dependencies need actual runtime proof. For
“install newest”, rebuild the current authorized tree, compare installed payload hashes to the
package, and verify that runtime's relevant flow. An installer exit code or version label is
insufficient. A dirty-tree snapshot request does not authorize exposing all local Git history.

`update.ts` checks immediately and every minute with one in-flight pass. It has two sources and
takes the higher version (the local feed keeps a tie): the private local feed
(`<userData>/private-updates` or an absolute `PARADIGMEVE_PRIVATE_UPDATE_DIR`), and the release
GitHub marks **Latest** in `absol89/ParadigmEve`, asked at most every six hours. That repository
is a compiled constant; never make it configurable or take it from a response. Pre-releases and
drafts are never offered, so a published release reaches installations only when the
maintainer promotes it to Latest. Asset URLs are built from the repository, a validated tag and
the artifact candidates of this build's own flavor (`-debug` builds take `-debug` artifacts), and a
redirect may land only on GitHub hosts. A Latest release without this flavor's artifact is
offered as its release page. Download to a partial file, verify SHA-256 against the release's
`SHA256SUMS.txt` before staging/adoption, and rehash at ordinary quit before handing off. Windows NSIS/Linux AppImage can apply automatically; macOS/DEB present the supported manual
path, development does not stage. Explicit install may relaunch; ordinary quit does not force
relaunch. Failed checks never replace a verified staged candidate with unverified bytes.

**Windows installers are `ParadigmEve-Windows-<arch>-debug.exe` since 2.3.0.** 2.2.9 was the
filename bridge: it still published `ParadigmEve-Setup-<arch>-debug.exe`, but its updater accepts
both names and prefers `Windows` when both are checksum-authorized, so 2.2.9 updates to 2.3.0
automatically. 2.2.8 and older only know `Setup` and must go through 2.2.9 or a manual install.
The updater keeps accepting the legacy `Setup` name second.

CI verifies supported OS families; native `release.yml` builds/smokes all six targets, then
assembles installers, extension ZIP, native-sources archive and `SHA256SUMS.txt`. `publish.yml`
is dispatched **at the reviewed version tag**, calls that reusable build in the same run,
requires `docs/release-notes/vX.Y.Z.md`, rechecks versions/privacy/hashes and refuses an existing
release. A tag alone does not build/publish. An unpublished candidate can be built separately,
but do not mix artifacts from another ref/run into a release.
Current release CI sets **debug** explicitly. macOS ZIPs may remain candidate/test artifacts, but
the public release surface and public checksum file omit those ZIPs and retain the macOS DMGs.

`verify:notices` checks installed production dependencies against the lockfile and rejects
missing license material or mismatched reviewed catalog hashes. Custom package updates cannot
inherit an older license review. Notice completeness and native source/replacement obligations
are separate checks; inspect the actual assembled artifacts. Hooks installed with
`npm run hooks:install` help keep personal identities/session provenance out of public history.
Release completion requires every target, assembly/hash check, Publish and public artifact
inspection to pass, preserving the user's exact requested title/changelog.
