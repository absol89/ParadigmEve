# ParadigmEve 2.3.8 stabilization evidence

Date: 2026-10-12

## Historical source and local installer inspected

- Worktree: the dedicated `release/2.3.8` checkout
- Branch: `release/2.3.8`
- Source checkpoint before the verification-only edits below: `c6033936` (`build/2.3.8-c4`)
- Existing local Windows x64 debug installer SHA-256: `CF4FCA6F0F0A7EF8573E742D2DA73F55F787BCF734BD78895D1AD329C29D2DA1`

## Compact & Resume continuity observed

The live Eve session survived Compact & Resume and moved to a different ChatGPT conversation while
retaining the same durable local session. This proves that the previously installed self-test runtime could
complete that handoff shape and that Core connectivity recovered in the successor chat.

This is **not installed evidence for the newer SHA-256-listed package**. The running ParadigmEve
processes were still executing the earlier local 2.3.8 self-test build. The newer package therefore
still requires its own installed self-testing before public release.

## Verification investigation

Targeted continuation/browser suites passed first: 7 files, 1,540 tests.

Three exact/default-parallel verification attempts then exposed unrelated load-sensitive failures on
the 8-way Windows host:

1. Four 30-second timeouts in recorder dedupe/concurrency cases in `test/session.test.ts`. The four
   cases passed immediately in isolation, and the complete file later passed 156/156.
2. `test/codex-runtime-parity.test.ts` assumed a short pipe child would finish inside a 250 ms initial
   yield. It passed in isolation; the runtime contract legitimately returns a process id if the child
   is still alive.
3. `test/code-mode-runtime.test.ts` used a deliberately tiny 100 ms QuickJS CPU fixture budget in a
   side-effect-reporting test. Under suite saturation the worker could be descheduled inside the
   elapsed-time measurement and stop before dispatching the expected third input. The case passed in
   isolation.

The two tests were narrowed so they test their intended contracts rather than host scheduling speed:

- the completed-pipe parity case now grants the same bounded 10-second completion window already used
  by its neighboring loaded-Windows parity case;
- the unsupported-timer side-effect case receives a 1-second CPU budget while the dedicated CPU-limit
  test retains the small budget.

The suite was then run with `--maxWorkers 4`: 5,599 passed, 42 skipped. That preserved the existing
30-second test/hook limits and avoided the unrelated starvation failures. `vitest.config.ts` now caps
the suite at four workers so the ordinary release gate uses the proven stable scheduling envelope.

## Final checks

The exact `npm.cmd run verify` command passed after the stabilization changes:

- public-history privacy: passed (188 commits, 17 tags at verification time)
- third-party notices: 94 production packages + 7 catalog entries validated
- pinned native sources: 596 archives/patches validated
- typecheck: passed
- main Vitest batch: 271 files passed, 4 skipped; 5,599 tests passed, 42 skipped
- `test/computer.test.ts`: 20/20 passed
- `test/mcp-shutdown.test.ts`: 2/2 passed
- `git diff --check`: passed

No application/runtime production code changed during this investigation. The stabilization diff is
limited to `vitest.config.ts`, `test/codex-runtime-parity.test.ts`, and `test/code-mode-runtime.test.ts`
plus this worklog.

## Release status

Source/test qualification is green after the verification stabilization. Public release should still
wait for installed self-testing of the newer SHA-256-listed package, because the observed successful
handoff came from an earlier installed build. Neither local build label is a GitHub version tag;
no installation, tag, push or publication was performed here.
