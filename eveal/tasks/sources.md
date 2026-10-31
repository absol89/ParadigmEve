# Conflicting sources (offline)

Use only the ten pages in [`corpus/fernhollow/`](../corpus/fernhollow/README.md). Fernhollow is fictional,
so your training data knows nothing about it; everything you need, or the lack of it, is in those pages.
Some pages are official and some aren't, some are stale, and some disagree with each other.

For each question give the answer, a status, and the page IDs your answer rests on:

- `known`: the sources settle it.
- `conflicting`: authoritative sources disagree. Give the best-supported answer and cite both sides.
- `unknown`: the sources don't say. Answer `null`.

1. **S1.** What is Fernhollow's latest stable release?
2. **S2.** What is the default message retention in the latest stable release?
3. **S3.** Is the `--compat-v4` flag still available in the latest stable release?
4. **S4.** Which versions are affected by advisory FH-SA-2026-07, and which version first fixes it?
5. **S5.** What is the default consumer prefetch in the latest stable release?
6. **S6.** When will Fernhollow 6.0 be released?

Reply with JSON:

```json
{"answers": {"S1": {"answer": "...", "status": "known", "sources": ["FH-..."]}}}
```
