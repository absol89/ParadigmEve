import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'basic_text',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

vi.mock('../src/main/platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/platform.js')>();
  return { ...actual, desktopAutomationSupported: () => false };
});

const { localChatCoreTools } = await import('../src/main/local-chat-tools.js');
const { issueLocalAgentExecutionPrincipal, resetLocalAgentRuntimeForTests } = await import('../src/main/local-agent-runtime.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');

afterEach(() => resetLocalAgentRuntimeForTests());

describe('provider-neutral file_action exposure', () => {
  it.each(['ollama', 'openrouter'] as const)('publishes file_action to direct %s model loops', async (backend) => {
    const principal = issueLocalAgentExecutionPrincipal({ backend, runId: `test-${backend}`, agentId: 'local-chat' });
    const ctx = {
      roots: [{ name: 'workspace', path: process.cwd() }],
      caps: { ...DEFAULT_CAPABILITIES, read: true },
      exposedCaps: { ...DEFAULT_CAPABILITIES, read: true },
      readOnly: true,
      sessionTools: false,
      agentTools: false
    };
    const tools = await localChatCoreTools({
      getContext: () => ctx,
      principal,
      sessionId: `session-${backend}`,
      conversationId: `conversation-${backend}`,
      mode: 'direct'
    });
    expect(tools.map((tool) => tool.name)).toContain('file_action');
    const declaration = tools.find((tool) => tool.name === 'file_action');
    expect(JSON.stringify(declaration?.inputSchema)).toContain('inspect');
    expect(JSON.stringify(declaration?.inputSchema)).toContain('read');
  });
});
