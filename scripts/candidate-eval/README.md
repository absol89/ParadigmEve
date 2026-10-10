# Candidate-eval Phase 0 harness

An operator-run experiment harness, not app surface. It lets several independent candidate fixes
for the same bug be compared against one frozen, hash-pinned acceptance contract, and produces a
reviewable promotion proposal without changing any checkout. Design background:
[Vault 17](../../docs/vault/17-candidate-eval-and-skill-learning.md) (when present).

Nothing here is imported by `src/`. Delete the folder to abandon the approach.

## Isolation: what is enforced and what is only detected

| Property | Status |
| --- | --- |
| Contract inputs (bug report, fixture patches, oracle tests, reference fix, strategy packages, ranking policy) cannot change after freezing | **Enforced**: every command re-hashes them (`CONTRACT_TAMPERED`) |
| Candidates cannot see the oracle tests or the historical fix through their own repository | **Enforced**: each workspace is a fresh repository whose only commit is the fixture tree; the oracle lives in the run directory until evaluation |
| Candidate changes to protected paths (oracle names, test helpers, package/tsconfig/vitest config, scripts) or outside `allowedPaths` are never committed or evaluated | **Enforced**: the guard disqualifies them and keeps the rejected diff as evidence |
| Evaluation runs the harness's own commands on a fresh checkout of the frozen commit, never the candidate's directory, with git hooks and fsmonitor disabled; tampered `.git` config/hooks disqualify the attempt before any git command runs | **Enforced** |
| Only one candidate runs at a time; a B-arm attempt needs a measured A baseline and remaining budget | **Enforced** at admission (`ATTEMPT_RUNNING`, `BASELINE_REQUIRED`, `BUDGET_EXHAUSTED`) |
| Promotion never changes the target; one open proposal per target; stale HEAD or dirty touched paths refuse | **Enforced** |
| A candidate writing outside its workspace (shared checkout, release worktree, sibling workspaces, node_modules lockfile) | **Detected only.** Before/after fingerprints halt the whole run and disqualify the attempt, but the write has already happened. Ignored files and paths outside the watched list are not covered. |
| A candidate reading outside its workspace (for example the shared checkout, which contains the real fix) | **Not enforced.** Only flagged afterwards by similarity to the reference fix. |
| Candidate code executed by the tests themselves | **Not confined.** It runs with the operator's OS authority; the harness only checks that the oracle bytes are unchanged after T1. |

True confinement needs an OS boundary (container, separate user or AppContainer) for both the
candidate agent and the evaluation commands. Until that exists, Phase 0 is **supervised only**:
one candidate at a time, an operator present, and any detected contamination halts the run.

## Running an experiment

Machine-specific absolute paths stay outside this public repository, in a machine file:

```json
{
  "productRepo": "<absolute path of any checkout of this repository>",
  "candidatesRoot": "<absolute path of a dedicated folder outside every checkout>",
  "watch": ["<shared checkout>", "<release worktree>"],
  "nodeModules": "<absolute path of an installed node_modules to link into workspaces>"
}
```

```bash
H=scripts/candidate-eval/cli.mjs
node $H freeze --spec scripts/candidate-eval/experiments/phase0-ab/spec.json --machine <machine.json> --run <candidatesRoot>/runs/<name>
node $H calibrate --run <run>                       # oracle fails on fixture, passes with the reference fix
node $H reserve --run <run> --task <task> --arm A --strategy baseline
node $H start --run <run> --attempt <id> --model <contract worker model>   # prints the brief to give the worker
#   ... run the worker with exactly that brief ...
node $H finish --run <run> --attempt <id> --tokens <n> --tool-uses <n> --duration-ms <n> [--report <file>]
node $H evaluate --run <run> --attempt <id>         # T1 oracle, then T2 typecheck; stops at the first failure
node $H select --run <run> --task <task> --arm A    # runs T3 on the top 2 eligible and records the winner
node $H verdict --run <run>                         # applies the frozen success criteria; writes report.md
node $H propose --run <run> --attempt <winner> --target <checkout>   # writes a proposal; applies nothing
node $H recover --run <run>                         # after any crash
```

Never delete a workspace or run directory recursively before its `node_modules` link is removed.

## Records

Everything lives under the run directory, outside every checkout:

- `contract.json`: the frozen contract with its `contractHash` (read-only).
- `journal.jsonl`: an append-only, fsynced event log. State is folded from it, an intent event
  precedes every side effect, a torn last line is ignored, and any other bad line fails closed.
- `strategies/<id>/SKILL.md`: frozen procedural inputs in SKILL.md-compatible form, pinned by package hash.
- `tasks/<id>/`: bug report, fixture patches, reference fix and oracle copies.
- `attempts/<id>/`: brief, worker report (never evidence), candidate patch or rejected diff.
- `evals/<id>/<tier>-<time>.log`: evaluation output, pinned by hash in the journal.
- `proposals/<id>/`: promotion proposal (`proposal.md`, `proposal.json`, `candidate.patch`).

The contract and evidence schemas are documented in `contract.mjs`, `journal.mjs` and
`harness.mjs`. Tests: `test/candidate-eval.test.ts`.
