# Browser upload recording repair

User request: browser-sent ChatGPT image attachments must appear in the local chat and archive,
and assistant messages must be recorded and displayed in their arrival order.

## Boundaries repaired

- The exchange rendered-user fallback discarded attachments and rejected image-only items.
  It now preserves explicit provider file ids with image MIME metadata, reconstructs typed
  image pointers, and copies bounded name/size metadata when available. Invalid identities,
  non-image MIME types and contradictory MIME fields remain rejected. Real model messages win.
- Mixed exchanges sorted a rendered user with no timestamp behind real assistant messages.
  The exact exchange-key user now comes first. Rendered items retain their original discovery
  ordinal, so timestamped model finals cannot jump ahead of rendered commentary without a clock.
  A complete provider message list remains authoritative; all-timestamped unions keep time ordering.
- A capture arriving before the user row was discarded while the extension retired its bytes.
  A verified preview now commits an empty user row under the typed provider message id. Later
  text revises the same row and preserves its origin. App receipts keep their original-byte custody.
  The canonical writer also refuses page assets from a stale pre-receipt snapshot after an app
  receipt has taken custody, covering asynchronous preview decoding racing the receipt.
- File-service file ids are accepted through Fiber, content sanitization and bridge ingress.
  Pixel matching remains exact same-origin estuary id equality. Overlapping exchange/user sections
  do not duplicate DOM candidates.
- Bounded rendered-item field-key/count diagnostics travel through the existing journal and log
  without being stored as conversation events. Capture outcomes are logged without URLs or text.

## Evidence and limitations

Regression coverage exercises rendered-item uploads without a model, image-only items, both file-id
forms, unrelated DOM images, malformed metadata, mixed exchange order, early capture custody,
message revisions, trace validation, and renderer image enrichment.

The live Chrome window was observed without activation. It is the user's active ChatGPT window;
no reload, navigation, focus change or new ChatGPT tab was used. Chrome exposes no existing remote
debugging port. Consequently, the actual populated rendered-attachment object and installed-build
upload round trip remain unverified. The parser accepts guarded flat id/MIME descriptors; an unknown
provider shape must be diagnosed from the new field-key trace, not guessed from an image URL.

Existing renderer and recovery-memory changes from another task were preserved. This repair does
not install or publish a release, or reconstruct bytes missing from historical uploads.

## Validation

- Initial reader/bridge/renderer/chronology run: 599 tests passed.
- Final reader run (`chatgpt-exchange-dom` and `fiber`): 86 tests passed.
- Full verification: 5,475 passed, 42 skipped, one failure. The remaining failure is the existing
  handoff-storage assertion expecting `10,000–30,000 tokens` and a minimum-length recommendation;
  the separately modified handoff prompt removed those requirements. Its source edit was already
  present at task start and was preserved, along with the obsolete assertion for its owner to resolve.
- All 614 content-script tests passed in full verification, including the new protocol regressions.
- The overlapping targeted store run had the same handoff assertion failure and two 30-second
  timeouts. The two timed-out tests and the new stale-preview custody regression all passed alone
  after the broad run finished (3 passed). The archive projection test passed in the targeted run.
- The isolated final CI stages were run separately because the handoff assertion stopped `verify`:
  `computer` 20/20 passed and `mcp-shutdown` 2/2 passed.
- Final typecheck and `git diff --check` passed. The final production build passed.

Scratch logs in the existing ignored `tools/release-preview` directory retain the verify and build
output. No extension reload, app restart or live post-fix upload was performed.

## c13 debug build

On the user's explicit build request, packaged an isolated snapshot of the tracked working-tree
bytes over `ed3b33f1` on `release/2.3.6`, preserving the shared dirty tree. The private snapshot uses
`--allow-uncheckpointed`; it is a local development build, not immutable release provenance.
The task receipt was copied into the snapshot; unrelated untracked experiments were excluded.

- Command: `node scripts/package.mjs --platform win32 --arch x64 --flavor debug --allow-uncheckpointed`.
- Installer: `C:\Projects\ParadigmEve-installers\2.3.6\c13\ParadigmEve-Windows-x64-debug.exe`.
- Size: 163,946,382 bytes.
- SHA-256: `46baea87868f85b7b9177c8b8114d1c8270ef381adf3fe19fa490494764f1061`.
- Packaging completed successfully; native Sharp, PTY and tree-sitter runtime probes passed,
  and all 18 Vault pages were verified inside NSIS.
- Extracted the installer without installing it. All 14 extension files matched packaged source;
  embedded app.asar matched the unpacked package, and all 9 embedded output bundles matched the
  build output. The embedded main bundle declares `BUILD_FLAVOR = "debug"`.
- Adjacent source-manifest.json, build-receipt.json, package.log and checksum file preserve evidence.

The source verification caveat above remains: c13 has not been installed or live-upload tested.
