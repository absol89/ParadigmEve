# Evaluated run manifests

Use [SUBMISSION.template.json](SUBMISSION.template.json) for each **new** run file. The template is excluded from published ranking. Do not include real user data, secret prompts, credentials, private links, raw conversation transcripts or machine-specific personal paths in a public submission.

The `review.status` field is initially `self-reported`. Only an independent human reviewer who has inspected evidence should set it to `verified` and provide their name and a public review reference (e.g. accepted PR or public issue). **The CLI checks schema, weights and presence of receipts, not the honesty or correctness of those receipts.** Run files are public and must be merged only after independent review.

When submitting, include model and harness details. Do not run another participant's submitted code in the site deployment workflow.
