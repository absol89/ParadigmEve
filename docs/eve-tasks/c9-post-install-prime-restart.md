# c9 post-install Prime restart and handoff investigation (source-only follow-up)

## Report and observed installed state

The c9 Windows installer restored the absent dedicated Eve Browser after install and the
Companion connected, but the exact Prime ChatGPT conversation did not restore alongside a
heartbeat conversation. The user also saw a Compact & Resume handoff that ChatGPT would not
accept while Prime was still thinking, and a restart wake that did not send.

The installed log separately establishes:

- A durable exact-Prime restart wake was queued at startup.
- Browser-profile restoration used the preservation branch, which did not run the separate
  exact-Prime startup path.
- Five minutes later, restart recovery treated the unadmitted wake as a reason to open
  Compact & Resume despite no positive provider-idle proof.
- The continuation remained awaiting-summary with neither source nor destination send
  attempted; the restart wake later became terminal without a Send acknowledgement.

An extension wake socket, a restored heartbeat tab, a missing recorder entry and
`ready:false` prove neither Prime-tab absence nor provider-idle state.

## Source changes after c9 (not installed)

- In `bridge.ts`, restart-wake recovery uses two complete, separated current Companion
  Chrome tab censuses, tied to the exact durable installation Prime/session and queued
  restart-wake input. Unknown census, an already-present Prime tab, a superseded/cancelled
  input, and a changed turn or session all revoke opening authority. This includes both
  interrupted-turn and previously idle Prime wakes.
- The existing browser-repair owner carries the one exact `prime-restart` action. The
  Companion scans again after the action claim, preserves any exact or still-loading tab,
  and opens at most one inactive Prime tab in an existing window of the dedicated
  extension profile. It never opens a new browser window, navigates or reloads an
  existing ChatGPT tab, selects/focuses a tab, or sends the wake.
- The five-minute restart timer does not manufacture a Compact & Resume ticket from
  absent or non-generating recorder state. A still-open historical turn is insufficient
  proof that ChatGPT has finished thinking; wake delivery stays with the durable outbox.

The current installed c9 cannot benefit from these edits until a new, independently
proven package is explicitly authorized, built and installed. No existing continuation,
Plan, wake, tab, draft, Voice state or installed binary was modified as part of this
source repair.

## Checks and limits

- Focused bridge/extension/restart/recovery-memory/input-startup verification:
  713 passed, no failures. Includes unknown, active and idle Prime censuses; existing
  and racing tabs; loading windows; and no unauthorized send.
- TypeScript and `git diff --check` passed after these source changes.
- The final uninterrupted whole-tree `npm.cmd run verify:ci` passed after the
  idle-Prime generalization: main Vitest 6,125 passed/44 skipped, Computer Use
  20 passed, MCP shutdown 2 passed — **6,147 passed, 44 skipped total**.
  TypeScript, public-history privacy, notices and Electron resolution passed.
  `git diff --check` passed after that run.
- Read-only post-test verification still found only candidate directories c1–c9.
  Installed `app.asar` SHA-256 remained
  `FFA65896BFECA5663BE46155DBA861C3A6875F5ED94961FBFE93832D6993652C`,
  identical to the previously verified c9 package, not this source revision.
- Automated Chrome mocks do not establish that a future real reboot preserves every
  focus/draft/Voice case; acceptance needs a natural absent-Prime restart without closing
  any currently active user tab to fabricate the condition.
- The already-filed `awaiting-summary` continuation is not automatically replayed or
  raw-edited here. It needs app-owned reconciliation/user choice after its current source
  page has a safe, observed turn boundary.
