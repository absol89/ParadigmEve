/**
 * Native ChatGPT Project <-> Eve local project mapping, both directions.
 *
 * The link is explicit and exact: one Eve project names one native `g-p-…` Project, never by
 * display name. Ingress: the service worker reads the Project from the observing tab's URL when it
 * journals, `/events` carries it, and a session with no project of its own joins the linked Eve
 * project. Egress: a fresh chat of a linked Eve project enters its native Project through a known
 * chat inside it (a cold Project address errors in ChatGPT's loader) and fails visibly otherwise.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { claimBrowserInput, enqueueInput, failUnreachableProjectInput, listInputs, pendingBrowserInputs, resetInputForTests } from '../src/main/session/input.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createSession, getSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { addProject, assignSessionProject, bindSessionNativeProject, linkNativeProject, listProjects, noteNativeProjectEntry } from '../src/main/projects.js';
import { normalizeProjectId } from '../src/main/session/continuation.js';
import { nativeChatGptProjectId, nativeProjectConversationId } from '../src/shared/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';

const NATIVE = 'g-p-0123456789abcdef0123456789abcdef';
const OTHER_NATIVE = 'g-p-fedcba9876543210fedcba9876543210';
const FIRST_ENTRY_CHAT = '6a000001-0000-83ed-8000-000000000001';
const ENTRY_CHAT = '6a000006-0000-83ed-8000-000000000006';
const workerSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

describe('native Project id parsing', () => {
  const urls = [
    `https://chatgpt.com/g/${NATIVE}-eve-work/project`,
    `https://chatgpt.com/g/${NATIVE}/c/${ENTRY_CHAT}`,
    `https://chat.openai.com/g/${NATIVE.toUpperCase()}-x/c/${ENTRY_CHAT}`,
    'https://chatgpt.com/g/g-abc123-some-gpt/c/abc',
    `http://chatgpt.com/g/${NATIVE}/project`,
    `https://evil.example/g/${NATIVE}/project`,
    'https://chatgpt.com/',
    'not a url'
  ];

  it('agrees with the service worker for every URL, and stores only the bare id', () => {
    const { api } = serviceWorker();
    for (const url of urls) expect(nativeChatGptProjectId(url)).toBe(api.projectFromUrl(url));
    expect(nativeChatGptProjectId(urls[0])).toBe(NATIVE);
    expect(nativeChatGptProjectId(NATIVE)).toBe(normalizeProjectId(NATIVE));
    expect(nativeChatGptProjectId('Eve work')).toBeNull();
  });

  it('reads the chat of a Project chat link only', () => {
    expect(nativeProjectConversationId(urls[1])).toBe(ENTRY_CHAT);
    expect(nativeProjectConversationId(urls[0])).toBeNull();
    expect(nativeProjectConversationId(`https://chatgpt.com/c/${ENTRY_CHAT}`)).toBeNull();
  });
});

describe('the app side of the mapping', () => {
  let directory: string, approved: string;
  beforeEach(async () => {
    resetInputForTests();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-native-projects-'));
    approved = path.join(directory, 'approved');
    await fs.mkdir(path.join(approved, 'first'), { recursive: true });
    await fs.mkdir(path.join(approved, 'second'));
    approved = await validateNewRoot(approved, []);
    initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
    await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
  });
  afterEach(async () => { resetSessionStoreForTests(); resetDurableForTests(); await fs.rm(directory, { recursive: true, force: true }); });

  it('links one native Project to at most one Eve project, by exact id only', async () => {
    const first = await addProject(path.join(approved, 'first'));
    const second = await addProject(path.join(approved, 'second'));
    const firstEntry = await createSession({ title: 'Native Project entry', conversationId: FIRST_ENTRY_CHAT });
    expect(await linkNativeProject(first.id, `https://chatgpt.com/g/${NATIVE}-first/c/${FIRST_ENTRY_CHAT}`))
      .toMatchObject({ nativeProjectId: NATIVE, nativeEntryConversationId: FIRST_ENTRY_CHAT });
    expect((await getSession(firstEntry.id))?.projectId).toBe(first.id);
    await expect(linkNativeProject(second.id, NATIVE)).rejects.toThrow(/already linked/);
    await expect(linkNativeProject(second.id, 'first')).rejects.toThrow(/ChatGPT Project link/);
    await expect(linkNativeProject(second.id, 'https://chatgpt.com/g/g-abc123-gpt/c/x')).rejects.toThrow(/ChatGPT Project link/);
    // A chat link also seeds the chat fresh Eve chats enter the Project through.
    expect(await linkNativeProject(second.id, `https://chatgpt.com/g/${OTHER_NATIVE}-second/c/${ENTRY_CHAT}`))
      .toMatchObject({ nativeProjectId: OTHER_NATIVE, nativeEntryConversationId: ENTRY_CHAT });
    resetDurableForTests(); initDurableStore(directory);
    expect((await listProjects()).map(row => row.nativeProjectId)).toEqual([NATIVE, OTHER_NATIVE]);
    const unlinked = await linkNativeProject(second.id, null);
    expect(unlinked.nativeProjectId).toBeUndefined();
    expect(unlinked.nativeEntryConversationId).toBeUndefined();
  });

  it('keeps a pasted Project chat link when its chat cannot join the project', async () => {
    const project = await addProject(path.join(approved, 'first'));
    const entry = await createSession({ title: 'Native Project entry', conversationId: ENTRY_CHAT });
    await fs.rm(path.join(approved, 'first'), { recursive: true });
    expect(await linkNativeProject(project.id, `https://chatgpt.com/g/${NATIVE}/c/${ENTRY_CHAT}`))
      .toMatchObject({ nativeProjectId: NATIVE, nativeEntryConversationId: ENTRY_CHAT });
    expect((await getSession(entry.id))?.projectId).toBeUndefined();
  });

  it('files an observed chat under the linked project without overriding any existing or inherited binding', async () => {
    const first = await addProject(path.join(approved, 'first'));
    const second = await addProject(path.join(approved, 'second'));
    await linkNativeProject(first.id, NATIVE);
    const website = await createSession({ title: 'Website-created chat', conversationId: 'website-chat' });
    expect(await bindSessionNativeProject(website.id, NATIVE)).toBe(true);
    expect((await getSession(website.id))?.projectId).toBe(first.id);

    const explicit = await createSession({ title: 'Explicit', conversationId: 'explicit-chat' });
    await assignSessionProject(explicit.id, second.id);
    expect(await bindSessionNativeProject(explicit.id, NATIVE)).toBe(false);
    expect((await getSession(explicit.id))?.projectId).toBe(second.id);

    const prime = await createSession({ title: 'Prime', conversationId: 'prime-chat' });
    const worker = await createSession({ title: 'Worker', conversationId: 'worker-chat',
      origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-1', task: 'Inspect' } });
    expect(await bindSessionNativeProject(worker.id, NATIVE)).toBe(false);
    expect((await getSession(worker.id))?.projectId).toBeUndefined();

    const unlinked = await createSession({ title: 'Other Project', conversationId: 'other-chat' });
    expect(await bindSessionNativeProject(unlinked.id, OTHER_NATIVE)).toBe(false);
    expect(await bindSessionNativeProject(unlinked.id, null)).toBe(false);
  });

  it('sends a fresh project chat through its native Project entry, and fails visibly without one', async () => {
    const project = await addProject(path.join(approved, 'first'));
    await linkNativeProject(project.id, NATIVE);
    const blind = await enqueueInput({ id: randomUUID(), projectId: project.id, sessionId: null, text: 'Needs the Project', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
    expect((await pendingBrowserInputs()).some(row => row.id === blind.id)).toBe(false);
    const failed = (await listInputs()).find(row => row.id === blind.id)!;
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatch(/linked ChatGPT Project.*Nothing was sent/);

    await noteNativeProjectEntry(NATIVE, ENTRY_CHAT);
    const entry = await enqueueInput({ id: randomUUID(), projectId: project.id, sessionId: null, text: 'Work there', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
    expect((await pendingBrowserInputs()).find(row => row.id === entry.id))
      .toMatchObject({ conversationId: null, projectEntry: { id: NATIVE, sourceConversationId: ENTRY_CHAT } });
    // Only the recorded entry chat may report that the Project could not be entered.
    expect(await failUnreachableProjectInput(entry.id, 'another-chat')).toBe(false);
    expect(await failUnreachableProjectInput(entry.id, ENTRY_CHAT)).toBe(true);
    expect((await listInputs()).find(row => row.id === entry.id)).toMatchObject({ state: 'failed' });

    const next = await enqueueInput({ id: randomUUID(), projectId: project.id, sessionId: null, text: 'Later', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
    expect(await claimBrowserInput(next.id, 'document', null)).toMatchObject({ id: next.id, nativeProject: NATIVE });
    // A claimed input is past the entry step; a late report cannot fail it.
    expect(await failUnreachableProjectInput(next.id, ENTRY_CHAT)).toBe(false);
  });

  it('keeps opening a fresh chat of an unlinked project at the site root', async () => {
    const plain = await addProject(path.join(approved, 'second'));
    const rootInput = await enqueueInput({ id: randomUUID(), projectId: plain.id, sessionId: null, text: 'Root', dueAt: 0, mode: 'auto', model: null, reasoningEffort: null });
    const offered = (await pendingBrowserInputs()).find(row => row.id === rootInput.id);
    expect(offered).toBeDefined();
    expect(offered!.projectEntry).toBeUndefined();
  });
});

describe('the service worker side of the mapping', () => {
  it('journals the tab\'s native Project with each observation and sends it on /events', async () => {
    const { api, context, posts } = serviceWorker([
      { id: 7, url: `https://chatgpt.com/g/${NATIVE}-eve/c/${ENTRY_CHAT}` }
    ]);
    await api.load();
    api.own(7, 'doc-7');
    const source = { tab: 7, documentId: 'doc-7', navigationEpoch: 0 };
    const reply = await api.HANDLERS.events({ conversationId: ENTRY_CHAT, entries: [
      { conversationId: ENTRY_CHAT, event: { kind: 'user_message', messageId: 'm1', text: 'hi' } },
      // A page never supplies its own Project claim.
      { conversationId: '11111111-2222', project: OTHER_NATIVE, event: { kind: 'user_message', messageId: 'm2', text: 'x' } }
    ] }, { documentId: 'doc-7' }, source);
    expect(reply.ok).not.toBe(false);
    const batch = api.nextJournalBatch(ENTRY_CHAT);
    expect(batch).toMatchObject({ conversationId: ENTRY_CHAT, project: NATIVE });
    expect(api.nextJournalBatch('11111111-2222')?.project).toBeNull();
    (context as any).call = async (route: string, init: { body: string }) => { posts.push({ route, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
    await api.deliverJournalBatch(batch);
    expect(posts.at(-1)).toMatchObject({ route: '/events', body: { conversationId: ENTRY_CHAT, project: NATIVE } });
  });

  it('opens a fresh project input on the Project\'s entry chat, never at the site root', async () => {
    const { api, created } = serviceWorker([]);
    await api.load();
    const id = randomUUID();
    await api.deliverDesktopInputs([{ id, conversationId: null, projectEntry: { id: NATIVE, sourceConversationId: ENTRY_CHAT } }], false, [], [id]);
    expect(created).toHaveLength(1);
    expect(created[0]!.url).toBe(`https://chatgpt.com/c/${ENTRY_CHAT}?cos-input=${id}#cos-input=${id}`);
  });
});

type Tab = { id: number; url?: string; pendingUrl?: string; windowId?: number; index?: number; status?: string };
function serviceWorker(initial: Tab[] = []) {
  const created: Tab[] = [];
  const tabs: Tab[] = [...initial];
  const posts: Array<{ route: string; body: unknown }> = [];
  const event = { addListener: () => {} };
  const store = (saved: Record<string, unknown>) => ({
    get: async () => ({ ...saved }),
    set: async (value: object) => { Object.assign(saved, value); },
    remove: async () => {}
  });
  const makeTab = async (options: Tab) => {
    const tab = { ...options, id: 100 + created.length };
    created.push(tab); tabs.push(tab);
    return tab;
  };
  const context = vm.createContext({
    chrome: {
      storage: { local: store({ port: 8765, token: 'test-pairing' }), session: store({}) },
      windows: { get: async (id: number) => ({ id }), create: async ({ url }: { url: string }) => ({ id: 80, tabs: [await makeTab({ url, windowId: 80 } as Tab)] }), update: () => {} },
      tabs: {
        query: async () => [...tabs],
        get: async (id: number) => { const tab = tabs.find(entry => entry.id === id); if (!tab) throw new Error('no such tab'); return tab; },
        create: makeTab,
        update: async () => undefined,
        remove: async () => undefined,
        sendMessage: async () => ({ ok: true }),
        onCreated: event, onUpdated: event, onRemoved: event
      },
      runtime: { getManifest: () => ({ version: '2.0.6' }), onMessage: event, onInstalled: event, onStartup: event },
      alarms: { onAlarm: event, create: () => {}, clear: async () => true },
      scripting: { executeScript: async () => [], insertCSS: async () => {} }
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout, TextEncoder, console,
    browserDriverModule: { installBrowserDriverLifecycle() {}, sweepStaleDrivenGroups: async () => {} }
  });
  vm.runInContext(`${workerSource}
globalThis.probe = { projectFromUrl, load, HANDLERS, nextJournalBatch, deliverJournalBatch, deliverDesktopInputs,
  own(tab, documentId) { tabDocuments[String(tab)] = documentId; tabEpochs[String(tab)] = 0; } };`, context);
  return { api: (context as unknown as { probe: any }).probe, context, created, posts };
}
