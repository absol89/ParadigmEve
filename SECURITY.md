# Security policy

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security problem.** Use GitHub's private vulnerability reporting for this repository: **Security → Report a vulnerability**.

Include the smallest useful reproduction, the app version, operating-system version/architecture, and whether the Chrome extension was connected. Redact personal file contents, usernames/paths, conversation text and account/workspace identifiers. Never post live API keys, connector URLs, tunnel tokens or other credentials. Rotate anything accidentally exposed.

This is a solo-maintained beta. There is no bug bounty or guaranteed response window.

Security fixes target the **latest published release**. If you can reproduce an issue safely on
the latest version, include that result in the private report.

## Security model

ParadigmEve is a permission boundary between ChatGPT and the logged-in OS user running the app:

- Filesystem tools validate paths against folders you explicitly approve.
- Read-only mode disables effective file writes, commands, desktop control and clipboard writes.
- `exec_command` is intentionally **not** confined to approved folders. It starts in an approved working directory, then runs with the normal privileges of your account.
- Screen, mouse/keyboard and clipboard permissions are desktop-wide capabilities on Windows and macOS, not folder permissions. On macOS they start off and also require the OS's own Screen Recording and Accessibility grants.
- MCP servers bind to loopback and use secret tokenized paths. Public reachability comes only from the tunnel you configure.
- The companion-extension bridge is a separate loopback service and exposes no filesystem, command or settings-mutation route.
- Stored API/bridge credentials use Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, a secure desktop secret store on Linux). Linux `basic_text` is refused; normal Activity logs are redacted, capped and memory-only.
- Assistive setup may create provider credentials on the user's behalf when explicitly authorized, but credentials remain isolated per application, least-privileged, locally protected, and independently revocable. See [Accessibility, browser identity, and credential stewardship](docs/accessibility-and-credential-stewardship.md).
- Session recording is separate durable local history. It is on for fresh installs and can be disabled.

### Layered approvals: keep Eve useful without making every tool a local opt-in

ParadigmEve deliberately does **not** make ordinary requested work unusable in the name of a
"safe default." A fresh install keeps the normal Core work surface available, including file
creation/editing/moving/deletion, command execution and saving ChatGPT-produced files. Those are
the capabilities that let Eve actually implement, test and deliver work instead of falling back to
chat-only instructions.

The security model is layered instead:

1. **ParadigmEve owns hard local boundaries.** Approved-root path checks, real-path validation,
   exact caller/session identity, process ownership, file-size limits, durable archive/delete
   invariants and platform/OS permission gates remain enforced locally. Provider approval does not
   replace these checks.
2. **ChatGPT/OpenAI owns contextual action approval where available.** ChatGPT app permissions can
   ask before actions, allow read actions, or automatically allow lower-risk actions while still
   requiring confirmation for higher-risk actions. ParadigmEve therefore keeps normal Core tools
   exposed instead of requiring users to discover and enable a second set of local write/exec
   switches before Eve can work. Provider approval is based on the app permission and action
   context; ParadigmEve does not distort copied Codex tool contracts merely to add another signal.
3. **Unattended autonomy is a separate product choice.** Features that can act later, repair the
   app itself, or continue without a fresh user request default more conservatively and are
   surfaced as explicit settings.

When ChatGPT offers the choice, **Allow low-risk actions** is the recommended balance for
ParadigmEve. It lets routine work proceed while retaining provider-side review for higher-impact
actions. **Allow all actions** is an intentionally higher-risk choice and is not the recommended
default. OpenAI documents these permission levels and notes that higher-risk actions may still
require confirmation or be denied:

- <https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt>
- <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>

Where ParadigmEve publishes MCP annotations such as read-only/destructive/open-world hints, they
are **advisory signals to the provider, not a security boundary**. ParadigmEve must still validate
every action itself.

### Fresh-install hygiene defaults

The baseline follows a "power on demand, ambient autonomy off" rule. Existing installs keep their
explicit saved choices; these are fresh-install defaults, not an upgrade-time permission reset.

| Behavior | Fresh default | Why |
| --- | --- | --- |
| Core file/process tools (`create`, `edit`, `move`, `delete`, `command`, `saveArtifact`) | **On** | They are required for Eve to do normal requested work. Local sandbox/invariant checks remain authoritative and ChatGPT can provide contextual action approval. |
| Multi-agent / workers | **On** | Workers are part of normal requested execution, not unattended permission to invent work. |
| Unattributed tool calls | **Off** | Powerful work may remain available, but ambiguous caller identity should fail closed rather than guessing which chat owns a mutation. |
| Computer Use (screen, mouse/keyboard, clipboard) | **Off** | Desktop-wide access reaches beyond approved project folders and deserves an explicit user choice plus any OS-level consent. |
| Privacy screenshots | **On** | Prefer window-bounded captures over monitor-wide pixels when a backend can choose. Windows Window2 is already stricter: model-facing observation captures the exact selected window and owned popups, and a failed native window capture does not silently substitute monitor pixels. |
| Start ParadigmEve at login | **Off** | Installing the app should not silently add a persistent startup program. |
| Connect automatically at startup | **Off** | A network connection should be opt-in on startup. Connecting the tunnel alone does not call a model or spend LLM tokens, but it still creates background network/control traffic. |
| Goal / Loop | **Off** | These can continue work without a fresh user message and therefore require deliberate opt-in. |
| LAN collaboration | **Off** | Network peer discovery/collaboration is useful but should never be assumed merely because machines share a network. |
| Eve may change ParadigmEve settings | **Off** | Self-maintenance is useful, but changing the app's own policy is a separate authority from doing project work. The exact Eve/Eva owner may still inspect its own `/appdata` through normal read-only file tools; writes/commands there and installation-root access remain behind this setting. |
| Eve may archive completed Eve work | **Off** | Housekeeping is opt-in and is narrowly scoped to completed Eve/worker Plans, not Activity history, sessions or Threads. |
| Eve may control the ParadigmEve window | **Off** | Model-driven mouse/keyboard control of the app itself can reach settings and therefore needs a separate explicit choice. Enabling it also implies settings authority; the UI does not pretend OS-level clicks can be reliably separated from settings clicks. |
| Session recording | **On** | Pins, Plans, provenance, exact-chat recovery and continuity depend on the local record. It stays local and has separate retention controls. |
| Automatic compaction | **On** | This is continuity protection for an actively used long conversation, not broad permission to invent new work. |
| Background chat placement | **On** | This controls where app-created browser tabs sit; it is not action authority by itself. |
| Ongoing plugin auto-refresh | **On** | It keeps the ChatGPT connector's tool schema current after app/tool changes. It is maintenance/network traffic, not a model call, and does not itself spend LLM tokens. Users can still turn it off for stricter metered/privacy preferences. Initial enrollment and required recovery remain correctness work. |
| Keep running when the window is closed | **Off** | Closing a fresh install should mean closed unless the user explicitly chooses tray/background persistence. |

The distinction is intentional: **normal tools answer a current user request; ambient autonomy can
act later or on the app itself.** The former stays useful out of the box, while the latter starts
from explicit consent.

## Expected limitations

These are properties of the current design, not vulnerability reports by themselves:

- **Release binaries are not publisher-signed; macOS builds are also unnotarized.** Apple-silicon Mach-O files may still carry ad-hoc signatures, which do not identify a publisher or establish Gatekeeper trust. Windows SmartScreen, macOS Gatekeeper or browsers can warn. Verify release SHA-256 checksums before running them.
- **The Linux AppImage has a sandbox-availability fallback.** Its electron-builder static launcher can add `--no-sandbox` when the host disables unprivileged user namespaces. On Debian/Ubuntu, prefer the DEB on such restrictive systems if you do not want the portable AppImage to take that fallback.
- **Fresh installs start Core work permissions enabled and read-only mode off, but Computer Use starts off.** Core tools are intentionally useful out of the box; desktop-wide screen/input/clipboard access is a separate explicit choice. Existing installs keep their explicit stored choices.
- **Application path checks are not a kernel/VM sandbox.** They substantially constrain the app's filesystem tools, but same-user filesystem races can still exist. Do not treat approved roots as isolation from a hostile local process.
- **Command and Windows Desktop capabilities are powerful by design.** If enabled, they can act wherever your logged-in user can act, subject to normal OS privilege boundaries.
- **Session recording is intentionally detailed and is not encrypted by `safeStorage`.** Recorded conversations/tool activity stay local to this app, but anyone with access to your OS account may be able to read the session files.

## Scope

In scope: this repository's desktop app, MCP surfaces, local browser bridge and `extension/` companion.

Out of scope: ChatGPT/OpenAI infrastructure, Electron/Chromium upstream, `tunnel-client`, `cloudflared`, and other third-party dependencies. Report upstream vulnerabilities to the relevant project as well.
