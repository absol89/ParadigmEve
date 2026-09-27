import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { flushRecorder, recordToolCall, repairDeterministicAttribution, resetRecorderForTests, sessionForConversation } from '../src/main/session/recorder.js';
import { appendEvent, createSession, flushSessions, getSession, indexedSessions, initSessionStore, readEvents, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import type { SessionEvent } from '../src/shared/session.js';

let dir = '';
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const row = (id: string, requestId: string | null, time: number) => ({
  source: 'mcp' as const, kind: 'tool_call' as const, time,
  call: { callId: id, requestId, tool: 'read', attribution: 'unattributed' as const, conversationId: null,
    attributionMethod: 'unattributed' as const, args: { text: '{}', chars: 2, truncated: false },
    result: { text: 'ok', chars: 2, truncated: false }, durationMs: 1, outcome: 'ok' as const,
    summary: { title: id, tone: 'neutral' as const, kind: 'read' as const } }
});
const record = (requestId?: string, text = 'ok') => recordToolCall({
  tool: 'read', args: {}, content: [{ type: 'text', text }], outcome: 'ok', durationMs: 1,
  startedAt: Date.now(), requestId
});
const prove = (requestId: string, sessionId: string) => observeRequestCorrelation({
  requestId, sessionId, conversationId: 'repair-target', messageId: requestId, tool: 'read', observedAt: Date.now()
});
const calls = async (id: string) => (await readEvents(id, { kinds: ['tool_call'] })) as Extract<SessionEvent, { kind: 'tool_call' }>[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-attribution-repair-'));
  initConfigPath(dir); initSessionStore(dir); initDurableStore(dir);
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await flushRecorder(); await flushSessions(); await flushDurable();
  resetRecorderForTests(); resetCorrelationRegistryForTests(); resetSessionStoreForTests();
  unsetSessionRootForTests(); resetDurableForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

it('invalidates a repaired bucket when concurrent replacement preserves its count and timestamp', async () => {
  const bucket = await createSession({ title: 'Unattributed activity' });
  const target = (await sessionForConversation('repair-target'))!;
  const time = Date.now() + 10_000;
  await appendEvent(bucket.id, row('known', 'known', time - 1));
  await appendEvent(bucket.id, row('still-unknown', 'still-unknown', time));
  prove('known', target);
  const entered = gate(); const release = gate();
  const append = fs.appendFile.bind(fs);
  vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
    if (String(args[0]).includes(target) && String(args[0]).endsWith('events.jsonl')) {
      entered.resolve(); await release.promise;
    }
    return append(...args);
  });
  const repairing = repairDeterministicAttribution();
  try {
    await entered.promise;
    await appendEvent(bucket.id, row('concurrent', 'concurrent', time - 2));
  } finally { release.resolve(); }
  await repairing;
  expect((await getSession(bucket.id))?.toolCalls).toBe(2);
  expect((await getSession(bucket.id))?.updatedAt).toBe(time);
  prove('concurrent', target);
  await repairDeterministicAttribution(new Set(['concurrent']));
  expect((await calls(target)).map(event => event.call.callId)).toEqual(['known', 'concurrent']);
  expect((await calls(bucket.id)).map(event => event.call.callId)).toEqual(['still-unknown']);
});

it('does not delete a bucket when every scanned call was repaired but another call arrived during copying', async () => {
  const bucket = await createSession({ title: 'Unattributed activity' });
  const target = (await sessionForConversation('repair-target'))!;
  await appendEvent(bucket.id, row('known', 'known', Date.now()));
  prove('known', target);
  const entered = gate(); const release = gate();
  const append = fs.appendFile.bind(fs);
  vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
    if (String(args[0]).includes(target) && String(args[0]).endsWith('events.jsonl')) {
      entered.resolve(); await release.promise;
    }
    return append(...args);
  });
  const repairing = repairDeterministicAttribution();
  try { await entered.promise; await appendEvent(bucket.id, row('arrived', null, Date.now())); }
  finally { release.resolve(); }
  await repairing;
  expect((await calls(bucket.id)).map(event => event.call.callId)).toEqual(['arrived']);
});

it('retains the writable empty bucket while an admitted call is still preparing its result asset', async () => {
  const target = (await sessionForConversation('repair-target'))!;
  await record('known');
  const bucket = (await indexedSessions()).find(session => session.title === 'Unattributed activity')!;
  prove('known', target);
  const entered = gate(); const release = gate();
  const write = fs.writeFile.bind(fs);
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]).includes(bucket.id) && String(args[0]).includes(`${path.sep}assets${path.sep}`)) {
      entered.resolve(); await release.promise;
    }
    return write(...args);
  });
  const pending = record(undefined, 'large result '.repeat(20_000));
  try {
    await entered.promise;
    await repairDeterministicAttribution();
    expect(await getSession(bucket.id)).not.toBeNull();
    expect(await calls(bucket.id)).toEqual([]);
  } finally { release.resolve(); }
  expect(await pending).not.toBeNull();
  expect(await calls(bucket.id)).toHaveLength(1);
});

it('deletes an empty inactive historical bucket inside the queued rewrite', async () => {
  const bucket = await createSession({ title: 'Unattributed activity' });
  const target = (await sessionForConversation('repair-target'))!;
  await appendEvent(bucket.id, row('known', 'known', Date.now()));
  prove('known', target);
  await repairDeterministicAttribution();
  expect(await getSession(bucket.id)).toBeNull();
  expect(await calls(target)).toHaveLength(1);
});

it('reuses the durable Unattributed bucket after recorder process state is lost', async () => {
  await record();
  await flushRecorder();
  await flushSessions();
  const [first] = (await indexedSessions()).filter(session => session.title === 'Unattributed activity');
  expect(first).toBeDefined();
  expect(await calls(first!.id)).toHaveLength(1);

  // Simulate an app restart without touching the durable session files.
  resetRecorderForTests();
  resetSessionStoreForTests();

  await record();
  await flushRecorder();
  await flushSessions();
  const buckets = (await indexedSessions()).filter(session => session.title === 'Unattributed activity');
  expect(buckets.map(bucket => bucket.id)).toEqual([first!.id]);
  expect(await calls(first!.id)).toHaveLength(2);
});

it('consolidates legacy restart-created diagnostic buckets without reattributing unknown evidence', async () => {
  const older = await createSession({ title: 'Unattributed activity' });
  const olderUnknown = row('older-unknown', null, Date.now() + 1);
  const olderSuperseded = {
    ...row('older-superseded', 'retired-request', Date.now() + 2),
    call: {
      ...row('older-superseded', 'retired-request', Date.now() + 2).call,
      attribution: 'superseded' as const,
      attributionMethod: 'superseded' as const
    }
  };
  await appendEvent(older.id, olderUnknown);
  await appendEvent(older.id, olderSuperseded);

  const newer = await createSession({ title: 'Unattributed activity' });
  await appendEvent(newer.id, row('newer-unknown', null, Date.now() + 10));

  await repairDeterministicAttribution();

  const buckets = (await indexedSessions()).filter(session => session.title === 'Unattributed activity');
  expect(buckets).toHaveLength(1);
  expect(buckets[0]?.id).toBe(newer.id);
  const retained = await calls(newer.id);
  expect(retained.map(event => event.call.callId).sort()).toEqual([
    'newer-unknown',
    'older-superseded',
    'older-unknown'
  ]);
  expect(retained.find(event => event.call.callId === 'older-superseded')?.call.attributionMethod).toBe('superseded');
  expect(retained.every(event => event.call.conversationId === null)).toBe(true);
});

it('caps cached request identities across buckets rather than allowing 50,000 per bucket', async () => {
  const buckets = await Promise.all([0, 1].map(async bucketIndex => {
    const bucket = await createSession({ title: 'Unattributed activity' });
    const rows = Array.from({ length: 25_001 }, (_, i) => ({ ...row(`${bucketIndex}-${i}`, `${bucketIndex}-${i}`, bucket.startedAt), seq: i + 1 }));
    await fs.writeFile(path.join(dir, 'sessions', bucket.id, 'events.jsonl'), rows.map(event => JSON.stringify(event)).join('\n') + '\n');
    return bucket;
  }));
  await flushSessions(); resetSessionStoreForTests();
  await repairDeterministicAttribution();
  const read = vi.spyOn(fs, 'readFile');
  await repairDeterministicAttribution(new Set(['unrelated-new-request']));
  const reread = read.mock.calls.filter(([file]) => buckets.some(bucket => String(file) === path.join(dir, 'sessions', bucket.id, 'events.jsonl')));
  // At least one bucket was evicted to maintain the aggregate bound and is reconstructed.
  expect(reread.length).toBeGreaterThan(0);
});
