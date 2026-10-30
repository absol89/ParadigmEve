import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createSession,
  flushSessions,
  getSession,
  initSessionStore,
  resetSessionStoreForTests,
  setSessionComposerPreference,
  unsetSessionRootForTests
} from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir = '';

beforeEach(async () => {
  dir = await makeTempDir('eve-composer-pref-');
  initSessionStore(dir);
});

afterEach(async () => {
  await flushSessions();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  await removeTempDir(dir);
});

it('persists independent Prime and Twin composer choices across store restart', async () => {
  const prime = await createSession({ conversationId: 'prime-chat-1234', title: 'Prime' });
  const twin = await createSession({ conversationId: 'twin-chat-1234', title: 'Twin' });

  await setSessionComposerPreference(prime.id, '5.6', 'medium', 100);
  await setSessionComposerPreference(twin.id, 'gpt-6', 'high', 101);

  await flushSessions();
  resetSessionStoreForTests();
  initSessionStore(dir);

  expect((await getSession(prime.id))?.composerPreference).toEqual({
    model: '5.6', reasoningEffort: 'medium', selectedAt: 100
  });
  expect((await getSession(twin.id))?.composerPreference).toEqual({
    model: 'gpt-6', reasoningEffort: 'high', selectedAt: 101
  });
});
