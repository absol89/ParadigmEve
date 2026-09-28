# Setup and reference

[Back to the overview](../README.md)

## Quick start

1. **Install and open CoS.** Choose the download for your operating system and CPU.
2. **Choose what ChatGPT may access.** In **Settings → Workspace**, approve a project folder and review the tool permissions.
3. **Connect the local tools.** Configure a tunnel in **Settings → Setup**, press **Connect**, then add the **Core** app in ChatGPT under **Plugins → Add → Create MCP App**.
4. **Load the companion extension.** Press **Open extension folder**. In `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select that folder. Pairing is automatic.
5. **Start a task.** Choose a project and model in CoS, write your request and send it.

Want screen and keyboard control? Enable **Desktop** permissions and connect its separate app. On macOS, also grant Screen Recording and Accessibility in System Settings.

**After an update:** managed Windows self-reinstall refreshes the Companion and recovers the dedicated
browser profile automatically; do not manually reload it during that flow. For manual/non-managed
updates, reload the matching unpacked Companion only if Chrome is still running an older Companion
runtime. Refresh ChatGPT apps/connectors separately only when prompted or when their tool declarations
changed.

## Requirements and platform notes

Windows 10/11, **macOS 13 Ventura or newer**, or a current desktop Linux. Chrome 116+ or a current
Edge/Brave, plus a ChatGPT account/workspace that can create custom MCP apps.

- **Unsigned beta:** Windows builds are not publisher-signed; macOS builds are unsigned and
  unnotarized. Verify each package against the release checksums.
- **Linux:** a Secret Service keyring is required. Prefer the DEB on Debian/Ubuntu; when
  unprivileged user namespaces are disabled, the AppImage launcher can fall back to `--no-sandbox`.
- **Permissions:** approve your folders and review capabilities before connecting. Filesystem roots
  and Computer Use screen/control/clipboard access remain explicit opt-ins, and shell commands run with
  your normal user privileges.

## Tunnel setup

For voice-assisted or accessibility-focused setup, and for the rules governing creation of credentials for other user-authorized applications, see [Accessibility, browser identity, and credential stewardship](accessibility-and-credential-stewardship.md).

### OpenAI Secure MCP Tunnel

1. Create a tunnel in [Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels), in the same workspace you use in ChatGPT.
2. Create a **Restricted** [API key](https://platform.openai.com/settings/organization/api-keys) with **Tunnels: Read** and **Tunnels: Use**.
3. Enter the tunnel ID and key in CoS and press **Connect**.
4. In ChatGPT, open **Plugins**, click **Add → Create MCP App** (older versions show **+**, and may first need Developer mode turned on under **Settings → Apps → Advanced settings**), then create a custom app of type **Tunnel** with **No authentication**. Keep the suggested app name: ParadigmEve recognizes its own tool calls by it. Review and enable its actions.

Core, Desktop and Plugins are separate connectors. Configure each surface you enable. Release packages include the pinned, checksum-verified `tunnel-client`.

### Other tunnels

**Cloudflare quick tunnel:** connect in CoS and use the displayed public URL as the MCP server URL in ChatGPT. The random path is a secret and changes on restart.

**Your own HTTPS tunnel:** forward to the loopback URL shown by CoS and preserve its secret path. Treat the resulting URL like a password.

## Permissions and connectors

| Connector | What it adds |
| --- | --- |
| **Core** | Local files, patches, terminals, generated-file downloads, session history, plans and workers. Available on all supported platforms. |
| **Desktop** | Screen inspection, mouse, keyboard and clipboard. Windows and macOS; macOS requires explicit enablement and OS permissions. |
| **Plugins** | External MCP tools such as Blender, Playwright and Memory, plus custom local or remote servers. [Plugin guide](plugins.md). |

You choose the approved folders and capabilities. File tools enforce those roots; shell commands run with your normal user privileges. Desktop access applies to the desktop, and external plugins have their own permissions. **Read-only mode** disables writes, command execution and desktop control.

History is stored locally, with recording on and 30-day retention by default. Credentials use the operating system's secure storage. Review permissions before connecting: fresh installs enable Core capabilities and two workers; filesystem roots and Computer Use screen/control/clipboard access remain explicit opt-ins.

[Security policy](../SECURITY.md) · [Accessibility & credential stewardship](accessibility-and-credential-stewardship.md) · [Tool reference](tool-surface.md) · [Architecture](../AGENTS.md)

## Sessions, workers and Astra

**Session history** belongs to the local session, not a particular ChatGPT tab. The companion records messages and the actual local tool results so the app and the model can read earlier work.

**Compact & Resume** asks for a handoff, starts a fresh provider conversation and rebinds that same session. Task and worker history move with it. Automatic compaction uses configured local estimates and eligible live work; Pro models never auto-compact.

**Workers** keep their conversation when they finish. Send a follow-up to reuse one. The default is two simultaneous workers per family, configurable up to eight. Idle owned tabs can be reused or closed after fresh checks; the durable worker history remains. Drafts, active work and pins are protected.

**Goal** can decide the task is complete and send nothing. **Loop** continues within the brief until disabled. Both support ChatGPT helpers or an optional API backend.

**Astra's finish boundary** can receive queued instructions, plan checkpoints and automatic follow-ups through tools within the same working turn when Session finish is enabled. You can end the turn from the composer. This does not remove provider usage or context limits.

## Troubleshooting

- **Missing or stale tools:** refresh the relevant CoS app in ChatGPT when its tool declaration is stale. Connector refresh is separate from Companion browser-runtime recovery.
- **Companion version/runtime mismatch:** during managed Windows self-reinstall, let the controller refresh, restart and recover the Companion; do not manually reload it mid-flow. Outside managed reinstall, reload the matching unpacked Companion if Chrome is still running older Companion code, then reload the affected ChatGPT page.
- **Models missing:** use **Reload ChatGPT models**. The picker reflects availability in your signed-in account.
- **`UNIDENTIFIED_CALLER`:** use that conversation in the paired browser so the extension can prove its request identity. CoS does not guess from the active tab.
- **`COMPACTION_IN_PROGRESS`:** let the source chat finish its handoff. Work continues in the replacement conversation.
- **Linux credential storage unavailable:** unlock GNOME Keyring or KWallet, then restart CoS.
- **A chat will not stop:** **Block** revokes local tools for that exact conversation. It does not claim to cancel the provider's generation.

The MCP connector uses ChatGPT's custom MCP app and tunnel interfaces. The companion also observes and automates the browser UI; this is not a public ChatGPT automation API. Your account's [terms and policies](https://openai.com/policies/) apply. Do not use it to evade limits or safety controls.

## Build from source and contribute

## Development

```sh
npm ci
npm run dev
npm run verify
```

Read [AGENTS.md](../AGENTS.md) before changing the app and [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a PR.

## Building

```sh
npm run dist:x64          # Windows x64
npm run dist:arm64        # Windows ARM64
npm run dist:mac:x64      # macOS Intel
npm run dist:mac:arm64    # macOS Apple silicon
npm run dist:linux:x64    # Linux x64
npm run dist:linux:arm64  # Linux ARM64
```

Build on the target OS. The release workflow uses native runners for all six targets, checks the packaged runtimes and assembles the complete artifact set with checksums and corresponding native library sources.

### Build macOS from a USB checkout

`BUILD-MAC.command` is a user-local bootstrap for carrying an exact Git checkout to a Mac. It detects Apple silicon versus Intel, verifies that Apple's Command Line Tools/Xcode SDK are present, uses an existing Node 22 installation when available or unpacks a verified Node 22 archive under `~/Library/Caches/ParadigmEve`, clones the exact clean USB commit onto the Mac's local filesystem, runs verification and the native macOS package/smoke checks, then copies the DMG, ZIP and checksums back to the ignored `mac-build-output/` folder on the USB checkout.

The optional ignored `redist/` folder can carry `node-v22.23.2-darwin-arm64.tar.gz` and/or `node-v22.23.2-darwin-x64.tar.gz` (plus the matching `SHASUMS256.txt`). If the matching archive is absent, the bootstrap downloads it from `nodejs.org` and verifies it against Node's published SHA-256 list. The build itself does not require administrator privileges once Apple's native developer tools are installed. If those tools are missing, macOS may require one administrator-authorized Apple installation before rerunning the script.

---

[MIT licensed](../LICENSE). Not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks.
