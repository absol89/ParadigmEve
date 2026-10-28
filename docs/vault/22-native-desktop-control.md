# 22 — Native Desktop control

> **Implementation contracts.** The sections below moved here unchanged from the former single-file
> `AGENTS.md` map. Their § numbers are kept so references such as “§14” still resolve; the
> [Vault index](README.md#former-agentsmd-sections) lists where each section lives.

## 18. Native Desktop

Desktop is available only on Windows and supported macOS. Linux removes it from live discovery
and enforcement while preserving stored preferences. Windows uses the bounded PowerShell/Win32/
UIA helper; macOS uses Swift ScreenCaptureKit/AX/CGEvent through an architecture-matched N-API
addon on an Electron worker. The packaged Electron app is the macOS permission subject; a
standalone CLI probe does not prove Screen Recording/Accessibility permission for the app.

`computer/index.ts` owns native actions, capture frames/accessibility refs, batching and
postconditions. Routine helper/queue/screenshot timing logs are opt-in using Activity's persistent
**Timing: On/Off** control (Off by default, even in debug builds). Unlike CLF_DEBUG console echo,
this controls emission into both the 500-entry ring and the file. Failure diagnostics stay active.
Registrars own live capability checks. Windows `windows-api.ts` implements the
13 Window2 methods: `list_windows`, `get_window`, `list_apps`, `launch_app`, `get_window_state`,
`click`, `press_key`, `type_text`, `scroll`, `set_value`, `drag`, `perform_secondary_action`,
`activate_window`. The old `observe`/`computer` wrapper is macOS-only. Windows observation state
is bounded per exact caller, contains no pixels/text, and input consumes its indexes/geometry.
Explicit activation consumes observation state too; ordinary input already activates its target.
Late observations and replaced principals cannot lend another call their state.
Observe → act uses exact frame/ref, target geometry and
helper generation. Recheck those after asynchronous image work and before every local action
in a batch. A replaced helper/window/display invalidates old coordinates and refs. Bound
decoded images, report actual visible crops, and never label a visible screen crop as a hidden
window capture. Coordinate clamping and physical input respect the current display/button map.

Windows uses source-owned Windows.Graphics.Capture for exact HWND compositor pixels, including
covered GPU windows, without activation or a visible-screen fallback. Minimized/unavailable
capture fails explicitly. DWM image bounds and outer window geometry have distinct roles.
Fresh read-only window observations may internally reacquire a named-window capture a bounded
number of times when Windows reports `STALE_FRAME` during that capture. Each attempt reacquires
geometry and related-window ownership from scratch, and only a fully stable attempt is published.
This resilience never carries over to input: clicks, drags and indexed/coordinate actions still
require the exact retained frame/ref and fail closed when that observed geometry becomes stale.
Before starting a window capture, the optional `IGraphicsCaptureSession3` interface disables
the capture border so individual screenshots do not flash a yellow outline. Older Windows
without that interface retains its system indicator; permissions and capture failures remain
Windows-owned. `scripts/verify-windows-capture-border.mjs` compares visible control/production
borders and the missing-interface case using an owned fixture on an unlocked Windows 11 desktop.
Screenshot observations default to optional UIA off; `include_text` adds indexed accessibility,
advertised semantic actions, bounded document/selection text and focused control. Up to three provably owned popup
windows have separate images/frames; same process alone is insufficient ownership evidence.
Public state retains observed window focus, accessibility truncation and provider failures;
frame ids/dimensions precede long accessibility text. Pixels appear once in native MCP image
blocks, never duplicated as data URLs in `structuredContent.value`. A text-provider failure
preserves a usable screenshot and its explicit diagnostic. Offscreen/disabled controls are marked.
Document text reports whether it represents the visible document ranges or a bounded prefix,
and separately reports when that returned scope itself exceeded the text budget. Browser
Documents prefer visible UIA text so scrolling produces the next useful viewport instead of
repeating an arbitrary page-start prefix; non-Document editors keep the bounded prefix behavior.

For Chromium browser windows, `BrowserRootView` owns the current accessibility tree, including
the address bar and displayed document. Legacy renderer HWNDs can expose old tabs with plausible
bounds and `IsOffscreen=false`; they are not alternative observation roots. Missing/ambiguous
browser roots fail text observation explicitly. Before semantic input, the cached element must
still descend from the same current UI root; liveness of an old tab's provider alone is insufficient.
Document text selects one provider within the existing bounded traversal, preferring a Document
over native editors. Browser toolbar editors never supply page text; an unobserved page leaves
document text absent. Native apps retain editor text when no Document provider is observed.
Read document/selection text once under their shared 8,000-character budget.

Windows physical input requires a returned Window `{app,id,title?}` and activates/checks it before
each action. App identity, pixel frames and refs must match that target; popup input rechecks its
original native owner. Public coordinates are pixels within the selected returned screenshot;
its declared dimensions match its PNG. The existing native frame owner converts through the
capture origin/scale without a second facade DPI conversion. Named punctuation follows the target
thread's keyboard layout, clicks support counts 1–3, and drags interpolate over a bounded duration.
Multiline text uses the existing Electron clipboard owner and targeted paste, with clipboard-write
permission checked before the batch. Native Unicode typing refuses multiline text before input.
Paste verifies target activation before replacing the clipboard and checks focus again at
physical injection. Activation uses bounded actual foreground observation after one attempt;
an immediate Windows return value alone cannot establish the result.
UIA actions resolve exact snapshot refs without a physical fallback for unsupported patterns.
App enumeration joins installed and running apps only by exact native AUMID or executable path,
including their windows and observed running status. Launch accepts a Shell app ID or explicit
`.exe` path/PATH application name without arguments. Launch acknowledgement requires later
observation to prove a window opened. Wheel input preserves raw deltas (120 per detent).

The Windows helper owns a unique temporary UTF-8 script file for its process lifetime, starts
with a process-scoped execution policy, and removes it on retirement. Native source stays out
of inherited environment blocks; streamed UTF-8 replies preserve split multibyte characters.

Focus/clipboard/input are real native effects. Validate target and action permission, retain
partial-batch outcomes, and report postcondition failure rather than invent success. The
browser-chord policy prevents tab/window management through forbidden input chords; address-bar
focus chords support authorized navigation, like clicking or setting that same native control;
it is not a general browser automation fallback. Browser-owned private chrome is not a discovery
surface for Eve/Eva: do not deliberately open, reveal, inspect or operate History, passwords/password
manager, Bookmarks/Favorites menus, or the bookmarks/favorites bar. Opening an ordinary browser
application menu is allowed when task-relevant, but do not deliberately choose entries that reveal those
private areas.

Native control must also preserve foreground user work. Before paste/type/focus/window-switch
actions, inspect the current foreground/focused editable control when available and treat any
active typing or unsent text as a hard conflict. Do not paste instructions or code over an
occupied input, do not clear or replace a user's unsent draft, and do not switch applications,
windows or tabs out from under an actively typing user. Defer the mutation and re-observe later;
only proceed when the target and draft state are still the intended ones. Ambiguous ownership is
not permission to take focus.

Treat an active voice-call browser tab as protected foreground state. Do not close, navigate,
reload, repurpose, replace, or reuse that tab for workers, setup flows, recovery, fresh-chat
creation, or cleanup while the voice call is active. Workers and Computer Use must use another
eligible tab/window instead. Voice conversation itself does not forbid Computer Use elsewhere:
when the user is hands-off and talking, Eve may type, paste, click, and switch among other
unprotected windows as authorized, provided the active voice-call tab remains intact and the
ordinary typing/draft protections above still hold. If call ownership or activity is ambiguous,
preserve the tab and choose another surface.

In particular, never toggle/show a hidden bookmarks/favorites bar to reveal more user data.
It may remain incidentally visible in an ordinary screenshot, but automation must ignore it unless the
user explicitly asks to use a specific already-visible bookmark. Capture/privacy settings
and platform permission failures remain explicit, with no Linux/helper fallback that bypasses the
capability model.
