# Translating ParadigmEve

ParadigmEve 2.2.4 currently ships an English (US) interface and a Swedish interface. This guide explains how localization works today, how to contribute translations safely, and what the localization system should become when its string sources are redesigned later.

The current implementation is intentionally small. Do not treat the target architecture near the end of this document as permission to refactor localization while making an ordinary translation or feature change.

## Current 2.2.4 localization model

The renderer owns the main current UI localization layer:

- `src/renderer/i18n.ts` contains language selection, lookup, interpolation, persistence, and live repainting.
- `src/renderer/locales/sv-SE.json` is the Swedish catalog.
- English is the canonical source language today. English strings live directly in renderer TypeScript and `src/renderer/index.html`; there is no separate English JSON catalog yet.
- `test/renderer-i18n.test.ts` is the focused regression suite for language selection, fallback, static-shell coverage, literal `t(...)` coverage, placeholder preservation, authored-content safety, and terminology-specific behavior.
- The selected UI language is stored in local storage as `cos.ui.language`.

The standalone static chat archive is intentionally outside that renderer pipeline so the recovery
file remains usable by itself under `file://`. Its current archive chrome is English except for the
new chronology toggle, which chooses `Newer first` / `Older first` or Swedish
`Nyare först` / `Äldre först` from the browser's `navigator.languages` / `navigator.language`.
Do not import renderer state or filesystem authority into that recovery page merely to share i18n.

Locale file names use BCP 47-style tags. The current locale is `sv-SE`. A future locale should use the narrowest stable tag that describes the shipped translation, such as `de-DE`, `fr-FR`, or `pt-BR`, rather than an informal filename.

### Canonical source language

English (US) is the source of truth for user-facing copy in the current system. The Swedish catalog uses the complete English source string as the lookup key.

For example:

```ts
t('Remove {0}', [name])
```

maps to a catalog entry shaped like:

```json
{
  "Remove {0}": "Ta bort {0}"
}
```

This means an English wording edit is also a localization-key change today. Search for an existing source string before creating another near-duplicate, and update every locale in the same change when a source key changes.

### What gets translated

Use `t(source, args)` for dynamic app-authored copy. Use `ui(node, property, () => t(...))` when a live language switch must repaint an existing node without replacing the control itself.

`initLanguage()` also scans the static renderer shell once and binds catalog-backed text plus `title`, `placeholder`, and `aria-label` attributes. It deliberately skips `script`, `style`, `svg`, `code`, `kbd`, `textarea`, and anything under `[translate="no"]`.

Language changes repaint registered app-owned labels in place. They must not reconstruct controls, clear drafts, move selections, replace icons, or overwrite a newer authored/runtime value that has taken ownership of a node.

Do not run user text, provider-authored text, model output, file paths, project names, Thread names, Quilt names, connector names, model IDs, or similar data through the translation catalog. The existing tests explicitly protect authored content from translation.

### Fallback behavior

`en` and `sv-SE` are the only accepted UI language values in 2.2.4.

If Swedish is selected and a key is missing, `t()` returns the English source string. English therefore remains the final runtime fallback for renderer copy.

A stored `zh-CN` value is explicitly reset to English by the current loader. Other unrecognized stored values are not accepted as active languages, so the in-memory language remains English until the user selects a supported locale.

Fallback is a safety net, not a normal contribution strategy. A feature PR that introduces new user-facing renderer copy should add the corresponding locale entries rather than relying on English fallback. Standalone recovery HTML copy must instead remain self-contained and explicitly test every supported localized variant it introduces.

## Interpolation and placeholders

The current formatter supports positional placeholders only:

```text
{0}  {1}  {2} ...
```

Translations may reorder placeholders when grammar requires it, but they must preserve the same placeholder identifiers and counts as the English source. `test/renderer-i18n.test.ts` checks placeholder parity across the Swedish catalog.

Arguments are inserted verbatim. Keep markup out of translatable messages and continue rendering untrusted/authored values through text properties rather than HTML. A translation must never turn an argument into executable markup.

Prefer one complete human sentence over fragments such as `"... " + t(...) + " ..."`. Fragmented grammar becomes hard or impossible to translate when word order, agreement, or punctuation changes between languages.

## Plurals, dates, times, numbers, and currency

The current system does not have ICU MessageFormat, grammatical plural rules, or a dedicated localized-message AST.

For plurals today, prefer complete source variants selected in code when singular and plural genuinely differ. Avoid inventing reusable English suffix fragments such as `"s"` as translation keys. If a message needs richer plural/select behavior, keep the immediate change narrow and record it as a candidate for the future architecture rather than building a second formatter in one feature.

Renderer code already uses `Intl.DateTimeFormat`, `Intl.NumberFormat`, and the browser's `toLocale*` helpers in several places. In 2.2.4 many of those calls use the environment locale (`undefined`) rather than the selected ParadigmEve UI language. Do not assume that changing the app language changes every date, time, or number format today.

When adding current copy:

- format dates/times/numbers with `Intl` or existing helpers rather than hand-building locale-specific punctuation;
- keep the formatted value as an interpolation argument inside a translated sentence;
- keep explicit currencies explicit (`USD` means USD); do not translate IDs or currency codes into a different semantic value;
- avoid embedding a fixed English date/time phrase when the platform formatter can provide the value.

Passing the selected ParadigmEve locale into all formatting belongs in the later architecture work described below.

## Product terminology and protected tokens

ParadigmEve terminology is part of the product model. Before translating a feature term, read the current Vault glossary and the nearby existing translations so one concept does not gain several competing names.

Current product concepts include **Pin**, **Thread**, **Quilt**, **Plan**, **Goal**, **Loop**, **Worker**, **Companion**, and the configured human-facing agent name such as **Eve** or **Eva**. The Swedish catalog intentionally keeps several of these product nouns in their product form while translating the surrounding sentence. Preserve that consistency unless product terminology is deliberately changed across the product and current manual together.

Never translate or rewrite syntax and identity that software consumes. This includes, at minimum:

- `%thread` references and their exact stored names, including values such as `%expenses`;
- `#quilt` references and their exact stored names;
- protocol/version identifiers;
- internal role or wire IDs such as `prime`, `worker-1`, request IDs, conversation IDs, run IDs, and session IDs;
- tool names, tool action values, schema field names, JSON keys, config keys, event kinds, and enum values;
- model/provider IDs such as `gpt-...` slugs and reasoning values such as `high` or `max` when they are machine values;
- filesystem paths, URLs, tunnel IDs, API keys, hashes, and other opaque identifiers;
- interpolation tokens such as `{0}` and `{1}`;
- user-authored names and the configured connection/agent name.

A display label for one of those concepts may be localized where the UI already does so. The machine value underneath it must remain unchanged. For example, a translated Worker label must not rewrite the raw `worker-1` identity.

## ParadigmEve's voice

Translations should preserve intent, warmth, and clarity rather than mirror English word order or expose implementation jargon.

ParadigmEve should sound cozy, human, calm, and competent. It should not sound childish, vague, corporate, or like a systems dashboard written for the person who implemented it.

Prefer the human concept when the product concept allows it. For example:

- **“Eve’s schedule”** or **“Your calendar”** is usually better user-facing language than a cron-style label when the user is managing ordinary scheduled work.
- **“Try again”** is often better than exposing an internal retry-state name.
- **“Open the chat Eve is using”** can be better than naming an internal ownership primitive.

Technical precision still matters where the distinction changes permission, data ownership, identity, or safety. Friendly wording must never blur what a capability can access. An integration that can read files, control the desktop, access a calendar, or send data must use capability-specific consent language and current documentation that says what the integration can actually do.

Translate meaning, not jargon for jargon's sake. If the English source itself is too implementation-shaped for users, improve the English source and translations together instead of hiding a poor source phrase only in one locale.

## Avoid duplicated and fragmented strings

Before adding a new message:

1. Search the renderer and locale catalog for the same meaning.
2. Reuse an existing complete source string when the product meaning is genuinely identical.
3. Do not create punctuation-only or sentence-fragment keys merely to make concatenation convenient.
4. Do not duplicate the same user-facing sentence separately in renderer, main-process status text, and Companion code when one shared concept should own it.
5. When two surfaces need intentionally different wording because their context differs, make that difference explicit rather than letting copy drift accidentally.

The current system cannot enforce one-source ownership across all app surfaces. Review copy across renderer, main-process status/detail strings, and `extension/` whenever a feature presents the same concept in more than one place.

## Updating an existing translation

For a wording-only translation fix:

1. Confirm the English source key and its UI context.
2. Edit the appropriate value in `src/renderer/locales/sv-SE.json`.
3. Preserve all placeholders exactly.
4. Check nearby product terminology for consistency.
5. Run the focused i18n test and typecheck.
6. If the wording documents a changed user-facing behavior rather than only improving translation quality, update the current Vault/manual page for that behavior in the same feature PR.

Do not change the English key merely to avoid editing the locale file. English source wording is product copy and should change only when the English UI should actually change.

## Adding a language safely today

Adding a language in 2.2.4 is a small code change as well as a catalog contribution. A JSON file alone is not enough because the supported-language list and selectors are currently explicit.

Use this checklist:

1. Add `src/renderer/locales/<locale>.json` using a stable BCP 47-style locale name.
2. Start from complete current English renderer coverage, not from another translation. Another locale can help with terminology, but English is the canonical source today.
3. Preserve every interpolation placeholder exactly.
4. Update `src/renderer/i18n.ts` to import the catalog, extend `Language`, select the right catalog, accept/persist the new locale, and bind its selector value. Keep English as the final fallback.
5. Add the locale to both language selectors in `src/renderer/index.html`, using the language's native display name. Update the current-language artwork/indicator in both Setup and Settings consistently. The UI currently shows one active flag/artwork plus one selector on each surface.
6. Extend `test/renderer-i18n.test.ts` so selection, persistence, flags/indicators, fallback, repainting, authored-content preservation, placeholder parity, and catalog coverage include the new locale.
7. Review the feature/product terminology against `docs/vault/glossary.md` and existing current 2.2.4 UI copy.
8. Exercise Setup, Settings, Chat, Pins/Threads/Quilts, Plans, worker UI, usage/model UI, and any feature-specific surface whose strings were added.
9. Run focused tests and `npm.cmd run typecheck` on Windows (`npm run ...` is fine on shells where the PowerShell shim is not restricted).

Keep the first community PR for a new language translation-focused. Do not combine it with a localization-engine rewrite.

## Missing and unused key checks

Current automated coverage already checks several important failure classes in `test/renderer-i18n.test.ts`:

- every translatable static renderer label/attribute represented by the test shell has a Swedish catalog entry;
- every literal renderer `t('...')`/`t("...")` call has a Swedish catalog entry;
- catalog values are non-empty;
- translation placeholders match the source placeholders;
- language switching preserves controls, drafts, selections, icons, and authored text.

Run:

```sh
npm.cmd test -- --run test/renderer-i18n.test.ts
npm.cmd run typecheck
```

There is no authoritative unused-key checker in 2.2.4. A naive grep is unsafe because static HTML lookup and dynamic `t(variable)` calls can consume catalog entries without a literal TypeScript call. Review apparently unused keys before deleting them, and prove their source path is gone.

The later architecture should add a real catalog validator that reports, per locale:

- missing keys;
- unused keys;
- duplicate source ownership;
- placeholder/schema mismatches;
- invalid locale metadata;
- untranslated source-language copies where they are not explicitly allowed;
- protected-token mutations.

## Tests and validation for translation PRs

At minimum, run the focused renderer i18n suite and typecheck. Add a focused regression when a translation bug exposed a behavior not already covered.

For a new or substantially expanded locale, also verify manually that:

- both language selectors stay synchronized;
- switching languages does not replace editable controls or lose drafts/selections;
- long translated strings fit the relevant layout and remain readable;
- keyboard/focus labels and `aria-label` text are translated where appropriate;
- authored text, provider/model text, paths, IDs, and product/user names stay untouched;
- placeholders render in the intended order;
- terminology is consistent across Chat, Setup, Settings, Pins/Threads/Quilts, Plans, workers, and related Companion guidance;
- permissions and integration consent remain explicit after translation.

Run `git diff --check -- TRANSLATION.md <changed localization files>` before submitting. If the change affects user-facing behavior, run the nearest feature tests too.

## Documentation is part of a user-facing feature

ParadigmEve's `docs/vault/` is the current 2.2.4 manual. A user-facing feature PR must update the relevant current Vault/manual page when behavior, terminology, permissions, setup, or workflow changes.

Do not leave the durable explanation only in code comments, a worklog, release scratch note, or terse “fixed X” issue text. Those can support the change, but they do not replace the current manual.

Use current terminology only. The Vault should explain how ParadigmEve works now, rather than teaching old product names or migration history.

For integrations, document the capability the user is consenting to, the data/surface it can reach, where the user enables or revokes it, and any relevant provider/OS permission boundary. Translation should preserve those distinctions instead of compressing them into a generic “connect” message.

## Pull request expectations

A translation/localization PR should state:

- locale(s) changed;
- UI areas reviewed;
- terminology decisions that may be non-obvious;
- whether English source copy changed;
- focused tests and validation run;
- any intentionally untranslated protected terms;
- relevant Vault/manual updates when user-facing behavior changed.

Keep diffs reviewable. Avoid unrelated formatting of the large locale JSON file. Do not silently rename product concepts in one language. If a term needs a product-level rename, treat that as a coordinated product/documentation change.

## Recommended target architecture for the later string-source redesign

This section is a design target, not the current implementation.

The next localization architecture should make translations simpler for community contributors and remove English prose strings from the role of lookup IDs.

### 1. One canonical message definition per user-facing concept

Create one canonical source catalog, preferably `en-US`, with stable semantic keys such as:

```text
plans.archive.ready
threads.pin.choose_destination
setup.connector.permission_low_risk
workers.activity.empty
```

Every locale should translate those keys. Renderer, main-process user-facing statuses, and Companion UI should consume the same message definitions or generated typed interfaces rather than independently hard-coding copies of the same sentence.

Stable keys let English wording evolve without invalidating every translation key and make unused-key analysis tractable.

### 2. A data-driven locale registry

Replace hard-coded language branches with one locale registry containing at least:

- locale tag;
- native display name;
- fallback locale;
- text direction;
- catalog loader;
- optional presentation metadata for the language picker.

Adding a community language should normally mean adding one catalog plus one registry entry, not editing language conditionals throughout the renderer.

Use predictable fallback resolution such as exact locale -> explicit parent/base fallback when appropriate -> `en-US`.

### 3. Typed messages and rich formatting rules

Generate or validate a message schema from the canonical catalog so call sites know which variables a message accepts.

Adopt a mature message format with plural/select support rather than adding more ad hoc formatter branches. ICU MessageFormat or an equivalent approach should support:

- plural categories;
- select/gender-like grammatical alternatives where actually needed;
- named variables instead of opaque positional indexes;
- locale-aware number/date/time formatting;
- translator-visible descriptions/context.

The selected ParadigmEve locale should be passed explicitly to `Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.RelativeTimeFormat`, and similar formatting APIs so UI language and formatting are coherent.

### 4. Protected-token validation

Message metadata or validation should mark tokens that translations may not alter: `%thread`, `#quilt`, tool/schema identifiers, literal command names, product syntax, provider IDs, and other machine-consumed values.

CI should reject protected-token changes and variable mismatches automatically.

### 5. Extraction and linting across all user-facing surfaces

CI should detect new hard-coded user-facing strings outside an explicit allowlist. The scan should cover renderer, main-process statuses that reach the UI, and Companion/extension UI.

The validator should enforce:

- no missing locale keys for required shipped locales;
- no unexplained unused keys;
- no duplicate canonical ownership for one message;
- valid variables and plural branches;
- consistent protected tokens;
- locale-file syntax/schema;
- stable semantic-key naming.

Generated reports should be understandable enough that a community translator can fix a PR without understanding the app's runtime architecture.

### 6. Translator context and voice live beside the message

Semantic keys alone are not enough. Give translators short context for ambiguous strings: where the text appears, what object it refers to, whether it is a button or explanatory sentence, and which terms are product names.

Keep the cozy/human voice guidance in contributor documentation and, where useful, attach concise translator notes to messages whose literal technical wording would be misleading.

### 7. Shared terminology ownership

Maintain a small current terminology table derived from the product/Vault glossary for terms such as Thread, Quilt, Pin, Plan, Goal, Loop, Worker, Companion, and connection/connector. Each locale should record intentional product terms and approved localized forms.

That terminology source should be current-state documentation, not a history of previous names.

### 8. Community-first workflow

The desired end state is:

1. a contributor copies the canonical catalog template or runs one extraction/update command;
2. the validator shows missing messages and translator context;
3. the contributor translates values without editing application control flow;
4. one focused command validates schema, placeholders/plurals, protected tokens, missing/unused keys, and formatting;
5. preview/testing makes layout and language switching easy to inspect;
6. the PR contains the locale file, any intentional terminology notes, and current manual updates only when behavior itself changed.

That is the standard the later redesign should aim for. The present 2.2.4 system should remain stable until that work is taken on as its own bounded change.
