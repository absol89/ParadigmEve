import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  appendEvent,
  bindSessionProject,
  createSession,
  initSessionStore,
  onSessionProjectionCommit,
  renameSession,
  resetSessionStoreForTests,
  setSessionOrigin,
  upsertMessageEvent
} from '../src/main/session/store.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-archive-projection-'));
  initSessionStore(directory);
});

afterEach(async () => {
  resetSessionStoreForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('notifies archive projections only after durable source mutations that changed canonical state', async () => {
  const commits: string[] = [];
  const stop = onSessionProjectionCommit((sessionId) => commits.push(sessionId));
  const session = await createSession({ title: 'Archive source' });
  expect(commits).toEqual([session.id]);

  await appendEvent(session.id, {
    time: 100,
    source: 'app',
    kind: 'note',
    message: { text: 'durable note', chars: 12, truncated: false }
  });
  expect(commits).toEqual([session.id, session.id]);

  const message = {
    time: 200,
    source: 'extension' as const,
    kind: 'assistant_message' as const,
    messageId: 'assistant-projection-test',
    message: { text: 'done', chars: 4, truncated: false },
    state: 'final' as const,
    final: true
  };
  expect((await upsertMessageEvent(session.id, message)).changed).toBe(true);
  expect(commits).toHaveLength(3);
  expect((await upsertMessageEvent(session.id, message)).changed).toBe(false);
  expect(commits).toHaveLength(3);

  await renameSession(session.id, 'Renamed archive source');
  expect(commits).toEqual([session.id, session.id, session.id, session.id]);
  await bindSessionProject(session.id, '11111111-1111-4111-8111-111111111111');
  expect(commits).toHaveLength(5);
  await setSessionOrigin(
    session.id,
    { kind: 'helper', fromSessionId: null, agentId: null, task: '' },
    'Helper archive source'
  );
  expect(commits).toHaveLength(6);
  stop();
  await appendEvent(session.id, {
    time: 300,
    source: 'app',
    kind: 'note',
    message: { text: 'after unsubscribe', chars: 17, truncated: false }
  });
  expect(commits).toHaveLength(6);
});
