# ParadigmEve Agent Arena (prototype v0.1)

> **Superseded by the [EVE-Al suite v0.2](v0.2/README.md).** Everything below describes the v0.1
> prototype, kept unchanged for reference; its page is at [v0.1.html](v0.1.html). The site root now
> serves v0.2. [v0.2/REVIEW-v0.1.md](v0.2/REVIEW-v0.1.md) explains what v0.2 fixes.

An **open-book, bring-your-own-agent** benchmark for real tool-using assistants. Site and package are static; run the agent and grade it locally. No API keys, hosted evaluator, live model invocation, paid services or third-party packages required to serve the page.

**Status: local proposal, not published.** Do not present the example/skeleton files as scored agents. The experiment was designed independently of any previous c29/c30 results.

## How to take it

1. **Recommended no-setup entry:** Open [START-HERE.md](START-HERE.md) and the [Lite mission](tasks/lite-mission.md). Read public sources, analyze a code snippet, write one Markdown report to any writable folder. No CLI, install or separate benchmark account needed; target about 20–45 minutes.
2. **Optional full 100-point evaluation:** Open [AGENT.md](AGENT.md) or the site. Read [manifest.json](manifest.json) and choose the tasks. The page is readable as HTML or plain Markdown/JSON.
3. Run a **fresh conversation** per task where appropriate. For optional full-code tasks, copy the fixture to a new local directory, then give the agent the **task prompt only**. The fixture intentionally fails a test. Preserve the original and exact patch, logs and final answer. Never run another participant's arbitrary code on your machine.
4. For the two-stage memory tasks, a runner uses the site's local browser challenge generator, or [tools/make-context.mjs](tools/make-context.mjs) if Node is already available. Do not publish its secret expected facts in a public run.
5. Save a [runs/SUBMISSION.template.json](runs/SUBMISSION.template.json) as a separately named `runs/<run-id>.json` with declared model/harness and check receipts. Reviewer verifies evidence and sets `review.status = "verified"`; self reports are allowed but **excluded from rankings**.
6. **Reviewer/maintainer only:** `node agent-arena/tools/score.mjs agent-arena/runs/<run-id>.json` scores full-suite JSON. `node agent-arena/tools/build-results.mjs` generates `results.json` and `RESULTS.md`. Participants in Lite only write a report; they need no Node.

The `tasks/` and `fixtures/` directories are intended public. Do not publish credentials, user chats, private file paths, real pinned references or real user data.
The optional code fixtures are also supplied as two tiny static ZIPs under `downloads/`; no Git checkout is necessary to inspect them. Never execute unknown code on a production machine; the default Lite mission needs no ZIP or runtime.

The [capability matrix](capability-matrix.json) lists demonstrations that are inspired by ParadigmEve's documented tools; it is **not** a live claim that Eve or another agent has every feature enabled. The [final submission procedure](tasks/final-submission.md) generates an independently reviewed full-suite results table after tasks have been completed.

## Hosting: GitHub Pages, no server

The proposed workflow is `.github/workflows/agent-arena-pages.yml` in the repository (local source; not yet published): **manual only**, from the default branch, deploys this `agent-arena/` folder as Pages. Before publishing, a human approves the exact source and configures **Settings → Pages → Source: GitHub Actions**. Once deployed the project-site URL should have the shape `https://absol89.github.io/ParadigmEve/` (not a confirmed live URL).

The GitHub Pages site is static and does **not** receive submissions, execute untrusted programs, host an agent, store per-user state or independently verify honesty. Submissions enter through independently reviewed repository pull requests; only committed reviewed JSON appears on the leaderboard. A human or trusted offline environment must execute code tests and corroborate cross-chat evidence. No GitHub Actions job should execute PR-submitted arbitrary code or grant it write tokens.

## Scope and limitations

- **Code/debugging 30**, **memory recall 25**, **durable hotlink 20**, **public-source research 15**, **capability audit 10**. Score 0–100; missing, unverifiable or unattempted checks score 0. Per-task rubric is in `manifest.json`.
- **Lite has a separate 30-point manual rubric and [reviewed results table](LITE-RESULTS.md)**, not the full-suite leaderboard. See [benchmark inspirations](EVALUATION-INSPIRATIONS.md) for links to SWE-bench Verified, GAIA, BrowseComp, LongMemEval, BFCL and Terminal-Bench, and for resource limits.
- **Public/open-book**: tasks and baseline tests are inspectable and can be rehearsed. This is an educational, reproducible capability demonstration, **not a secret benchmark or blind leaderboard**. Prefer independent test variants and a supervised held-out challenge for strong model comparisons.
- **Memory/hotlink**: without an isolated browser/account/tool principal, source files and prior-chat transcripts may leak into a new chat. Session separation and lack of answer-key reposting must be evidenced; the rubric cannot enforce it through Pages.
- **Fairness**: publish actual model, version, reasoning effort, tool availability, approval counts, source build, hardware, permitted workdirs and run date. Compare like with like. A model without computer tools should be labelled `not-applicable` for corresponding capabilities, not falsely depicted as a failed implementation of Eve.
- **Safety**: no production changes, source tree reset, publish, remote installation, user account modifications or model switching is part of any task. Participants can decline unsupported/unsafe actions and report limitations.
- No tracking, cookies, hosted accounts or external JS libraries. GitHub itself logs page visits under its privacy policy.

## Extending v0.1

Add a versioned task and its maximum check weights to `manifest.json`, create a self-contained prompt and fixture, then extend the offline grader's tests. Freeze a published version before adding an unseen variant or changing weights. The next step after pilot validation is a CI-only, **trusted-source** smoke test (not code execution from untrusted PRs) and a documented human review policy.
