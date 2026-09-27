import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests, createSession, latestProjectConversation, rebindSession } from '../src/main/session/store.js';
import { addProject, assignSessionProject, getSessionProject, listProjects, removeProject } from '../src/main/projects.js';
import { startExpensesProject, resolveExpensesDataProject, resolveExpensesProject } from '../src/main/expenses-project.js';
import { createCollection, initializeDefaultThreads, pinsLibrary, updateQuiltMetadata } from '../src/main/pins.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { EXPENSES_INSTRUCTIONS } from '../src/shared/expenses-template.js';
import { prepareSessionPrompt } from '../src/main/session/prompt.js';

let directory: string, approved: string, folder: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-expenses-project-'));
  approved = path.join(directory, 'approved');
  await fs.mkdir(approved);
  approved = await validateNewRoot(approved, []);
  folder = path.join(approved, 'Expenses');
  await fs.mkdir(folder);
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetSessionStoreForTests(); resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('starts an empty local project, links one Thread, and safely reopens it', async () => {
  const project = await startExpensesProject(folder);
  expect(project.template).toMatchObject({ id: 'expenses', version: 1 });
  expect(EXPENSES_INSTRUCTIONS).toContain('Workers may read evidence and return interpretations to Primary');
  expect((await pinsLibrary()).quilts).toHaveLength(1);
  expect(await fs.readFile(path.join(folder, 'AGENTS.md'), 'utf8')).toBe(EXPENSES_INSTRUCTIONS);
  expect(JSON.parse(await fs.readFile(path.join(folder, 'data/ledger.json'), 'utf8'))).toMatchObject({ version: 1, revision: 0, records: [] });
  expect(await fs.readdir(path.join(folder, 'receipts'))).toEqual([]);
  expect(await startExpensesProject(folder)).toEqual(project);
  expect((await listProjects()).length).toBe(1);
  expect(await resolveExpensesProject('%expenses coffee 30 SEK')).toEqual(project);
  expect(await resolveExpensesProject('coffee 30 SEK', project.id)).toEqual(project);
  expect(await resolveExpensesProject('Process these receipts', null, project.template!.quiltId)).toEqual(project);
  expect(await resolveExpensesProject('coffee 30 SEK')).toBeNull();
  expect(await resolveExpensesProject('#expenses')).toBeNull();
  expect(await resolveExpensesDataProject('#expenses')).toEqual(project);
  await createCollection({ name: 'expenses' });
  expect(await resolveExpensesProject('#expenses')).toBeNull();
  expect(await resolveExpensesDataProject('#expenses')).toBeNull();
});

it('binds the local Expenses project to the preseeded expenses Thread without creating another Thread', async () => {
  await initializeDefaultThreads();
  const starter = (await pinsLibrary()).quilts.find(thread => thread.title === 'expenses');
  expect(starter).toBeTruthy();

  const project = await startExpensesProject(folder);
  expect(project.template?.quiltId).toBe(starter!.id);
  expect((await pinsLibrary()).quilts.map(thread => thread.title)).toEqual(['how', 'appdata%', 'expenses', 'organize', 'plans', 'claude']);
});

it('reopens through the stored Thread id after the bound Thread is renamed', async () => {
  const project = await startExpensesProject(folder);
  const quiltId = project.template!.quiltId;
  await updateQuiltMetadata({ quiltId, title: 'household-spend', collectionNames: [] });

  expect(await startExpensesProject(folder)).toEqual(project);
  const snapshot = await pinsLibrary();
  expect(snapshot.quilts).toHaveLength(1);
  expect(snapshot.quilts[0]).toMatchObject({ id: quiltId, title: 'household-spend' });
  expect(await resolveExpensesProject('%household-spend coffee 30 SEK')).toEqual(project);
});

it('refuses ordinary populated folders and unsupported markers without replacing files', async () => {
  const own = path.join(folder, 'AGENTS.md');
  await fs.writeFile(own, 'keep mine');
  await expect(startExpensesProject(folder)).rejects.toThrow(/empty folder/);
  expect(await fs.readFile(own, 'utf8')).toBe('keep mine');
  await fs.writeFile(path.join(folder, '.eve-template.json'), JSON.stringify({ id: 'other', version: 1 }));
  await expect(startExpensesProject(folder)).rejects.toThrow(/Unsupported/);
  expect(await listProjects()).toEqual([]);
});

it('keeps project identity across restart, resume and removal from sidebar', async () => {
  const project = await startExpensesProject(folder);
  const session = await createSession({ title: 'Expenses', conversationId: 'expenses-original' });
  await assignSessionProject(session.id, project.id);
  expect(await rebindSession(session.id, 'expenses-original', 'expenses-resumed')).toBe(true);
  await removeProject(project.id);
  resetSessionStoreForTests(); resetDurableForTests(); initDurableStore(directory);
  expect((await getSessionProject(session.id))?.real).toBe(folder);
  expect((await resolveExpensesProject('%expenses'))?.id).toBe(project.id);
  expect((await startExpensesProject(folder)).ungrouped).toBeUndefined();
});

it('selects the newest ordinary conversation for the exact Expenses project from the uncapped session index', async () => {
  const project = await startExpensesProject(folder);
  const first = await createSession({ title: 'Expenses first', conversationId: 'expenses-first' });
  await assignSessionProject(first.id, project.id);
  const worker = await createSession({
    title: 'Expenses worker', conversationId: 'expenses-worker',
    origin: { kind: 'worker', fromSessionId: first.id, agentId: 'worker-1', task: 'Analyze receipts' }
  });
  await assignSessionProject(worker.id, project.id);
  const latest = await createSession({ title: 'Expenses latest', conversationId: 'expenses-latest' });
  await assignSessionProject(latest.id, project.id);

  expect((await latestProjectConversation(project.id))?.id).toBe(latest.id);

  const otherFolder = path.join(approved, 'Other project');
  await fs.mkdir(otherFolder);
  const other = await addProject(otherFolder);
  const unrelated = await createSession({ title: 'Newer elsewhere', conversationId: 'elsewhere' });
  await assignSessionProject(unrelated.id, other.id);
  expect((await latestProjectConversation(project.id))?.id).toBe(latest.id);
});

it('uses complete Core and project instructions through the normal first-chat bootstrap', async () => {
  const project = await startExpensesProject(folder);
  const prompt = await prepareSessionPrompt('%expenses I spent 30 SEK', { projectId: project.id });
  expect(prompt).toContain('PARADIGMEVE_CONTEXT');
  expect(prompt).toContain('AGENTS.md instructions for /work/Expenses');
  expect(prompt).toContain('sourceIndex is the image ordinal in the current user message');
  expect(prompt).toContain('The printed paid total is authoritative for spending');
  expect(prompt).toContain('specific store/restaurant location');
  expect(prompt).toContain('%expenses I spent 30 SEK');
});

it('fails on conflicting Thread/project selection and revoked folder permissions', async () => {
  const project = await startExpensesProject(folder);
  const otherFolder = path.join(approved, 'Other'); await fs.mkdir(otherFolder);
  const other = await addProject(otherFolder);
  await expect(resolveExpensesProject('%expenses', other.id)).rejects.toThrow(/conflicts/);
  await expect(startExpensesProject(otherFolder)).rejects.toThrow(/already has/);
  expect(await fs.readdir(otherFolder)).toEqual([]);
  await saveConfig({ ...defaultConfig(), roots: [] });
  await expect(resolveExpensesProject('%expenses')).rejects.toThrow();
  expect((await listProjects()).find(row => row.id === project.id)?.template?.quiltId).toBeTruthy();
});

it('does not initialize without write permission and rejects corrupt ledgers on reopen', async () => {
  await saveConfig({ ...defaultConfig(), readOnly: true, roots: [{ name: 'work', path: approved }] });
  await expect(startExpensesProject(folder)).rejects.toThrow(/permissions/);
  expect(await fs.readdir(folder)).toEqual([]);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
  await startExpensesProject(folder);
  const ledger = path.join(folder, 'data/ledger.json');
  await fs.writeFile(ledger, '{broken');
  await expect(startExpensesProject(folder)).rejects.toThrow();
  expect(await fs.readFile(ledger, 'utf8')).toBe('{broken');
});
