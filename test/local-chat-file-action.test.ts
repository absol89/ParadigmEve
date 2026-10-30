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
  it('publishes root object properties for every direct local tool', async () => {
    const principal = issueLocalAgentExecutionPrincipal({ backend: 'ollama', runId: 'schema-check', agentId: 'local-chat' });
    const ctx = {
      roots: [{ name: 'workspace', path: process.cwd() }],
      caps: { ...DEFAULT_CAPABILITIES, read: true },
      exposedCaps: { ...DEFAULT_CAPABILITIES, read: true },
      readOnly: false,
      sessionTools: true,
      agentTools: true
    };
    const tools = await localChatCoreTools({
      getContext: () => ctx,
      principal,
      sessionId: 'schema-check',
      conversationId: 'schema-check',
      route: 'ollama-local',
      mode: 'direct'
    });
    const invalid = tools.filter((tool) => {
      const props = tool.inputSchema.properties;
      return !props || typeof props !== 'object' || Array.isArray(props);
    });
    expect(invalid.map((tool) => tool.name)).toEqual([]);
    const file = tools.find((tool) => tool.name === 'file_action')!;
    expect((file.inputSchema.properties as Record<string, { enum?: string[] }>).op?.enum).toEqual(['inspect', 'read', 'providers']);
    expect(file.inputSchema.required).toEqual(['op']);
    const pins = tools.find((tool) => tool.name === 'pins')!;
    expect((pins.inputSchema.properties as Record<string, { enum?: string[] }>).action?.enum).toContain('create_thread');
    expect(pins.inputSchema.required).toEqual(['action']);
    const source = (pins.inputSchema.properties as Record<string, { properties?: Record<string, { enum?: string[] }> }>).source;
    expect(source?.properties?.kind?.enum).toEqual(['session_event', 'plan']);
  });

  it.each([['ollama', 'ollama-local'], ['llamacpp', 'llamacpp-local'], ['openrouter', 'openrouter']] as const)('publishes file_action to direct %s model loops', async (backend, route) => {
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
      route,
      mode: 'direct'
    });
    expect(tools.map((tool) => tool.name)).toContain('file_action');
    const declaration = tools.find((tool) => tool.name === 'file_action');
    expect(JSON.stringify(declaration?.inputSchema)).toContain('inspect');
    expect(JSON.stringify(declaration?.inputSchema)).toContain('read');
    if (backend === 'openrouter') expect(declaration?.inputSchema).toHaveProperty('anyOf');
  });
});
