/**
 * Localized aliases for the shipped starter references.
 *
 * `%how`, `%expenses`, `%organize` and `#plans` are stored under their English names, because
 * the starter Threads are app-owned and Eve's standing prompts name them that way. A person who
 * writes in Swedish or Spanish should be able to type `%utgifter` or `#planes` and reach the same
 * context, and see the localized name in the app. Aliases are accepted in every language, so a
 * Swedish alias works from an English UI too.
 *
 * Aliases only ever route to a canonical name. A real Thread or Quilt the user created with the
 * same name as an alias always wins; resolution tries the exact name first.
 */
export type ReferenceAliasLanguage = 'en' | 'sv-SE' | 'es-419';
export type ReferenceDisplayLanguage = Exclude<ReferenceAliasLanguage, 'en'>;

interface ReferenceAliasEntry {
  /** The stored starter name, lower case and without a sigil. */
  readonly canonical: string;
  /** Other accepted spellings, including singular and plural forms. */
  readonly aliases: Readonly<Partial<Record<ReferenceAliasLanguage, readonly string[]>>>;
  /** The name shown in the app when the UI language is not English. */
  readonly display: Readonly<Record<ReferenceDisplayLanguage, string>>;
}

export const REFERENCE_ALIASES: readonly ReferenceAliasEntry[] = [
  {
    canonical: 'how',
    aliases: { 'sv-SE': ['hur'], 'es-419': ['como', 'cómo'] },
    display: { 'sv-SE': 'hur', 'es-419': 'cómo' }
  },
  {
    canonical: 'expenses',
    aliases: { en: ['expense'], 'sv-SE': ['utgifter', 'utgift'], 'es-419': ['gastos', 'gasto'] },
    display: { 'sv-SE': 'utgifter', 'es-419': 'gastos' }
  },
  {
    canonical: 'organize',
    aliases: { en: ['organise'], 'sv-SE': ['organisera'], 'es-419': ['organizar', 'organiza'] },
    display: { 'sv-SE': 'organisera', 'es-419': 'organizar' }
  },
  {
    // The Schedule workspace's chat shortcuts. `#schedule` is the base: `#schedules`, `#schema`,
    // `#scheman`, `#agenda` and `#agendas` all mean it, as `%schedule` already names the availability Thread.
    canonical: 'schedule',
    aliases: { en: ['schedules'], 'sv-SE': ['schema', 'scheman'], 'es-419': ['agenda', 'agendas'] },
    display: { 'sv-SE': 'schema', 'es-419': 'agenda' }
  },
  {
    canonical: 'myweek',
    aliases: { en: ['my-week'], 'sv-SE': ['minvecka', 'min-vecka'], 'es-419': ['mi-semana', 'misemana'] },
    display: { 'sv-SE': 'minvecka', 'es-419': 'mi-semana' }
  },
  {
    canonical: 'routines',
    aliases: { en: ['routine'], 'sv-SE': ['rutiner', 'rutin'], 'es-419': ['rutinas', 'rutina'] },
    display: { 'sv-SE': 'rutiner', 'es-419': 'rutinas' }
  },
  {
    // `plan`, `plans`, `planer`, `planen` and `planes` all mean the one Plans Thread / #plans Concept.
    canonical: 'plans',
    aliases: { en: ['plan'], 'sv-SE': ['plan', 'planer', 'planen'], 'es-419': ['plan', 'planes'] },
    display: { 'sv-SE': 'planer', 'es-419': 'planes' }
  }
];

/**
 * The Schedule workspace's chat shortcuts. They need no saved Quilt to mean something: Eve's instructions
 * define them, so a localized spelling of one is explained to Eve even when no Quilt exists.
 */
export const SCHEDULE_SHORTCUT_REFERENCES: readonly string[] = ['#schedule', '#myweek', '#routines'];

/**
 * Words that mark nearby text as being about Pins vocabulary, in every language. A reference that
 * did not resolve is only reported to Eve when it sits next to one of these (or names a real
 * same-name Thread), so ordinary hashtags stay ordinary.
 */
export const PRODUCT_REFERENCE_WORDS: readonly string[] = [
  'pin', 'pins', 'pinned', 'thread', 'threads', 'quilt', 'quilts', 'concept', 'concepts', 'hotlink', 'hotlinks',
  // Swedish
  'tråd', 'trådar', 'tråden', 'koncept', 'konceptet', 'fäst', 'fästa',
  // Spanish
  'hilo', 'hilos', 'concepto', 'conceptos', 'fijar', 'fijado', 'fijados'
];

const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase();

const canonicalByAlias: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const entry of REFERENCE_ALIASES) {
    for (const names of Object.values(entry.aliases)) {
      for (const name of names ?? []) map.set(normalize(name), entry.canonical);
    }
  }
  return map;
})();

const languagesByAlias: ReadonlyMap<string, ReadonlySet<ReferenceAliasLanguage>> = (() => {
  const map = new Map<string, Set<ReferenceAliasLanguage>>();
  for (const entry of REFERENCE_ALIASES) {
    for (const [language, names] of Object.entries(entry.aliases) as Array<[ReferenceAliasLanguage, readonly string[]]>) {
      for (const name of names) {
        const key = normalize(name);
        map.set(key, (map.get(key) ?? new Set()).add(language));
      }
    }
  }
  return map;
})();

export const REFERENCE_LANGUAGE_NAMES: Readonly<Record<ReferenceDisplayLanguage, string>> = {
  'sv-SE': 'Swedish',
  'es-419': 'Latin American Spanish'
};

/**
 * The one non-English language a spelling belongs to: `utgifter` is Swedish, `cómo` is Spanish.
 * Null when it is not an alias, or when several languages share it (`plan` is English, Swedish and
 * Spanish), because then the spelling says nothing about the language the person is writing in.
 */
export function referenceAliasLanguage(reference: string): ReferenceDisplayLanguage | null {
  const sigil = reference[0];
  if (sigil !== '%' && sigil !== '#') return null;
  const body = reference.slice(1);
  const languages = languagesByAlias.get(normalize(sigil === '%' && body.endsWith('%') ? body.slice(0, -1) : body));
  if (!languages || languages.size !== 1) return null;
  const [only] = languages;
  return only === 'sv-SE' || only === 'es-419' ? only : null;
}

/** `utgifter` becomes `expenses`. Returns null for a canonical name or one that is not an alias. */
export function canonicalReferenceName(name: string): string | null {
  const key = normalize(name);
  const canonical = canonicalByAlias.get(key);
  return canonical && canonical !== key ? canonical : null;
}

/** `%utgifter` becomes `%expenses` and `#planer` becomes `#plans`. Null when there is nothing to route. */
export function canonicalReference(reference: string): string | null {
  const sigil = reference[0];
  if (sigil !== '%' && sigil !== '#') return null;
  const body = reference.slice(1);
  const trailing = sigil === '%' && body.endsWith('%') ? '%' : '';
  const canonical = canonicalReferenceName(trailing ? body.slice(0, -1) : body);
  return canonical ? `${sigil}${canonical}${trailing}` : null;
}

/** The name to show for a stored starter name: `expenses` is `utgifter` in Swedish. */
export function localizedReferenceName(name: string, language: string): string {
  if (language !== 'sv-SE' && language !== 'es-419') return name;
  const key = normalize(name);
  const entry = REFERENCE_ALIASES.find(row => row.canonical === key);
  return entry ? entry.display[language] : name;
}

/** Matches Pins vocabulary in any supported language, as a whole word. */
export const PRODUCT_REFERENCE_WORD_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${PRODUCT_REFERENCE_WORDS.join('|')})(?![\\p{L}\\p{N}])`,
  'iu'
);
