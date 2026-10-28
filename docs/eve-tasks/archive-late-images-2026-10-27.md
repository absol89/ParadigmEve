# Archive late user images — 2026-10-27 source-only follow-up

## Observed boundary

The installed 2.4.5 c23 recorder eventually filed both original user-uploaded screenshot
previews. The canonical message owned two WebP assets, and the session image API could return
both. The separately published archive user event still had zero assets: it had become
immutable before the delayed preview bytes were filed. Rebuilding the static site alone could
not add images to that previously published event.

## Source approach

`ArchiveRuntime` keeps published words and chronology immutable. For a canonical user message
with newly retained local image bytes, it writes a distinct append-only `late_user_image`
event whose deterministic identity includes the exact original user event and asset id. It
never associates an image by nearby timestamp/order and never fetches provider URLs. A
missing source asset remains retryable; successful custody retains a content-addressed blob.
Static projection joins these supplements by their recorded original user event identity,
so the images render inline with that message instead of as a second user turn. Its two
streaming passes apply only to chats being rendered, not to unchanged reused fragments.

## Verification and remaining acceptance

- 16 archive suites / 120 tests passed, including late two-image enrichment, pending-bytes
  retry, append-only idempotence, stable chronological transcript, and static cache integrity.
- `npm run typecheck`, `npm run verify:privacy`, and `git diff --check` passed.
- This change is source-only in the isolated next-candidate worktree. No installer was built,
  installed, or activated. Consequently the original live archive view has not yet been
  re-projected through this new code.
- The apparent original browser-compositor ordering anomaly and the ten unclaimed recovery
  offers remain separate, unproven root causes; this source change makes no claim to fix them.
- Historical heartbeat debt remains in its original worker review lane. No conversion,
  denied review retry, or model change was performed.
