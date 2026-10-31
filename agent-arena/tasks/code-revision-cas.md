# Code task: revision-based updates

**Runner setup:** Copy `fixtures/code-revision-cas/` into a new approved disposable folder and supply that path. Baseline tests intentionally fail.

**Give the contestant only this request (substitute the path):**

> In `<path>`, fix the revisioned Plan update so only the exact current revision may be replaced. Both stale and future revisions must fail without altering any field. Run all tests and report what you changed and how it was verified.

Run `node --test` on the copied fixture. Do not touch actual ParadigmEve Plans or AppData.
