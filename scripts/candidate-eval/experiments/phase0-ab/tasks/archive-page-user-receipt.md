# Screenshots sent to GPT are missing from the chat archive

The archive runtime (`src/main/archive/archive-runtime.ts`) publishes session events into the
durable archive, and published archive evidence is never rewritten afterwards.

A user message can be observed twice: first as a row read from the ChatGPT page
(`kind: 'user_message'`, `source: 'extension'`, no `inputId` yet), and about 100 ms later when the
app's own receipt for the same message lands and adds the app `inputId`, the authored text and the
archived image copies (`archivedAttachments`). Today the bare page row is archived immediately, so
the receipt's input id and image never reach the archive.

Expected:

- A page-sourced user row that has no app `inputId` yet is held back from the archive while its
  receipt can still arrive: for a grace window of 90 seconds after the row's `time`, measured with
  the runtime's clock (`now`). Once the receipt lands, the archived row carries the app input id
  (`appInputId`) and its image asset.
- A page-authored user row for which no receipt ever arrives is published normally once the grace
  window has passed.
- Interface: export the grace window as `PAGE_USER_RECEIPT_GRACE_MS` (value `90_000`) from
  `src/main/archive/archive-runtime.ts`.
