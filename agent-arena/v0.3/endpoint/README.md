# EVE-Al v0.3 verified scoring endpoint (not deployed)

A static page cannot keep a secret, so the public scorer (`../web/`) scores only what follows from a
seed the person already holds. Verified scores come from this endpoint, which keeps the secrets on
the server. It is written for the Web `fetch` API (`core.mjs`, `createHandler(env, deps, store)`).

## What it does

| Route | Purpose |
| --- | --- |
| `POST /v1/tickets` | New held-out challenge. Returns a random `ticket` and the public challenge id. |
| `GET /v1/tickets/<ticket>/files` | The challenge files and the honesty block. No reveal script, seed or key. |
| `POST /v1/tickets/<ticket>/pushback` | `{"initial": "<initial.json text>"}`. Commits the first answers (first commit wins), then returns the follow-ups. |
| `POST /v1/tickets/<ticket>/score` | `{"texts": {pitfalls, sources, honesty, swedish, instructions, calibration, pushback_final}}`. Scores once per ticket and returns a signed receipt. |
| `GET /v1/health` | What it measures. |

- **Seeds:** HMAC-SHA256 of the ticket under `SEED_SECRET`. Whoever holds the ticket can fetch the
  files, but can't derive the key.
- **Fixed keys:** the pitfalls and sources keys (the 2026-10-31 rotation) come from `V02_KEYS` and are
  never sent out.
- **Receipts:** a canonical JSON payload with totals per dimension only, signed with Ed25519
  (`SIGNING_KEY`). `verifyReceipt(publicKey, receipt)` checks one, and the public key can go on the site.
- **Admission:** only tickets recorded by the issue route are accepted. Well-shaped but unissued
  handles are rejected before deriving seeds or generating challenges; unsupported methods are also
  rejected before generation.
- **Rate limits:** per address, 10 new tickets, 60 file fetches, 30 pushback commits and 30 scoring calls an hour.
  Limits run before ticket lookup and challenge generation, including for invalid handles.
  Each ticket is scored once, so it can't be used to test answers one at a time against the key.
- **Not measured here:** hygiene and the general fix. Both run the agent's code or read its files, and
  no free serverless host is a safe sandbox for that. They stay with the offline scorer in a disposable
  machine.

## Known limits

- The fixed pitfalls and sources keys are the weak point of any oracle. Scoring once per ticket and
  returning only totals slows probing, but someone with many tickets and addresses could still learn
  the key. Rotating them (v0.2 has variants) is the real fix.
- A ticket is used up when it is scored, even if that request then fails.
- Everyone holding the ticket counts as the operator. The agent must never see the ticket.

## Hosting (free tiers; your account, your decision)

- One challenge id is 20,000 hash rounds, about 50 ms of CPU. That is over the Cloudflare Workers free
  plan's 10 ms per request, so the free choices are Node functions: **Netlify Functions** or
  **Vercel Functions** (Hobby). A paid Cloudflare Worker also works.
- `store` needs three calls: `hit` (rate limit), `putIfAbsent` and `get`. Netlify Blobs, Upstash
  Redis (free tier) or Workers KV can back them only through an adapter providing atomic `hit` and
  `putIfAbsent` semantics; a read-then-write KV implementation is insufficient. Issued-ticket records
  must remain available for the ticket's lifetime. `memoryStore()` is for tests only.
- The hosting adapter must strip client-supplied forwarding headers and supply its own trusted
  client address. The core's per-address limits are only as trustworthy as that adapter.
- `deps` comes from `agent-arena/v0.2`: `lib/challenges.mjs` (honestyChallenge) and
  `tools/score-answers.mjs` (scoreAnswers). The second imports `node:fs`, which is another reason to
  use a Node host.
- Secrets: `SEED_SECRET` (32 random bytes, base64), `SIGNING_KEY` (Ed25519 PKCS#8, base64), and
  `V02_KEYS` (the pitfalls and sources JSON from the operator's encrypted key archive; the copies in the
  public v0.2 tree are the retired set). Keep them out of the repo and out of the agent's
  machine.

## Tests

```bash
EVEAL_V02=<agent-arena/v0.2> node --test agent-arena/v0.3/tools/endpoint.test.mjs
```
