# ParadigmEve durable chat archive browser experiment

Status: implementation experiment
Date: 2026-09-22
Branch: `experiment/chat-archive-browser`
Base: ParadigmEve `2.2.3` / `fc5aad5be7a6127661d1bc166cf0e711fed281aa`

## 1. Product idea

ParadigmEve should be able to preserve a conversation as something the user truly owns.

The mental model is:

> Obsidian for chats, images, files, tool evidence and agent memory rather than Markdown notes.

The user should be able to close ParadigmEve, reboot the computer, disconnect the internet, open
one local archive entry point and browse their retained conversations like a saved ChatGPT-style
frontend:

- a chat list/sidebar;
- titles, dates, project/Thread/Quilt context, model/provider and continuation lineage;
- scrollable user and assistant turns;
- collapsible tool calls and results;
- inline image/file cards;
- full-size local image viewing;
- links between continued/compacted chats;
- local search;
- no provider login or network dependency merely to read retained history.

Static HTML is therefore a first-class durability output, but it is not the semantic database.
The archive must remain reconstructable even if the HTML is deleted or a future renderer changes.

## 2. Goals

### 2.1 Primary goals

1. **Own the evidence locally.** A retained chat survives provider deletion, provider URL expiry,
   app restart and computer reboot to the extent ParadigmEve actually captured its bytes/events.
2. **Human-readable recovery.** A user can browse retained chats without running ParadigmEve by
   opening static local HTML.
3. **Machine-readable recovery.** A future ParadigmEve or another local agent can reconstruct the
   semantic conversation without scraping presentation HTML.
4. **Images survive reboot.** Any image that ParadigmEve claims is durably retained must have
   locally owned bytes or an explicit durable placeholder saying the bytes were never captured.
5. **Provider-neutral history.** Luna/ChatGPT, OpenRouter, local models and future providers can all
   attach to the same ParadigmEve-owned evidence and memory layers.
6. **No hidden-memory fiction.** Provider/account/model memory may be useful, but it is never
   presented as ParadigmEve durability.
7. **Parallel-thread friendly.** Multiple chats can share one project/Thread memory and artifact
   library without pretending they are one provider conversation.
8. **Loss is visible.** Missing bytes, unavailable provider-only attachments, retired assets,
   incomplete capture and corrupt records render as explicit states, never as silent emptiness.

### 2.2 Secondary goals

- Browse thousands of chats without loading every transcript at once.
- Search titles, authored text, tool summaries, filenames and curated memory.
- Export one conversation as a portable `.evechat` bundle.
- Export a whole archive as a static site.
- Rebuild search/index/HTML from the canonical evidence.
- Reuse a retained local image/file in a new conversation later.
- Allow Pins/Threads/Quilts to point at retained image/file evidence without duplicating bytes.

## 3. Non-goals

- HTML is not the only source of truth.
- The experiment does not attempt to recover historical bytes ParadigmEve never captured.
- The experiment does not promise to reproduce private provider implementation details.
- The archive does not make provider memory deterministic.
- A search index is not authority.
- A memory summary is not evidence.
- A Pin is not a second copy of a transcript or asset.
- This experiment must not rewrite, reset or migrate the tagged `2.2.3` source in place.

## 4. Durability model

The strongest practical design is redundant and layered:

1. **Canonical semantic evidence**
   - append-only/versioned session events;
   - stable session/event/message identities;
   - explicit continuation lineage;
   - references to content-addressed assets.
2. **Canonical content bytes**
   - local content-addressed blobs;
   - SHA-256 identity;
   - MIME type, byte length and image geometry;
   - never dependent on a provider URL after successful capture.
3. **Rebuildable catalog/search**
   - SQLite is preferred for fast lookup, FTS and joins;
   - it is a cache/projection and can be deleted/rebuilt from evidence + blobs.
4. **Static HTML projection**
   - generated from canonical evidence;
   - can be deleted and regenerated;
   - remains useful if ParadigmEve itself no longer runs.
5. **Portable bundles**
   - one conversation plus its manifest/events/assets/viewer;
   - importable by future ParadigmEve versions.

This deliberately avoids making one SQLite file, one JSON file or one HTML file the only copy of
meaningful history.

## 5. Authority boundaries

### 5.1 Evidence

Evidence answers: **what actually happened?**

Examples:

- authored user message;
- assistant response revision/final;
- tool call and tool result;
- uploaded file/image;
- generated/provider image;
- provider/model identity observed for that turn;
- compaction/continuation boundary;
- exact source relation for Pins/Plans/Requests.

Evidence is immutable except for the existing canonical revision rules that collapse provider
streaming revisions into one logical message. Rebuildable projections must never invent evidence.

### 5.2 Memory

Memory answers: **what should an agent remember later?**

Memory is separate from evidence and points back to evidence.

A proposed memory record:

```ts
type MemoryEntry = {
  id: string;
  scope: 'global' | 'project' | 'thread' | 'agent';
  scopeId?: string;
  text: string;
  sourceRefs: Array<{
    sessionId: string;
    eventSeq?: number;
    assetId?: string;
  }>;
  createdAt: number;
  updatedAt: number;
  authoredBy: 'user' | 'eve' | 'system';
  status: 'active' | 'superseded' | 'retired';
};
```

Memory may be curated automatically only when the product contract explicitly permits it. A
memory entry never replaces its cited evidence.

### 5.3 Search/index

Search answers: **where might the relevant evidence/memory be?**

The index is rebuildable. Losing the index must not lose the archive.

### 5.4 HTML

HTML answers: **how can a human inspect this safely without the app?**

HTML is presentation, not authority.

## 6. Archive layout

The experiment should not destructively relocate the current session store. It should build a
versioned archive alongside it.

Illustrative layout under ParadigmEve user data:

```text
archive/
  archive-manifest.json
  blobs/
    sha256/
      01/
        01ab...cdef.webp
      83/
        83cd...9012.pdf
  sessions/
    <session-id>/
      manifest.json
      events.jsonl
  memory/
    entries.jsonl
  index/
    archive.sqlite
  site/
    index.html
    archive.css
    archive.js
    data/
      catalog.js
      sessions/
        <session-id>.js
    assets/
      <content-hash>.<ext>
```

### 6.1 Why keep per-session JSONL

- append-only records are easy to salvage;
- corruption is localized to one session/file;
- diffs/debugging are human-readable;
- a future implementation does not need SQLite to understand the semantic archive;
- it matches ParadigmEve's existing durable-session direction.

### 6.2 Why also use SQLite

SQLite is well suited to:

- title/date/provider/project indexes;
- FTS over authored text/tool summaries/memory;
- asset reverse references;
- continuation lineage queries;
- large archive pagination.

But `archive.sqlite` is explicitly **rebuildable**. It is never the only copy of a message or
asset.

## 7. Archive manifest

`archive-manifest.json` should include:

- archive schema version;
- creation/migration timestamps;
- ParadigmEve build/version that last wrote it;
- hash algorithm;
- site-generation version;
- current index schema version;
- feature flags for image/file/native-provider capture;
- optional integrity-scan timestamp/result.

It must not contain credentials or provider bearer tokens.

## 8. Session manifest

Each archived session manifest should be small and replaceable:

```ts
type ArchiveSessionManifest = {
  schemaVersion: number;
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  projectId?: string;
  projectPathLabel?: string;
  threadIds: string[];
  quiltIds: string[];
  providerConversationIds: string[];
  continuation?: {
    predecessorSessionId?: string;
    successorSessionId?: string;
    providerFromConversationId?: string;
    providerToConversationId?: string;
  };
  eventCount: number;
  assetCount: number;
  captureState: 'complete' | 'partial' | 'metadata-only';
};
```

The manifest accelerates browsing but does not replace `events.jsonl`.

## 9. Event requirements

Every durable event needs enough identity to preserve chronology and provenance:

- `sessionId`;
- monotonically ordered local `eventSeq`;
- local timestamp;
- event kind;
- provider message/turn id when observed;
- app input id when app-authored;
- actor/role;
- model/provider identity when known;
- associated asset refs;
- source/provenance fields needed by Pins/Plans/Requests.

The archive must preserve exact unknowns. It must not synthesize provider ids or model names.

## 10. Image and file authority

This is a hard requirement for the experiment.

### 10.1 App-authored uploads

Today the normal composer path can retain only a small preview after delivery while the staged
original becomes cleanup-eligible. The archive experiment changes the durability contract:

1. stage the selected bytes as today;
2. after exact admission/delivery ownership is established, promote the original bytes into the
   canonical retained asset/blob store;
3. record the retained blob id on the durable user-message/attachment evidence;
4. render preview and full-size content from local retained bytes after reboot;
5. staging remains temporary transport state and may still be cleaned.

### 10.2 Native provider user uploads

Provider attachment metadata alone is not sufficient to claim offline retention.

If ParadigmEve cannot lawfully/securely capture the bytes, the archive records:

- filename/MIME/size if observed;
- provider attachment id if safe to retain;
- `captureState: 'provider-only'`;
- an explicit archive card saying the content was not captured locally.

No dead provider URL is rendered as if it were a durable file.

### 10.3 Generated/assistant images

Introduce a first-class durable generated/native-image evidence type rather than hiding image
authority inside assistant Markdown.

The event should carry:

- exact provider message identity;
- provider asset identity when safe;
- local blob/preview id when captured;
- source dimensions;
- MIME;
- capture status/error;
- grouping key for multi-image responses;
- retirement state.

Metadata should become durable before optional pixel capture finishes. If pixels are available,
capture them into the local blob store. Do not rely on signed provider URLs surviving.

### 10.4 Tool images

Existing session-owned tool image assets are a strong path and should be preserved. The archive
indexes them and exposes them in the transcript/site without converting them into prose.

### 10.5 OpenRouter and future providers

Any provider adapter that receives:

- base64 image bytes;
- a binary image body;
- or a URL that the adapter is already authorized to materialize

must copy the resulting bytes into the same archive/blob path before claiming durable retention.

## 11. Blob store

Content bytes are addressed by SHA-256.

```ts
type ArchiveBlobRef = {
  sha256: string;
  mimeType: string;
  byteLength: number;
  extension?: string;
  width?: number;
  height?: number;
};
```

Rules:

- write temp file, hash/verify, then atomic rename/publication;
- deduplicate identical bytes across sessions;
- never use the original filename as authority;
- original filename is metadata only;
- no automatic age eviction of retained archive blobs;
- storage cleanup first retires references durably, then deletes bytes;
- a missing blob after reference publication is a visible integrity error.

## 12. Static HTML archive

### 12.1 Entry point

`archive/site/index.html` must open directly from disk with no local web server.

The first screen should feel like a lightweight chat frontend:

- sidebar/chat list;
- search;
- selected chat title + metadata;
- scrollable transcript;
- Back/Forward-friendly chat navigation;
- local assets only.

### 12.2 No network dependency

The generated site must:

- use bundled/local CSS and JavaScript only;
- make no analytics requests;
- make no provider/API requests;
- not require authentication;
- not attempt to repair missing bytes from the internet.

### 12.3 File-URL compatibility

Do not depend on `fetch()` of sibling JSON because browsers vary in `file://` restrictions.

Use one of:

- script data shards assigning inert JSON payloads to a namespaced global;
- fully rendered per-chat pages;
- an iframe/page architecture that works from local files.

Authored/provider content is data, never executable script.

### 12.4 Transcript rendering

Support:

- user messages;
- assistant messages;
- streaming/final identity collapsed to the canonical logical message;
- tool groups collapsed by default with explicit expansion;
- image rows/galleries;
- file cards;
- Plan/Thread/Quilt source links when their target is also archived;
- compaction/continuation cards;
- explicit partial/missing-capture states.

### 12.5 Image UX

At minimum:

- useful inline thumbnail;
- click to full-size local viewer;
- filename/type/dimensions where known;
- Save/copy/reuse actions in the live Eve app;
- static HTML can offer a direct local-file link where browser security permits.

The archive must never require the provider to render an image that ParadigmEve labels retained.

## 13. In-app Archive surface

The static site is the recovery layer; the live app should expose the same archive model natively.

Proposed workspace destination: **Archive**.

It should provide:

- chat list and filters;
- project/Thread/Quilt filters;
- image/file filter;
- search;
- selected-chat transcript;
- local image viewer;
- source links back to live Plans/Pins/Threads when available;
- `Open static archive`;
- `Export conversation`;
- `Rebuild archive index`;
- storage/integrity status.

The in-app view and HTML generator should share a pure archive-view model instead of independently
deciding chronology/content.

## 14. Portable `.evechat` bundle

A single-conversation export is a ZIP-compatible container:

```text
conversation.evechat
  manifest.json
  events.jsonl
  index.html
  archive.css
  archive.js
  assets/
    <hash>.<ext>
```

Requirements:

- self-contained for retained assets;
- no absolute local filesystem paths;
- no credentials;
- deterministic manifest/event ids;
- import validates schema, path traversal, sizes and hashes;
- import never silently merges into an existing authoritative session;
- imported archive is read-only evidence until an explicit restore/copy action.

## 15. Full static archive export

The user can optionally export a browsable directory containing:

- every selected chat;
- all referenced retained blobs, deduplicated;
- the static archive viewer;
- a manifest with counts/hashes.

The export operation must clearly distinguish:

- **private local archive**: may contain the full retained chat history;
- **share/export**: user-selected scope with an explicit privacy warning.

## 16. Search and indexing

### 16.1 SQLite projection

Proposed tables:

- `sessions`;
- `events`;
- `messages_fts`;
- `assets`;
- `event_assets`;
- `lineage`;
- `memory_entries`;
- `memory_fts`;
- `thread_membership`;
- `quilt_membership`.

The database stores normalized/queryable projections plus refs into canonical evidence. It does not
become the only copy of transcript text or bytes.

### 16.2 Rebuild

`Rebuild archive index` must:

1. create a new temporary index;
2. scan canonical manifests/events/blobs;
3. validate and populate it;
4. atomically replace the old index only after success.

A corrupt/missing index must not prevent direct session browsing.

## 17. Provider-neutral memory

The archive solves evidence durability. It does not by itself solve recall.

Add a separate small memory layer:

- global memory;
- project memory;
- Thread memory;
- optional agent-specific memory.

Every memory item should point to source evidence when it came from a conversation.

Retrieval can combine:

- exact keyword/FTS;
- Thread/Quilt/Project membership;
- recency;
- optional embeddings later.

Embeddings are derived indexes and may be rebuilt or replaced. They are never the retained truth.

## 18. Parallel chats/projects

One project can have many parallel conversations.

Project context is composed from:

1. current user request;
2. project instructions/AGENTS;
3. activated Thread/Quilt context;
4. relevant curated project memory;
5. explicitly retrieved historical evidence/artifacts.

No provider conversation needs to contain every prior turn. This is the provider-neutral seam that
lets Luna, an OpenRouter model or another future model work over the same ParadigmEve project.

## 19. Provider-memory declaration

ParadigmEve should expose the distinction in user-facing diagnostics/settings:

- **Local evidence:** retained by ParadigmEve.
- **Local memory:** curated/retrieved by ParadigmEve.
- **Provider memory:** optional account/model behavior outside ParadigmEve's durability guarantee.

If a workflow depends on provider memory, the app should say so rather than implying the local
archive contains that state.

## 20. Privacy and security

- Archive stays local by default.
- Never store provider bearer tokens, setup secrets or browser credentials.
- Preserve existing recorder redaction/scrubbing rules.
- Static HTML must treat authored Markdown/HTML as untrusted data.
- No inline event handlers from captured content.
- Escape filenames/titles/tool arguments before rendering.
- Generated links to local assets must stay within the archive root.
- Bundle import rejects `..`, absolute paths, symlinks escaping the import root and oversized
  declared/decoded content.
- Export warns that human-authored chat text itself may contain private information.

## 21. Integrity and recovery

Provide an archive integrity scan that can report:

- invalid JSONL line;
- duplicate/conflicting event id;
- missing referenced blob;
- hash mismatch;
- impossible lineage;
- unsupported schema version;
- orphan blob;
- stale/rebuildable index;
- stale/rebuildable HTML.

Repair policy:

- never rewrite canonical evidence merely to satisfy a projection;
- rebuild indexes/HTML;
- quarantine malformed imports;
- show partial sessions with explicit errors instead of hiding the entire chat.

## 22. Retention and deletion

Separate temporary transport storage from retained archive storage.

- pending upload staging may remain bounded/age-pruned;
- retained archive blobs are not silently age-pruned;
- deleting a chat or clearing image storage is an explicit user action;
- reference retirement is committed before byte deletion;
- shared blobs are removed only when no retained event references them;
- HTML/index projections can always be deleted and regenerated.

## 23. Migration from current ParadigmEve

The first experiment migration is non-destructive:

1. enumerate current durable sessions;
2. read canonical current events;
3. retain existing session-owned assets by hash;
4. create archive session manifests;
5. copy/deduplicate eligible bytes into archive blobs when needed;
6. index what exists;
7. mark historical metadata-only attachments/images honestly;
8. generate the static site.

Do not invent full-resolution bytes for old attachments whose originals were already discarded.

## 24. Schema evolution

Every canonical archive structure is versioned.

Rules:

- readers accept known older versions;
- migrations create a new representation from old evidence rather than editing history in place
  when feasible;
- HTML/site version can advance independently;
- SQLite schema can be dropped/rebuilt;
- portable bundles declare minimum compatible archive schema.

## 25. Implementation seams

Suggested new main-process modules:

```text
src/main/archive/
  archive-store.ts
  archive-blobs.ts
  archive-index.ts
  archive-migrate.ts
  archive-export.ts
  archive-integrity.ts
  archive-html.ts
```

Suggested shared types:

```text
src/shared/archive.ts
```

Suggested renderer:

```text
src/renderer/archive-surface.ts
src/renderer/archive-surface.css
```

The archive must use narrow IPC methods rather than giving the renderer generic filesystem access.

## 26. Relationship to current session store

For the experiment:

- current session events remain authoritative runtime evidence;
- archive ingestion subscribes to committed session evidence, not browser guesses;
- the archive can also rebuild by scanning current durable sessions;
- the archive does not become a second independent chronology owner;
- once the design proves stable, common event/blob primitives may be factored into one owner.

## 27. Relationship to Pins/Threads/Quilts

- A Pin continues to point to evidence; it does not own duplicate bytes.
- Thread/Quilt archive pages can be generated from memberships.
- Image/file Pins resolve through the retained archive blob.
- Archive search can filter by Thread/Quilt.
- Starting a new chat from a Thread still activates current Thread semantics, not an entire archived
  transcript dump.

## 28. Relationship to Plans/Requests

Archive rendering may display Plan/Request links and snapshots for navigation, but lifecycle authority
remains in the existing owners.

Static HTML is read-only. It cannot sign off, archive or mutate a Plan.

## 29. Relationship to Compact & Resume

Compact & Resume must look like one local work history even when provider conversation ids change.

The archive should show:

- one durable local session;
- the provider A -> B continuation boundary;
- exact source/destination conversation ids only in developer metadata if appropriate;
- assets before/after the continuation in one chronological transcript.

## 30. Reboot/offline acceptance contract

The core experiment is accepted only when this scenario passes:

1. Start ParadigmEve.
2. Create/send a user message containing a locally selected image.
3. Receive or record an assistant/tool image that ParadigmEve claims to retain.
4. Verify both appear in the live Eve transcript.
5. Close ParadigmEve completely.
6. Reboot/reinitialize against the same user-data directory.
7. Disconnect or block network access for the archive viewer.
8. Open the archive.
9. Select the exact prior chat.
10. Scroll to the relevant turns.
11. Open both retained images full-size from local bytes.
12. Verify hashes/byte identity against the retained blob records.

Provider-only historical attachments are allowed to show an explicit unavailable placeholder; they
are not allowed to masquerade as retained images.

## 31. Required automated tests

### Evidence/storage

- append/reopen session events;
- promote app-upload original into retained blob;
- content-hash dedupe;
- corrupt/missing blob state;
- quota/storage cleanup retirement ordering;
- restart rebuild from canonical evidence;
- index deletion/rebuild;
- site deletion/regeneration.

### Generated images

- image-only assistant terminal response becomes durable image evidence;
- text + multiple images retain exact provider grouping;
- metadata survives when pixel capture fails;
- local bytes survive restart;
- stale/signed provider URL is not required after capture;
- retired provider tuple cannot silently resurrect deleted content.

### HTML

- opens from `file://` without a server;
- no external network URLs/scripts/styles;
- hostile authored HTML cannot execute;
- chat navigation works;
- large transcript can be paged/rendered without unbounded DOM growth;
- missing asset produces explicit placeholder;
- image opens at useful size.

### Portable bundle

- deterministic manifest;
- hash validation;
- path traversal rejection;
- oversized file rejection;
- import does not overwrite an existing live session;
- offline viewer works after extraction.

### Memory

- memory points to exact evidence;
- deleting/rebuilding index does not delete memory/evidence;
- superseded memory remains auditable;
- provider swap can load the same selected local memory.

## 32. Dogfood matrix

Test four distinct image classes separately:

| Class | Expected after restart/offline |
| --- | --- |
| Eve composer upload | Full retained local image |
| Direct/native ChatGPT upload | Full local image only if bytes were captured; otherwise explicit provider-only card |
| Native/generated assistant image | Durable `native_image` evidence + local pixels when captured |
| Tool-returned image | Durable existing local asset |

Also test:

- unsent image draft -> allowed to disappear unless draft persistence is explicitly added;
- admitted queued attachment -> must survive restart to delivery/cancel boundary;
- Compact & Resume -> retained assets stay attached to the same local session;
- provider/model swap -> archive remains identical.

## 33. Performance targets

Initial targets, to validate rather than blindly optimize:

- 10,000 sessions searchable without loading all transcripts;
- chat list initial render from index/manifest only;
- selected transcript loaded in bounded pages;
- image thumbnails lazy-loaded;
- static site generation incremental by changed session;
- blob dedupe avoids duplicate copies of identical content.

## 34. Experiment phases

### Phase A — authority and reboot safety

- first-class generated/native image evidence;
- durable original app-upload promotion;
- archive blob store;
- archive session manifests;
- deterministic restart tests.

### Phase B — archive browser

- rebuildable index;
- Archive workspace;
- static HTML site;
- full-size local image viewer;
- explicit partial/missing states.

### Phase C — portability

- `.evechat` export/import;
- whole-archive static export;
- integrity scan and repair projections.

### Phase D — provider-neutral memory

- curated memory entries with provenance;
- project/Thread scopes;
- archive/search retrieval;
- provider swap experiment.

## 35. Experiment branch rules

- Base is the exact `2.2.3` tag at `fc5aad5be7a6127661d1bc166cf0e711fed281aa`.
- Never move or rewrite tag `2.2.3`.
- Do not modify the published 2.2.3 installer.
- Keep worker file ownership non-overlapping where possible.
- Do not reset/clean/rebase away another worker's edits.
- Commit experiment checkpoints independently from the release tag.
- Build/install only after source tests and the reboot archive contract are green.

## 36. Definition of success

The experiment succeeds when ParadigmEve can truthfully say:

> This conversation, its retained images/files and the evidence linking them are locally owned.
> You can reboot, go offline and browse them without the provider. The HTML view is a durable human
> projection; the semantic events and content-addressed bytes are the recoverable source of truth.
> Agent memory is a separate local layer with provenance, so changing models does not erase the
> project's history.
