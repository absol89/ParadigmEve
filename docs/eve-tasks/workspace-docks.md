# Workspace docks: Files, Terminal, Agents, Review

**Owner:** Eve · **Target:** 2.3.1 · **Status:** Ready to start · **Written:** 2026-09-28

## Goal

Give every ParadigmEve chat a workspace beside it, comparable to Chat On Steroids 2.1.17:

- **Files**: a tree of the chat's project with a read-mostly viewer for code, text, Markdown and images. It hides
  `.git` and `.DS_Store`, like other editors.
- **Terminal**: a real shell in the project folder, in the side panel or along the bottom.
- **Agents**: the chat's workers, reusing ParadigmEve's existing `src/renderer/agent-panel.ts`.
- **Review**: a read-only Git view. It shows what changed in the project's repository, what one of Eve's edits did,
  or a comparison of two local branches without checking anything out. Review never writes to the repository.
- **Docking**: the Files, Terminal, Agents and Review panels open in a side panel, and a Terminal can also sit
  along the bottom. Shortcuts are Ctrl+Shift+1–4 for the side panel and Ctrl+` for the bottom Terminal, matched
  by physical key so non-US keyboards work.
- **Greyed-out panels explain themselves**: Files and Review need a project, Agents needs an open chat.

This is one focused job. Do not mix in other 2.1.17 features.

## Out of scope

- Upstream's Skills library and any skill import from folders, `SKILL.md` or GitHub. It is intentionally not
  ported.
- Desktop pets / avatar, the Usage page and Goal/Loop changes. They are separate 2.3.x work.
- Writing to Git from Review: no stage, commit, checkout, reset or stash.
- An in-app code *editor* that saves files. Viewing is in scope. Saving files stays with Eve's existing tools,
  which carry permissions, recording and review.

## Upstream references

Chat On Steroids, public repository `https://github.com/totec448-spec/chat-on-steroids`, tag `v2.1.17`. Port the
behaviour, not the files: ParadigmEve has diverged a lot, and a straight copy will not fit its owners.

| Area | Upstream files | Upstream commits (oldest first) |
| --- | --- | --- |
| Files and Terminal (first version) | `src/main/project-files.ts`, `src/main/project-file-watcher.ts`, `src/shared/project-files.ts`, `src/renderer/file-panel.ts`, `src/renderer/file-code-editor.ts`, `src/renderer/file-pdf-viewer.ts`, `src/main/workspace-terminal.ts`, `src/main/workspace-terminal-ipc.ts`, `src/shared/workspace-terminal.ts`, `src/renderer/workspace-terminal.ts` | `c91f1be` |
| Dock shell | `src/renderer/workspace-docks.ts` | `9a5defb`, `287474e`, `90940de`, `bd8b06d`, `c4816fd`, `3318fb3` |
| Review | `src/main/project-git.ts`, `src/shared/project-git.ts` | `ce6bd23`, `1922f06`, `facc2fb`, `04388cc` |
| Polish | — | `2735162` (hide `.git`/`.DS_Store`), `533c6d8` (why a panel is greyed out) |
| Upstream notes | `docs/worklog-2026-09-24-ui-docks.md`, `docs/worklog-2026-09-25-flat-terminal-tabs.md`, `docs/worklog-2026-09-25-projectless-terminal.md` | — |

Upstream adds `@xterm/xterm`, `@xterm/addon-fit`, `codemirror` with `@codemirror/*`, and `pdfjs-dist`.
ParadigmEve already ships `node-pty`.

## ParadigmEve rules this work must keep

Read `AGENTS.md` first, especially "Delete before adding", the owner table (§4) and the filesystem boundary.

1. **Filesystem authority stays in one place.** Every path Files or Review reads resolves through the existing
   approved-root owner (`resolvePath` in `src/main/sandbox.ts`) to a canonical real path. Do not use upstream's
   project-path shortcuts. A project folder grants no permission by itself. A path outside the approved roots is
   refused visibly, never silently widened.
2. **Capabilities are honoured live.**
   - Files and Review need the `read` capability.
   - Terminal needs the `command` capability, the same one that gates `exec_command`.
   - Read-only mode disables the Terminal.
   - Turning a capability off while a panel is open closes or disables that panel with an explanation.
3. **One owner per fact.** The terminal reuses ParadigmEve's existing `node-pty` process handling where possible
   rather than adding a second PTY stack. Agents reuses `agent-panel.ts`. The current project comes from the
   existing session/project binding (`src/main/projects.ts`), not a new store.
4. **Review is read-only in code, not just in UI.** Git runs with a fixed argument list (no shell). It uses
   read-only commands such as `status --porcelain`, `diff`, `log` and `show`. Upstream's platform-safe Git
   resolution (`facc2fb`) is the model to follow.
5. **Localization.** Every new user-facing string goes through `t()`/`ui()` from `src/renderer/i18n.ts`, with a
   Swedish entry in `src/renderer/locales/sv-SE.json` in the same change.
6. **Privacy and packaging.**
   - New dependencies need their notices: run `npm run verify:notices`, and regenerate notices with the scripts
     it names if it asks.
   - Keep the renderer bundle growth reasonable. If `pdfjs-dist` is heavy, PDF viewing may wait.
   - `npm run verify:privacy` must pass before every commit.
7. **The MCP tool-list size budget** (`test/mcp.test.ts`) must not grow unless a model-facing change is part of
   this task. The docks are UI and should not need one.

## Acceptance criteria

- A chat with a project can open Files, Terminal, Agents and Review in the side panel, and a Terminal at the bottom.
  The layout survives an app restart.
- A chat without a project shows Files and Review greyed out, with the reason. Agents shows its reason when no chat
  is open.
- Terminal disabled:
  - when `command` is off, the panel says so, and a running terminal ends when the permission is removed;
  - in read-only mode, the Terminal does not start.
- Files never lists or opens anything outside the approved roots. A symlink or junction pointing outside is
  refused, which needs a test.
- Review never changes the repository. Tests should spy on the Git runner and assert only read-only subcommands
  run.
- Shortcuts work on a non-US keyboard layout.
- Every new string has a Swedish translation.
- `npm run typecheck`, the full `vitest` suite, `npm run verify:privacy` and `npm run verify:notices` pass.
- The Vault and `AGENTS.md` describe the docks' owners and boundaries, and the 2.3.1 notes gain a short
  "Workspace" section.

## How to work and report

- Work on a new branch `eve/workspace-docks` from `release/2.3.1`, in a separate `git worktree` next to the main
  checkout. The main checkout is shared and usually dirty.
- Commit in small steps: Files, Terminal, Agents, Review, dock shell, polish. Never push, tag or publish.
- If a rule above conflicts with how upstream works, stop and ask rather than weakening the rule.
- When done, reply with:
  - the branch and commits;
  - what was ported and what was left out, and why;
  - the exact test and verification output;
  - anything the user should check by hand in the app.

## Prompt for Eve

Paste this into a fresh Eve chat that has the ParadigmEve repository as an approved folder:

> Your single focus for this chat is ParadigmEve's Workspace docks. Read `docs/eve-tasks/workspace-docks.md` and
> `AGENTS.md` in the ParadigmEve repository first.
>
> Before you change anything:
>
> 1. Tell me in your own words what we are building and what is out of scope.
> 2. Tell me which ParadigmEve owners each dock will use for files, commands, projects and workers.
> 3. Explain how you will keep Review read-only and Files inside the approved folders.
> 4. List the upstream commits you will port, in order, and any dependency or bundle concern.
>
> Wait for my OK. Then work on branch `eve/workspace-docks` in its own worktree, committing each dock separately.
> Run the checks the task file lists after each step. Stop and ask me if a rule in the task file conflicts with
> upstream's approach. Do not push, tag or publish anything.
