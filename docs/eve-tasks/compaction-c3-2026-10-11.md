# 2.3.8 — Compact & Resume destination acceptance (historical local checkpoint)

## Incident / evidence

- User's captured handoff `AA1zwpy_` followed an earlier failed `kQlKcoT4` continuation. The 401 from the conversation-title call was not evidence that ChatGPT signed out. The replacement bootstrap passed the destination dispatch fence, but no corresponding accepted destination was recorded by the local session. The previously opened app-owned browser attempt timed out without proving that the message was delivered.
- In the earlier `bootstrapConversation()` flow, a `/c/<id>` route and a matching rendered user bubble were both necessary for the fresh Resume ACK. The route alone was rightly insufficient, but a late/virtualized rendered bubble could prevent the durable session rebind even if ChatGPT accepted the text.

## Fix

- `extension/usage.js`: project only an exact `[[CLF-RESUME:token]]` marker with the conversation ID from a bounded same-response server `input_message` stream event. Do not forward the handoff content, request body, cookies or headers.
- `extension/content.js`: only the one already-armed-and-clicked destination accepts matching stream evidence. A reply can be acknowledged before React renders a user bubble or the browser URL changes. Contrary routes and foreign/stale markers remain insufficient.
- `extension/background.js` / `src/main/bridge.ts`: an unresolved destination Send can publish a user-visible session note while keeping the durable `dispatched-unresolved` fence; no unsafe automatic re-send or duplicate-tab opening.

## Checks

- `npm run typecheck` — passed.
- `vitest` focused stream-only content fixture, stream projection and negative shape tests — passed.
- Continuation/content/background/bridge regression run — 1,312 passed across 7 test files before the last two extra diagnostic tests were added.
- Diagnostic note and relay tests — both passed.

## Boundaries / installed self-testing

- A previously dispatched ticket from the preceding local build without durable ChatGPT acceptance evidence is intentionally not auto-replayed. An installed self-test of this change and a restart/wake test are still needed with the matching Companion; automated tests prove the code path but cannot establish that the current ChatGPT account still emits the tested SSE event shape.
- Neither the active ChatGPT tab nor the installed app was reloaded or replaced during implementation. The original local build labels remain historical artifact identifiers, not GitHub version tags; no public release, tag, push or installation is implied.
