# 14 — Coding skills

Read-when-needed checklists for coding work. The always-on rules live in the coding instructions every
Core connector sends; open the section here that matches the task when it calls for more depth. Each
checklist is short on purpose: follow it, then report what you did.

Adapted from the Recommended skills in [chat-on-steroids PR #523](https://github.com/totec448-spec/chat-on-steroids/pull/523)
and its existing catalog (MIT, © Chat On Steroids contributors), with ParadigmEve's own lessons added.

## Contents

- [Code review](#code-review)
- [Debug systematically](#debug-systematically)
- [Test-first bug fix](#test-first-bug-fix)
- [Refactor safely](#refactor-safely)
- [Explore an unfamiliar codebase](#explore-an-unfamiliar-codebase)
- [Security review](#security-review)
- [Performance investigation](#performance-investigation)
- [Upgrade dependencies](#upgrade-dependencies)
- [Commit messages and PR descriptions](#commit-messages-and-pr-descriptions)
- [Write documentation](#write-documentation)
- [Accessibility review](#accessibility-review)
- [SQL queries](#sql-queries)

## Code review

1. **Understand the intent first.** Read the description, the linked issue and the tests. Say in one sentence what the change is meant to do.
2. **Read the whole change**, not just the first file. Note every file touched and why.
3. **Check correctness against the intent.** For each changed function: what inputs reach it, what it returns on every path, and what happens on errors, empty values, concurrency and retries.
4. **Check safety.** User input reaching a shell, file path, SQL, HTML or URL; secrets in logs; permissions widened; data deleted or overwritten.
5. **Check the tests.** Does a test fail without the change? Are the edge cases from step 3 covered?
6. **Run what you can:** the tests, the type checker, the linter.

Report findings, not impressions: file and line, the concrete failure, and a fix. Order by severity (bugs and security, then missing tests, then clarity). Leave out style the formatter settles and anything you are not confident about. If nothing is wrong, say so and say what you checked.

## Debug systematically

- **No fix before a root cause.** A change that hides the symptom without an explanation usually moves the bug.
- Change **one thing at a time.**

1. **Reproduce**: exact steps, input, actual versus expected. If it does not reproduce reliably, collect evidence (logs, timing, environment) instead of guessing.
2. **Read the error completely**: message, stack trace, line numbers.
3. **Look at what changed recently**: commits, dependencies, configuration, the provider page.
4. **Trace the data backwards** from where it goes wrong to where the bad value first appears.
5. **State one hypothesis** ("X happens because Y") and test it with the smallest experiment.
6. **Fix at the source**, and add a test that fails before the fix and passes after.
7. **Verify**: run the suite, remove temporary logging, re-check the original reproduction.

If three fixes in a row fail, stop and question the design instead of trying a fourth.

## Test-first bug fix

1. Find the test framework and how to run a single test.
2. **Write a failing test** through the public interface. Confirm it fails *for the right reason*.
3. Make the **smallest change** that makes it pass. No unrelated refactoring.
4. Run the whole suite. Fix anything you broke.
5. Look for **siblings of the bug**: the same mistake elsewhere (search for every copy of a constant, rule or name) and neighbouring edge cases (empty, one, many, very large, unicode, concurrent, slow machine).
6. Report the root cause in a sentence or two, the test you added, and the suite result.

## Refactor safely

1. **Make sure tests cover the behaviour** you are about to touch; if not, add characterisation tests first.
2. **One kind of change at a time**: rename, extract, move or simplify, never all at once and never mixed with features or bug fixes.
3. **Small steps**, running the tests after each.
4. **Keep the public interface stable** unless changing it is the goal; update every caller if it changes.
5. Follow the surrounding code's patterns.
6. Summarise what moved and why, and how you confirmed behaviour is unchanged.

## Explore an unfamiliar codebase

1. **Read the top-level docs**: README, CONTRIBUTING, AGENTS.md, a docs folder.
2. **Find how to build, run and test**: manifests, Makefile, CI workflows. Run the tests once for a baseline.
3. **Map the structure**: one line per top-level folder.
4. **Find the entry points**: main files, routes, CLI commands, exported APIs.
5. **Follow one real flow end to end** related to the task.
6. **Note the conventions**: naming, error handling, test style. New code should look like the surrounding code.
7. Summarise the map in under 15 lines before starting, and say what you still don't know.

## Security review

Look for:

- **Injection**: user input reaching a shell command, SQL, file path, URL, HTML or template without escaping or parameters.
- **Secrets**: keys, tokens or passwords in code, logs, error messages, URLs or client bundles.
- **File and path access**: traversal (`../`), following symlinks or junctions, writing outside the intended folder.
- **Authentication and authorisation**: missing checks, checks only in the UI, IDs that reach another user's data.
- **Unsafe defaults**: debug modes, permissive CORS, disabled TLS verification, world-writable files.
- **Dependencies**: known-vulnerable or abandoned packages, unpinned versions.

For each finding: where, how it could be exploited (one sentence), severity, and the fix. No working exploit code. If nothing serious is found, say what was checked.

## Performance investigation

1. **Define slow**: which action, how slow now, how fast it must be.
2. **Measure before changing anything** with realistic data: timings, a profiler, query plans, network traces.
3. **Find the part that dominates** the time and ignore the rest for now.
4. **Fix that part**: less work, caching, a better algorithm or index, or doing it later.
5. **Measure again** under the same conditions and report before and after numbers.
6. Keep correctness: run the tests, and watch memory and error rates as well as speed.

## Upgrade dependencies

1. **List what is outdated** and why each upgrade is wanted (security fix, feature, support ending).
2. **Read the changelog and migration notes** between the versions, especially breaking changes.
3. **Upgrade one package (or one related group) at a time** and commit each separately.
4. **Apply the required code changes**, then build, type-check and test.
5. **Check the lockfile diff** for surprising transitive changes; pinned checksums must be updated from the publisher's own list.
6. Report what changed, what needed code changes and what is left.

## Commit messages and PR descriptions

- **Subject**: imperative mood, about 60 characters, no trailing period.
- **Body**: why the change was needed and what it does, including the user-visible effect.
- One logical change per commit.

A PR description covers the problem (with a reproduction if possible), the change as behaviour rather than a file list, the verification with results, and any risks or follow-ups. Keep it factual and link the issue it closes.

## Write documentation

1. **Know the reader**: a newcomer, a user or a maintainer. Write for exactly one.
2. **Start with what it is and why it matters**, in two or three sentences.
3. **Quick start first**: the shortest path to a working result, with copy-pasteable commands.
4. **Then the details**: configuration, common tasks, troubleshooting, reference.
5. **Test every step yourself** where possible; commands and paths must be exactly right.
6. Prefer examples over explanations and keep sections short.

## Accessibility review

Check against WCAG 2.2 AA and give a concrete fix for each problem:

- **Keyboard**: everything reachable and usable with Tab, Shift+Tab, Enter, Space and arrows; visible focus; no traps.
- **Names and labels**: every control, including icon-only ones, has an accessible name; fields have labels; images have useful alt text (empty if decorative).
- **Structure**: one main heading, logical heading order, landmarks, real lists and table headers.
- **Contrast and colour**: text at least 4.5:1 (3:1 for large text); meaning never carried by colour alone.
- **Motion and timing**: respects reduced motion; nothing flashes; timeouts can be extended.
- **Dynamic content**: status messages are announced; dialogs trap focus and return it on close.

## SQL queries

1. **Understand the schema**: tables, keys, relationships, engine.
2. **Build the query step by step**: main table, then joins one at a time, then filters, grouping, ordering.
3. **Always use parameters** for user-supplied values.
4. **Be explicit**: named columns, explicit join types, aliases.
5. **Check correctness**: row counts before and after each join, NULL handling, time zones.
6. **For slow queries**, read the plan and look for missing indexes or large scans.
7. For `UPDATE` and `DELETE`, run the matching `SELECT` first and use a transaction.
