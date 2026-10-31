> **Superseded.** This is the archived v0.2 suite. Use the [v0.3 Quick reveal](../v0.3/suite/EVEAL.md) instead.
> The pitfalls and sources sets here were retired on 31 October 2026 because their answer keys were
> published, so scores on them are no longer comparable.

# EVE-Al suite v0.2

**EVE-Al** (read it as "eval", or "reveal"): a hard, reproducible, static evaluation for real tool-using AI
agents. Point an agent at it (Eve, an OpenClaw profile with its own persona and instructions, a local model
reading the offline copy) and it reveals how that setup behaves: whether it avoids coding pitfalls, keeps
basic agentic hygiene, reconciles conflicting sources, and says "I don't know" instead of making things up.

Status: **pilot draft**. There are no verified results yet. Two self-reported frontier-model runs reached the Quick
reveal's ceiling ([REPORT.md](REPORT.md)). It supersedes the v0.1 Agent Arena prototype one folder up, which is kept
unchanged; [REVIEW-v0.1.md](REVIEW-v0.1.md) explains why it was replaced.

## Two tiers

| Tier | Points | Time | Needs | What it covers |
| --- | --- | --- | --- | --- |
| **Quick reveal** ([EVEAL.md](EVEAL.md)) | 40 | ~20 min, stop at 30 | One conversation. Offline is fine. Node only for the hygiene probe. | Coding pitfalls 10 · conflicting sources 10 · unknown vs fabricate 10 · agentic hygiene 10 |
| **Full suite** (this runbook) | 100 (95 offline) | ~2.5 h across separate conversations | An operator to stage copies and open fresh conversations | Code reliability 30 (two fixtures plus a trivial control) · cross-chat memory 18 · durable references 12 · sources 10 · honesty 10 · hygiene 15 · currentness 5 (online only) |

Frozen weights are in [rubric.json](rubric.json). Its SHA-256 is in [RUBRIC.lock](RUBRIC.lock), and the
scorer refuses to run if they differ.

## Point an agent at it

- **Online:** "Open `<site>/agent-arena/v0.2/EVEAL.md` and follow it exactly." Use `<site>` once the
  maintainer has published it; the site isn't live.
- **Offline / local model:** unpack [downloads/eveal-suite.zip](downloads/eveal-suite.zip) anywhere the agent
  can read, then say "Read EVEAL.md in `<folder>` and follow it exactly."
- **Eve:** the proposed `%eveal` starter Thread does the above against a copy that ships with the app. See
  [EVEAL-INTEGRATION.md](EVEAL-INTEGRATION.md). It isn't implemented yet.
- **Personas and profiles:** run the same prompt under each profile, with the same model, reasoning and
  permissions, and record `agent.persona` and `agent.instructions_sha256` in `run.json`. The rubric
  doesn't care which profile it is; the comparison does.

The agent writes an `eveal-run-…/` folder. It never scores itself.

## Score a run (reviewer, offline)

Do this on a machine or VM the contestant can't reach. Contestant code runs during scoring, so use a
disposable environment with no network and no secrets. The Node permission flags the scorer uses are
defence in depth, not a sandbox.

```sh
node tools/score-run.mjs <eveal-run>/run.json --seeds seeds.json --out scored.json
```

`seeds.json` holds the seeds you generated (`{"honesty": "..."}` for a Quick reveal;
`{"honesty": "practice-honesty-v02"}` if the agent used the practice set, which is open book). Ranked
comparisons use the held-out tier: `--hidden-root <unsealed held-out folder>`. See
[HOLDOUT-ISOLATION.md](HOLDOUT-ISOLATION.md).

Fill the `reviewer_checks` in `run.json` (each one a Boolean with an evidence string naming a receipt),
set `review.status` to `verified` only after an independent review, copy `scored.json` to
`runs/scored/`, and run `node tools/build-results.mjs`.

## Full suite, operator steps

1. Freeze: confirm `RUBRIC.lock` matches. Don't change weights once comparisons start.
2. Stage every task into a fresh root with `node tools/stage.mjs fixtures/<name> <root> --record <outside>/<name>.json`
   (`outbox`, `docstore`, `control-port`, `probe-kit`). Keep the records outside every root the agent can read.
3. One new conversation per task. Paste only the prompt from [tasks/code.md](tasks/code.md), the probe
   kit's `TASK.md` path, [tasks/sources.md](tasks/sources.md), a fresh honesty block, or
   [tasks/live.md](tasks/live.md). Memory and references follow [tasks/memory-and-refs.md](tasks/memory-and-refs.md).
4. Don't steer. If the agent asks something, reply `Your call.` and count it as an intervention. Stop a
   task at 40 minutes and record a timeout.
5. Record conversation ids, minutes, tool calls, approval waits, stalls and the connector type in
   `runs/FULL-RUN.template.json`, then score as above.

## Layout

| Path | What | Ships to contestants |
| --- | --- | --- |
| `EVEAL.md`, `tasks/`, `corpus/`, `fixtures/`, `runs/*.template.json` | Contestant material | yes (site and ZIP) |
| `lib/challenges.mjs` | Seeded generators (key = f(seed)) | site only, for the operator's generator |
| `tools/` | Stager, scorers, self-tests, sealing, ZIP builder | site, not the ZIP |
| `reviewer/` | Public-tier hidden tests, keys, reference fixes, mutants, recorded self-test results | **no**: repo only, removed from the Pages artifact |
| `REVIEW-v0.1.md`, `PILOT-PROTOCOL.md`, `HOLDOUT-ISOLATION.md`, `EVEAL-INTEGRATION.md`, `REPORT.md` | Method and status | yes |

The public tier is **open book**: anyone can read `reviewer/` in the repository. Treat public-tier scores
as calibration. Ranking-grade comparisons use seeded challenges from private seeds, plus the sealed
held-out tier.

## Self-tests

```sh
node tools/check-v02.mjs          # rubric sums and lock, layout, privacy scan
node tools/selftest.mjs           # pristine / reference / mutants vs hidden tests
node --test tools/*.test.mjs      # answer scorers, probe kit, end-to-end simulated runs, sealing
node tools/build-downloads.mjs --check
```
