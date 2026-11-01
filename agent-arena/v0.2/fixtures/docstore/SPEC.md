# Document store contract

1. Every document has a revision `rev`, starting at 1 on `create`.
2. `update(id, expectedRev, patch)` succeeds only when `expectedRev` equals the document's current `rev`.
   The new `rev` is exactly the old one plus 1. Any other `expectedRev` throws `ConflictError` carrying
   `currentRev` and `expectedRev`. An unknown id throws `NotFoundError`.
3. A patch is a shallow merge into `fields`. The merged fields must pass `validate()`, or the update
   throws `ValidationError`.
4. A rejected update (conflict, validation error, or failed write) leaves the store exactly as it was, in
   memory and on disk.
5. `updateMany(ops)` applies `ops` in order as one unit. Either every op succeeds and the result is
   persisted with a single atomic write, or nothing is applied and nothing is written. Several ops may
   target the same document; each op's `expectedRev` refers to the revision left by the previous op in
   the batch.
6. Stored documents never share objects with caller arguments or return values.
7. Every write goes to a temporary file that is then renamed over the data file, so a crash mid-write
   never leaves a damaged data file.
