import { expect, it } from 'vitest';
import { authoredPinsReferences } from '../src/shared/pins-intent.js';
import { prependUserPrompt } from '../src/shared/user-prompt.js';

it('classifies canonical #Quilt and %Thread syntax without assigning creation semantics', () => {
  expect(authoredPinsReferences('Use #Eve with %Architecture, then continue.')).toEqual([
    { kind: 'quilt', reference: '#Eve' },
    { kind: 'thread', reference: '%Architecture' }
  ]);
  // Unknown product-shaped syntax is still only an inert reference. Resolution decides later
  // whether it names durable state; this classifier never creates or routes anything itself.
  expect(authoredPinsReferences('Explain #typescript generics.')).toEqual([
    { kind: 'quilt', reference: '#typescript' }
  ]);
});

it('reads only the authored part of an app transport frame', () => {
  const framed = prependUserPrompt('Use #Eve and %How for this request.', 'Hidden setup mentions #Internal and %Bootstrap.');
  expect(authoredPinsReferences(framed)).toEqual([
    { kind: 'quilt', reference: '#Eve' },
    { kind: 'thread', reference: '%How' }
  ]);
});

it.each(['HANDOFF', 'RESUME'] as const)('does not interpret %s continuation payloads as product syntax', (mode) => {
  const payload = `[[CLF-${mode}:token_0123456789abcdef]]\n\nContinue prior text containing #Eve and %How.`;
  expect(authoredPinsReferences(payload)).toEqual([]);
  expect(authoredPinsReferences(prependUserPrompt(payload, 'Setup #Internal'))).toEqual([]);
});

it('ignores URL fragments and percent-encoded URL text', () => {
  for (const text of [
    'Open https://example.test/docs#Architecture and summarize it.',
    'Open https://example.test/%20file.txt',
    'Search https://example.test/?q=%20',
    'Compare www.example.test/page#Eve with the homepage.'
  ]) expect(authoredPinsReferences(text)).toEqual([]);
});

it('ignores quoted, code, blockquote and pasted-log examples while retaining preceding prose intent', () => {
  for (const text of [
    'Example: "use #Eve with %How"',
    "Example: 'use #Eve with %How'",
    'Example: `#Eve %How`',
    '> copied example #Eve %How',
    '```text\n#Eve %How\n```',
    'Logs:\nINFO #Eve\nWARN %How',
    '2026-09-17 12:00:00 INFO #Eve should not route'
  ]) expect(authoredPinsReferences(text)).toEqual([]);

  expect(authoredPinsReferences('Use #Eve for this request.\nLogs:\nINFO %How')).toEqual([
    { kind: 'quilt', reference: '#Eve' }
  ]);
});
