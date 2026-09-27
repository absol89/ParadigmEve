import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTINUATION_MARKER } from '../src/shared/session.js';

const TOKEN = '9TrLcrd37Lf7b64FZMJ9MQ';

describe('Compact & Resume marker', () => {
  it('accepts the plain marker and the escaped-Markdown hard break a fresh-chat composer sends', () => {
    for (const text of [
      `[[CLF-RESUME:${TOKEN}]]\n\nContinuing a ParadigmEve session.`,
      // Live 2026-09-27: the replacement chat's bootstrap arrived with `\` hard breaks.
      `[[CLF-RESUME:${TOKEN}]]\\\n\\\nContinuing a ParadigmEve session.`,
      `[[CLF-HANDOFF:${TOKEN}]]`
    ]) {
      expect(CONTINUATION_MARKER.exec(text)?.slice(1)).toEqual([text.includes('HANDOFF') ? 'HANDOFF' : 'RESUME', TOKEN]);
    }
  });

  it('still refuses a marker glued to other text', () => {
    expect(CONTINUATION_MARKER.exec(`[[CLF-RESUME:${TOKEN}]]x`)).toBeNull();
    expect(CONTINUATION_MARKER.exec(`[[CLF-RESUME:${TOKEN}]]\\x`)).toBeNull();
  });

  it('is mirrored exactly by the Companion, which cannot import it', () => {
    const content = readFileSync('extension/content.js', 'utf8');
    expect(content).toContain(`const CONTINUATION_MARKER = ${CONTINUATION_MARKER.toString()};`);
  });
});
