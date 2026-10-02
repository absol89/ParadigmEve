import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { PINS_STATE, pinsLibrary, resetPinsForTests } from '../src/main/pins.js';
import type { SurfaceRegistrar, ToolResult } from '../src/main/mcp/kernel.js';

const fixture = vi.hoisted(() => ({
  caller: { sessionId: 'session-caller-1', conversationId: 'conversation-caller' } as { sessionId: string | null; conversationId: string | null },
  summary: {
    id: 'session-source-1',
    title: 'Source chat',
    conversationId: 'conversation-source',
    chatIds: ['conversation-source']
  } as any,
  events: [] as any[],
  plans: { live: [] as any[], done: [] as any[] }
}));

vi.mock('../src/main/mcp/call-context.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/main/mcp/call-context.js')>()),
  currentCaller: () => fixture.caller
}));

vi.mock('../src/main/session/store.js', () => ({
  getSession: async (id: string) => id === fixture.summary.id ? fixture.summary : null,
  readEvents: async (id: string) => id === fixture.summary.id ? [...fixture.events] : []
}));
vi.mock('../src/main/plans.js', () => ({ listPlans: async () => fixture.plans }));

const { registerPinsTool, pinsToolSchema } = await import('../src/main/mcp/pins-tool.js');

let directory: string;
let run: (args: unknown) => Promise<ToolResult>;

function text(result: ToolResult): string {
  return result.content.map(part => part.type === 'text' ? part.text : '').join('');
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-pins-tool-'));
  resetDurableForTests();
  resetPinsForTests();
  initDurableStore(directory);
  fixture.summary = {
    id: 'session-source-1',
    title: 'Source chat',
    conversationId: 'conversation-source',
    chatIds: ['conversation-source']
  };
  fixture.events = [];
  fixture.plans = { live: [], done: [] };
  fixture.caller = { sessionId: 'session-caller-1', conversationId: 'conversation-caller' };
  registerPinsTool({
    sessionToolsExposed: true,
    sessionToolsLive: true,
    register: (_name: string, config: { inputSchema: z.ZodType }, handler: (args: any) => Promise<ToolResult>) => {
      run = (args) => handler(config.inputSchema.parse(args));
    },
    featureDisabled: () => ({ isError: true, content: [{ type: 'text', text: 'disabled' }] })
  } as unknown as SurfaceRegistrar);
});

afterEach(async () => {
  resetPinsForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('model-facing Pins tool', () => {
  it('creates a promptless Thread with the explicitly approved Quilt and resolves exact names only', async () => {
    const created = await run({ action: 'create_thread', title: '%Eva', quilt_names: ['#Eva'] });
    expect(created.isError).not.toBe(true);
    const body = JSON.parse(text(created));
    expect(body.created.reference).toBe('%Eva');
    expect(body.created.quilts).toEqual(['#Eva']);
    expect(body.created.prompt).toBeNull();
    expect(body.prompt).toBeNull();

    const exact = await run({ action: 'list', reference: '#Eva' });
    expect(exact.isError).not.toBe(true);
    expect(JSON.parse(text(exact)).quilt.threads).toEqual([
      expect.objectContaining({ reference: '%Eva' })
    ]);

    const typo = await run({ action: 'list', reference: '#Evaa' });
    expect(typo.isError).not.toBe(true);
    expect(JSON.parse(text(typo))).toEqual({
      status: 'missing',
      kind: 'quilt',
      reference: '#Evaa',
      exact: true,
      created: false
    });
    const library = await pinsLibrary();
    expect(library.collections.map(row => row.name)).toEqual(['Eva']);
  });

  it('creates or reuses an exact #Concept-backed promptless Thread without creating a same-name Quilt', async () => {
    const created = await run({
      action: 'create_concept',
      title: '#Architecture',
      description: 'Architecture ideas summarized from durable chats.'
    });
    expect(created.isError).not.toBe(true);
    expect(JSON.parse(text(created))).toMatchObject({
      created: true,
      alias: '#Architecture',
      concept: {
        reference: '%Architecture',
        description: 'Architecture ideas summarized from durable chats.',
        prompt: null
      }
    });
    let library = await pinsLibrary();
    expect(library.collections).toHaveLength(0);
    expect(library.quilts).toHaveLength(1);

    const reused = await run({
      action: 'create_concept',
      title: 'Architecture',
      description: 'Updated architecture summary.'
    });
    expect(reused.isError).not.toBe(true);
    expect(JSON.parse(text(reused))).toMatchObject({
      created: false,
      alias: '#Architecture',
      concept: { description: 'Updated architecture summary.' }
    });
    library = await pinsLibrary();
    expect(library.quilts).toHaveLength(1);
    expect(library.quilts[0]?.description).toBe('Updated architecture summary.');
  });

  it('updates one exact wider Quilt description for user-approved enrichment', async () => {
    const thread = JSON.parse(text(await run({ action: 'create_thread', title: 'research', quilt_names: ['#Research'] }))).created;
    const listed = JSON.parse(text(await run({ action: 'list', reference: '#Research' })));
    expect(listed.quilt.description).toBeNull();
    const updated = await run({
      action: 'set_quilt_description',
      quilt_id: listed.quilt.id,
      description: 'Research gathered from related chats after user approval.'
    });
    expect(updated.isError).not.toBe(true);
    expect(JSON.parse(text(updated))).toMatchObject({
      updated: {
        reference: '#Research',
        description: 'Research gathered from related chats after user approval.',
        threads: [{ id: thread.id, reference: '%research' }]
      }
    });
  });

  it('associates a Quilt to an existing Thread atomically and creates the Quilt only on an explicit create flag', async () => {
    const createdThread = JSON.parse(text(await run({ action: 'create_thread', title: 'architecture', quilt_names: [] })));
    const threadId = createdThread.created.id;

    const missing = await run({
      action: 'associate_quilt',
      thread_id: threadId,
      quilt_name: '#architecture',
      create_if_missing: false
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('Quilt #architecture was not found');
    expect((await pinsLibrary()).collections).toHaveLength(0);

    const associated = await run({
      action: 'associate_quilt',
      thread_id: threadId,
      quilt_name: '#architecture',
      create_if_missing: true
    });
    expect(associated.isError).not.toBe(true);
    expect(JSON.parse(text(associated))).toMatchObject({
      created: true,
      quilt: { reference: '#architecture' },
      thread: { id: threadId, reference: '%architecture', quilts: ['#architecture'] }
    });

    const verified = await run({ action: 'list', reference: '#architecture' });
    expect(verified.isError).not.toBe(true);
    expect(JSON.parse(text(verified))).toMatchObject({
      status: 'resolved',
      quilt: { reference: '#architecture', threads: [{ id: threadId, reference: '%architecture' }] }
    });

    const repeated = await run({
      action: 'associate_quilt',
      thread_id: threadId,
      quilt_name: '#architecture',
      create_if_missing: false
    });
    expect(repeated.isError).not.toBe(true);
    expect(JSON.parse(text(repeated)).created).toBe(false);
    expect((await pinsLibrary()).collections).toHaveLength(1);
  });

  it('refuses ambiguous legacy exact names instead of selecting the first durable match', async () => {
    const first = JSON.parse(text(await run({ action: 'create_thread', title: 'architecture', quilt_names: ['#Eve'] }))).created;
    const library = await pinsLibrary();
    const quilt = library.collections[0]!;
    await writeDurableNow(PINS_STATE, {
      ...library,
      quilts: [
        ...library.quilts,
        { ...library.quilts[0]!, id: '88888888-8888-4888-8888-888888888888' }
      ],
      collections: [
        ...library.collections,
        { ...quilt, id: '99999999-9999-4999-8999-999999999999', name: '#eve' }
      ]
    });

    const threadResult = await run({ action: 'list', reference: '%architecture' });
    expect(threadResult.isError).toBe(true);
    expect(text(threadResult)).toContain('ambiguous');
    expect(text(threadResult)).toContain('No Thread was selected or created');

    const quiltResult = await run({ action: 'list', reference: '#Eve' });
    expect(quiltResult.isError).toBe(true);
    expect(text(quiltResult)).toContain('ambiguous');
    expect(text(quiltResult)).toContain('No Quilt was selected or created');
    expect(first.reference).toBe('%architecture');
  });

  it('pins one exact recorded user source and unpins only the Pin', async () => {
    const createdThread = JSON.parse(text(await run({ action: 'create_thread', title: 'bugs', quilt_names: [] })));
    const threadId = createdThread.created.id;
    fixture.events = [{
      kind: 'user_message',
      seq: 824,
      time: 1234,
      source: 'extension',
      messageId: 'message-824',
      turnId: 'turn-824',
      authoredText: 'Please preserve this exact source.',
      message: { text: 'transport wrapper', truncated: false, chars: 17 }
    }];

    const pinned = await run({
      action: 'pin',
      thread_id: threadId,
      source: { kind: 'session_event', session_id: fixture.summary.id, event_seq: 824 }
    });
    expect(pinned.isError).not.toBe(true);
    const pin = JSON.parse(text(pinned)).pin;
    expect(pin.kind).toBe('prompt');
    expect(pin.excerpt).toBe('Please preserve this exact source.');
    expect(pin.provenance).toEqual({
      sessionId: fixture.summary.id,
      conversationId: 'conversation-source',
      eventSeq: 824,
      messageId: 'message-824',
      turnId: 'turn-824'
    });

    const removed = await run({ action: 'unpin', pin_id: pin.id });
    expect(removed.isError).not.toBe(true);
    expect(JSON.parse(text(removed))).toMatchObject({ removed: true, source_preserved: true });
    expect(fixture.events).toHaveLength(1);
    expect((await pinsLibrary()).pins).toHaveLength(0);
    expect((await pinsLibrary()).quilts).toHaveLength(1);
  });

  it('pins an exact recorded message to existing %architecture after reading a legacy preview library', async () => {
    const createdThread = JSON.parse(text(await run({ action: 'create_thread', title: 'architecture', quilt_names: [] })));
    const threadId = createdThread.created.id;
    const current = await pinsLibrary();
    await writeDurableNow(PINS_STATE, {
      ...current,
      pins: [{
        id: '77777777-7777-4777-8777-777777777777',
        quiltId: threadId,
        kind: 'message',
        createdAt: 1_789_319_960_431,
        excerpt: 'legacy preview '.repeat(180),
        provenance: {
          sessionId: 'session-old-pin',
          conversationId: 'conversation-old-pin',
          eventSeq: 9,
          messageId: 'message-old-pin'
        }
      }]
    });
    fixture.events = [{
      kind: 'assistant_message',
      seq: 825,
      time: 5678,
      source: 'extension',
      messageId: 'message-825',
      turnId: 'turn-825',
      message: { text: 'Claims should be downstream of evidence, never the other way around.', truncated: false, chars: 68 }
    }];

    const listed = await run({ action: 'list', reference: '%architecture' });
    expect(listed.isError).not.toBe(true);
    expect(JSON.parse(text(listed)).thread.reference).toBe('%architecture');

    const pinned = await run({
      action: 'pin',
      thread_id: threadId,
      source: { kind: 'session_event', session_id: fixture.summary.id, event_seq: 825 }
    });
    expect(pinned.isError).not.toBe(true);
    const created = JSON.parse(text(pinned)).pin;
    expect(created).toMatchObject({
      kind: 'message',
      quiltId: threadId,
      provenance: {
        sessionId: fixture.summary.id,
        conversationId: 'conversation-source',
        eventSeq: 825,
        messageId: 'message-825',
        turnId: 'turn-825'
      }
    });
    const repaired = await pinsLibrary();
    expect(repaired.pins).toHaveLength(2);
    expect(repaired.pins.find(pin => pin.id === '77777777-7777-4777-8777-777777777777')?.excerpt).toHaveLength(2_000);
  });

  it('fails visibly for a missing Thread or source event instead of approximating either', async () => {
    fixture.events = [{ kind: 'user_message', seq: 7, time: 7, source: 'extension', message: { text: 'x', truncated: false, chars: 1 } }];
    const missingThread = await run({
      action: 'pin',
      thread_id: '11111111-1111-4111-8111-111111111111',
      source: { kind: 'session_event', session_id: fixture.summary.id, event_seq: 7 }
    });
    expect(missingThread.isError).toBe(true);
    expect(text(missingThread)).toContain('No Pin was created');

    const thread = JSON.parse(text(await run({ action: 'create_thread', title: 'Exact', quilt_names: [] }))).created;
    const missingSource = await run({
      action: 'pin',
      thread_id: thread.id,
      source: { kind: 'session_event', session_id: fixture.summary.id, event_seq: 8 }
    });
    expect(missingSource.isError).toBe(true);
    expect(text(missingSource)).toContain('E8 does not exist');
    expect((await pinsLibrary()).pins).toHaveLength(0);
  });

  it('allows catalog reads without caller proof but refuses every mutation when chat identity is missing', async () => {
    fixture.caller = { sessionId: null, conversationId: null };
    expect((await run({ action: 'list' })).isError).not.toBe(true);
    const create = await run({ action: 'create_thread', title: 'Nope', quilt_names: [] });
    expect(create.isError).toBe(true);
    expect(text(create)).toContain('Exact chat identity is required');
    const associate = await run({
      action: 'associate_quilt',
      thread_id: '11111111-1111-4111-8111-111111111111',
      quilt_name: '#Nope',
      create_if_missing: true
    });
    expect(associate.isError).toBe(true);
    expect(text(associate)).toContain('Exact chat identity is required');
    for (const change of [
      { action: 'set_thread_prompt', thread_id: '11111111-1111-4111-8111-111111111111', prompt: 'planted' },
      { action: 'set_pin_sticky', pin_id: '11111111-1111-4111-8111-111111111111', sticky: true }
    ]) {
      const refused = await run(change);
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain('Exact chat identity is required');
    }
    expect((await pinsLibrary()).quilts).toHaveLength(0);
    expect((await pinsLibrary()).collections).toHaveLength(0);
  });

  it('creates a %Instruction with its approved standing prompt in one call', async () => {
    // The %claude request stayed blocked because the tool could not set a prompt at all.
    const prompt = 'Eve and Claude collaborate through exact evidence: Eve reports live findings, Claude fixes and tests.';
    const created = await run({ action: 'create_thread', title: '%claude', prompt, quilt_names: ['#Eve'] });
    expect(created.isError).not.toBe(true);
    const body = JSON.parse(text(created));
    expect(body.created).toMatchObject({ reference: '%claude', prompt, pins: [], quilts: ['#Eve'] });
    expect(body.prompt).toBe(prompt);
    const listed = JSON.parse(text(await run({ action: 'list', reference: '%claude' })));
    expect(listed.thread).toMatchObject({ prompt, pins: [] });
  });

  it('sets, replaces and clears one exact Thread prompt and refuses an unknown Thread', async () => {
    const thread = JSON.parse(text(await run({ action: 'create_thread', title: 'notes', quilt_names: [] }))).created;
    const first = await run({ action: 'set_thread_prompt', thread_id: thread.id, prompt: '  Summarise before answering.  ' });
    expect(first.isError).not.toBe(true);
    expect(JSON.parse(text(first))).toMatchObject({ updated: { id: thread.id, prompt: 'Summarise before answering.' }, cleared: false });
    const cleared = JSON.parse(text(await run({ action: 'set_thread_prompt', thread_id: thread.id, prompt: '' })));
    expect(cleared).toMatchObject({ updated: { id: thread.id, prompt: null }, cleared: true });
    expect((await pinsLibrary()).quilts[0]!.prompt).toBeUndefined();

    const missing = await run({ action: 'set_thread_prompt', thread_id: '22222222-2222-4222-8222-222222222222', prompt: 'x' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('No prompt was changed');
  });

  it('sets and clears the Heart on one exact Prompt Pin', async () => {
    const thread = JSON.parse(text(await run({ action: 'create_thread', title: 'hearts', quilt_names: [] }))).created;
    fixture.events = [{
      kind: 'user_message', seq: 5, time: 1, source: 'extension', messageId: 'm-5', turnId: 't-5',
      authoredText: 'Keep this on top.', message: { text: 'Keep this on top.', truncated: false, chars: 17 }
    }];
    const pin = JSON.parse(text(await run({
      action: 'pin', thread_id: thread.id, source: { kind: 'session_event', session_id: fixture.summary.id, event_seq: 5 }
    }))).pin;

    const on = await run({ action: 'set_pin_sticky', pin_id: pin.id, sticky: true });
    expect(on.isError).not.toBe(true);
    expect(JSON.parse(text(on))).toEqual({ pin_id: pin.id, sticky: true, thread_id: thread.id });
    expect(JSON.parse(text(await run({ action: 'list', reference: '%hearts' }))).thread.pins[0]).toMatchObject({ id: pin.id, sticky: true });
    const off = JSON.parse(text(await run({ action: 'set_pin_sticky', pin_id: pin.id, sticky: false })));
    expect(off.sticky).toBe(false);
    expect((await pinsLibrary()).pins[0]).not.toHaveProperty('sticky');

    const missing = await run({ action: 'set_pin_sticky', pin_id: '33333333-3333-4333-8333-333333333333', sticky: true });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('No Heart was changed');
  });

  it('pins an exact Plan id without inventing a chat source', async () => {
    const thread = JSON.parse(text(await run({ action: 'create_thread', title: 'plans', quilt_names: [] }))).created;
    const planId = '22222222-2222-4222-8222-222222222222';
    fixture.plans.live = [{
      id: planId,
      title: 'Ship the real thing',
      section: 'live',
      provenance: { kind: 'plan', sessionId: fixture.summary.id, conversationId: 'conversation-source' }
    }];
    const catalog = JSON.parse(text(await run({ action: 'list' })));
    expect(catalog.plans).toEqual([{ id: planId, title: 'Ship the real thing', section: 'live' }]);
    const result = await run({ action: 'pin', thread_id: thread.id, source: { kind: 'plan', plan_id: planId } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(text(result)).pin.provenance).toEqual({
      planId,
      sourceSessionId: fixture.summary.id,
      sourceConversationId: 'conversation-source'
    });
  });

  it('keeps the wire schema narrow', () => {
    expect(pinsToolSchema.safeParse({ action: 'list', reference: '#Eva', create: true }).success).toBe(false);
    expect(pinsToolSchema.safeParse({ action: 'list', reference: 'Eva' }).success).toBe(false);
    expect(pinsToolSchema.safeParse({ action: 'pin', thread_id: 'x', source: { kind: 'session_event', session_id: 'session-1', event_seq: 1 } }).success).toBe(false);
    // A standing prompt is an explicit, user-approved field; an empty one is not a prompt.
    expect(pinsToolSchema.safeParse({ action: 'create_thread', title: 'Eva', prompt: 'Approved guidance', quilt_names: [] }).success).toBe(true);
    expect(pinsToolSchema.safeParse({ action: 'create_thread', title: 'Eva', prompt: '   ', quilt_names: [] }).success).toBe(false);
    expect(pinsToolSchema.safeParse({ action: 'set_thread_prompt', thread_id: 'x', prompt: 'p' }).success).toBe(false);
    expect(pinsToolSchema.safeParse({ action: 'set_pin_sticky', pin_id: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(pinsToolSchema.safeParse({ action: 'create_thread', title: 'Eva', collection_names: [] }).success).toBe(false);
    expect(pinsToolSchema.safeParse({ action: 'associate_quilt', thread_id: '11111111-1111-4111-8111-111111111111', quilt_name: '#Eva' }).success).toBe(false);
  });
});
