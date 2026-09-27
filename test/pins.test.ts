import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_THREADS_MIGRATION_STATE,
  PINS_STATE,
  createCollection,
  createPin,
  createQuilt,
  createThread,
  deleteQuilt,
  initializeDefaultThreads,
  pinsLibrary,
  removePin,
  resetPinsForTests,
  setPinSticky,
  setQuiltCollections,
  setQuiltPrompt,
  setQuiltState,
  starterThreadEntry,
  threadSettingsEntries,
  updateQuiltMetadata
} from '../src/main/pins.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { createPlan, resetPlansForTests } from '../src/main/plans.js';
import {
  createSession,
  initSessionStore,
  readEvents,
  resetSessionStoreForTests,
  unsetSessionRootForTests,
  upsertMessageEvent
} from '../src/main/session/store.js';
import { pinsContextReferences, selectPinsContext } from '../src/shared/pins-context.js';
import {
  DEFAULT_THREAD_DEFINITIONS,
  SUPERSEDED_EXPENSES_THREAD_PROMPTS,
  SUPERSEDED_HOW_THREAD_PROMPT_SHA256,
  SUPERSEDED_HOW_THREAD_PROMPTS,
  SUPERSEDED_ORGANIZER_THREAD_PROMPTS
} from '../src/shared/default-threads.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-pins-'));
  resetPinsForTests();
  resetPlansForTests();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  initSessionStore(directory);
  initDurableStore(directory);
});

afterEach(async () => {
  resetPinsForTests();
  resetPlansForTests();
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

const message = (target: any) => ({
  kind: 'message' as const,
  target,
  sourceCreatedAt: 1_700_000_100_000,
  contextCreatedAt: 1_700_000_000_000,
  title: 'Useful answer',
  excerpt: 'The part worth keeping.',
  sourceLabel: 'Chat review',
  provenance: {
    sessionId: 'session-pin-1',
    conversationId: 'conversation-pin-1',
    eventSeq: 12,
    messageId: 'message-pin-1',
    turnId: 'turn-pin-1'
  }
});

it('ships %how as a question-first helper that consults the current manual quietly', () => {
  const how = DEFAULT_THREAD_DEFINITIONS.find(thread => thread.title === 'how')!;
  expect(how.description).toContain('Ask Eve about ParadigmEve');
  expect(how.prompt.startsWith('Help the user with whatever they want to know/do in ParadigmEve\n\n')).toBe(true);
  expect(how.prompt).toContain('Start with the user\'s current question');
  expect(how.prompt).toContain('What would you like to know or do in ParadigmEve?');
  expect(how.prompt).toContain('Quietly consult the current packaged ParadigmEve manual');
  expect(how.prompt).toContain('Use ParadigmEve\'s local file tools');
  expect(how.prompt).toContain('instead of guessing or pretending you read it');
  expect(how.prompt).toContain('current product behavior and verified evidence');
  expect(how.prompt).toContain('The user\'s current request is authoritative');
  expect(how.prompt).not.toContain('activation directory');
  expect(how.prompt).not.toContain('work_context');
  expect(how.prompt).not.toContain('/paradigmeve-manual');
  expect(how.prompt).not.toContain('/appdata/docs/vault');
  expect(how.prompt).not.toContain('Chrome tab');
});

it('creates the six empty default Threads, including the #Eve how/appdata/claude starters and Plans starter, on a pristine install', async () => {
  await initializeDefaultThreads();

  const snapshot = await pinsLibrary();
  expect(snapshot.pins).toEqual([]);
  expect(snapshot.collections).toEqual([expect.objectContaining({ name: 'Eve' })]);
  expect(snapshot.quilts.map(thread => thread.title)).toEqual(['how', 'appdata%', 'expenses', 'organize', 'plans', 'claude']);
  const eve = snapshot.collections[0]!;
  const how = snapshot.quilts.find(thread => thread.title === 'how')!;
  const appdata = snapshot.quilts.find(thread => thread.title === 'appdata%')!;
  const expenses = snapshot.quilts.find(thread => thread.title === 'expenses')!;
  const organize = snapshot.quilts.find(thread => thread.title === 'organize')!;
  const plans = snapshot.quilts.find(thread => thread.title === 'plans')!;
  const claude = snapshot.quilts.find(thread => thread.title === 'claude')!;
  expect(how).toMatchObject({
    state: 'pinned',
    collectionIds: [eve.id],
    description: expect.stringContaining('Ask Eve about ParadigmEve'),
    prompt: expect.stringContaining('Start with the user\'s current question')
  });
  expect(how.prompt).toContain('What would you like to know or do in ParadigmEve?');
  expect(how.prompt).toContain('Quietly consult the current packaged ParadigmEve manual');
  expect(how.prompt).toContain('Use ParadigmEve\'s local file tools');
  expect(how.prompt).toContain('instead of guessing or pretending you read it');
  expect(how.prompt).toContain('current product behavior and verified evidence');
  expect(how.prompt).toContain('The user\'s current request is authoritative');
  expect(how.prompt).not.toContain('activation directory');
  expect(how.prompt).not.toContain('work_context');
  expect(how.prompt).not.toContain('/paradigmeve-manual');
  expect(how.prompt).not.toContain('/appdata/docs/vault');
  expect(how.prompt).not.toContain('Chrome tab');
  expect(appdata).toMatchObject({
    state: 'pinned',
    collectionIds: [eve.id],
    description: expect.stringContaining('self-maintenance'),
    prompt: expect.stringContaining('/appdata')
  });
  expect(expenses).toMatchObject({
    state: 'pinned',
    description: expect.stringContaining('Receipts'),
    prompt: expect.stringContaining('Run Expenses as a low-friction recurring inbox')
  });
  expect(expenses.prompt).toContain('sourceIndex is the image ordinal in the current user message');
  expect(expenses.prompt).toContain('specific store/restaurant location');
  expect(expenses.prompt).toContain('The printed paid total is authoritative for spending');
  expect(expenses.prompt).toContain('reread the live revision/tail and continue');
  expect(organize).toMatchObject({
    state: 'pinned',
    description: expect.stringContaining('Downloads'),
    prompt: expect.stringContaining('open Settings, go to Workspace, find Folders, click Add')
  });
  expect(organize.prompt).toContain('which files or folders should be analyzed');
  expect(organize.prompt).toContain('optimize for finding and using things again');
  expect(organize.prompt).toContain('Needs review/To sort');
  expect(organize.prompt).toContain('Images or messages that clearly show a desired arrangement');
  expect(plans).toMatchObject({
    state: 'pinned',
    description: 'Create and refine durable Plans with Eve. The plan stays near this app\'s chat window too.',
    prompt: expect.stringContaining('what they want the %Plan to accomplish')
  });
  expect(claude).toMatchObject({
    state: 'pinned',
    collectionIds: [eve.id],
    description: expect.stringContaining('between Eve and Claude'),
    prompt: expect.stringContaining('Claude must not merge, tag, push, or start CI')
  });
  expect(claude.prompt).toContain('Latest promotion remains a separate user-controlled gate');

  resetDurableForTests();
  initDurableStore(directory);
  expect((await pinsLibrary()).quilts.map(thread => thread.title)).toEqual(['how', 'appdata%', 'expenses', 'organize', 'plans', 'claude']);
});

it('adds a starter generation to an older Pins library without rewriting its existing Threads', async () => {
  const custom = await createQuilt({ title: 'My filing system', collectionIds: [] });
  await initializeDefaultThreads();

  const snapshot = await pinsLibrary();
  expect(snapshot.quilts[0]).toEqual(custom);
  expect(snapshot.quilts.map(thread => thread.title)).toEqual([
    'My filing system',
    'how',
    'appdata%',
    'expenses',
    'organize',
    'plans',
    'claude'
  ]);
  expect(snapshot.pins).toEqual([]);
});

it('exposes Settings entries only for settings-bearing starters by durable starter ownership', async () => {
  await initializeDefaultThreads();
  const snapshot = await pinsLibrary();
  const expenses = snapshot.quilts.find(thread => thread.title === 'expenses')!;
  const ordinary = await createQuilt({ title: 'My ordinary Thread', collectionIds: [] });
  await setQuiltState(ordinary.id, 'archived');

  expect(await threadSettingsEntries()).toEqual([{
    starterId: 'expenses',
    threadId: expenses.id,
    title: 'expenses',
    surface: 'expenses'
  }]);

  await updateQuiltMetadata({
    quiltId: expenses.id,
    title: 'My spending',
    description: expenses.description ?? '',
    collectionNames: []
  });
  expect(await threadSettingsEntries()).toEqual([{
    starterId: 'expenses',
    threadId: expenses.id,
    title: 'My spending',
    surface: 'expenses'
  }]);
});

it('resolves the Plans starter by durable identity after a user rename without exposing it in Settings', async () => {
  await initializeDefaultThreads();
  const plans = await starterThreadEntry('plans');
  expect(plans).toMatchObject({ starterId: 'plans', title: 'plans' });
  expect(plans?.threadId).toBeTruthy();

  const snapshot = await pinsLibrary();
  const held = snapshot.quilts.find(thread => thread.id === plans!.threadId)!;
  await updateQuiltMetadata({
    quiltId: held.id,
    title: 'My planning room',
    description: held.description ?? '',
    collectionNames: []
  });

  expect(await starterThreadEntry('plans')).toEqual({
    starterId: 'plans',
    threadId: held.id,
    title: 'My planning room'
  });
  expect((await threadSettingsEntries()).some(entry => entry.starterId === 'plans')).toBe(false);
});

it('upgrades the exact previous shipped Plans description without overwriting a custom description', async () => {
  const definition = DEFAULT_THREAD_DEFINITIONS.find(thread => thread.starterId === 'plans')!;
  const previousDescription = definition.supersededDescriptions?.[0];
  expect(previousDescription).toBe('Create and refine durable Plans with Eve.');

  const plans = await createThread({
    title: 'plans',
    description: previousDescription,
    prompt: definition.prompt,
    collectionNames: []
  });
  await initializeDefaultThreads();
  expect((await pinsLibrary()).quilts.find(thread => thread.id === plans.id)?.description)
    .toBe('Create and refine durable Plans with Eve. The plan stays near this app\'s chat window too.');

  await updateQuiltMetadata({
    quiltId: plans.id,
    title: plans.title,
    description: 'My own planning description.',
    collectionNames: []
  });
  await initializeDefaultThreads();
  expect((await pinsLibrary()).quilts.find(thread => thread.id === plans.id)?.description)
    .toBe('My own planning description.');
});

it('creates first-save prompt, Link and Quilt names atomically before the new object becomes visible', async () => {
  const created = await createThread({
    title: 'handoff',
    description: 'Reusable handoff context.',
    prompt: 'Read this before continuing.',
    link: 'https://example.com/handoff',
    collectionNames: ['Eve', 'Research']
  });
  expect(created).toMatchObject({
    title: 'handoff',
    description: 'Reusable handoff context.',
    prompt: 'Read this before continuing.',
    link: 'https://example.com/handoff'
  });
  const snapshot = await pinsLibrary();
  expect(created.collectionIds).toHaveLength(2);
  expect(snapshot.collections.map(row => row.name)).toEqual(['Eve', 'Research']);
  expect(snapshot.quilts.filter(row => row.title === 'handoff')).toHaveLength(1);
});

it('adopts a legacy custom starter reference without duplicating it and restores other missing shipped starters', async () => {
  const customHow = await createQuilt({ title: '%HOW', collectionIds: [] });
  await setQuiltPrompt(customHow.id, 'My own help prompt');

  await initializeDefaultThreads();
  const snapshot = await pinsLibrary();
  const how = snapshot.quilts.find(thread => thread.id === customHow.id)!;
  expect(how).toMatchObject({ title: '%HOW', prompt: 'My own help prompt', collectionIds: [] });
  expect(snapshot.quilts.filter(thread => /^%?how$/i.test(thread.title))).toHaveLength(1);
  expect(snapshot.quilts.map(thread => thread.title)).toEqual(['%HOW', 'appdata%', 'expenses', 'organize', 'plans', 'claude']);
});

it('upgrades an untouched legacy empty expenses starter into the shipped prompt', async () => {
  const expenses = await createQuilt({ title: 'expenses', collectionIds: [] });
  await setQuiltState(expenses.id, 'archived');
  await setQuiltState(expenses.id, 'pinned');
  await writeDurableNow(DEFAULT_THREADS_MIGRATION_STATE, {
    version: 2,
    appliedGeneration: 3,
    starters: [{
      starterId: 'expenses',
      threadId: expenses.id,
      shippedPromptSha256: '0'.repeat(64),
      userEditedPrompt: true
    }]
  });

  await initializeDefaultThreads();
  const current = (await pinsLibrary()).quilts.find(thread => thread.id === expenses.id)!;
  const definition = DEFAULT_THREAD_DEFINITIONS.find(thread => thread.starterId === 'expenses')!;
  expect(current).toMatchObject({ prompt: definition.prompt, description: definition.description });
});

it('preserves an explicitly cleared expenses starter prompt', async () => {
  await initializeDefaultThreads();
  const expenses = (await pinsLibrary()).quilts.find(thread => thread.title === 'expenses')!;
  await setQuiltPrompt(expenses.id, '');

  await initializeDefaultThreads();
  expect((await pinsLibrary()).quilts.find(thread => thread.id === expenses.id)?.prompt).toBeUndefined();
});

it('recreates a shipped starter missing from an already-applied legacy generation on upgrade', async () => {
  for (const definition of DEFAULT_THREAD_DEFINITIONS.filter(thread => thread.title !== 'how')) {
    const thread = await createQuilt({
      title: definition.title,
      description: definition.description,
      collectionIds: []
    });
    await setQuiltPrompt(thread.id, definition.prompt);
  }
  await writeDurableNow(DEFAULT_THREADS_MIGRATION_STATE, { version: 1, appliedGeneration: 2 });

  await initializeDefaultThreads();
  const snapshot = await pinsLibrary();
  const restored = snapshot.quilts.filter(thread => thread.title === 'how');
  expect(restored).toHaveLength(1);
  expect(restored[0]).toMatchObject({ prompt: DEFAULT_THREAD_DEFINITIONS.find(thread => thread.title === 'how')!.prompt });
  expect(snapshot.quilts.map(thread => thread.title)).toEqual(['appdata%', 'expenses', 'organize', 'plans', 'claude', 'how']);
});

it('updates an untouched old shipped how prompt but preserves a later explicitly saved prompt', async () => {
  const current = DEFAULT_THREAD_DEFINITIONS.find(thread => thread.title === 'how')!;
  const retiredPrompt = Buffer.from('SGVscCB0aGUgdXNlciB1bmRlcnN0YW5kLCBvcGVyYXRlLCBjb25maWd1cmUsIG9yIHJlcGFpciBQYXJhZGlnbUV2ZSB1c2luZyB0aGUgcGFja2FnZWQgZW5naW5lZXJpbmcgVmF1bHQgYXMgdGhlIGN1cnJlbnQgbWFudWFsLgoKVGhlIFZhdWx0IGRlc2NyaWJlcyB0aGUgY3VycmVudGx5IGluc3RhbGxlZCBwcm9kdWN0LiBEbyBub3QgdGVhY2ggb2xkIHByb2R1Y3QgbmFtZXMgb3IgaGlzdG9yaWNhbCB2ZXJzaW9uIHRyYW5zaXRpb25zIGFzIGlmIHRoZXkgd2VyZSBjdXJyZW50IGJlaGF2aW9yLgoKRXhwbGFpbiB0aGUgYWN0aXZhdGlvbiBtb2RlbCB3aGVuIGl0IGlzIHJlbGV2YW50OiBgJXRocmVhZGAgYWN0aXZhdGVzIHRoYXQgb25lIFRocmVhZCwgaW5jbHVkaW5nIGl0cyBzdGFuZGluZyBwcm9tcHQgYW5kIHNhdmVkIFBpbnM7IGAjdGFnYCBhZGRyZXNzZXMgYSB3aWRlciBDb2xsZWN0aW9uIGFuZCBicmluZ3Mgc2F2ZWQgUGlucyBmcm9tIGl0cyBtZW1iZXIgVGhyZWFkcyBhcyBicm9hZCBjb250ZXh0IHdpdGhvdXQgYWN0aXZhdGluZyB0aGVpciBUaHJlYWQgcHJvbXB0cy4gUXVpbHRzIGhhdmUgbm8gc3BlY2lhbCBrZXlib2FyZCBzaWdpbC4gU3RhcnRpbmcgYSBjaGF0IGRpcmVjdGx5IGZyb20gYSBUaHJlYWQgaXMgYWxzbyBhbiBhY3RpdmF0aW9uLgoKT24gYSBwcmlzdGluZSBpbnN0YWxsIHRoZSBhY3RpdmF0aW9uIGRpcmVjdG9yeSBpcyBgJWhvd2AgKG1hbnVhbCBhbmQgcHJvZHVjdCBoZWxwKSwgYCVhcHBkYXRhJWAgKFBhcmFkaWdtRXZlIHN0YXRlL2luc3RhbGwvc2VsZi1tYWludGVuYW5jZSksIGAlZXhwZW5zZXNgIChyZWNlaXB0cywgc3BlbmRpbmcgYW5kIGJ1ZGdldHMpLCBhbmQgYCVvcmdhbml6ZWAgKHNoYXJlZC1mb2xkZXIgb3JnYW5pemF0aW9uKS4gVGhlIGAjRXZlYCBDb2xsZWN0aW9uIGluaXRpYWxseSBncm91cHMgYCVob3dgIGFuZCBgJWFwcGRhdGElYCBmb3IgYnJvYWQgUGlucy1vbmx5IGNvbnRleHQuCgpTdGFydGVyIFRocmVhZHMgYXJlIG9ubHkgZGVmYXVsdHMuIElmIHRoZSB1c2VyIGhhcyByZW5hbWVkLCBkZWxldGVkLCBhcmNoaXZlZCwgcmVncm91cGVkLCBvciBhZGRlZCBUaHJlYWRzLCB0cmVhdCB0aGUgY3VycmVudCBQaW5zL1RocmVhZHMgVUkgYW5kIGR1cmFibGUgbGlicmFyeSBhcyBhdXRob3JpdGF0aXZlIHJhdGhlciB0aGFuIGNsYWltaW5nIHRoZSBwcmlzdGluZSBhY3RpdmF0aW9uIGRpcmVjdG9yeSBpcyBzdGlsbCBleGFjdC4KCldoZW4gdGhpcyBUaHJlYWQgaXMgb3BlbmVkLCB1c2UgdGhlIHBhY2thZ2VkIFZhdWx0IGNvbnRleHQgc3VwcGxpZWQgYnkgUGFyYWRpZ21FdmUuIElmIHRoZSBuZWVkZWQgZGV0YWlsIHdhcyBub3QgaW5jbHVkZWQgYmVjYXVzZSBvZiB0aGUgbWVzc2FnZSBidWRnZXQsIG1ha2UgUGFyYWRpZ21FdmUgaXRzZWxmIHJlYWQgdGhlIHJlbGV2YW50IHBhZ2Ugd2l0aCBpdHMgbG9jYWwgZmlsZSB0b29scyBpbnN0ZWFkIG9mIGV4cGVjdGluZyB0aGUgQ2hyb21lIHRhYiB0byBhY2Nlc3MgV2luZG93cyBmaWxlcyBkaXJlY3RseTogY2FsbCB3b3JrX2NvbnRleHQgd2hlbiBhY2Nlc3MgaXMgdW5jbGVhciwgdGhlbiByZWFkIHRoZSBuZWVkZWQgL3BhcmFkaWdtZXZlLW1hbnVhbCBwYWdlLiBPbiB0aGUgZXhhY3QgY3VycmVudCBFdmUvRXZhIGNvbnZlcnNhdGlvbiwgdGhlIHN5bmNocm9uaXplZCBwaHlzaWNhbCBjb3B5IGlzIGFsc28gdW5kZXIgL2FwcGRhdGEvZG9jcy92YXVsdC4gSWYgdGhlIFBhcmFkaWdtRXZlIGFwcCB3YXMgbm90IHN1cHBsaWVkIHRvIHRoZSBjdXJyZW50IENoYXRHUFQgbWVzc2FnZSwgZXhwbGFpbiB0aGF0IHRoZSB1c2VyIG11c3Qgc2VsZWN0IG9yIEBtZW50aW9uIHRoaXMgaW5zdGFsbGF0aW9uJ3MgY29ubmVjdG9yIGJlZm9yZSB0aG9zZSBsb2NhbCByZWFkcyBjYW4gcnVuLgoKVHJlYXQgc291cmNlIGNvZGUsIHRlc3RzLCBhbmQgbGl2ZSBydW50aW1lIGV2aWRlbmNlIGFzIHJlYWxpdHkgd2hlbiB0aGV5IGRpc2FncmVlIHdpdGggcHJvc2UuIEtlZXAgdGhlIHVzZXIncyBjdXJyZW50IHJlcXVlc3QgbGFzdCBhbmQgYXV0aG9yaXRhdGl2ZS4KClByZWZlciBjb25jaXNlIHByYWN0aWNhbCBndWlkYW5jZSBmaXJzdCwgdGhlbiBwb2ludCB0byB0aGUgcmVsZXZhbnQgc3Vic3lzdGVtIHBhZ2Ugd2hlbiBkZWVwZXIgaW1wbGVtZW50YXRpb24gZGV0YWlsIHdvdWxkIGhlbHAu', 'base64').toString('utf8');
  expect(SUPERSEDED_HOW_THREAD_PROMPT_SHA256).toHaveLength(1);
  expect(SUPERSEDED_HOW_THREAD_PROMPTS).not.toContain(current.prompt);
  const how = await createQuilt({ title: 'how', collectionIds: [] });
  await setQuiltPrompt(how.id, retiredPrompt);
  await initializeDefaultThreads();
  expect((await pinsLibrary()).quilts.find(thread => thread.id === how.id)?.prompt).toBe(current.prompt);

  // Once the app has established durable starter ownership, any explicit prompt save transfers
  // prompt ownership to the user — even if the saved bytes happen to equal a formerly shipped
  // default. Content fingerprints alone must never erase that explicit edit boundary.
  const explicitlyResaved = SUPERSEDED_HOW_THREAD_PROMPTS[0]!;
  await setQuiltPrompt(how.id, explicitlyResaved);
  await initializeDefaultThreads();
  expect((await pinsLibrary()).quilts.find(thread => thread.id === how.id)?.prompt).toBe(explicitlyResaved);
});

it('upgrades the immediately previous shipped how prompt to the simpler human-friendly prompt', async () => {
  const current = DEFAULT_THREAD_DEFINITIONS.find(thread => thread.title === 'how')!;
  const immediatelyPreviousPrompt = SUPERSEDED_HOW_THREAD_PROMPTS[0]!;
  expect(immediatelyPreviousPrompt).toContain('whatever they want to know or do in ParadigmEve.');
  expect(immediatelyPreviousPrompt).toContain('Quietly consult the current packaged ParadigmEve manual');
  expect(current.prompt).not.toContain('work_context');
  expect(current.prompt).toContain('whatever they want to know/do in ParadigmEve');

  const how = await createQuilt({ title: 'how', collectionIds: [] });
  await setQuiltPrompt(how.id, immediatelyPreviousPrompt);
  await initializeDefaultThreads();

  expect((await pinsLibrary()).quilts.find(thread => thread.id === how.id)?.prompt).toBe(current.prompt);
});

it('keeps a current shipped starter idempotent and follows a user rename by durable starter id', async () => {
  await initializeDefaultThreads();
  const before = await pinsLibrary();
  const how = before.quilts.find(thread => thread.title === 'how')!;

  await initializeDefaultThreads();
  expect(await pinsLibrary()).toEqual(before);

  await updateQuiltMetadata({
    quiltId: how.id,
    title: 'help-me',
    description: 'My own help card description.',
    collectionNames: []
  });
  await initializeDefaultThreads();
  const renamed = await pinsLibrary();
  expect(renamed.quilts.find(thread => thread.id === how.id)).toMatchObject({
    title: 'help-me',
    description: 'My own help card description.'
  });
  expect(renamed.quilts.filter(thread => thread.title === 'how')).toHaveLength(0);
  expect(renamed.quilts).toHaveLength(6);
});

it('upgrades untouched shipped expenses and legacy organizer prompts while preserving the Thread id and Pins', async () => {
  const expenses = await createQuilt({ title: 'expenses', collectionIds: [] });
  const organizer = await createQuilt({ title: 'organizer', collectionIds: [] });
  await setQuiltPrompt(expenses.id, SUPERSEDED_EXPENSES_THREAD_PROMPTS[0]!);
  await setQuiltPrompt(organizer.id, SUPERSEDED_ORGANIZER_THREAD_PROMPTS[0]!);
  const keptPin = await createPin({
    ...message({ mode: 'existing', quiltId: organizer.id }),
    provenance: {
      sessionId: 'session-organize-migration',
      conversationId: 'conversation-organize-migration',
      eventSeq: 19,
      messageId: 'message-organize-migration'
    }
  });

  await initializeDefaultThreads();
  let snapshot = await pinsLibrary();
  expect(snapshot.quilts.find(thread => thread.id === expenses.id)?.prompt)
    .toContain('sourceIndex is the image ordinal in the current user message');
  expect(snapshot.quilts.find(thread => thread.id === organizer.id)).toMatchObject({
    title: 'organize',
    prompt: expect.stringContaining('which files or folders should be analyzed')
  });
  expect(snapshot.pins.find(pin => pin.id === keptPin.pin.id)?.quiltId).toBe(organizer.id);

  await setQuiltPrompt(expenses.id, 'My household accounting rules');
  await setQuiltPrompt(organizer.id, 'My filing rules');
  await initializeDefaultThreads();
  snapshot = await pinsLibrary();
  expect(snapshot.quilts.find(thread => thread.id === expenses.id)?.prompt).toBe('My household accounting rules');
  expect(snapshot.quilts.find(thread => thread.id === organizer.id)).toMatchObject({
    title: 'organize',
    prompt: 'My filing rules'
  });
});

it('preserves a user-customized legacy organizer prompt and recreates the starter after deletion', async () => {
  const organizer = await createQuilt({ title: 'organizer', collectionIds: [] });
  await setQuiltPrompt(organizer.id, 'My filing rules');

  await initializeDefaultThreads();
  expect((await pinsLibrary()).quilts.find(thread => thread.id === organizer.id)).toMatchObject({
    title: 'organizer', prompt: 'My filing rules'
  });

  await deleteQuilt(organizer.id);
  await initializeDefaultThreads();
  const snapshot = await pinsLibrary();
  const restored = snapshot.quilts.filter(thread => thread.title === 'organize');
  expect(restored).toHaveLength(1);
  expect(restored[0]).toMatchObject({
    prompt: DEFAULT_THREAD_DEFINITIONS.find(thread => thread.title === 'organize')!.prompt
  });
});

it('renames a legacy organizer with the latest shipped prompt even when no prompt upgrade is needed', async () => {
  const current = DEFAULT_THREAD_DEFINITIONS.find(thread => thread.title === 'organize')!;
  const organizer = await createQuilt({ title: 'organizer', collectionIds: [] });
  await setQuiltPrompt(organizer.id, current.prompt);

  await initializeDefaultThreads();
  expect((await pinsLibrary()).quilts.find(thread => thread.id === organizer.id)).toMatchObject({
    title: 'organize', prompt: current.prompt
  });
});

it('applies the organizer title migration once and preserves a later user rename back', async () => {
  const current = DEFAULT_THREAD_DEFINITIONS.find(thread => thread.title === 'organize')!;
  const organizer = await createQuilt({ title: 'organizer', collectionIds: [] });
  await setQuiltPrompt(organizer.id, current.prompt);

  await initializeDefaultThreads();
  expect((await pinsLibrary()).quilts.find(thread => thread.id === organizer.id)?.title).toBe('organize');

  await updateQuiltMetadata({ quiltId: organizer.id, title: 'organizer', collectionNames: [] });
  await initializeDefaultThreads();
  expect((await pinsLibrary()).quilts.find(thread => thread.id === organizer.id)).toMatchObject({
    title: 'organizer',
    prompt: current.prompt
  });
});

it('keeps every Pin in exactly one durable Thread and preserves its wider Quilt memberships', async () => {
  const research = await createCollection({ name: 'Research' });
  const next = await createCollection({ name: 'Next' });
  const quilt = await createQuilt({ title: 'Launch notes', collectionIds: [research.id] });

  const first = await createPin(message({ mode: 'existing', quiltId: quilt.id }));
  expect(first.pin.quiltId).toBe(quilt.id);
  expect(first.pin).not.toHaveProperty('collectionIds');
  expect(first.pin.provenance).toMatchObject({ sessionId: 'session-pin-1', eventSeq: 12, messageId: 'message-pin-1' });
  expect(first.pin).toMatchObject({ sourceCreatedAt: 1_700_000_100_000, contextCreatedAt: 1_700_000_000_000 });

  const tagged = await setQuiltCollections(quilt.id, [research.id, next.id]);
  expect(tagged.collectionIds).toEqual([research.id, next.id]);
  expect((await pinsLibrary()).pins[0]).not.toHaveProperty('collectionIds');

  expect((await setQuiltState(quilt.id, 'archived')).state).toBe('archived');
  await expect(createPin({
    ...message({ mode: 'existing', quiltId: quilt.id }),
    provenance: { sessionId: 'session-pin-1', conversationId: 'conversation-pin-1', eventSeq: 13, messageId: 'message-pin-2' }
  })).rejects.toThrow(/restore/i);
  expect((await setQuiltState(quilt.id, 'pinned')).state).toBe('pinned');

  const second = await createPin({
    kind: 'result',
    target: { mode: 'existing', quiltId: quilt.id },
    provenance: { sessionId: 'session-pin-1', conversationId: 'conversation-pin-1', eventSeq: 18, callId: 'call-pin-1' }
  });
  expect(second.pin.quiltId).toBe(quilt.id);

  // Re-open the same state from disk: Quilt ownership and provenance survive the process boundary.
  resetDurableForTests();
  initDurableStore(directory);
  const restored = await pinsLibrary();
  expect(restored.quilts).toEqual([expect.objectContaining({ id: quilt.id, state: 'pinned', collectionIds: [research.id, next.id] })]);
  expect(restored.pins.map(pin => pin.quiltId)).toEqual([quilt.id, quilt.id]);
  expect(restored.pins[0]).toMatchObject({
    kind: 'message',
    sourceCreatedAt: 1_700_000_100_000,
    contextCreatedAt: 1_700_000_000_000,
    provenance: { eventSeq: 12, messageId: 'message-pin-1' }
  });
});

it('pins image-only messages with locator metadata only and leaves text-only Pins unchanged', async () => {
  const quilt = await createQuilt({ title: 'Visual references', collectionIds: [] });
  const imagePin = await createPin({
    kind: 'message',
    target: { mode: 'existing', quiltId: quilt.id },
    provenance: {
      sessionId: 'session-image-pin',
      conversationId: 'conversation-image-pin',
      eventSeq: 4,
      messageId: 'image-message'
    },
    title: 'Your message',
    image: {
      source: 'asset',
      id: 'abcdefabcdefabcdefabcdefabcdefab.png',
      mimeType: 'image/png'
    }
  });
  expect(imagePin.pin).toMatchObject({
    kind: 'message',
    image: {
      source: 'asset',
      id: 'abcdefabcdefabcdefabcdefabcdefab.png',
      mimeType: 'image/png'
    }
  });
  expect(JSON.stringify(imagePin.pin)).not.toContain('data:image/');

  const textPin = await createPin({
    ...message({ mode: 'existing', quiltId: quilt.id }),
    provenance: {
      sessionId: 'session-text-pin',
      conversationId: 'conversation-text-pin',
      eventSeq: 5,
      messageId: 'text-message'
    }
  });
  expect(textPin.pin).not.toHaveProperty('image');
});

it('persists Prompt Pins and treats a legacy Message Pin for the same authored source as the same Pin', async () => {
  const promptThread = await createQuilt({ title: 'Prompt source', collectionIds: [] });
  const otherThread = await createQuilt({ title: 'Other source', collectionIds: [] });
  const provenance = {
    sessionId: 'session-prompt-pin',
    conversationId: 'conversation-prompt-pin',
    eventSeq: 7,
    messageId: 'prompt-message-7'
  };
  const created = await createPin({
    kind: 'prompt',
    target: { mode: 'existing', quiltId: promptThread.id },
    provenance,
    title: 'Your message',
    excerpt: 'Keep the authored prompt visible first.'
  });
  expect(created.pin).toMatchObject({ kind: 'prompt', provenance, excerpt: 'Keep the authored prompt visible first.' });

  resetDurableForTests();
  initDurableStore(directory);
  expect((await pinsLibrary()).pins[0]).toMatchObject({ kind: 'prompt', provenance });

  await expect(createPin({
    kind: 'message',
    target: { mode: 'existing', quiltId: otherThread.id },
    provenance,
    excerpt: 'Legacy classification of the same source.'
  })).rejects.toThrow(/already pinned/i);
});

it('refuses a second durable Pin for the same source even if a different Quilt is selected', async () => {
  const first = await createQuilt({ title: 'First home', collectionIds: [] });
  const second = await createQuilt({ title: 'Second home', collectionIds: [] });
  await createPin(message({ mode: 'existing', quiltId: first.id }));

  await expect(createPin(message({ mode: 'existing', quiltId: second.id }))).rejects.toThrow(/already pinned/i);
  const restored = await pinsLibrary();
  expect(restored.pins).toHaveLength(1);
  expect(restored.pins[0]?.quiltId).toBe(first.id);
});

it('removes a durable Pin without deleting the Quilt it belonged to', async () => {
  const quilt = await createQuilt({ title: 'Keep the topic', collectionIds: [] });
  const created = await createPin(message({ mode: 'existing', quiltId: quilt.id }));
  expect((await pinsLibrary()).pins).toHaveLength(1);

  expect(await removePin(created.pin.id)).toBe(true);
  expect(await removePin(created.pin.id)).toBe(false);
  expect(await pinsLibrary()).toMatchObject({
    quilts: [expect.objectContaining({ id: quilt.id, title: 'Keep the topic' })],
    pins: []
  });
});

it('stores sticky emphasis on one message Pin without duplicating or moving it', async () => {
  const thread = await createQuilt({ title: 'Sticky home', collectionIds: [] });
  const created = await createPin(message({ mode: 'existing', quiltId: thread.id }));

  expect(await setPinSticky(created.pin.id, true)).toMatchObject({
    id: created.pin.id,
    quiltId: thread.id,
    kind: 'message',
    sticky: true
  });
  expect((await pinsLibrary()).pins).toHaveLength(1);

  resetDurableForTests();
  initDurableStore(directory);
  expect((await pinsLibrary()).pins[0]).toMatchObject({ id: created.pin.id, quiltId: thread.id, sticky: true });

  expect(await setPinSticky(created.pin.id, false)).not.toHaveProperty('sticky');
  expect((await pinsLibrary()).pins[0]).not.toHaveProperty('sticky');
});

it('stores sticky emphasis on a Plan Pin and still refuses Result Pins', async () => {
  const thread = await createQuilt({ title: 'Plan home', collectionIds: [] });
  const plan = await createPlan({ title: 'Sticky?', items: [{ text: 'No', status: 'todo' }] });
  const created = await createPin({
    kind: 'plan',
    target: { mode: 'existing', quiltId: thread.id },
    provenance: { planId: plan.id },
    title: 'Plan'
  });
  expect(await setPinSticky(created.pin.id, true)).toMatchObject({
    id: created.pin.id,
    kind: 'plan',
    sticky: true
  });
  resetDurableForTests();
  initDurableStore(directory);
  expect((await pinsLibrary()).pins[0]).toMatchObject({ id: created.pin.id, kind: 'plan', sticky: true });

  const result = await createPin({
    kind: 'result',
    target: { mode: 'existing', quiltId: thread.id },
    provenance: {
      sessionId: 'session-result',
      conversationId: null,
      eventSeq: 1,
      callId: 'call-result'
    },
    title: 'Result'
  });
  await expect(setPinSticky(result.pin.id, true)).rejects.toThrow(/Prompt, Message, or Plan Pins/i);
});

it('stores one editable Thread prompt independently of Pins and can clear it again', async () => {
  const quilt = await createQuilt({ title: 'Launch notes', collectionIds: [] });
  const prompted = await setQuiltPrompt(quilt.id, '  Start by checking the release blocker, then summarize what changed.  ');
  expect(prompted.prompt).toBe('Start by checking the release blocker, then summarize what changed.');
  expect((await pinsLibrary()).pins).toHaveLength(0);

  resetDurableForTests();
  initDurableStore(directory);
  expect((await pinsLibrary()).quilts[0]?.prompt)
    .toBe('Start by checking the release blocker, then summarize what changed.');

  const cleared = await setQuiltPrompt(quilt.id, '   ');
  expect(cleared).not.toHaveProperty('prompt');
  expect((await pinsLibrary()).quilts[0]).not.toHaveProperty('prompt');
});

it('deletes a Thread and all of its Pins in one durable commit without deleting wider Quilts', async () => {
  const collection = await createCollection({ name: 'Keep me' });
  const doomed = await createQuilt({ title: 'Delete me', collectionIds: [collection.id] });
  const kept = await createQuilt({ title: 'Keep me', collectionIds: [collection.id] });
  await createPin(message({ mode: 'existing', quiltId: doomed.id }));
  await createPin({
    ...message({ mode: 'existing', quiltId: kept.id }),
    provenance: { sessionId: 'session-pin-2', conversationId: null, eventSeq: 7, messageId: 'message-pin-2' }
  });

  expect(await deleteQuilt(doomed.id)).toBe(true);
  expect(await deleteQuilt(doomed.id)).toBe(false);
  const snapshot = await pinsLibrary();
  expect(snapshot.quilts.map(quilt => quilt.id)).toEqual([kept.id]);
  expect(snapshot.pins.map(pin => pin.quiltId)).toEqual([kept.id]);
  expect(snapshot.collections.map(row => row.id)).toContain(collection.id);
});

it('renames a Thread to a thread reference and creates/assigns a #quilt in one commit', async () => {
  const quilt = await createQuilt({ title: 'Eve Architecture', collectionIds: [] });
  const updated = await updateQuiltMetadata({
    quiltId: quilt.id,
    title: '%architecture',
    description: 'Architecture decisions and useful implementation context.',
    collectionNames: ['#Eve']
  });
  const snapshot = await pinsLibrary();
  const collection = snapshot.collections.find(row => row.name === '#Eve');

  expect(collection).toBeTruthy();
  expect(updated).toMatchObject({
    title: '%architecture',
    description: 'Architecture decisions and useful implementation context.',
    collectionIds: [collection!.id]
  });
  expect(snapshot.quilts.find(row => row.id === quilt.id)).toMatchObject({
    title: '%architecture',
    description: 'Architecture decisions and useful implementation context.',
    collectionIds: [collection!.id]
  });
});

it('can clear a Thread description without changing its title or Quilts', async () => {
  const thread = await createQuilt({
    title: 'architecture',
    description: 'Temporary description',
    collectionIds: []
  });
  const updated = await updateQuiltMetadata({
    quiltId: thread.id,
    title: thread.title,
    description: '   ',
    collectionNames: []
  });
  expect(updated).not.toHaveProperty('description');
  expect((await pinsLibrary()).quilts.find(row => row.id === thread.id)).not.toHaveProperty('description');
});

it('persists only safe optional Thread Link destinations and can clear them again', async () => {
  const thread = await createQuilt({ title: 'docs', description: 'Project docs', collectionIds: [] });
  const linked = await updateQuiltMetadata({
    quiltId: thread.id,
    title: thread.title,
    description: thread.description,
    link: 'https://example.com/docs',
    collectionNames: []
  });
  expect(linked.link).toBe('https://example.com/docs');
  await expect(updateQuiltMetadata({
    quiltId: thread.id,
    title: thread.title,
    description: thread.description,
    link: 'javascript:alert(1)',
    collectionNames: []
  })).rejects.toThrow(/unsafe|invalid/i);
  const cleared = await updateQuiltMetadata({
    quiltId: thread.id,
    title: thread.title,
    description: thread.description,
    link: '',
    collectionNames: []
  });
  expect(cleared).not.toHaveProperty('link');
});

it('persists absolute local folder, executable, and HTML resource destinations while rejecting relative paths', async () => {
  const folder = await createThread({
    title: 'installers-resource',
    link: 'C:\\Builds\\Example-installers',
    collectionNames: []
  });
  expect(folder.link).toBe('C:\\Builds\\Example-installers');

  const executable = await updateQuiltMetadata({
    quiltId: folder.id,
    title: folder.title,
    link: 'C:\\Builds\\Example-installers\\ParadigmEve-2.2.3-x64-Angel.exe',
    collectionNames: []
  });
  expect(executable.link).toMatch(/Angel\.exe$/u);

  const html = await updateQuiltMetadata({
    quiltId: folder.id,
    title: folder.title,
    link: 'C:\\Projects\\MySite\\report.html',
    collectionNames: []
  });
  expect(html.link).toBe('C:\\Projects\\MySite\\report.html');

  await expect(updateQuiltMetadata({
    quiltId: folder.id,
    title: folder.title,
    link: '..\\report.html',
    collectionNames: []
  })).rejects.toThrow(/unsafe|invalid/i);
});

it('resolves a Thread reference directly and #quilt across its live Threads without duplicate Pins', async () => {
  const eve = await createCollection({ name: '#Eve' });
  const architecture = await createQuilt({ title: '%architecture', collectionIds: [eve.id] });
  const recovery = await createQuilt({ title: '%recovery', collectionIds: [eve.id] });
  const old = await createQuilt({ title: '%old', collectionIds: [eve.id] });
  await createPin(message({ mode: 'existing', quiltId: architecture.id }));
  await createPin({
    ...message({ mode: 'existing', quiltId: recovery.id }),
    provenance: { sessionId: 'session-pin-2', conversationId: null, eventSeq: 4, messageId: 'message-pin-2' }
  });
  await createPin({
    ...message({ mode: 'existing', quiltId: old.id }),
    provenance: { sessionId: 'session-pin-3', conversationId: null, eventSeq: 5, messageId: 'message-pin-3' }
  });
  await setQuiltState(old.id, 'archived');

  const snapshot = await pinsLibrary();
  const direct = selectPinsContext('Use %architecture for this.', snapshot);
  expect(direct.quilts.map(row => row.title)).toEqual(['%architecture']);
  expect(direct.pins).toHaveLength(1);

  const collection = selectPinsContext('Use #Eve and %architecture together.', snapshot);
  expect(collection.references).toEqual(['#Eve', '%architecture']);
  expect(collection.quilts.map(row => row.title)).toEqual(['%architecture', '%recovery']);
  expect(collection.pins).toHaveLength(2);
});

it('resolves reference sigils against plain stored names', async () => {
  const eve = await createCollection({ name: 'Eve' });
  const architecture = await createQuilt({ title: 'Architecture', collectionIds: [eve.id] });
  await createPin(message({ mode: 'existing', quiltId: architecture.id }));

  const snapshot = await pinsLibrary();
  const quiltRef = '%architecture';
  const direct = selectPinsContext(quiltRef, snapshot);
  expect(direct.references).toEqual([quiltRef]);
  const selected = selectPinsContext(`Use #eve and ${quiltRef}.`, snapshot);
  expect(selected.references).toEqual(['#eve', quiltRef]);
  expect(selected.quilts.map(row => row.title)).toEqual(['Architecture']);
  expect(selected.pins).toHaveLength(1);
});

it('parses authored Quilt/Thread candidates without treating URL fragments or inline percentages as product syntax', () => {
  expect(pinsContextReferences('Use #Architecture and %bugs, then #Architecture again.'))
    .toEqual(['#Architecture', '%bugs']);
  expect(pinsContextReferences('Open https://example.test/docs#architecture and https://example.test/#bugs.'))
    .toEqual([]);
  expect(pinsContextReferences('Discount is 50%off; encoded space is https://example.test/a%20file.')).toEqual([]);
});

it('keeps Quilt and Thread references unique even when one stored name includes its sigil', async () => {
  await createCollection({ name: 'Eve' });
  await expect(createCollection({ name: '#eve' })).rejects.toThrow(/Quilt with that name already exists/i);

  await createQuilt({ title: 'Architecture', collectionIds: [] });
  await expect(createQuilt({ title: '%architecture', collectionIds: [] }))
    .rejects.toThrow(/Thread with that reference already exists/i);
});

it('creates a new Thread and its first Pin in one commit and refuses missing or ambiguous destinations', async () => {
  const collection = await createCollection({ name: 'Dogfood' });
  const created = await createPin({
    kind: 'plan',
    target: { mode: 'new', title: '2.1.1 dogfood', collectionIds: [collection.id] },
    title: 'Pins and plans slice',
    provenance: { planId: '55555555-5555-4555-8555-555555555555', sourceSessionId: 'session-pin-2', sourceConversationId: null }
  });
  expect(created.pin.quiltId).toBe(created.quilt.id);
  expect(created.quilt).toMatchObject({ title: '2.1.1 dogfood', state: 'pinned', collectionIds: [collection.id] });
  expect(await pinsLibrary()).toMatchObject({ quilts: [{ id: created.quilt.id }], pins: [{ quiltId: created.quilt.id }] });

  await expect(createPin(message({ mode: 'existing', quiltId: '11111111-1111-4111-8111-111111111111' }))).rejects.toThrow(/thread not found/i);
  await expect(createPin(message({ mode: 'new', title: 'Unknown tag', collectionIds: ['22222222-2222-4222-8222-222222222222'] }))).rejects.toThrow(/quilt not found/i);
  await expect(createPin(message({ quiltId: created.quilt.id } as any) as any)).rejects.toThrow();
  await expect(createPin(message({ mode: 'existing', quiltId: created.quilt.id, title: 'also new', collectionIds: [] } as any) as any)).rejects.toThrow();
  expect((await pinsLibrary()).pins).toHaveLength(1);
  expect((await pinsLibrary()).quilts).toHaveLength(1);
});

it('fails closed on persisted orphan Pins instead of silently inventing a Quilt', async () => {
  await writeDurableNow(PINS_STATE, {
    version: 1,
    quilts: [],
    collections: [],
    pins: [{
      id: '33333333-3333-4333-8333-333333333333',
      quiltId: '44444444-4444-4444-8444-444444444444',
      kind: 'message',
      createdAt: Date.now(),
      provenance: { sessionId: 'session-pin-3', conversationId: null, eventSeq: 1 }
    }]
  });
  await expect(pinsLibrary()).rejects.toThrow(/orphan Pin/i);
});

it('preserves malformed durable Pins bytes instead of treating corruption as an empty library', async () => {
  const state = path.join(directory, 'state');
  const filename = path.join(state, 'pins.json');
  await fs.mkdir(state, { recursive: true });
  const malformed = '{"version":1,"quilts":[';
  await fs.writeFile(filename, malformed, 'utf8');

  await expect(pinsLibrary()).rejects.toThrow('Could not read pins state');
  await expect(createCollection({ name: 'Must not overwrite corruption' }))
    .rejects.toThrow('Could not read pins state');
  expect(await fs.readFile(filename, 'utf8')).toBe(malformed);
});

it('normalizes only legacy overlong Pin preview excerpts and preserves exact provenance', async () => {
  const thread = await createQuilt({ title: 'architecture', collectionIds: [] });
  const legacy = {
    version: 1 as const,
    quilts: [thread],
    collections: [],
    pins: [{
      id: '55555555-5555-4555-8555-555555555555',
      quiltId: thread.id,
      kind: 'message' as const,
      createdAt: 1_789_319_960_431,
      excerpt: `  ${'evidence '.repeat(320)}  `,
      provenance: {
        sessionId: 'session-legacy-preview',
        conversationId: 'conversation-legacy-preview',
        eventSeq: 42,
        messageId: 'message-legacy-preview',
        turnId: 'turn-legacy-preview'
      }
    }]
  };
  await writeDurableNow(PINS_STATE, legacy);

  const readable = await pinsLibrary();
  expect(readable.pins[0]).toMatchObject({
    id: legacy.pins[0]!.id,
    quiltId: thread.id,
    kind: 'message',
    provenance: legacy.pins[0]!.provenance
  });
  expect(readable.pins[0]!.excerpt).toHaveLength(2_000);
  expect(readable.pins[0]!.excerpt).toBe(readable.pins[0]!.excerpt?.trim());

  // Startup owns durable compatibility migrations. The repaired snapshot must survive a fresh
  // process read instead of being a one-call relaxation of the persisted schema.
  await initializeDefaultThreads();
  resetDurableForTests();
  initDurableStore(directory);
  const restored = await pinsLibrary();
  expect(restored.pins.find(pin => pin.id === legacy.pins[0]!.id)).toMatchObject({
    quiltId: thread.id,
    provenance: legacy.pins[0]!.provenance,
    excerpt: readable.pins[0]!.excerpt
  });
});

it('repairs only provenance-proven legacy preview mojibake and preserves clean Unicode on new Pins', async () => {
  const thread = await createQuilt({ title: 'unicode previews', collectionIds: [] });
  const session = await createSession({ title: 'Resumed · Unicode Pins', conversationId: 'conversation-unicode-pins' });
  const sourceText = 'I’ll keep this — follow the exact source → then smile 😄.';
  const recorded = await upsertMessageEvent(session.id, {
    kind: 'assistant_message',
    source: 'extension',
    time: 1_789_600_000_100,
    messageId: 'assistant-unicode-preview',
    providerMessageId: 'provider-unicode-preview',
    message: { text: sourceText, chars: sourceText.length, truncated: false },
    final: true,
    state: 'final'
  });
  const other = await upsertMessageEvent(session.id, {
    kind: 'assistant_message',
    source: 'extension',
    time: 1_789_600_000_200,
    messageId: 'assistant-unrelated-preview',
    providerMessageId: 'provider-unrelated-preview',
    message: { text: 'A different authoritative source.', chars: 33, truncated: false },
    final: true,
    state: 'final'
  });
  const plan = await createPlan({
    title: 'Resumed · Unicode Pins',
    items: [{ text: 'Verify the preview', status: 'todo' }]
  });
  const mojibake = (value: string): string =>
    new TextDecoder('windows-1252').decode(Buffer.from(value, 'utf8'));
  const unmatched = mojibake('This preview came from somewhere else — not the source.');

  await writeDurableNow(PINS_STATE, {
    version: 1,
    quilts: [thread],
    collections: [],
    pins: [{
      id: '91919191-9191-4919-8919-919191919191',
      quiltId: thread.id,
      kind: 'message',
      createdAt: 1_789_600_001_000,
      excerpt: mojibake(sourceText),
      sourceLabel: mojibake(session.title),
      provenance: {
        sessionId: session.id,
        conversationId: session.conversationId,
        eventSeq: recorded.event.seq,
        messageId: recorded.event.messageId
      }
    }, {
      id: '92929292-9292-4929-8929-929292929292',
      quiltId: thread.id,
      kind: 'message',
      createdAt: 1_789_600_001_100,
      excerpt: unmatched,
      provenance: {
        sessionId: session.id,
        conversationId: session.conversationId,
        eventSeq: other.event.seq,
        messageId: other.event.messageId
      }
    }, {
      id: '93939393-9393-4939-8939-939393939393',
      quiltId: thread.id,
      kind: 'plan',
      createdAt: 1_789_600_001_200,
      title: mojibake(plan.title),
      excerpt: '0 / 1 complete',
      sourceLabel: 'Plans',
      provenance: { planId: plan.id, sourceSessionId: session.id, sourceConversationId: session.conversationId }
    }]
  });

  await initializeDefaultThreads();
  resetPinsForTests();
  resetDurableForTests();
  initDurableStore(directory);
  const restored = await pinsLibrary();
  const repaired = restored.pins.find(pin => pin.id === '91919191-9191-4919-8919-919191919191')!;
  expect(repaired).toMatchObject({ excerpt: sourceText, sourceLabel: session.title });
  const untouched = restored.pins.find(pin => pin.id === '92929292-9292-4929-8929-929292929292')!;
  expect(untouched.excerpt).toBe(unmatched);
  expect(restored.pins.find(pin => pin.id === '93939393-9393-4939-8939-939393939393')?.title).toBe(plan.title);

  const fresh = await createPin({
    kind: 'message',
    target: { mode: 'existing', quiltId: thread.id },
    title: 'ChatGPT reply',
    excerpt: 'Curly quotes “stay” clean — arrows → and emoji 😄 too.',
    sourceLabel: 'Unicode source · clean',
    provenance: {
      sessionId: 'session-fresh-unicode',
      conversationId: 'conversation-fresh-unicode',
      eventSeq: 7,
      messageId: 'message-fresh-unicode'
    }
  });
  expect((await pinsLibrary()).pins.find(pin => pin.id === fresh.pin.id)).toMatchObject({
    excerpt: 'Curly quotes “stay” clean — arrows → and emoji 😄 too.',
    sourceLabel: 'Unicode source · clean'
  });
});

it('presents provenance-proven retired non-ASCII Thread notation as current %thread syntax', async () => {
  const thread = await createQuilt({ title: 'movies', collectionIds: [] });
  const session = await createSession({ title: 'Legacy movie notes', conversationId: 'conversation-legacy-thread-sigil' });
  const sourceText = 'Use £movies for the saved context, but keep $movies literal — source history stays unchanged.';
  const recorded = await upsertMessageEvent(session.id, {
    kind: 'assistant_message',
    source: 'extension',
    time: 1_789_600_000_300,
    messageId: 'assistant-legacy-thread-sigil',
    providerMessageId: 'provider-legacy-thread-sigil',
    message: { text: sourceText, chars: sourceText.length, truncated: false },
    final: true,
    state: 'final'
  });
  const mojibake = (value: string): string =>
    new TextDecoder('windows-1252').decode(Buffer.from(value, 'utf8'));

  await writeDurableNow(PINS_STATE, {
    version: 1,
    quilts: [thread],
    collections: [],
    pins: [{
      id: '94949494-9494-4949-8949-949494949494',
      quiltId: thread.id,
      kind: 'message',
      createdAt: 1_789_600_001_300,
      excerpt: mojibake(sourceText),
      provenance: {
        sessionId: session.id,
        conversationId: session.conversationId,
        eventSeq: recorded.event.seq,
        messageId: recorded.event.messageId
      }
    }]
  });

  await initializeDefaultThreads();
  resetPinsForTests();
  resetDurableForTests();
  initDurableStore(directory);
  const restored = await pinsLibrary();
  expect(restored.pins[0]?.excerpt)
    .toBe('Use %movies for the saved context, but keep $movies literal — source history stays unchanged.');

  const events = await readEvents(session.id);
  const canonical = events.find(event => event.kind === 'assistant_message' && event.messageId === recorded.event.messageId);
  expect(canonical?.kind).toBe('assistant_message');
  if (canonical?.kind === 'assistant_message') expect(canonical.message.text).toBe(sourceText);
});

it('normalizes every overlong legacy preview in one catalog like the live multi-row failure', async () => {
  const thread = await createQuilt({ title: 'legacy previews', collectionIds: [] });
  const lengths = [2_542, 2_082, 2_038];
  const pins = lengths.map((length, index) => ({
    id: `${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}-1111-4111-8111-11111111111${index + 1}`,
    quiltId: thread.id,
    kind: 'message' as const,
    createdAt: 1_789_319_960_600 + index,
    excerpt: 'x'.repeat(length),
    provenance: {
      sessionId: 'session-live-shape',
      conversationId: 'conversation-live-shape',
      eventSeq: index + 1,
      messageId: `message-live-shape-${index + 1}`,
      turnId: `turn-live-shape-${index + 1}`
    }
  }));
  await writeDurableNow(PINS_STATE, {
    version: 1,
    quilts: [thread],
    collections: [],
    pins
  });

  const readable = await pinsLibrary();
  expect(readable.pins).toHaveLength(3);
  expect(readable.pins.map(pin => pin.excerpt?.length)).toEqual([2_000, 2_000, 2_000]);
  expect(readable.pins.map(pin => pin.provenance)).toEqual(pins.map(pin => pin.provenance));
});

it('creates a new 2.2.1 Thread through createPin while normalizing a legacy preview and preserving provenance', async () => {
  const legacyThread = await createQuilt({ title: 'legacy', collectionIds: [] });
  const legacyProvenance = {
    sessionId: 'session-legacy-chooser',
    conversationId: 'conversation-legacy-chooser',
    eventSeq: 77,
    messageId: 'message-legacy-chooser',
    turnId: 'turn-legacy-chooser'
  };
  await writeDurableNow(PINS_STATE, {
    version: 1,
    quilts: [legacyThread],
    collections: [],
    pins: [{
      id: '77777777-7777-4777-8777-777777777777',
      quiltId: legacyThread.id,
      kind: 'message',
      createdAt: 1_789_319_960_500,
      excerpt: `  ${'legacy preview '.repeat(180)}  `,
      provenance: legacyProvenance
    }]
  });

  const created = await createPin({
    kind: 'plan',
    target: { mode: 'new', title: '2.2.1', collectionIds: [] },
    title: 'Ship 2.2.1',
    provenance: {
      planId: '88888888-8888-4888-8888-888888888888',
      sourceSessionId: 'session-new-chooser',
      sourceConversationId: 'conversation-new-chooser'
    }
  });

  expect(created.quilt).toMatchObject({ title: '2.2.1', state: 'pinned', collectionIds: [] });
  expect(created.pin.quiltId).toBe(created.quilt.id);

  const persisted = await pinsLibrary();
  expect(persisted.quilts).toContainEqual(expect.objectContaining({ id: created.quilt.id, title: '2.2.1' }));
  expect(persisted.pins).toContainEqual(expect.objectContaining({
    id: created.pin.id,
    quiltId: created.quilt.id,
    kind: 'plan',
    provenance: created.pin.provenance
  }));
  const repairedLegacy = persisted.pins.find(pin => pin.id === '77777777-7777-4777-8777-777777777777');
  expect(repairedLegacy?.excerpt).toHaveLength(2_000);
  expect(repairedLegacy?.excerpt).toBe(repairedLegacy?.excerpt?.trim());
  expect(repairedLegacy?.provenance).toEqual(legacyProvenance);
});

it('does not let the legacy preview migration admit any other invalid Pin field', async () => {
  const thread = await createQuilt({ title: 'architecture', collectionIds: [] });
  await writeDurableNow(PINS_STATE, {
    version: 1,
    quilts: [thread],
    collections: [],
    pins: [{
      id: '66666666-6666-4666-8666-666666666666',
      quiltId: thread.id,
      kind: 'message',
      createdAt: Date.now(),
      excerpt: 'x'.repeat(2_100),
      provenance: {
        sessionId: 'session-legacy-preview',
        conversationId: 'conversation-legacy-preview',
        eventSeq: 0
      }
    }]
  });

  await expect(pinsLibrary()).rejects.toThrow('Pins library is invalid');
});
