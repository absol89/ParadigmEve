import { expect, it } from 'vitest';
import { redactCredentialText } from '../src/main/redaction.js';
import { pluginManager } from '../src/main/plugins/manager.js';

it('masks recognizable provider secrets without erasing ordinary hashes and identifiers', () => {
  const credentials = [
    'sk-ant-api03-' + 'A'.repeat(45),
    'github_pat_' + 'B'.repeat(35),
    'ghp_' + 'C'.repeat(36),
    'AKIA' + 'D'.repeat(16),
    'AIza' + 'E'.repeat(35),
    'xoxb-' + 'F'.repeat(30),
    'eyJ' + 'G'.repeat(25) + '.eyJ' + 'H'.repeat(25) + '.' + 'I'.repeat(30),
    'Bearer ' + 'J'.repeat(40),
    '-----BEGIN PRIVATE KEY-----\n' + 'K'.repeat(60) + '\n-----END PRIVATE KEY-----',
  ];
  for (const value of credentials) expect(redactCredentialText('before ' + value + ' after')).not.toContain(value);
  const sha256 = 'a6'.repeat(32);
  const opaqueId = 'candidate_' + 'L'.repeat(48);
  expect(redactCredentialText(sha256 + '\n' + opaqueId)).toBe(sha256 + '\n' + opaqueId);
});

it('redacts Core-compatible text and structured results but leaves image bytes and the input intact', () => {
  const secret = 'github_pat_' + 'Q'.repeat(35);
  const input = {
    content: [
      { type: 'text' as const, text: 'token: ' + secret },
      { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
    ],
    structuredContent: { output: secret, nested: [{ value: 'Bearer ' + 'Z'.repeat(40) }], exit_code: 0 },
  };
  const projected = pluginManager.redactResult(input);
  expect(JSON.stringify(projected)).not.toContain(secret);
  expect(JSON.stringify(projected)).not.toContain('Z'.repeat(40));
  expect(projected.content[1]).toEqual(input.content[1]);
  expect(projected.structuredContent).toMatchObject({ exit_code: 0 });
  expect(input.structuredContent.output).toBe(secret);
});
