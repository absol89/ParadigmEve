import { afterEach, beforeEach, expect, it } from 'vitest';
import { flushSessions, initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests, upsertMessageEvent, createSession, writeAsset } from '../src/main/session/store.js';
import { findInSession } from '../src/main/session/find.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir = '';
beforeEach(async () => { dir = await makeTempDir('eve-find-'); initSessionStore(dir); });
afterEach(async () => { await flushSessions(); resetSessionStoreForTests(); unsetSessionRootForTests(); await removeTempDir(dir); });

const stored = (text: string) => ({ text, truncated: false, chars: text.length });

// Find in chat (ported from Chat On Steroids 2.1.37): every message holding the phrase, in the order
// they were said, from the whole recording rather than the page the window happens to hold.
it('finds every message of one chat that holds a phrase, in order, ignoring case and spacing', async () => {
  const { id } = await createSession({ title: 'Release planning' });
  const said: Array<['user_message' | 'assistant_message', string]> = [
    ['user_message', 'Check the Windows installer'],
    ['assistant_message', 'The windows   INSTALLER builds; the bridge is next.'],
    ['user_message', 'And the installer for macOS?'],
    ['assistant_message', 'Both installers are signed.']
  ];
  for (const [index, [kind, text]] of said.entries()) {
    await upsertMessageEvent(id, { time: Date.now() + index, source: 'extension', kind, messageId: `m${index}`, message: stored(text), ...(kind === 'assistant_message' ? { final: true, state: 'final' as const } : {}) } as any);
  }
  const found = await findInSession(id, 'windows installer');
  expect(found.map((match) => match.messageId)).toEqual(['m0', 'm1']);
  expect(found.map((match) => match.kind)).toEqual(['user_message', 'assistant_message']);
  expect((await findInSession(id, 'installer')).map((match) => match.messageId)).toEqual(['m0', 'm1', 'm2', 'm3']);
  expect(await findInSession(id, '   ')).toEqual([]);
  expect(await findInSession(id, 'linux')).toEqual([]);
});

it('searches the full overflow text of a long message, not only its stored preview', async () => {
  const { id } = await createSession({ title: 'Long answer' });
  const full = `${'filler '.repeat(2000)}the needle is here`;
  const assetId = (await writeAsset(id, Buffer.from(full, 'utf8'), 'text/plain')).id;
  await upsertMessageEvent(id, { time: Date.now(), source: 'extension', kind: 'assistant_message', messageId: 'long', final: true, state: 'final', message: { text: full.slice(0, 200), truncated: true, chars: full.length, assetId } } as any);
  expect((await findInSession(id, 'needle is here')).map((match) => match.messageId)).toEqual(['long']);
});
