# 09 — Build, install, update and release

Back to [vault index](README.md).

## Version authorities

For a build to be coherent, these declarations must agree:

- `package.json`
- `src/main/version.ts::APP_VERSION`
- `extension/manifest.json`

Tests enforce agreement.

The current app source line is **2.3.7**. The earlier **App + Companion 2.2.2** Angel checkpoint remains
part of the release history, and the current bridge protocol is **15**. A 2.3.7 package is not coherent
until all three version declarations above agree. App version and bridge protocol are separate
authorities and must not be inferred from each other.

## Git provenance for cumulative release lines

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

1. launches the assisted installer visibly;
2. accepts only known forward/default actions;
3. accepts the installer's “ParadigmEve is running” request and lets it close the app;
4. has a bounded force-stop fallback only if the requested close never retires the app;
5. finishes the installer;
6. resolves the executable from `%APPDATA%\ParadigmEve\install-path.txt`, which the NSIS install
   writes from its final `$INSTDIR`; an older install with no marker may fall back once to the
   historical `%LOCALAPPDATA%\Programs\ParadigmEve\ParadigmEve.exe` location;
7. starts/signals installed Eve in the foreground with one-shot connect + Companion recovery flags,
   so the normal initial-window path presents Eve maximized instead of leaving the post-install
   recovery launch tray-only;
8. materializes the packaged Companion into the stable unpacked-extension folder, then refreshes the
   dedicated Chrome profile: an open profile restarts through `chrome://restart/`; a closed profile
   launches with **restore last session**;
9. if Chrome presents **Restore pages?**, invokes native **Restore** before considering replacement
   tabs, preserving human tabs and reusing exact restored Eve conversations where identity is proven;
10. polls `/recovery` for a current-generation protocol-15 Companion document.

The install-path marker is what keeps self-reinstall and later self-maintenance correct when the user
chooses a non-default installation directory. It records the executable path only; AppData remains a
separate state/config location.

The controller's recovery readiness fence is regression-tested against the current bridge protocol
so a successful modern reconnect is not misreported as a failed reinstall.

For a local debug self-test build, pass the suffixed installer explicitly; the controller's no-argument default deliberately remains the canonical shipping filename:

```powershell
npm.cmd run dist:x64 -- --flavor debug

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-self-reinstall.ps1 `
  -InstallerPath .\release\ParadigmEve-Windows-x64-debug.exe
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
