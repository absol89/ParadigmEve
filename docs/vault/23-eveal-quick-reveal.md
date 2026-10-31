# 23 — `%eveal`: the EVE-Al Quick reveal

`%eveal` is an app-owned starter Thread that runs the **EVE-Al Quick reveal**: a short, offline check of
how the current setup (model, build, persona, tools) behaves as an agent. It is worth 80 points and aims
for 40 minutes with a hard stop at 55. `%eve-al` routes to the same Thread.

- **v0.2 tasks (40 points):** coding pitfalls, conflicting sources, honest "I don't know" answers and
  agentic hygiene, unchanged.
- **v0.3 tasks (40 points):** Swedish applied comprehension (8), verifiable instruction following (8), a
  seeded general fix whose private tests catch special-casing the visible test (12), grounded pushback
  (6) and evidence calibration (6). Each is generated from a seed by `agent-arena/v0.3/tools/gen.mjs`;
  the public practice challenge ships in `eveal/`, and an operator gives a held-out challenge as a folder
  with a `CHALLENGE.md`. Keys and private tests are regenerated from the seed at scoring time and never
  exist in the suite.

## What happens when it is activated

- The standing prompt is deliberately short (about 160 tokens). It points at
  `/paradigmeve-eveal/EVEAL.md` and does **not** paste the suite into the opening message, unlike the
  `%how` quick reference. The agent reads each task file only when a step needs it, so a run reads
  about 9k tokens of suite material in total.
- The agent writes one `eveal-run-<yyyymmdd-hhmm>/` folder inside an approved Workspace folder (for
  example `/<root>/eveal-runs/`) and tells the user its full path. With no writable approved folder it
  says so and stops; add one under **Settings → Workspace → Folders** first.
- Activation adds a short `# EVE-Al suite` block naming `/paradigmeve-eveal`. On ChatGPT that is all;
  the model reads `EVEAL.md` itself.
- **Ollama and OpenRouter chats** get the same Thread activation from their opening message (it rides in
  the system prompt on every turn, so trimming long history never drops it), plus `EVEAL.md` itself,
  because a local model may have a small context or no tools. A model on this computer (Ollama local)
  also gets the suite's folder on disk, so a command can copy the probe kit, the general-fix module and
  the pushback kit. Remote models never get a
  disk path. A chat without a file-reading tool (delegate mode, or a model without tool support) is told
  so, shows the user the steps and the suite location, and stops instead of guessing.
- Chats with the Ollama daemon on this computer use its native `/api/chat` with a `num_ctx` sized to the
  request (and never shrunk within a run, so the model is not reloaded every turn). Ollama's
  OpenAI-compatible endpoint ignores `num_ctx` and its default window is often 4k tokens, so a local chat
  with tools (7–9k tokens) used to lose its front, system prompt and Thread context included, without any
  error. `app.log` records each local turn's activated Threads and context size, and the prompt tokens
  against `num_ctx`; a count at the window's edge is logged as a warning.
- The native Ollama chat response is read as bounded newline-delimited JSON with `stream: true`,
  accumulating content and tool-call entries before the agent loop can execute anything. A complete
  `done` event is required; truncated/error streams fail closed. This avoids the five-minute
  response-header timeout that formerly cancelled long `stream: false` generations (the 2026-10-30
  LFM3 run had generated about 6,142 tokens at 21 tokens/s before its client disconnected).
- If the user pastes an honesty block (it starts with `Honesty check (challenge hon-`), the agent answers
  that one instead of the practice set. If the user names a v0.3 challenge folder, the agent reads the
  five v0.3 tasks from it instead of the practice files; the folder must be one the chat can read (an
  approved Workspace folder), since it is not part of `/paradigmeve-eveal`.
- The pushback task needs one command (`node reveal.mjs` in the agent's copy of the pushback kit). A chat
  that cannot run commands records that and the task is reported as not measured, not as zero. The kit
  has only files the agent may read (`CASES.md`, and `reveal.mjs` with the follow-ups masked inside it),
  because a chat that reaches the suite through the read tool can copy a file only by reading it.

## The `/paradigmeve-eveal` namespace

- The suite ships as `eveal/` in the package resources (`electron-builder.yml` `extraResources`) and is
  mounted **read-only** at `/paradigmeve-eveal`, next to the Vault's `/paradigmeve-manual`. Only `read`,
  `find` and `view_image` see it, and only when a call names it; `apply_patch`, file actions and commands
  never do. It needs no approved folder and no self-maintenance authority. The root name is reserved, so
  a user folder cannot shadow it.
- Unlike the flat manual it has subfolders (`tasks/`, `corpus/fernhollow/`, `corpus/larkspur/`, `corpus/v03-svenska/`,
  `corpus/v03-calibration/`, `fixtures/…`), with the normal
  traversal and link confinement of approved roots.
- To run a fixture, the agent copies it into its output folder with its file tools; nothing executes
  inside the shipped suite.
- Reading a suite file by its full path makes the suite the chat's working folder, and `EVEAL.md` links
  its files relatively, so relative reads (`tasks/pitfalls.md`) resolve inside the suite too. A write or
  command that lands there is refused as read-only and told to use a full path in an approved folder;
  the mount is never reported as an unknown root. The opening context also writes the main paths out
  in full.

## What ships, and what never does

Only the contestant material ships: `EVEAL.md`, `tasks/`, `corpus/`, `fixtures/` and
`runs/*.template.json`. The v0.3 practice files in it are exactly what `gen.mjs --practice` writes
(`gen.mjs --practice --check` and the v0.3 tests compare them). **Answer keys, hidden
tests and scoring tools (`reviewer/`, `tools/`) never ship.** Eve can read anything installed, so a key in
the package would make every run worthless. `test/packaging.test.ts` checks the source tree and the
builder filter, and `scripts/smoke-packaged-runtime.mjs` refuses a package whose `eveal/` holds a
`reviewer` or `tools` path or differs from the source bytes.

## Scoring stays outside Eve

`%eveal` never scores itself. The user scores the output folder offline with the suite's own scoring
tools from a separate checkout or download, ideally on another machine: `agent-arena/v0.3/tools/score.mjs`
scores all 80 points, using v0.2's scorer for the first 40 (`EVEAL_V02` names its folder). A shell on the
same account can still read a public checkout's keys and any seed stored there, so a practice run is a
self-check, not a blind score. A held-out run needs fresh private seeds (v0.2 honesty and v0.3), the
held-out v0.2 tier, and a judge the agent cannot reach; without that isolation the scorer labels it
open-book.

Approval prompts, stalls and connector type are host conditions, recorded separately in `run.json`.
