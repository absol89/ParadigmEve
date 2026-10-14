import { promises as fs } from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

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

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initDurableStore, flushDurable, resetDurableForTests } = await import('../src/main/durable.js');
const { initSessionStore, readEvents, flushSessions, resetSessionStoreForTests, unsetSessionRootForTests } = await import('../src/main/session/store.js');
const { sessionForConversation, flushRecorder, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { localChatCoreTools } = await import('../src/main/local-chat-tools.js');
const { issueLocalAgentExecutionPrincipal, resetLocalAgentRuntimeForTests } = await import('../src/main/local-agent-runtime.js');
const { createRegistrar } = await import('../src/main/mcp/kernel.js');
const { registerCoreTools } = await import('../src/main/mcp/tools-core.js');
const { emptyEvidence } = await import('../src/main/mcp/call-context.js');
const { resetFileProviderConsentForTests } = await import('../src/main/file-provider-consent.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');

/** One script every chat route runs: inspect, two bounded reads and an on-demand provider query. */
const SCRIPT = [
  { name: 'file_action', args: { op: 'inspect', path: '/workspace/book.xlsx' } },
  { name: 'file_action', args: { op: 'read', path: '/workspace/book.xlsx', range: 'A1:B2' } },
  { name: 'file_action', args: { op: 'read', path: '/workspace/letter.docx' } },
  { name: 'file_edit', args: { op: 'provider_tools', provider: 'artcraft.gridcraft' } }
] as const;

let dir = '';
const context = () => ({
  roots: [{ name: 'workspace', path: path.join(dir, 'workspace') }],
  caps: { ...DEFAULT_CAPABILITIES, read: true, edit: true, create: true },
  exposedCaps: { ...DEFAULT_CAPABILITIES, read: true, edit: true, create: true },
  readOnly: false,
  sessionTools: false,
  agentTools: false
});

beforeEach(async () => {
  dir = await makeTempDir('eve-broker-neutral-');
  initConfigPath(dir); initSessionStore(dir); initDurableStore(dir);
  await saveConfig(defaultConfig());
  await fs.mkdir(path.join(dir, 'workspace'));
  await fs.writeFile(path.join(dir, 'workspace', 'book.xlsx'), zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="Budget" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Rent</t></is></c><c r="B1"><v>1200</v></c></row></sheetData></worksheet>')
  }));
  await fs.writeFile(path.join(dir, 'workspace', 'letter.docx'), zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Dear Ada</w:t></w:r></w:p></w:body></w:document>') }));
});
afterEach(async () => {
  resetLocalAgentRuntimeForTests();
  await flushRecorder(); await flushSessions(); await flushDurable();
  resetRecorderForTests(); resetSessionStoreForTests(); unsetSessionRootForTests(); resetDurableForTests();
  await removeTempDir(dir);
});

/** The same text a local model loop receives (text parts joined), from the Core registrar. */
async function viaCore(conversationId: string): Promise<string[]> {
  resetFileProviderConsentForTests('win32-x64');
  const reg = createRegistrar(null, context(), 'core');
  registerCoreTools(reg);
  const parent = { startedAt: Date.now(), transportKey: null, agent: null, caller: { transportKey: null, requestId: null, conversationId, sessionId: null, localPrincipal: null }, outcome: null, evidence: emptyEvidence() };
  const out: string[] = [];
  for (const step of SCRIPT) {
    const result = await reg.invokeNested(step.name, step.args, parent);
    out.push(result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n').trim());
  }
  return out;
}

async function viaLocalChat(backend: 'ollama' | 'openrouter', route: 'ollama-local' | 'openrouter'): Promise<{ texts: string[]; sessionId: string }> {
  resetFileProviderConsentForTests('win32-x64');
  const conversationId = `ollama-neutral-${backend}`;
  const sessionId = (await sessionForConversation(conversationId))!;
  const principal = issueLocalAgentExecutionPrincipal({ backend: 'ollama', runId: `chat:${sessionId}`, agentId: `turn-${backend}` });
  const tools = await localChatCoreTools({ getContext: context, principal, sessionId, conversationId, route, mode: 'direct' });
  const texts: string[] = [];
  for (const step of SCRIPT) {
    const tool = tools.find((candidate) => candidate.name === step.name);
    expect(tool, step.name).toBeDefined();
    texts.push((await tool!.invoke(step.args, principal)).content);
  }
  return { texts, sessionId };
}

describe('provider-neutral file broker', () => {
  it('runs the same script with the same results on ChatGPT Core, local Ollama and OpenRouter, recording each route', async () => {
    const core = await viaCore('chatgpt-neutral');
    expect(core[0]).toContain('provider_offer: GridCraft (artcraft.gridcraft)');
    expect(core[1]).toContain('Rent\t1200');
    expect(core[2]).toContain('Dear Ada');
    expect(core[3]).toMatch(/PROVIDER_NOT_READY/);

    for (const [backend, route] of [['ollama', 'ollama-local'], ['openrouter', 'openrouter']] as const) {
      const local = await viaLocalChat(backend, route);
      expect(local.texts, backend).toEqual(core);
      await flushRecorder();
      const calls = (await readEvents(local.sessionId, { kinds: ['tool_call'] })).flatMap((event) => event.kind === 'tool_call' ? [event.call] : []);
      expect(calls.map((call) => call.tool)).toEqual(SCRIPT.map((step) => step.name));
      expect(calls.every((call) => call.contentRecipient === route)).toBe(true);
    }
  });

  it('never lists a Craft app tool on any route, installed or not', async () => {
    const reg = createRegistrar(null, context(), 'core');
    registerCoreTools(reg);
    const principal = issueLocalAgentExecutionPrincipal({ backend: 'ollama', runId: 'chat:neutral', agentId: 'turn' });
    const local = await localChatCoreTools({ getContext: context, principal, sessionId: 'neutral', conversationId: null, route: 'ollama-cloud', mode: 'direct' });
    for (const names of [reg.registered(), local.map((tool) => tool.name)]) {
      expect(names).toContain('file_action');
      expect(names).toContain('file_edit');
      expect(names.filter((name) => /craft|read_range|open_workbook|save_workbook/i.test(name))).toEqual([]);
    }
  });
});
