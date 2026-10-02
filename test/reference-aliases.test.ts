import { expect, it } from 'vitest';
import {
  referenceAliasLanguage,
  canonicalReference,
  localizedReferenceName,
  PRODUCT_REFERENCE_WORD_PATTERN
} from '../src/shared/reference-aliases.js';

it('routes localized spellings of the shipped starters to their canonical reference', () => {
  expect(canonicalReference('%utgifter')).toBe('%expenses');
  expect(canonicalReference('%gastos')).toBe('%expenses');
  expect(canonicalReference('%Utgift')).toBe('%expenses');
  expect(canonicalReference('%hur')).toBe('%how');
  expect(canonicalReference('%cómo')).toBe('%how');
  expect(canonicalReference('%organisera')).toBe('%organize');
  expect(canonicalReference('%organizar')).toBe('%organize');
  // plan, plans, planer, planen and planes are one reference, for a Thread and for a Concept.
  for (const form of ['plan', 'planer', 'planen', 'planes', 'PLANER']) {
    expect(canonicalReference(`%${form}`), form).toBe('%plans');
    expect(canonicalReference(`#${form}`), form).toBe('#plans');
  }
  // Canonical names, unknown names and non-references are left alone.
  expect(canonicalReference('%expenses')).toBeNull();
  expect(canonicalReference('#plans')).toBeNull();
  expect(canonicalReference('%appdata%')).toBeNull();
  expect(canonicalReference('%vacation')).toBeNull();
  expect(canonicalReference('utgifter')).toBeNull();
});

it('knows which language a spelling belongs to, and abstains when several share it', () => {
  expect(referenceAliasLanguage('%utgifter')).toBe('sv-SE');
  expect(referenceAliasLanguage('#planer')).toBe('sv-SE');
  expect(referenceAliasLanguage('%hur')).toBe('sv-SE');
  expect(referenceAliasLanguage('%cómo')).toBe('es-419');
  expect(referenceAliasLanguage('%gastos')).toBe('es-419');
  expect(referenceAliasLanguage('#planes')).toBe('es-419');
  expect(referenceAliasLanguage('%organizar')).toBe('es-419');
  // `plan` is English, Swedish and Spanish at once, and canonical or unknown names are not aliases.
  expect(referenceAliasLanguage('%plan')).toBeNull();
  expect(referenceAliasLanguage('%expense')).toBeNull();
  expect(referenceAliasLanguage('%expenses')).toBeNull();
  expect(referenceAliasLanguage('%vacation')).toBeNull();
});

it('shows a starter under its localized name only when the app is not in English', () => {
  expect(localizedReferenceName('expenses', 'sv-SE')).toBe('utgifter');
  expect(localizedReferenceName('Plans', 'es-419')).toBe('planes');
  expect(localizedReferenceName('how', 'es-419')).toBe('cómo');
  expect(localizedReferenceName('organize', 'sv-SE')).toBe('organisera');
  expect(localizedReferenceName('expenses', 'en')).toBe('expenses');
  expect(localizedReferenceName('vacation', 'sv-SE')).toBe('vacation');
});

it('recognizes Pins vocabulary in every supported language as whole words', () => {
  for (const word of ['thread', 'Threads', 'concept', 'Concepts', 'tråd', 'trådar', 'koncept', 'hilo', 'hilos', 'concepto', 'conceptos', 'quilt']) {
    expect(PRODUCT_REFERENCE_WORD_PATTERN.test(`make a ${word} for this`), word).toBe(true);
  }
  expect(PRODUCT_REFERENCE_WORD_PATTERN.test('a spreadsheet of conceptual hilosa pinnacle')).toBe(false);
});

it('routes the Schedule shortcuts, singular and plural, to their base names in every language', () => {
  for (const form of ['schedules', 'schema', 'scheman', 'agenda', 'agendas', 'SCHEMAN']) {
    expect(canonicalReference(`#${form}`), form).toBe('#schedule');
  }
  expect(canonicalReference('#schedule')).toBeNull();
  for (const form of ['my-week', 'minvecka', 'min-vecka', 'mi-semana', 'misemana']) expect(canonicalReference(`#${form}`), form).toBe('#myweek');
  for (const form of ['routine', 'rutin', 'rutiner', 'rutina', 'rutinas']) expect(canonicalReference(`#${form}`), form).toBe('#routines');
  expect(canonicalReference('#myweek')).toBeNull();
  expect(canonicalReference('#routines')).toBeNull();
  // The spelling says which language it is, except the English plural.
  expect(referenceAliasLanguage('#scheman')).toBe('sv-SE');
  expect(referenceAliasLanguage('#agendas')).toBe('es-419');
  expect(referenceAliasLanguage('#mi-semana')).toBe('es-419');
  expect(referenceAliasLanguage('#schedules')).toBeNull();
  // The chips show the base name in each language.
  expect(localizedReferenceName('schedule', 'sv-SE')).toBe('schema');
  expect(localizedReferenceName('schedule', 'es-419')).toBe('agenda');
  expect(localizedReferenceName('myweek', 'sv-SE')).toBe('minvecka');
  expect(localizedReferenceName('routines', 'es-419')).toBe('rutinas');
});
