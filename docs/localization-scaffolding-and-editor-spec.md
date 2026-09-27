# ParadigmEve localization scaffolding + Localization Lab specification

Status: implementation specification
Date: 2026-09-19
Scope: renderer-owned UI localization and first-party translation tooling

## 1. Goal

Make localization boring, legible, and safe.

Adding or maintaining a language should not require hunting through `index.html`, TypeScript, a giant flat
dictionary, or localization runtime code. A translator should be able to open one clearly named product
section, see stable string identities beside the source language, translate that section, validate it, and
preview it in the real app.

ParadigmEve should also be able to host a small Localization Lab that edits the same data model, imports and
exports spreadsheet-friendly CSV, previews a locale live, and saves a draft preset without granting the
renderer generic filesystem access.

This is reliability/tooling work, not a new user workflow. The substrate lands before the editor.

## 2. Existing behavior that must survive

Current product invariants from `AGENTS.md` remain authoritative:

- US English and Swedish are the shipped UI languages today.
- The selected UI locale persists locally and Setup/Settings show one current language at a time.
- Changing locale repaints app-owned chrome without rebuilding controls or destroying drafts, selections,
  icons, scroll positions, or authored content.
- User-authored messages, provider/model text, file paths, model-authored Plans/headlines, connector data,
  and other external/authored content are never translated merely because they happen to resemble a UI
  string.
- Authored prose keeps automatic text direction. App shell/code remain structurally controlled by Eve.

The current implementation in `src/renderer/i18n.ts` already has a useful ownership model: bindings repaint
only while the localized value still owns the node. Preserve that behavior.

## 3. Problems in the current scaffold

Today `src/renderer/locales/sv-SE.json` is one large flat object whose keys are English display strings.
That creates four avoidable costs:

1. editing English copy changes translation identity;
2. the translator cannot browse one product area without scanning the entire catalogue;
3. the same English phrase cannot safely have context-specific translations;
4. adding a third locale requires editing runtime unions/imports, HTML selectors/flags, and a monolithic
   translation file rather than copying a clear locale skeleton.

The current `initLanguage()` also discovers static HTML translations by comparing rendered English text
against catalogue keys. That is convenient for a two-language bootstrap but is not a durable localization
contract.

## 4. Canonical source of truth

### Decision

**JSON is canonical. CSV is an interchange/editor format only.**

The canonical repository structure is sectioned JSON with stable semantic keys. English is an explicit
source locale rather than an implicit collection of source-code literals.

```text
src/renderer/locales/
  manifest.json
  en-US/
    common.json
    setup.json
    settings.json
    chat.json
    threads.json
    plans.json
    schedule.json
    expenses.json
    agents.json
    plugins.json
    diagnostics.json
  sv-SE/
    common.json
    setup.json
    settings.json
    chat.json
    threads.json
    plans.json
    schedule.json
    expenses.json
    agents.json
    plugins.json
    diagnostics.json
```

Section boundaries may be adjusted once against the real string inventory, but after migration a string
belongs to one section and one semantic key. Do not create overlapping "misc" copies.

### Locale manifest

`src/renderer/locales/manifest.json` is the single shipped-locale registry.

Conceptual shape:

```json
{
  "sourceLocale": "en-US",
  "locales": [
    {
      "id": "en-US",
      "aliases": ["en"],
      "nativeName": "English (US)",
      "direction": "ltr",
      "flag": "us",
      "status": "shipping"
    },
    {
      "id": "sv-SE",
      "aliases": [],
      "nativeName": "Svenska",
      "direction": "ltr",
      "flag": "se",
      "status": "shipping"
    }
  ],
  "sections": [
    { "id": "common", "label": "Common UI" },
    { "id": "setup", "label": "Setup" },
    { "id": "settings", "label": "Settings" },
    { "id": "chat", "label": "Chat" },
    { "id": "threads", "label": "Threads and Quilts" },
    { "id": "plans", "label": "Plans" },
    { "id": "schedule", "label": "Schedule" },
    { "id": "expenses", "label": "Expenses" },
    { "id": "agents", "label": "Agents and workers" },
    { "id": "plugins", "label": "Plugins and connectors" },
    { "id": "diagnostics", "label": "Status and diagnostics" }
  ]
}
```

Locale ids are canonical BCP-47 tags. Existing stored `en` migrates to `en-US`. The already-retired
`zh-CN` preference continues to fall back to `en-US`; no Chinese locale is reintroduced.

`flag` is presentation metadata, never locale identity. A custom/draft locale may omit it and display a
text/initial badge instead. Adding a locale must not require hand-authoring SVG in `index.html`.

### Section file shape

Each section is deliberately boring: a flat JSON object whose keys are stable semantic ids and whose values
are plain-text strings.

Example `en-US/settings.json`:

```json
{
  "apiProvider.title": "API provider",
  "apiProvider.provider.label": "Provider",
  "apiProvider.primaryModel.label": "Primary model",
  "apiProvider.fallbackModels.label": "Fallback models",
  "apiProvider.fallbackModels.add": "Add fallback",
  "language.label": "Language"
}
```

Example `sv-SE/settings.json`:

```json
{
  "apiProvider.title": "API-leverantör",
  "apiProvider.provider.label": "Leverantör",
  "apiProvider.primaryModel.label": "Primär modell",
  "apiProvider.fallbackModels.label": "Reservmodeller",
  "apiProvider.fallbackModels.add": "Lägg till reservmodell",
  "language.label": "Språk"
}
```

Rules:

- Keys describe meaning, not current English wording.
- Values are plain text. Locale values never contain executable HTML.
- A key is globally unique after prefixing its section (`settings.apiProvider.title`).
- Placeholders remain positional in v1: `{0}`, `{1}`, etc.
- The target locale must preserve the exact placeholder multiset from English.
- Provider ids, model ids, file paths and authored names are arguments, not translated string content.
- Context-specific wording gets a context-specific key even when English text happens to match another key.

Do not introduce ICU/message-format complexity merely to complete this migration. Existing count-sensitive
call sites may continue selecting singular/plural keys explicitly. A future plural engine can be added at
the localization boundary without invalidating stable ids.

## 5. Runtime API

### Stable-key API

The target public renderer API remains small:

```ts
type LocaleId = string;

currentLanguage(): LocaleId;
t(key: TranslationKey, args?: readonly unknown[]): string;
setLanguage(locale: LocaleId): void;
ui(node, property, value): node;
uiText(value): Text;
```

`t()` resolves:

1. active locale value when present and non-empty;
2. `en-US` value;
3. in debug only, an obvious missing-key marker plus diagnostic logging if the key itself is unknown.

Production must never expose a raw semantic key when a valid English source entry exists.

### Migration adapter

The existing codebase uses English source strings as translation keys. Migration may therefore use a
temporary explicit adapter such as `tLegacy(source, args)` or a generated legacy source→stable-key map.
It exists only so sections can move safely in bounded batches.

New UI copy added after the scaffold lands MUST use stable keys. Tests must prevent new legacy literals
from expanding the compatibility map. The migration is complete only when the compatibility map is empty
and deleted.

Do not make `t()` permanently guess whether an argument is a stable id or English prose; that would leave
two invisible localization contracts forever.

### Static HTML

Static app-authored HTML gets explicit identities rather than being translated by text matching.

Preferred shape:

```html
<h2 data-i18n="settings.apiProvider.title">API provider</h2>
<input data-i18n-placeholder="settings.apiProvider.endpoint.placeholder" ... />
<button data-i18n-aria-label="common.remove">...</button>
```

The English text/attribute remains in HTML as a readable fallback and review surface, but the semantic key
owns localization identity.

`initLanguage()` binds those nodes once and retains the existing ownership rule: a later authored/runtime
value that replaced the localized value must not be overwritten by a locale refresh.

### Direction and formatting

Changing locale sets both:

- `document.documentElement.lang = localeId`;
- `document.documentElement.dir = locale.direction`.

Locale-aware dates/numbers use `currentLanguage()`/the locale registry with `Intl`, not hard-coded
`sv-SE ? ... : en` branches. Authored/provider prose retains its own direction rules and is not forced
through app-shell direction assumptions.

## 6. Build-time catalogue generation

The renderer should not require a hand-written import every time a locale is added.

Add a build/validation tool that reads `manifest.json` and every declared locale/section, validates them,
and generates the bounded runtime catalogue/registry consumed by `i18n.ts`.

Suggested files:

```text
scripts/locales-build.mjs
scripts/locales-csv.mjs
src/renderer/locales/generated.ts   # generated, never hand-edited
```

Exact implementation may differ if the current bundler has a cleaner safe mechanism, but the invariant is
that **manifest + section JSON is authoritative; runtime import wiring is derived**.

The generator output is deterministic. `npm run verify` or a dedicated verification script fails when the
checked/generated output is stale.

## 7. Validation contract

Validation is the main reason to build the scaffold.

### Every locale pack

- locale id parses as a supported BCP-47 tag;
- only declared sections are accepted;
- key count and individual string/cell sizes are bounded;
- no duplicate semantic key exists across sections;
- every value is a string;
- placeholders exactly match the English source placeholders;
- no NUL/control payload or executable markup is accepted as translation data;
- unknown keys are reported, never silently promoted into the app catalogue.

### Shipping locales

`status: shipping` locales must have a non-empty translation for every source key. No silent partial Swedish
release is allowed.

### Draft/experimental locales

Missing or blank translations are allowed and visibly fall back to English. Completeness is measured from
the source keyset and shown in the editor.

### Coverage

Verification must prove:

- every explicit static `data-i18n*` reference names a real key;
- every literal dynamic `t('...')` reference names a real key;
- English source sections contain no orphan duplicate identities;
- every shipped locale preserves placeholders;
- locale switching preserves existing DOM/control ownership behavior;
- user/provider/authored content remains untouched;
- new UI source cannot bypass localization unnoticed.

The current renderer-i18n tests around preserving drafts, selections, icons, authored messages, model ids,
and provider text remain acceptance tests, rewritten around stable keys rather than discarded.

## 8. Migration strategy

Do not rewrite all renderer copy in one giant patch.

### Phase A — scaffold

1. Introduce locale manifest/schema/validator/generator.
2. Introduce explicit `en-US` source locale.
3. Add runtime stable-key lookup while retaining a bounded legacy adapter.
4. Move language selector options/metadata to the locale registry so another locale requires data, not
   duplicated HTML/runtime unions.
5. Keep visible behavior identical for English and Swedish.

### Phase B — migrate by product section

Move sections independently. A section migration owns:

- its `en-US/<section>.json`;
- its `sv-SE/<section>.json`;
- its renderer call sites/static HTML annotations;
- its focused localization tests.

Recommended order:

1. common + language controls;
2. settings + setup;
3. chat + agents;
4. Threads/Quilts + Plans;
5. Schedule + Expenses;
6. plugins + diagnostics.

Section files are intentionally separate so these migrations can be delegated without multiple workers
editing one 120 KB locale file.

### Phase C — remove legacy identity

When every app-owned string is keyed:

- delete the English-source-string compatibility map;
- delete the monolithic `sv-SE.json`;
- add a gate that fails on new `t("English prose")`/implicit static-text localization patterns;
- retain English fallbacks in HTML only as readable source/failure presentation, not identity.

## 9. CSV interchange

CSV is generated from the canonical JSON and may be re-imported into a draft locale.

The useful spreadsheet orientation is **one string per row, languages in columns**:

```csv
section,key,en-US,sv-SE
settings,apiProvider.title,API provider,API-leverantör
settings,apiProvider.primaryModel.label,Primary model,Primär modell
settings,apiProvider.fallbackModels.add,Add fallback,Lägg till reservmodell
```

For a single target locale the editor may export:

```csv
section,key,en-US,target
```

where the actual target locale id is also recorded by the import/export operation rather than inferred from
human wording.

CSV rules:

- UTF-8; import tolerates an optional BOM from Windows spreadsheet tools;
- RFC-4180 quoting for commas, quotes and newlines;
- `section` + `key` is identity and is never translated;
- source English is review/context data; importing it never mutates the source catalogue;
- unknown keys are shown as conflicts and ignored until explicitly resolved;
- duplicate rows are an error;
- placeholder mismatch is an error for that row;
- import is bounded by file bytes, row count and cell size;
- the app never evaluates spreadsheet formulas or markup contained in cells.

CSV is never loaded directly by the runtime and never becomes a second canonical store.

## 10. Localization Lab

### Product position

First implementation is a **debug/dev localization tool**, not a shipping end-user feature. It dogfoods the
same locale schema and can later be promoted if custom language packs prove useful to normal users.

It lives under Settings as `Localization Lab` only when the build flavor permits developer tooling.

### Main screen

The editor shows:

- target locale selector;
- `New language` action;
- native name / BCP-47 id / direction metadata;
- completeness summary (`742 / 760 translated`, for example);
- section filter;
- search by key, English text or translation;
- `Missing only` toggle;
- validation status;
- Import CSV, Export CSV, Import JSON, Export JSON;
- Preview and Save draft actions.

The translation grid is conceptually:

| Key | English | Translation | Status |
| --- | --- | --- | --- |
| `apiProvider.title` | API provider | API-leverantör | ✓ |
| `apiProvider.primaryModel.label` | Primary model | Primär modell | ✓ |
| `apiProvider.fallbackModels.add` | Add fallback |  | Missing |

The selected section is already known, so repeating it on every visible row is optional.

### New language

`New language` asks for:

- BCP-47 locale id, e.g. `es-ES`;
- native display name, e.g. `Español`;
- direction (`ltr` default, `rtl` explicit);
- optional flag/region presentation;
- source structure to copy (initially `en-US`).

"Copy English" means **copy the key/section structure with blank target values**, not mark every English
value as translated. This gives an honest 0% starting point while keeping the English column visible beside
each row. Identical legitimate translations can then be entered deliberately.

### Editing and save

- Grid edits are local editor state until saved.
- `Save draft` validates then writes a locale draft atomically.
- Validation failures remain visible per row and do not partially replace the last valid saved draft.
- The editor may auto-save a separate recovery draft, but that recovery state is not a published locale.
- Sorting/filtering never changes canonical key order on disk; generated JSON uses deterministic section/key
  ordering.

### Preview

Preview applies the unsaved/draft target catalogue to app-owned localization bindings using the same runtime
translation path. It must not rebuild the window or mutate user-authored/provider content.

Leaving preview restores the previously selected normal locale exactly.

An eventual `Show in app` action may navigate/highlight a known surface, but it is not required for the
first editor slice. Translation correctness is more important than a locator feature.

## 11. Draft preset storage and authority

The renderer receives no generic file API.

Purpose-built main-process localization storage owns draft packs under Electron `userData`, conceptually:

```text
<userData>/locales/drafts/<locale-id>/...
```

Main validates locale id, section ids, bounds and schema before any read/write. Draft publication uses the
existing durable temp→rename pattern or equivalent atomic write discipline.

Renderer IPC is narrow, for example:

```ts
listLocaleDrafts()
loadLocaleDraft(localeId)
saveLocaleDraft(pack, expectedRevision)
importLocaleFile()
exportLocaleFile(pack, format)
```

Exact method names are implementation details. There is no arbitrary path parameter from the renderer.

Concurrent edits use an `expectedRevision`/generation check so an older Localization Lab window cannot
overwrite a newer saved preset silently.

Repo-shipped locale JSON remains source-controlled product material. The Localization Lab does not silently
write into `src/renderer/locales`. A developer can export a validated repo-ready pack and then intentionally
add/review it in the repository.

## 12. Security and trust boundaries

- Locale files are untrusted text input, not code.
- Never use `innerHTML` for translations.
- Never translate model ids, provider ids, paths, commands, credentials, user messages, tool output or
  externally authored titles by catalogue lookup.
- Import cannot widen app permissions or choose a provider/model/tool.
- A malformed locale cannot prevent app startup; built-in English remains a validated fallback.
- Imported locale size is bounded before parsing and after decoding.
- Export/import errors are explicit and retain the previous valid draft.
- Locale selection is presentation state only; it cannot alter execution authority.

## 13. Translation quality workflow

The scaffold should support a simple human loop:

1. create/copy locale structure;
2. translate one product section;
3. filter to missing/invalid rows;
4. validate placeholders;
5. preview the real UI;
6. fix awkward length/context issues;
7. save/export;
8. review diff and focused UI tests;
9. only then mark a built-in locale `shipping`.

Machine translation may propose text later, but it does not become canonical merely because a model produced
it. Human review/preview remains the publication boundary for shipped copy.

## 14. Test plan

### Schema/tooling

- manifest accepts valid canonical locales and rejects invalid/duplicate ids;
- aliases migrate `en` → `en-US` and retired `zh-CN` → source fallback;
- duplicate semantic keys fail;
- unknown sections fail;
- shipping locale missing/blank strings fail;
- draft locale missing strings falls back to English and reports completeness accurately;
- placeholder deletion/addition/reordering policy is enforced;
- deterministic generation produces identical output from identical input;
- CSV round-trip preserves Unicode, quotes, commas and newlines;
- duplicate/unknown CSV rows are rejected/reported without mutating source English.

### Runtime

- English and Swedish switching keeps existing nodes/inputs/selections/icons intact;
- authored/provider/model/path text is unchanged;
- static `data-i18n*` and dynamic key coverage is complete;
- active locale changes `lang` and `dir` correctly;
- `Intl` date/number formatting follows the registry locale;
- stale/newer authored node values retain ownership across a locale repaint;
- missing draft translation falls back to English;
- malformed custom draft cannot replace last valid runtime pack.

### Localization Lab

- new locale copies structure with blank target values and 0% honest completeness;
- filter/search/missing-only do not alter data;
- placeholder error blocks save for that row/pack as specified;
- save uses optimistic revision and refuses stale overwrite;
- preview/restore preserves user drafts and normal selected locale;
- imported CSV edits only known target translation cells;
- export contains stable section/key identities and correct Unicode;
- no generic filesystem path crosses renderer IPC.

### Acceptance

At minimum rerun the existing renderer i18n/state/layout suites plus new locale schema/editor suites,
typecheck, `git diff --check`, and full `npm run verify` before considering the substrate integrated.

## 15. Worker implementation boundaries

Implementation should be delegated only after this specification exists. Workers receive disjoint file
ownership and no nested delegation.

Recommended sequence:

### Worker A — schema/generator foundation

Own new locale schema/build tooling and focused tests. Establish manifest parsing, section loading,
deterministic generation, placeholder validation and CSV codec without migrating renderer sections yet.

### Worker B — runtime + common/language controls

After Worker A's contract is stable, adapt `i18n.ts`, locale selector registry, current-language persistence,
static key binding and common section. Preserve the existing DOM ownership tests.

### Workers C/D — bounded section migrations

Migrate non-overlapping section files and their owning renderer files/tests. Sectioned JSON exists partly to
make this safe. No two workers edit the same section locale files.

### Worker E — Localization Lab storage/IPC

Own purpose-built draft locale storage, optimistic revision, bounded import/export and preload contract.
Must not create generic filesystem IPC.

### Worker F — Localization Lab renderer

Own the debug/dev editor surface on top of the established schema/storage API. No schema invention in the
renderer.

Prime independently reviews integration, resolves contract seams, runs the combined suites, and performs
hands-on English/Swedish + one disposable third-locale dogfood before any promotion.

## 16. First implementation milestone

The first milestone is deliberately smaller than the full editor:

**A third locale can be created by copying the English section structure, the validator reports exactly what
is missing/invalid, the runtime can preview it with English fallback, and English/Swedish behavior is
unchanged.**

Only after that works should the in-app spreadsheet editor be treated as implementation rather than UI
mockup.

## 17. Non-goals for this pass

- automatic machine translation;
- cloud translation service integration;
- locale-specific model/provider routing;
- translating user/provider/tool content;
- rich HTML translations;
- a full ICU plural/gender engine;
- direct source-tree mutation from the renderer;
- shipping arbitrary community locale packs before the draft/validation trust boundary is dogfooded.

## 18. Completion definition

The localization scaffold is "proper" when all of these are true:

- English is explicit structured source data, not implicit translation identity;
- every app-owned localized string has a stable semantic key and clear product section;
- Swedish is split into the same readable sections;
- adding a locale is data + translation work, not runtime wiring work;
- validation catches missing strings, unknown keys and placeholder damage before runtime;
- CSV is a reversible interchange view, not a competing source of truth;
- locale switching still preserves live UI state and authored content;
- a draft locale can be previewed without being shipped;
- the Localization Lab edits exactly the same schema used by source-controlled locale packs;
- the editor cannot write arbitrary files or silently overwrite newer locale work;
- the old monolithic source-string catalogue and compatibility path are deleted after migration.

The governing principle is:

> **Stable keys own meaning; sectioned JSON owns translation; generated runtime data owns delivery; the
> Localization Lab is only an editor over that same contract.**

## 19. Publication sequence

The localization architecture is a suitable first independently publishable repository slice, but
publication has a deliberate human-language gate.

Sequence:

1. finish and verify the localization substrate: stable keys, sectioned JSON, generated runtime registry,
   validation, English fallback and unchanged English/Swedish runtime behavior;
2. dogfood the migrated Swedish UI in the real app and let the product owner revise wording until the
   Swedish copy is natural, consistent and pleasant again;
3. rerun localization/runtime verification after those copy edits;
4. present the exact reviewed diff and publication contents for approval;
5. only then publish/commit the localization architecture as the first repository-facing slice.

Passing automated tests is not permission to publish awkward or mechanically migrated Swedish copy.
Likewise, Swedish copy polish must not become an excuse to redesign the localization schema after the
architecture has stabilized; wording edits should remain data-only wherever possible.

No remote publication, repository push, release, or public-GitHub transition is implied by this
specification. Those remain explicit user-approved actions.
