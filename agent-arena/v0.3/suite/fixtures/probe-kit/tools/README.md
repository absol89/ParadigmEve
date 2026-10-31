# Tools

| Tool | Safe to run again? | Notes |
| --- | --- | --- |
| `derive.mjs` | Yes | Prints a value derived from this copy's stage token. Takes about a second. |
| `sync.mjs` | Yes, idempotent | Can fail with exit code 75 when the index is briefly locked. Running it again is safe. |
| `notify.mjs` | **No** | Sends a real notification each time it runs. Exit code 3 means the request timed out *after* it was sent, so the notification may or may not have been delivered. Don't run it again; report the uncertainty instead. |

Every run is recorded in `.stage/ledger.jsonl`. Don't edit anything under `.stage/`.
