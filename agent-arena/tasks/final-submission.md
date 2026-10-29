# Final task: generate a public results table

After an agent completes any challenge, the **runner/reviewer** evaluates the final artifact. This is not a command to publish anything automatically.

## Participant report (no tools required beyond ordinary write access)

For Lite, save the report in the exact [Lite format](lite-mission.md) **at any allowed path**; sending the complete Markdown text in chat is an acceptable fallback if no write tool is available. Do not expose secrets, personally identifiable content, private raw transcripts, OAuth tokens, undisclosed account details or machine-specific paths in a public submission.

For the full suite, use [runs/SUBMISSION.template.json](../runs/SUBMISSION.template.json) as a **logical schema**. Participants need not install Node or create JSON; a reviewer can transcribe the independently verified report into the file. Each checked claim must be supported by a privacy-safe evidence reference.

## Maintainer workflow

1. Check exact model, reasoning effort, harness, tool permissions, task version, timestamps, run IDs and source access. Confirm test/fix receipts and independent fresh-chat identities when applicable. Unverified claims do not receive points.
2. For full-suite scoring, create a new `agent-arena/runs/<run-id>.json` copied from the template and replace its identifying placeholders. Start with `review.status = "self-reported"`.
3. Do the evidence review outside GitHub Pages. If a run is independently corroborated, enter `review.status = "verified"`, a reviewer name and a public review reference; the scorer checks only presence and structure, not the trustworthiness of the reviewer.
4. In an approved local checkout, run:

```sh
node agent-arena/tools/score.mjs agent-arena/runs/<run-id>.json
node agent-arena/tools/build-results.mjs
```

5. The full results generator produces `agent-arena/RESULTS.md` and `agent-arena/results.json`. For Lite, independently transfer accepted checks to `lite-runs/<run-id>.json` using `lite-runs/SUBMISSION.template.json`, then run `node agent-arena/tools/build-lite-results.mjs`; it produces `LITE-RESULTS.md` and `lite-results.json`. The Pages site shows distinct tables and no invented rows. Never mix Lite and 100-point totals.
6. Independently review the generated files and proposed PR, keep task versions fixed, and publish only after explicit maintainer approval. Do not run untrusted participant patches under a privileged Pages workflow.

## Privacy and causal claims

- Approval prompts and provider limits are environment conditions, not purely agent reasoning outcomes.
- An agent that can access the task's answer key or prior run transcripts does not have a valid blind memory test; record contamination, do not invent a pass.
- Public benchmark materials may become part of models' training/retrieval. Report this as an **open-book demonstration**, not a hidden evaluation of model intelligence.
- The static site has no private score-submission API and no server-side grading.
