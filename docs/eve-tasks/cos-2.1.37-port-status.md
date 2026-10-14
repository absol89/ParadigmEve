# Chat On Steroids 2.1.37 port and c6 — status (2026-10-14)

Branch `feature/cos-2.1.37-port`, cut from `release/2.4.0` at `f37889ae`, in the
`ParadigmEve-file-broker-2.4.0` worktree. Local commits only; nothing pushed or merged.

## A. Port (done)

| Eve commit | Upstream | What |
| --- | --- | --- |
| `5bd8730b` | `305e530a` (#1453) | Find in chat (Ctrl/Cmd+F): whole-recording search via `sessions:find` (`src/main/session/find.ts`), bar in `renderer/chat-find.ts`, reveal through `revealSourceEvent`. |
| `668c6d0d` | `737de925` | A never-authorized message for a broken running answer is requeued after the turn instead of cancelled. Narrower than upstream: authorized sends are never requeued. |

Reviewed and not ported:

- `80242562` long-turn final answer placement — Eve pages by latest revision seq and never drops live revisions; bug absent.
- `72fb5999` reopened-after-stalled turn — needs upstream's `timelineTurns`/`readCompletedFinal` subsystem, which Eve never ported.
- `201115d1` compaction after stream loss — Eve's compaction pickups are time-scheduled with no silence gate; bug absent.
- `078e62d2` Goal helper prompt size — Eve's helper uses an incremental reference without a trim loop; needs its own design.
- `a300bc6d`, `7a4188be` built-in browser — Eve has no built-in browser.
- `cac0f372` app requests through the system proxy — depends on 2.1.36's tunnel proxy, not in Eve; deferred as a feature port.
- `021a6d62`, `fe752eef`, `ef671294` packaging retries — Eve already retries every packaging download (`download-with-retry.mjs`, native-source retry and vendored fallback).
- `1ad5d62c` link cards as Markdown — excluded by Eve's link-format rule.
- New features of 2.1.37 (slash commands, Enter setting, turn-done notifications, keep awake, Send now, worker-chat archiving, storage growth, plugin-refresh offer, Goal loop guard) — not fixes; out of scope.

## Full-suite result on this branch

5749 passed, 5 failed: the ripgrep-dependent exec test (no rg in this worktree), two exec tests and one Ollama skills test that pass when run alone (load flakiness), and the Vulkan hash test below. None touch files this port changed.

## B. After Eve commits c5 on `release/2.4.0` (waiting for Eric)

1. On `release/2.4.0`: fix c5 review findings
   - 1: `content.js` boundary — when the new user message is not found, fall back to all observed turns instead of an empty prefix.
   - 2: decide the old turn's outcome after the exact-turn Fiber refresh (bounded wait), or let the recorder upgrade a "replaced by a new user message" end when that turn's final arrives. Pick the cleaner variant.
   - 4: `archive-runtime.ts` — compute "later stable final of the same turn" once per projection (or only after the last user message), not per mutable row.
   - 5: give `finishGeneration` a "refresh this exact turn for any outcome" option instead of the duplicated block and misleading comment.
   - Tests for finding 3: a witnessed live generation whose final lands with the next user message; a lost generation node.
   - Split the `test/code-mode-mcp.test.ts` polling change into its own commit if c5 bundled it.
   - Pre-existing on release/2.4.0 (f37889ae): `test/transcription-staging.test.ts` "ships the vendored Vulkan build tools unmodified and hash-verified" fails on a correct LF checkout (`transcription-engine/third_party/vulkan-build/SOURCES.txt` is `eol=lf`; the Eve 2.4.0 worktree has it as CRLF on disk, which the pinned hash appears to match). Re-pin from the committed LF bytes.
2. Rebase `feature/cos-2.1.37-port` onto `release/2.4.0` and fast-forward `release/2.4.0` to it. No file overlap with c5 is expected.

## C. Broker and c6

1. Rebase `feature/file-format-broker-2.4.0` (6 commits, base `491cd336`) onto `release/2.4.0`.
   Expected conflicts (keep both sides): `src/main/mcp/surfaces.ts` CORE_TOOLS (`skills` + `file_action`/`file_edit`),
   `local-chat-tools.ts` (skills delegate exception + broker `route`), `local-agent-tools.ts` allowlist,
   `ollama-chat.ts` / `ollama-worker-executor.ts` (skills catalog + broker route/endpoint), preload, `index.html`,
   locales, `AGENTS.md`, package files, `test/mcp.test.ts` counts.
2. Re-measure Core tools/list bytes (about 46.4 KB expected with skills); trim or set the cap with a comment.
3. Full suite, `verify:notices`, `verify:privacy`, diff check; then `npm run candidate -- c6`.

Rules: follow the repo `CLAUDE.md` (no Claude attribution in commits). Ask before force operations, dropping commits, or touching Eve's uncommitted files.
