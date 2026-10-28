# 2.4.5 c8 post-install Eve Browser startup

Status: source fix and tests; not yet packaged or installed. Date: 2026-10-26.

## Symptom and live evidence

After c8's successful silent no-focus self-reinstall, the user reported that Eve did not open its dedicated Chrome tab at boot. The installer invoked the replacement with `--background --connect-on-start --preserve-chatgpt-tabs`. The installed `app.log` records startup at 03:15:25 UTC and again at 03:20:37 UTC, each taking the "Companion browser profile preserved during upgrade" branch without initiating dedicated-profile recovery. The bridge was running, but `/recovery` did not establish a current Companion document during the install controller's bounded wait. Those facts did not prove whether Chrome itself was present.

At 03:22:01 UTC, a `chrome.exe` process with Eve's `--user-data-dir=...\ParadigmEve\setup-browser-profile` started under ParadigmEve. At 03:22:01–02 UTC, the app recorded Companion extension 2.4.5 connection and an authenticated wake channel. The later native window census showed `Chrome.setupbrowserprofile.Default` (the dedicated Eve Browser) and an unrelated ordinary Chrome window. This later launch followed newly queued ChatGPT input; it does not prove c8's initial boot path had recovered Chrome. No browser was closed, reloaded, retargeted, focused or launched for diagnosis.

## First wrong boundary

`src/main/index.ts` gave `--preserve-chatgpt-tabs` highest precedence and only logged that it would wait for in-place extension refresh. The one-shot installer signal did not distinguish a live dedicated window (which must remain untouched) from a genuinely absent dedicated window (which can restore Chrome's saved session). The ordinary foreground predicate independently rejects `--background` and preservation launches; changing that general predicate would wrongly affect login startup and could disturb active ChatGPT work.

## Source repair

- Keep install preservation as a distinct startup authority, including second-instance signals received by an already-running Eve and signals arriving before `runtimeReady`.
- Use two exact native dedicated-profile window censuses, fail closed on unknown/error/changed browser selection, and perform no operation if a dedicated window is present, regardless of Companion connection status.
- Only after confirmed absence, launch the selected dedicated Chrome-family profile with `--restore-last-session` and Eve's existing Windows `Start-Process -WindowStyle Minimized` launcher; supply no ChatGPT URL. Wait for its native window. This path invokes no focus/navigation action on a live ChatGPT page, does not restart a running browser, and preserves Chrome's own tab session as the restore authority. An OS minimized-start request is not yet live proof that a particular Chrome build will honor it.
- Coalesce repeated installer signals for one process. An authored wake already probing browser state outranks an installer repair; authored wakes that arrive during install restore wait for that owner. Unknown decisions remain retryable.

## Verification and remaining acceptance

Focused Vitest suites (`browser`, `setup-assistant`, `browser-startup`, `window-lifecycle`, `packaging`): 161 passed. TypeScript: passed. `git diff --check`: passed. Negative tests cover present active Eve Browser, unknown census, delayed appearance, selected-family changes, duplicate signals, both orders of authored-wake overlap, and refusal to fall back to a foreground launcher after a minimized-launch failure.

Final `npm.cmd run verify:ci` exited 0: 300 main test files passed, four skipped (6,117 tests passed, 44 skipped); Computer Use 20 passed; MCP shutdown 2 passed; **6,139 passed, 44 skipped** overall. Privacy, third-party notices, TypeScript and Electron resolution gates passed. An earlier full run was deliberately interrupted when a source-level launch-mechanism correction was needed; only the final uninterrupted run is the gate result.

This is **not installed-runtime acceptance**. Installed c8 still contains the suppressed startup path. Testing a truly absent Eve Browser on the live machine would require closing or altering a live browser and was deliberately not attempted. A later candidate may package this source fix; verify the actual installer/boot and focus behavior on a non-active session before claiming the runtime defect resolved.
