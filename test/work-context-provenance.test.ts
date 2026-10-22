import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const fixture = vi.hoisted(() => ({ sharedOwner: null as string | null }));
vi.mock('../src/main/eve-access.js', () => ({
  sharedEveOwnerForCurrentCall: () => fixture.sharedOwner
}));

import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { workContext } from '../src/main/mcp/work-context.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let configDir: string;
const toolContext = { roots: [], caps: defaultConfig().capabilities, readOnly: false, sessionTools: false, agentTools: false };

function call(requestId: string | null, conversationId: string | null, sessionId: string | null): CallContext {
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: { transportKey: null, requestId, conversationId, sessionId },
    outcome: null,
    evidence: emptyEvidence()
  };
}

function result(context: CallContext): Record<string, any> {
  return runInCallContext(context, () => workContext(toolContext, 'win32').structuredContent as Record<string, any>);
}

beforeAll(async () => {
  configDir = await makeTempDir('clf-work-context-proof-');
  initConfigPath(configDir);
  await saveConfig(defaultConfig());
});

afterAll(async () => { await removeTempDir(configDir); });
beforeEach(() => { fixture.sharedOwner = null; });

it('reports exact request, conversation and session proof without borrowing a shared owner', () => {
  fixture.sharedOwner = 'prime-not-this-chat';
  const context = result(call('wfr_exact', 'worker-chat', 'worker-session'));
  expect(context.callerIdentity).toBe('proven');
  expect(context.callerProof).toEqual({
    kind: 'exact_companion', requestId: 'wfr_exact', conversationId: 'worker-chat',
    sessionId: 'worker-session', chatgptApproval: 'external_to_eve'
  });
  expect(context.conversationId).toBe('worker-chat');
});

it('does not misrepresent shared local Eve authority as Prime or worker chat identity', () => {
  fixture.sharedOwner = 'prime-chat';
  const context = result(call('wfr_remote_phone', null, null));
  expect(context.callerIdentity).toBe('shared-eve');
  expect(context.callerProof).toEqual({
    kind: 'shared_authority_unattributed', requestId: 'wfr_remote_phone',
    conversationId: null, sessionId: null, chatgptApproval: 'external_to_eve'
  });
  expect(context).not.toHaveProperty('conversationId');
  expect(context).not.toHaveProperty('sessionId');
});

it('reports unproven attribution without manufacturing a conversation or provider approval', () => {
  const context = result(call(null, null, null));
  expect(context.callerIdentity).toBe('unproven');
  expect(context.callerProof).toEqual({
    kind: 'unproven', requestId: null, conversationId: null,
    sessionId: null, chatgptApproval: 'external_to_eve'
  });
  expect(context).not.toHaveProperty('conversationId');
});
