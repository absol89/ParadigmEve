# 16 — Languages, localization and aliases

Back to [vault index](README.md).

ParadigmEve ships in three languages: **English**, **Svenska** (`sv-SE`) and **Español (Latinoamérica)**
(`es-419`). This page explains who owns each piece of text, how a string reaches the screen, how the
agent's own name is applied, how the browser setup guide is localized, and how localized spellings of the
built-in `%`/`#` names reach the same context as the English ones.

## Authority and projections

| Fact | Authority | Projections |
| --- | --- | --- |
| App language | The user's choice in **Settings → Setup** or **Settings → Appearance → Language**, stored as `cos.ui.language` in the renderer | `document.documentElement.lang`, both language selectors and flags, every bound label |
| Text of a language | `src/renderer/locales/sv-SE.json` and `src/renderer/locales/es-419.json`, **keyed by the exact English source string** | The renderer, the setup guide's embedded tables, tests |
| The agent's name | `config.mcp.connectorName` (default `Eve`) | Every catalog string through `setAgentName()` |
| What a starter is called | The stored Thread title (`how`, `expenses`, `organize`, `plans`) | Localized aliases and display names from `src/shared/reference-aliases.ts` |

English is not a catalog: it is the source text in code. A language file maps an English string to its
translation, so the key must match the source exactly (punctuation, `’` versus `'`, leading and trailing
spaces). `t(source, args)` looks the key up, falls back to the English source when it is missing, then
fills `{0}`, `{1}` placeholders with the arguments. Arguments are authored content and are never
translated or rewritten.

## Adding or changing text

1. Write the English once, at the call site or in `index.html`.
2. Add the same key to **both** `sv-SE.json` and `es-419.json`. Keep the placeholder set identical;
   `test/renderer-i18n.test.ts` fails on a missing static label, a Spanish key that Swedish does not
   have, an empty translation, or a placeholder mismatch.
3. Prefer one string with a placeholder over concatenation. Plural and singular are separate keys.
4. Text built in the main process with a name baked in must be looked up as a template: use `tNamed()`
   in the renderer or `templateWithName()` (`src/shared/name-template.ts`) in the main process. They
   replace only whole-word matches, so the default name `Eve` is not found inside `ParadigmEve`.
5. Third-party UI labels the user must find on OpenAI, ChatGPT or Chrome pages (`Create Tunnel`,
   `Developer mode`, `Allow all actions`, `Load unpacked`) stay in English in the setup guide so they
   match what those pages show.

## The agent's name

The catalogs are written for the default agent name, `Eve`. When `config.mcp.connectorName` differs,
`withAgent()` in `src/renderer/i18n.ts` rewrites catalog text before arguments go in:

- English `Eve's` / `Eve’s` becomes `Eva's` (`Chris’` after a name ending in `s`).
- Swedish `Eves` becomes `Evas` (no extra `s` after `s`, `x` or `z`).
- Spanish sentences already say `de Eve`, so only the bare name changes.
- `Eve Browser`, `Eve browser` and `Eve Plugins` are product names and never change; `ParadigmEve` is
  untouched because matching is by whole word.

Changing the name rebinds the whole interface at once. The connector card, its summary and its
pasteable description are looked up through the same name template, so a differently named agent still
gets a translated card.

## The setup guide

The localhost guide opened by **Setup → Start guided browser setup** is a static page rendered by
`src/main/setup-assistant.ts`. Its text is not a second translation: `src/main/setup-guide-i18n.ts`
lists the English text the page shows and looks each entry up in the same catalogs (`{0}` is the browser
label, `{1}` the app name). The page embeds the resulting tables and translates its own text nodes in
the browser.

- The guide opens in the language Eve is set to; Setup passes it through `setup:start`.
- A header dropdown switches between English, Svenska and Español without changing any step logic. All
  six steps stay clickable previews, and runtime messages (copied, saved, errors) follow the language.
- The header shows Eve's coffee cup, inlined as a `data:` image (the page's policy allows `img-src data:`
  and nothing remote) and used as the favicon. The wordmark reads `ParadigmEve · Guided setup`.
- The connector **description** the user pastes into ChatGPT is translated too. The canonical English
  description lives in `src/main/mcp/surfaces.ts`; the catalogs hold it with the name as `{0}`.
- The guide's own choice does not persist across runs, because the guide is served from a different
  random port each time. The next run opens in Eve's language again.

## The startup splash

The boot splash (`src/main/startup-splash.ts`) is drawn before the renderer exists, from a script-free
`data:` document, so it cannot read the renderer's `cos.ui.language`. The renderer reports every language
change, and once at startup, through `ui:setLanguage`; the main process keeps it in one small
`ui-language.txt` in the user data folder (`src/main/ui-language.ts`) and reads it synchronously when it
opens the splash. A missing or unreadable file means English. The greeting uses the same catalog keys as the
rest of the app (`Welcome back`, `Keeping things {0} for you…`, `warm`), so it changes language with them.
The layout is Eve's portrait on the left and the coffee cup, wordmark and greeting on the right; both
images are inlined, and its policy allows only `data:` images.

## Localized aliases for built-in `%`/`#` names

The shipped starters are stored in English because Eve's prompts name them that way. The shared resolver
also accepts localized spellings, in any UI language, and routes them to the stored name:

| Typed | Reaches |
| --- | --- |
| `%utgifter`, `%gastos`, `%expense` | `%expenses` |
| `%hur`, `%como`, `%cómo` | `%how` |
| `%organisera`, `%organizar`, `%organiza`, `%organise` | `%organize` |
| `plan`, `plans`, `planer`, `planen`, `planes` after `%` or `#` | the Plans Thread (`%`) or the `#plans` Concept (`#`) |
| `#schedule`, `#schedules`, `#schema`, `#scheman`, `#agenda`, `#agendas` | the Schedule shortcut `#schedule` (the base name) |
| `#myweek`, `#minvecka`, `#mi-semana` | `#myweek` |
| `#routines`, `#routine`, `#rutiner`, `#rutinas` | `#routines` |

Rules:

- An exact durable name always wins. A real Thread or Quilt the user named `utgifter` shadows the alias.
- Routing lives in `resolvePinsReference()` and `selectPinsContext()` (`src/shared/pins-context.ts`), so
  context injection, the Expenses project binding and in-chat reference links agree. `#utgifter` stays
  data-only exactly like `#expenses`.
- A routed alias adds a `# Eve localized reference aliases` block to the context Eve receives, naming each
  spelling and its canonical reference.
- **Reply language.** When a spelling belongs to exactly one non-English language (`utgifter` is Swedish,
  `gastos` is Spanish), the block tells Eve: if the rest of the user's message is also written in that
  language, answer in it; if the message is in another language, answer in that language instead. A
  spelling shared by several languages (`plan`) carries no language instruction, and a message with no
  alias gets none either. Never force a language on a message written in another one, and keep tool
  calls, Thread names and file paths in their canonical form.
- The three Schedule shortcuts need no saved Quilt. The Schedule screen's "Chat about" chips put the localized
  spelling (`#agenda`, `#mi-semana`, `#rutinas`) into the chat box; when such a spelling reaches Eve with no Quilt behind
  it, the context block still explains it as the Schedule shortcut and applies the reply-language rule, instead of
  reporting a missing Quilt.
- The Pins screen shows the starters under their localized names in Swedish and Spanish (`%utgifter`,
  `#planes`); the stored title does not change.
- An unresolved `#name` is reported to Eve only when Pins vocabulary sits nearby. The vocabulary list is
  English, Swedish and Spanish (thread, tråd, hilo, concept, koncept, concepto, quilt, pin, and so on).

The object formerly called a Hotlink is now an **Instruction** (`%Instruction`, Swedish `%Instruktion`,
Spanish `%Instrucción`): a Thread with a prompt and no Pins. Only the user-facing name changed.

## Pets

A pet's display name can be changed by the user (**Rename** in the pet's menu). The override is stored
in the pet library state, never in the package, and **Reset** restores the package's own name. Pets can
ship per-language `descriptions` in `pet.json`; the card shows the one for the current language and falls
back to the English `description`. See [15 — Desktop pets and avatars](15-desktop-pets-and-avatars.md).

## Static archive site

The generated `archive/site/index.html` chooses Swedish labels from the browser's language list and is
otherwise English; it does not read the app language and has no Spanish yet. Its sidebar search hides
non-matching chats with the `hidden` attribute, so the `.chat-link[hidden]` rule must stay in the
generated CSS or the filter silently stops working.

## Evidence when a translation looks wrong

1. Find the English source string in code and its key in the language file. A missing key falls back to
   English, which is the usual cause of one untranslated line.
2. If the string has a name or count baked in by the main process, look for a `{0}` template instead
   of the literal text.
3. Check that `es-419.json` has exactly the keys of `sv-SE.json` and the same placeholders.
4. Restart the app: the main process bundles the catalogs at build time.
