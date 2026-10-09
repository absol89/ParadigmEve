# 2.3.7 — readable everywhere: GPT-6 content, offline archive, %claude

Branch `release/2.3.7`, started from `release/2.3.6` (33ebf056) with Eve's uncommitted content-reference work.

## Goals and where they stand

| Goal | Proof |
|---|---|
| A. A local Ollama chat is archived correctly with Eve offline | `ollama-chat-provider.test.ts` › acceptance A: two local turns, every non-loopback request fails and is recorded (none happen), store restart, archive rebuilt from the local store, search finds the words, provenance `ollama-local / llama3.2` |
| B. ChatGPT chats show their words, not ids | `chatgpt-exchange-dom.test.ts` (GPT-6 DIL fallback, escapes, unresolved reference), `backend-recording.test.ts` (self-reference repaired in place, turn not completed by a wrapper), `renderer-timeline.test.ts` (waiting, then words in place), `archive-runtime.test.ts` (missing words, never the pointer) |
| C. Ollama Cloud archives as cloud and stays readable without the cloud | acceptance C: provenance `ollama-cloud / gemma4:cloud`, readable after restart and rebuild with no network |
| %claude | `env.test.ts` (Claude Desktop's managed Claude Code put on exec_command PATH), `pins.test.ts` (Thread contract) |

## Root causes

- GPT-6 / DIL (chatgpt.com, 2026-10-08): a reply's `content` is only `::chatgpt-content-reference{…}`; the words are
  `model_dil_v2.fallbackMarkdown` on the `dil` reference naming the same message, with punctuation backslash-escaped
  outside code. `renderItemMessage()` read `content`, so replies were archived and shown as reference ids.
- Archive provenance: `providerIdentity()` stamped every event `chatgpt` and ignored `event.provider`.
- %claude: Claude Code exists here only as Claude Desktop's managed binary,
  `%APPDATA%\Claude\claude-code\<version>\<build>\claude.exe`, never on PATH. Found, it still answers
  `Not logged in · Please run /login`: the CLI keeps its own sign-in, separate from the desktop app. The user signs in.

## Chat On Steroids v2.1.28 → v2.1.31 (116 commits) — capture-relevant classification

| Upstream | Subject | ParadigmEve |
|---|---|---|
| 0c407b7a, 78be0891 | GPT-6 DIL `fallbackMarkdown`, unescape outside code | **Ported** (`renderItemText`, `unescapeFallbackMarkdown`) |
| fa77d609 | content-reference pattern cannot backtrack | Present: ParadigmEve's patterns are anchored and bounded |
| 721923b1, 779247ed | app-sent user text recorded with Markdown escapes | Partly present: app sends show `authoredText`; page-inserted text (Goal replies) still escaped — candidate |
| f0ee4efd | large rendered compaction finals end to end | Candidate (compaction, not archive correctness) |
| 01a59c78 | current ChatGPT file attachment tiles | Candidate for app-sent attachments (upload tile detection) |
| bb4f949d, e913a7c8, ae185aff, 4e25fa76 | GPT-6 model lanes, picker | Not ported: model picker/product presentation, not capture |
| dc776941, d969628f | approval card waits are not stalls | Candidate (turn completion) |
| c02cb424, 9e738c8e, c85137d3, 4d704a00, fec61625, 3282074d, e4e8ef92 | stream cache, resume ownership, compact draft, could-not-load page, silent recovery, pickup reloads, continuation retry | Candidates for delivery/recovery robustness; each needs its own diff against ParadigmEve's diverged content.js |
| 38ea1bd9, 7c30c447, 078e9633, 2fed5885, 0a839782, 7c8b0117 | Goal/Loop helper behaviour on GPT-6 | Not ported: Chat On Steroids helper design differs from ParadigmEve's Goal |
| remaining (~90) | UI, sidebar, setup, What's New, pets, CI | Not relevant to capture |

## Live verification still needed (installed and reloaded build)

1. Local Ollama chat with the network unplugged; restart Eve still offline; open Archive: both sides readable.
2. GPT-6 typed chat on chatgpt.com: Eve's chat and Archive show the reply words, no `::chatgpt-content-reference`.
3. GPT-6 Voice, then typed continuation: same check.
4. Ollama Cloud turn; disconnect; restart; the cloud turn stays readable, labelled Ollama Cloud.
5. Switch GPT → local Ollama → Ollama Cloud → GPT: one session, each turn with its own provider, in order.
6. %claude: after the user signs Claude Code in (`claude` then `/login` in a terminal), Eve runs `claude --version`
   and a tagged `claude -p … --output-format json` and reports the tag, session id and answer.
