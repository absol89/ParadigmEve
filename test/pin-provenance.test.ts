import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createPin, createQuilt, pinsLibrary } from '../src/main/pins.js';
import { authoredMessageConversationId } from '../src/renderer/pin-provenance.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-pin-provenance-'));
  resetDurableForTests();
  initDurableStore(directory);
});

afterEach(async () => {
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('links an authored message only while the session has one proven conversation', () => {
  expect(authoredMessageConversationId({ conversationId: 'conversation-a', chatIds: ['conversation-a'] }))
    .toBe('conversation-a');
  expect(authoredMessageConversationId({ conversationId: 'conversation-b', chatIds: ['conversation-a', 'conversation-b'] }))
    .toBeNull();
  expect(authoredMessageConversationId({ conversationId: 'conversation-b', chatIds: ['conversation-a'] }))
    .toBeNull();
  expect(authoredMessageConversationId({ conversationId: null, chatIds: [] }))
    .toBeNull();
});

it('never persists current chat B as the source of an old authored message from resumed chat A', async () => {
  const quilt = await createQuilt({ title: 'Historical source proof', collectionIds: [] });
  const conversationId = authoredMessageConversationId({
    conversationId: 'conversation-b',
    chatIds: ['conversation-a', 'conversation-b']
  });
  expect(conversationId).toBeNull();

  const created = await createPin({
    kind: 'message',
    target: { mode: 'existing', quiltId: quilt.id },
    title: 'Old answer from chat A',
    provenance: {
      sessionId: 'session-resumed-1',
      conversationId,
      eventSeq: 7,
      messageId: 'message-a-7'
    }
  });
  expect(created.pin.kind).toBe('message');
  if (created.pin.kind !== 'message') throw new Error('expected message Pin');
  expect(created.pin.provenance.conversationId).toBeNull();

  resetDurableForTests();
  initDurableStore(directory);
  const restored = await pinsLibrary();
  expect(restored.pins[0]!.kind).toBe('message');
  if (restored.pins[0]!.kind !== 'message') throw new Error('expected message Pin');
  expect(restored.pins[0]!.provenance.conversationId).toBeNull();
});
