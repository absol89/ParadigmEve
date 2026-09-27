import { z } from 'zod';
import {
  associateThreadWithQuilt,
  createPin,
  createThread,
  pinsLibrary,
  removePin,
  setCollectionDescription,
  setPinSticky,
  setQuiltPrompt,
  setThreadDescription
} from '../pins.js';
import { listPlans } from '../plans.js';
import { getSession, readEvents } from '../session/store.js';
import type { SessionEvent } from '../../shared/session.js';
import type { CreatePinResult, Pin, Quilt, QuiltCollection } from '../../shared/pins.js';
import { currentCaller } from './call-context.js';
import { expandStored, fail, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';

const uuid = z.string().uuid();
const sessionId = z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i);

export const pinsToolSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
    reference: z.string().trim().min(2).max(120).regex(/^[%#]/).optional()
  }).strict(),
  z.object({
    action: z.literal('pin'),
    thread_id: uuid,
    source: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('session_event'),
        session_id: sessionId,
        event_seq: z.number().int().min(1).max(10_000_000)
      }).strict(),
      z.object({ kind: z.literal('plan'), plan_id: uuid }).strict()
    ])
  }).strict(),
  z.object({ action: z.literal('unpin'), pin_id: uuid }).strict(),
  z.object({
    action: z.literal('associate_quilt'),
    thread_id: uuid,
    quilt_name: z.string().trim().min(1).max(80),
    create_if_missing: z.boolean()
  }).strict(),
  z.object({
    action: z.literal('create_thread'),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000).optional(),
    // The exact standing prompt the user approved. With no Pins this makes a %Hotlink.
    prompt: z.string().trim().min(1).max(16_000).optional(),
    quilt_names: z.array(z.string().trim().min(1).max(80)).max(50).default([])
  }).strict(),
  z.object({
    action: z.literal('set_thread_prompt'),
    thread_id: uuid,
    // Empty clears the prompt.
    prompt: z.string().max(16_000)
  }).strict(),
  z.object({
    action: z.literal('set_pin_sticky'),
    pin_id: uuid,
    sticky: z.boolean()
  }).strict(),
  z.object({
    action: z.literal('create_concept'),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000)
  }).strict(),
  z.object({
    action: z.literal('set_quilt_description'),
    quilt_id: uuid,
    description: z.string().trim().max(1_000)
  }).strict()
]);

const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase();
const strip = (value: string, sigil: '%' | '#'): string => normalize(value.startsWith(sigil) ? value.slice(1) : value);

function threadView(thread: Quilt, quiltGroups: readonly QuiltCollection[], pins: readonly Pin[]) {
  const names = thread.collectionIds.flatMap(id => {
    const quilt = quiltGroups.find(row => row.id === id);
    return quilt ? [`#${quilt.name}`] : [];
  });
  return {
    id: thread.id,
    reference: `%${thread.title}`,
    state: thread.state,
    description: thread.description ?? null,
    link: thread.link ?? null,
    prompt: thread.prompt ?? null,
    quilts: names,
    pins: pins.filter(pin => pin.quiltId === thread.id).map(pin => ({
      id: pin.id,
      kind: pin.kind,
      title: pin.title ?? null,
      sourceLabel: pin.sourceLabel ?? null,
      sticky: 'sticky' in pin && pin.sticky === true,
      provenance: pin.provenance
    }))
  };
}

function quiltView(quilt: QuiltCollection, threads: readonly Quilt[]) {
  return {
    id: quilt.id,
    reference: `#${quilt.name}`,
    description: quilt.description ?? null,
    threads: threads.filter(thread => thread.collectionIds.includes(quilt.id)).map(thread => ({ id: thread.id, reference: `%${thread.title}` }))
  };
}

async function exactMessageText(sessionIdValue: string, event: Extract<SessionEvent, { kind: 'user_message' | 'assistant_message' }>): Promise<string> {
  if (event.kind === 'user_message' && event.authoredText !== undefined) return event.authoredText;
  return (await expandStored(sessionIdValue, event.message)).text;
}

async function pinRecordedEvent(
  threadId: string,
  sourceSessionId: string,
  eventSeq: number
): Promise<{ created: CreatePinResult } | { error: string }> {
  const [summary, events] = await Promise.all([getSession(sourceSessionId), readEvents(sourceSessionId)]);
  if (!summary) return { error: `Recorded session ${sourceSessionId} does not exist.` };
  const event = events.find(row => row.seq === eventSeq);
  if (!event) return { error: `Recorded event E${eventSeq} does not exist in session ${sourceSessionId}. Use session read to obtain an exact E<number> source reference.` };
  const conversationId = summary.conversationId && summary.chatIds.length === 1 && summary.chatIds[0] === summary.conversationId
    ? summary.conversationId
    : null;

  if (event.kind === 'user_message' || event.kind === 'assistant_message') {
    const text = await exactMessageText(sourceSessionId, event);
    return { created: await createPin({
      kind: event.kind === 'user_message' ? 'prompt' : 'message',
      target: { mode: 'existing', quiltId: threadId },
      sourceCreatedAt: event.time,
      title: event.kind === 'user_message' ? 'Your message' : 'ChatGPT reply',
      ...(text ? { excerpt: text.slice(0, 2_000) } : {}),
      sourceLabel: summary.title,
      provenance: {
        sessionId: sourceSessionId,
        conversationId,
        eventSeq: event.seq,
        ...(event.messageId ? { messageId: event.messageId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {})
      }
    }) };
  }

  if (event.kind === 'tool_call') {
    const result = await expandStored(sourceSessionId, event.call.result);
    return { created: await createPin({
      kind: 'result',
      target: { mode: 'existing', quiltId: threadId },
      sourceCreatedAt: event.time,
      title: event.call.summary.title,
      excerpt: result.text.slice(0, 2_000),
      sourceLabel: summary.title,
      provenance: {
        sessionId: sourceSessionId,
        conversationId: event.call.conversationId,
        eventSeq: event.seq,
        callId: event.call.callId,
        ...(event.turnId ? { turnId: event.turnId } : {})
      }
    }) };
  }

  return { error: `Recorded event E${eventSeq} is ${event.kind}, which is not a Pin source. Pin a user message, assistant message, tool result, or Plan.` };
}

export function registerPinsTool(reg: SurfaceRegistrar): void {
  if (!reg.sessionToolsExposed) return;
  reg.register('pins', toolDeclaration('pins', () => ({
    title: 'Pins, Threads and Quilts',
    description:
      'Pins. list exact %Thread/#Quilt. pin exact event/Plan to thread_id; unpin. create_thread: approved Thread+Quilts, optional approved ' +
      'prompt (0 Pins+prompt=%Hotlink). set_thread_prompt: set/clear (empty) exact Thread prompt, user-approved text only. ' +
      'set_pin_sticky: Heart on exact Prompt/Message/Plan Pin. create_concept: exact 0-Pin promptless %Thread, no same-name Quilt. ' +
      'set_quilt_description: approved Quilt text. associate_quilt: exact Thread/Quilt; create_if_missing only if approved. Never fuzzy-route.',
    inputSchema: pinsToolSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  })), args => guard('pins', async () => {
    if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings -> Chat');
    if (args.action !== 'list') {
      const caller = currentCaller();
      if (!caller.sessionId || !caller.conversationId) {
        return fail('Exact chat identity is required to change Pins or Threads. Nothing was changed; retry after the companion reconnects.');
      }
    }
    const library = await pinsLibrary();

    if (args.action === 'list') {
      if (!args.reference) {
        const threads = library.quilts.slice(0, 200).map(thread => ({
          id: thread.id,
          reference: `%${thread.title}`,
          state: thread.state,
          description: thread.description ?? null,
          prompt: thread.prompt ?? null,
          link: thread.link ?? null
        }));
        const quilts = library.collections.slice(0, 200).map(quilt => ({
          id: quilt.id,
          reference: `#${quilt.name}`,
          description: quilt.description ?? null
        }));
        const planLibrary = await listPlans();
        const plans = [...planLibrary.live, ...planLibrary.done].slice(0, 100).map(plan => ({
          id: plan.id,
          title: plan.title,
          section: plan.section
        }));
        return ok(JSON.stringify({
          threads,
          quilts,
          plans,
          threadCount: library.quilts.length,
          quiltCount: library.collections.length,
          planCount: planLibrary.live.length + planLibrary.done.length,
          truncated: library.quilts.length > threads.length || library.collections.length > quilts.length ||
            planLibrary.live.length + planLibrary.done.length > plans.length
        }));
      }
      if (args.reference.startsWith('#')) {
        const quilts = library.collections.filter(row => strip(row.name, '#') === strip(args.reference!, '#'));
        if (quilts.length > 1) {
          return fail(`Quilt ${args.reference} is ambiguous in durable Pins state. No Quilt was selected or created.`);
        }
        return quilts.length === 1
          ? ok(JSON.stringify({ status: 'resolved', quilt: quiltView(quilts[0]!, library.quilts) }))
          : ok(JSON.stringify({ status: 'missing', kind: 'quilt', reference: args.reference, exact: true, created: false }));
      }
      const threads = library.quilts.filter(row => strip(row.title, '%') === strip(args.reference!, '%'));
      if (threads.length > 1) {
        return fail(`Thread ${args.reference} is ambiguous in durable Pins state. No Thread was selected or created.`);
      }
      return threads.length === 1
        ? ok(JSON.stringify({ status: 'resolved', thread: threadView(threads[0]!, library.collections, library.pins) }))
        : ok(JSON.stringify({ status: 'missing', kind: 'thread', reference: args.reference.startsWith('%') ? args.reference : `%${args.reference}`, exact: true, created: false }));
    }

    if (args.action === 'create_thread') {
      const thread = await createThread({
        title: args.title.startsWith('%') ? args.title.slice(1) : args.title,
        ...(args.description ? { description: args.description } : {}),
        ...(args.prompt ? { prompt: args.prompt } : {}),
        collectionNames: args.quilt_names.map(name => name.startsWith('#') ? name.slice(1) : name)
      });
      const fresh = await pinsLibrary();
      return ok(JSON.stringify({ created: threadView(thread, fresh.collections, fresh.pins), prompt: thread.prompt ?? null }));
    }

    if (args.action === 'set_thread_prompt') {
      const held = library.quilts.find(row => row.id === args.thread_id);
      if (!held) return fail(`Thread ${args.thread_id} was not found. No prompt was changed.`);
      // Through the same state owner as the Thread editor, which also makes a shipped starter
      // prompt user-owned so a later app update never overwrites it.
      const updated = await setQuiltPrompt(held.id, args.prompt);
      const fresh = await pinsLibrary();
      return ok(JSON.stringify({ updated: threadView(updated, fresh.collections, fresh.pins), cleared: !updated.prompt }));
    }

    if (args.action === 'set_pin_sticky') {
      const held = library.pins.find(pin => pin.id === args.pin_id);
      if (!held) return fail(`Pin ${args.pin_id} was not found. No Heart was changed.`);
      if (held.kind !== 'prompt' && held.kind !== 'message' && held.kind !== 'plan') {
        return fail(`Pin ${args.pin_id} is a ${held.kind} Pin; only Prompt, Message, or Plan Pins take a Heart. Nothing was changed.`);
      }
      const updated = await setPinSticky(held.id, args.sticky);
      return ok(JSON.stringify({ pin_id: updated.id, sticky: 'sticky' in updated && updated.sticky === true, thread_id: updated.quiltId }));
    }

    if (args.action === 'create_concept') {
      const rawTitle = args.title.replace(/^[%#]/u, '');
      const key = strip(rawTitle, '%');
      const sameNameQuilts = library.collections.filter(row => strip(row.name, '#') === key);
      if (sameNameQuilts.length) {
        return fail(`Quilt #${rawTitle} already exists. It remains authoritative for #${rawTitle}; no Concept Thread was created or changed.`);
      }
      const matches = library.quilts.filter(row => strip(row.title, '%') === key);
      if (matches.length > 1) {
        return fail(`Concept #${rawTitle} is ambiguous in durable Pins state. No Thread was selected, created, or changed.`);
      }
      if (matches.length === 1) {
        const held = matches[0]!;
        const hasPins = library.pins.some(pin => pin.quiltId === held.id);
        if (held.prompt || hasPins) {
          return fail(`Thread %${held.title} already exists with ${held.prompt ? 'a prompt' : 'Pins'} and is not a Concept. Nothing was changed.`);
        }
        const updated = await setThreadDescription(held.id, args.description);
        const fresh = await pinsLibrary();
        return ok(JSON.stringify({ created: false, concept: threadView(updated, fresh.collections, fresh.pins), alias: `#${updated.title}` }));
      }
      const created = await createThread({ title: rawTitle, description: args.description, collectionNames: [] });
      const fresh = await pinsLibrary();
      return ok(JSON.stringify({ created: true, concept: threadView(created, fresh.collections, fresh.pins), alias: `#${created.title}` }));
    }

    if (args.action === 'set_quilt_description') {
      const quilt = library.collections.find(row => row.id === args.quilt_id);
      if (!quilt) return fail(`Quilt ${args.quilt_id} was not found. No description was changed.`);
      const updated = await setCollectionDescription(quilt.id, args.description);
      return ok(JSON.stringify({ updated: quiltView(updated, library.quilts) }));
    }

    if (args.action === 'unpin') {
      const held = library.pins.find(pin => pin.id === args.pin_id);
      if (!held) return fail(`Pin ${args.pin_id} was not found. No Pin was removed.`);
      await removePin(args.pin_id);
      return ok(JSON.stringify({ removed: true, pin_id: args.pin_id, source_preserved: true }));
    }

    if (args.action === 'associate_quilt') {
      const reference = args.quilt_name.startsWith('#') ? args.quilt_name : `#${args.quilt_name}`;
      const associated = await associateThreadWithQuilt({
        threadId: args.thread_id,
        quiltName: args.quilt_name,
        createIfMissing: args.create_if_missing
      });
      if (associated.status === 'missing') {
        return fail(`Quilt ${reference} was not found. No association was changed; create_if_missing=true may be used only after the user approved creating that exact Quilt.`);
      }
      const fresh = await pinsLibrary();
      const thread = fresh.quilts.find(row => row.id === associated.thread.id)!;
      const quilt = fresh.collections.find(row => row.id === associated.quilt.id)!;
      return ok(JSON.stringify({
        created: associated.created,
        quilt: quiltView(quilt, fresh.quilts),
        thread: threadView(thread, fresh.collections, fresh.pins)
      }));
    }

    const thread = library.quilts.find(row => row.id === args.thread_id);
    if (!thread) return fail(`Thread ${args.thread_id} was not found. No Pin was created.`);
    const source = args.source;
    if (source.kind === 'session_event') {
      const result = await pinRecordedEvent(thread.id, source.session_id, source.event_seq);
      if ('error' in result) return fail(result.error);
      return ok(JSON.stringify({ pin: result.created.pin, thread: { id: result.created.quilt.id, reference: `%${result.created.quilt.title}` } }));
    }
    const plans = await listPlans();
    const plan = [...plans.live, ...plans.done].find(row => row.id === source.plan_id);
    if (!plan) return fail(`Plan ${source.plan_id} was not found. No Pin was created.`);
    const created = await createPin({
      kind: 'plan',
      target: { mode: 'existing', quiltId: thread.id },
      title: plan.title,
      sourceLabel: 'Plans',
      provenance: {
        planId: plan.id,
        ...(plan.provenance?.sessionId ? { sourceSessionId: plan.provenance.sessionId } : {}),
        ...(plan.provenance?.conversationId ? { sourceConversationId: plan.provenance.conversationId } : {})
      }
    });
    return ok(JSON.stringify({ pin: created.pin, thread: { id: created.quilt.id, reference: `%${created.quilt.title}` } }));
  }));
}
