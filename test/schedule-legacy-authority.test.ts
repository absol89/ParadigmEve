import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eveCronWorkAuthorityMatches, eveCronWorkPayloadHash } from '../src/main/schedule.js';

const base = { target: { kind: 'installation-agent' } as const, text: 'Prepare my brief.', automation: 'off' as const };
const authority = (payloadHash: string) => ({ kind: 'ui-user' as const, changeId: 'c', authorizedAt: 1, payloadHash });
const legacyHash = (text: string): string =>
  createHash('sha256').update(JSON.stringify({ target: base.target, text, automation: 'off', objective: null, projectId: null }), 'utf8').digest('hex');

describe('schedule work authority', () => {
  it('accepts the pre-2.3.4 digest for work without context', () => {
    expect(eveCronWorkAuthorityMatches({ ...base, authority: authority(legacyHash(base.text)) })).toBe(true);
  });

  it('accepts the current digest', () => {
    expect(eveCronWorkAuthorityMatches({ ...base, authority: authority(eveCronWorkPayloadHash(base)) })).toBe(true);
  });

  it('rejects a legacy digest when the text was changed', () => {
    expect(eveCronWorkAuthorityMatches({ ...base, text: 'Something else', authority: authority(legacyHash(base.text)) })).toBe(false);
  });
});
