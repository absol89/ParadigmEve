# Critical review of Agent Arena v0.1

Reviewed: the untracked `agent-arena/` prototype (v0.1 manifest, Lite manifest, six task prompts, two code
fixtures, the browser and Node challenge generators, both scorers and the manual Pages workflow). v0.1 is
kept unchanged next to this folder and is superseded by v0.2.

Verdict: v0.1 is an honest, safe and well-labelled *demonstration*, but it isn't yet a benchmark. Nearly
every item can be passed by a competent model with no tools, a strong agent can't be told apart from a
competent one, and the scorer can't tell a real receipt from a typed one.

## 1. Difficulty: at ceiling on almost every item

| Item | Why it's at ceiling |
| --- | --- |
| `code-uncertain-send` | 12 lines. The comment on line 9 names the bug (`// BUG: an uncertain provider outcome is not equivalent to an explicit rejection`), and the failing test asserts the exact expected return value (`'needs-review'`) and state (`'uncertain'`). The fix is literally specified by the test. |
| `code-revision-cas` | 7 lines and one comparison. The test names say "stale" and "future". Changing `<` to `!==` turns it green. |
| Lite L2 | The same 12-line function, plus the prompt already tells the agent that `'unknown'` may have been accepted. The diagnosis is given away; only the patch is asked. |
| Research (L1 and `public-source-audit`) | "Is GitHub Pages static and are public-repo Actions minutes free?" is a well-known fact in any recent model's training data. Retrieval can't be told apart from recall, so the 4/5-point "actually retrieved" checks rest only on the agent's word. |
| `fresh-chat-recall` | Five independent facts, each picked from a 4-item list, with no distractors, corrections or conflicts. Chance accuracy is 25% per field. Any working memory or chat-search tool gets 5/5, so the task can't separate a good memory from a basic one. |
| `durable-hotlink` | Create one record, read it back once. No update, rename, scope, stale handle or near-miss, so "durable reference" means nothing more than "write and read". |
| `capability-audit` | "Demonstrate one file read and one test run." Any agent with a shell passes. Agents without one can type a plausible transcript, and the reviewer has no way to tell. |

Expected v0.1 outcome: competent and strong agents both score ~85–100 on the code, memory and research
tracks. The only spread comes from tool availability, which is a property of the host rather than the agent.

## 2. Validity: what is actually measured

- **Visible tests are the spec.** Both fixtures have no hidden tests, so "tests green" (7 of 15 points per
  task) rewards satisfying assertions rather than the invariant. A patch that special-cases the test inputs
  scores the same as a correct one.
- **No adjacent invariants.** Nothing checks that a fix keeps explicit-rejection retries, idempotent ACKs,
  lease ownership or atomic persistence, so a fix that breaks a neighbouring guarantee can't lose points.
- **No penalty for side effects.** Editing the tests, touching unrelated files, a 200-line rewrite or a
  false "all tests pass" claim cost nothing. In the c29–c31 fixation runs, side effects and claims that
  didn't match receipts were exactly where agents differed.
- **Rubric checks reward vocabulary.** For example, "Final response gives precise cause…" and "Understands unknown
  provider acceptance as non-retryable ambiguity" are judged from prose. An agent that echoes the rubric's
  words scores the same as one that reasoned.
- **No trivial control.** Nothing detects an agent spending 20 tool calls and a hypothesis tree on a
  one-line change. The fixation experiment's behavioural goals (deliberate only when uncertain, choose
  Skills sparingly) have no item at all.
- **Host and model are conflated.** "Demonstrated capabilities" scores whether the *host* exposes a shell,
  not whether the model uses it well (handling failure, permission boundaries, honest inability).

## 3. Loopholes

1. **Scorer trusts Booleans.** `score.mjs` / `score-lite.mjs` add up reviewer-entered `true`s and only
   check that *some* evidence string exists. `"evidence": ["ok"]` satisfies it, and nothing ties a check to
   an artifact, a hash or a re-run.
2. **`review.status = "verified"` is self-asserted.** Any non-empty `reviewer` and `reference` string passes.
3. **Fixture identity is unchecked.** Nothing proves the agent worked on an untouched copy. A pre-patched
   or stale fixture is invisible.
4. **Retrieval credit without retrieval.** Research checks accept a cited URL. A model can cite the
   documented URL from memory.
5. **Memory pass by guessing.** The stage-2 prompt lists the five field names, and every field has 4
   options. Guessing has a 1/1024 chance of 5/5, but partial credit by guessing is common (expected 1.25/5).
6. **Capability theatre.** A fabricated "tool receipt" in prose can't be told apart from a real one.

## 4. Leakage

- **Answer keys on the contestant's disk.** `make-context.mjs` prints `PRIVATE_RUNNER_ANSWER` to stdout,
  and the browser generator offers "Save runner answer file", which goes to the Downloads folder of the very
  machine the agent controls. The fixation experiment showed an agent with a shell on the user's account
  will read Claude session files and notes to find a key, so "keep it away from the contestant" isn't
  achievable on that machine.
- **Generator and values are public.** The value pools are in `app.js`, so a contestant who reads them only
  needs to choose among 4^5 combinations, and partial knowledge leaks.
- **Public tests = public answers.** Fixture tests and the full rubric are open. v0.1 says this honestly
  ("open-book"), but it also has no held-out tier, so no comparison it produces can be ranking-grade.
- **The Lite L2 code appears in full on the site.** It is the same function as the full-suite fixture, so
  doing Lite contaminates the code task.

## 5. Fairness

- Points for "has a shell" or "has cross-chat memory" penalise hosts, not models. v0.1's `not-applicable`
  idea is right, but the scorer has no such state: missing equals zero.
- There is no protocol for identical model, reasoning effort and permissions, run count, run order or
  interventions, so differences between two runs can't be attributed to anything.
- Eve's `%Thread`/Pins idiom is named in the hotlink task and the `%arena-` handle prefix mirrors it, which
  nudges toward Eve-specific tools. That's mild, but worth removing.
- Time and tool-call counts are recorded but never used. A run that takes 40 minutes on a one-line fix
  scores the same as a 2-minute run.

## 6. What v0.1 got right (kept in v0.2)

- Static Pages only. No hosted execution, submissions or tracking, and a manual, default-branch-only workflow.
- Self-reports excluded from ranking. No fabricated rows in the results tables.
- Clear separation of host conditions (connector, approvals) from task outcome.
- Original synthetic fixtures. No private data.
- The 30-point Lite tier with no install, alongside a separate full suite.

## 7. Resulting requirements for v0.2

Hidden negative tests per fixture, validated against known-bad "naive fix" mutants. A diff-based side-effect
penalty. Disk-state and tool-receipt scoring instead of prose. A seed-only answer key (nothing on disk) for
the memory and reference tasks. A synthetic research corpus with planted stale, contradictory and
misleading sources, plus one live currentness check. A judgment probe kit whose receipts can't be produced
without actually executing. A trivial control task. A held-out tier stored sealed, off the contestant's
reach. A frozen, hash-locked rubric. A scorer that re-runs tests and recomputes from artifacts.
