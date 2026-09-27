import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import {
  AGENT_IDENTITY_STATE,
  claimAgentConversation,
  clearAgentConversation,
  currentAgentConversationId,
  replaceAgentConversation,
  resetAgentIdentityForTests,
  restoreAgentIdentity,
  snapshotAgentIdentity,
  transferAgentConversation
} from '../src/main/agent-identity.js';

const cleanup: string[] = [];

afterEach(async () => {
  resetAgentIdentityForTests();
  resetDurableForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempStore(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-agent-identity-'));
  cleanup.push(dir);
  initDurableStore(dir);
}

describe('one Eve/Eva conversation identity', () => {
  it('migrates one exact legacy owner only when the dedicated state is truly absent', async () => {
    await tempStore();
    expect(restoreAgentIdentity(null, 'legacy-exact-owner')).toEqual({ persist: true, migrated: true });
    expect(currentAgentConversationId()).toBe('legacy-exact-owner');
    expect(snapshotAgentIdentity()).toEqual({ version: 1, conversationId: 'legacy-exact-owner' });

    resetAgentIdentityForTests();
    expect(restoreAgentIdentity({ version: 1, conversationId: null }, 'other-broker-owner')).toEqual({ persist: false, migrated: false });
    expect(currentAgentConversationId()).toBeNull();

    resetAgentIdentityForTests();
    expect(restoreAgentIdentity({ version: 1, conversationId: 'bad id with spaces' }, 'other-broker-owner')).toEqual({ persist: false, migrated: false });
    expect(currentAgentConversationId()).toBeNull();
  });

  it('claims only from null, then transfers and clears exact ownership durably', async () => {
    await tempStore();
    restoreAgentIdentity({ version: 1, conversationId: null });

    expect(await claimAgentConversation('fresh-owner-1234')).toBe(true);
    expect(await claimAgentConversation('competing-owner-5678')).toBe(false);
    expect(currentAgentConversationId()).toBe('fresh-owner-1234');
    await expect(readDurable(AGENT_IDENTITY_STATE)).resolves.toEqual({ version: 1, conversationId: 'fresh-owner-1234' });

    expect(await transferAgentConversation('unrelated-owner', 'must-not-adopt')).toBe(true);
    expect(currentAgentConversationId()).toBe('fresh-owner-1234');
    expect(await transferAgentConversation('fresh-owner-1234', 'resumed-owner-9999')).toBe(true);
    expect(currentAgentConversationId()).toBe('resumed-owner-9999');
    await expect(readDurable(AGENT_IDENTITY_STATE)).resolves.toEqual({ version: 1, conversationId: 'resumed-owner-9999' });

    expect(await clearAgentConversation('some-old-chat')).toBe(false);
    expect(await clearAgentConversation('resumed-owner-9999')).toBe(true);
    expect(currentAgentConversationId()).toBeNull();
    await expect(readDurable(AGENT_IDENTITY_STATE)).resolves.toEqual({ version: 1, conversationId: null });
  });

  it('serializes strict replacement against competing owner transitions', async () => {
    await tempStore();
    restoreAgentIdentity({ version: 1, conversationId: 'owner-a-1234' });

    const [replacement, competingReplacement] = await Promise.all([
      replaceAgentConversation('owner-a-1234', 'owner-b-5678'),
      replaceAgentConversation('owner-a-1234', 'owner-c-9012')
    ]);
    expect([replacement, competingReplacement]).toEqual([true, false]);
    expect(currentAgentConversationId()).toBe('owner-b-5678');

    restoreAgentIdentity({ version: 1, conversationId: 'owner-a-1234' });
    const [continuation, lateReplacement] = await Promise.all([
      transferAgentConversation('owner-a-1234', 'owner-c-9012'),
      replaceAgentConversation('owner-a-1234', 'owner-b-5678')
    ]);
    expect(continuation).toBe(true);
    expect(lateReplacement).toBe(false);
    expect(currentAgentConversationId()).toBe('owner-c-9012');
  });
});
