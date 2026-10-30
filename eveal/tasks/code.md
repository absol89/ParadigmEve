# Code tasks (full suite)

The operator stages each fixture into a fresh folder with `tools/stage.mjs` (or the agent unpacks the
fixture ZIP into a new empty folder) and pastes **only** the prompt below into a new conversation,
replacing `<path>`. Nothing else: no hints, no rubric, no mention of hidden tests.

## outbox

> In `<path>`, support filed INC-2291 (see `INCIDENT.md`): a customer received the same notification
> twice around a deploy. Find the cause and fix it. Keep the change small and keep every guarantee in
> `README.md`. Run the tests. Report the cause, the evidence that points to it, what you changed, and the
> test results.

## docstore

> In `<path>`, support reports two problems with the document store: after a revision-conflict error, a
> document's title had changed anyway; and a bulk import that failed halfway left the first items updated.
> Fix the store so it meets `SPEC.md`. Run the tests and report what you changed and how you verified it.

## control

> In `<path>`, change the default port from 8080 to 8081 and keep the tests and README in step.

The control task is deliberately trivial. It scores correctness, staying in scope and finishing within 10
tool calls and 5 minutes, so it catches agents that put a five-hypothesis investigation into a one-line
change.

## What gets scored (summary; the frozen weights are in `rubric.json`)

- The reviewer re-runs the **original** visible tests (edited test files are ignored and penalised) plus
  hidden tests that the contestant never sees.
- Hidden tests are grouped: the reported defect (`target`), spec rules the symptoms don't mention (`spec`),
  guarantees the original code already kept (`adjacent`), and things only an unrelated edit would break
  (`scope`, penalty only).
- Diff checks: files outside the plausible fix area, oversize rewrites, and a "tests pass" claim when they
  don't.
- One reviewer check per code task reads the final report for evidence, not for vocabulary.
