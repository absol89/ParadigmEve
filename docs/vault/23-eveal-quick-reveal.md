# 23 — `%eveal`: the EVE-Al Quick reveal

`%eveal` is an app-owned starter Thread that runs the **EVE-Al Quick reveal**: a short, offline check of
how the current setup (model, build, persona, tools) behaves as an agent. It covers coding pitfalls,
conflicting sources, honest "I don't know" answers and agentic hygiene, is worth 40 points, and aims for
20 minutes with a hard stop at 30. `%eve-al` routes to the same Thread.

## What happens when it is activated

- The standing prompt is deliberately short (about 160 tokens). It points at
  `/paradigmeve-eveal/EVEAL.md` and does **not** paste the suite into the opening message, unlike the
  `%how` quick reference. The agent reads each task file only when a step needs it, so a run reads
  about 4k tokens of suite material in total.
- The agent writes one `eveal-run-<yyyymmdd-hhmm>/` folder inside an approved Workspace folder (for
  example `/<root>/eveal-runs/`) and tells the user its full path. With no writable approved folder it
  says so and stops; add one under **Settings → Workspace → Folders** first.
- Activation adds a short `# EVE-Al suite` block naming `/paradigmeve-eveal`. On ChatGPT that is all;
  the model reads `EVEAL.md` itself.
- **Ollama and OpenRouter chats** get the same Thread activation from their opening message (it rides in
  the system prompt on every turn, so trimming long history never drops it), plus `EVEAL.md` itself,
  because a local model may have a small context or no tools. A model on this computer (Ollama local)
  also gets the suite's folder on disk, so a command can copy the probe kit. Remote models never get a
  disk path. A chat without a file-reading tool (delegate mode, or a model without tool support) is told
  so, shows the user the steps and the suite location, and stops instead of guessing.
- Chats with the Ollama daemon on this computer use its native `/api/chat` with a `num_ctx` sized to the
  request (and never shrunk within a run, so the model is not reloaded every turn). Ollama's
  OpenAI-compatible endpoint ignores `num_ctx` and its default window is often 4k tokens, so a local chat
  with tools (7–9k tokens) used to lose its front, system prompt and Thread context included, without any
  error. `app.log` records each local turn's activated Threads and context size, and the prompt tokens
  against `num_ctx`; a count at the window's edge is logged as a warning.
- If the user pastes an honesty block (it starts with `Honesty check (challenge hon-`), the agent answers
  that one instead of the practice set.

## The `/paradigmeve-eveal` namespace

- The suite ships as `eveal/` in the package resources (`electron-builder.yml` `extraResources`) and is
  mounted **read-only** at `/paradigmeve-eveal`, next to the Vault's `/paradigmeve-manual`. Only `read`,
  `find` and `view_image` see it, and only when a call names it; `apply_patch`, file actions and commands
  never do. It needs no approved folder and no self-maintenance authority. The root name is reserved, so
  a user folder cannot shadow it.
- Unlike the flat manual it has subfolders (`tasks/`, `corpus/larkspur/`, `fixtures/…`), with the normal
  traversal and link confinement of approved roots.
- To run a fixture, the agent copies it into its output folder with its file tools; nothing executes
  inside the shipped suite.

## What ships, and what never does

Only the contestant material ships: `EVEAL.md`, `tasks/`, `corpus/`, `fixtures/` and
`runs/*.template.json`, the same contents as the public `eveal-suite.zip` download. **Answer keys, hidden
tests and scoring tools (`reviewer/`, `tools/`) never ship.** Eve can read anything installed, so a key in
the package would make every run worthless. `test/packaging.test.ts` checks the source tree and the
builder filter, and `scripts/smoke-packaged-runtime.mjs` refuses a package whose `eveal/` holds a
`reviewer` or `tools` path or differs from the source bytes.

## Scoring stays outside Eve

`%eveal` never scores itself. The user scores the output folder offline with the suite's own scoring
tools from a separate checkout or download, ideally on another machine. A shell on the same account can
still read a public checkout's keys, so a public-tier Quick reveal is a self-check, not a blind score;
ranking-grade runs need a private honesty seed and the held-out tier.

Approval prompts, stalls and connector type are host conditions, recorded separately in `run.json`.
