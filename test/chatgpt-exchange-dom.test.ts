import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The 2026-09-24 ChatGPT renderer: one `[data-turn-key]` element per exchange (user message +
 * reply) instead of one section per role, search units carrying the message ids, assistant prose
 * under `[data-markdown-text-style]`, and tool activity folded under a "Worked for …" header that
 * sits outside every unit. The shape below is the structure-only live probe, ids replaced.
 */
const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
const THREAD = '6ab65814-1111-4111-8111-111111111111';

function exchange(n: number, userId: string, userText: string, assistantId: string | null, answer = '') {
  const assistant = assistantId === null ? '' : `
    <div class="block-x"><div data-content-search-unit-key="fallback-turn-${n}:2:assistant"
         data-chatgpt-search-unit-key="fallback-turn-${n}:2:assistant"
         data-chatgpt-search-message-ids="${assistantId} ${assistantId.slice(0, 8)}">
      <span data-chatgpt-agent-turn-start=""></span>
      <h4 data-conversation-role="assistant" class="sr-only">ChatGPT said:</h4>
      <div class="group flex" data-chatgpt-selection-conversation-id="${THREAD}" data-chatgpt-selection-message-id="${assistantId}">
        <div class="MarkdownRoot-abc" data-markdown-text-style="assistant-message"><p class="Paragraph-x"><span>${answer}</span></p></div>
      </div>
    </div></div>`;
  return `
  <div data-turn-key="${userId}"><div class="flex flex-col gap-1.5" data-content-search-turn-key="fallback-turn-${n}">
    <div class="contents"><div class="contents"><div class="group flex flex-col pb-2 pt-2"><div class="flex flex-col gap-3">
      <div class="block-x"><div class="group/user-message" data-chatgpt-search-unit-key="fallback-turn-${n}:0:user" data-chatgpt-search-message-ids="${userId}">
        <div class="w-full" data-content-search-unit-key="fallback-turn-${n}:0:user"><div class="group/user-message">
          <div class="bg-user-message" data-user-message-bubble="true"><div class="flex flex-col items-end gap-1">
            <div class="relative w-full min-w-0 text-size-chat"><div data-search-result-target=""><div>
              <div class="text-size-chat whitespace-pre-wrap">${userText}</div>
            </div></div></div>
          </div></div>
        </div></div>
      </div></div>
      <div class="block-x"><div class="min-w-0 text-size-chat relative py-0"><div class="flex min-w-0 flex-col">
        <div class="group/activity-header"><span class="inline-flex"><span class="text-text/60">Worked for 45s</span></span></div>
      </div></div></div>
      ${assistant}
    </div></div></div></div>
  </div></div>`;
}

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; });

function page(body: string): JSDOM {
  dom = new JSDOM(`<!doctype html><html><body><div data-request-input-activity-root="">${body}</div></body></html>`, {
    url: `https://chatgpt.com/c/${THREAD}`, runScripts: 'outside-only', pretendToBeVisual: true
  });
  return dom;
}

describe('ChatGPT DOM adapter on the per-exchange renderer', () => {
  function clf(body: string) {
    const window = page(body).window as unknown as Record<string, any>;
    window.eval(domSource);
    return { api: window.CLF_DOM, document: window.document as Document };
  }

  it('splits each exchange into a user turn and an assistant turn, in reading order', () => {
    const { api } = clf(exchange(0, 'user-a', 'First question', 'asst-a', 'First answer') +
      exchange(1, 'user-b', 'Second question', 'asst-b', 'Second answer'));
    const turns = api.turns();
    expect(turns.map((turn: any) => [turn.role, turn.id])).toEqual([
      ['user', 'user-a'], ['assistant', 'user-a'], ['user', 'user-b'], ['assistant', 'user-b']
    ]);
    expect(turns[0].node.getAttribute('data-chatgpt-search-unit-key')).toBe('fallback-turn-0:0:user');
    expect(turns[1].node.getAttribute('data-turn-key')).toBe('user-a');
  });

  it('reads exact message ids and authored text from the search units', () => {
    const { api } = clf(exchange(0, 'user-a', 'Read my notes', 'asst-a', 'Here they are.'));
    expect(api.messages().map((message: any) => ({ id: message.id, role: message.role, text: message.text, turnId: message.turnId })))
      .toEqual([
        { id: 'user-a', role: 'user', text: 'Read my notes', turnId: 'user-a' },
        { id: 'asst-a', role: 'assistant', text: 'Here they are.', turnId: 'user-a' }
      ]);
  });

  it('keeps an exchange whose reply has not rendered yet as a user message plus an empty assistant turn', () => {
    const { api } = clf(exchange(0, 'user-a', 'Just sent', null));
    expect(api.turns().map((turn: any) => turn.role)).toEqual(['user', 'assistant']);
    expect(api.messages().map((message: any) => message.id)).toEqual(['user-a']);
  });

  it('never reads the activity header or the user bubble as assistant prose', () => {
    const { api } = clf(exchange(0, 'user-a', 'Question text', 'asst-a', 'Answer text'));
    const assistant = api.turns()[1];
    const texts = api.messagesIn(assistant).map((message: any) => message.text);
    expect(texts).toEqual(['Answer text']);
    expect(texts.join(' ')).not.toMatch(/Worked for|Question text/);
  });

  it('names the first user message by its unit and its exact id', () => {
    const { api } = clf(exchange(0, 'user-a', 'Opening instruction', 'asst-a', 'Ok'));
    const first = api.firstUserMessage();
    expect(first?.getAttribute('data-chatgpt-search-unit-key')).toBe('fallback-turn-0:0:user');
    expect(api.messageIdOf(first)).toBe('user-a');
  });

  it('treats exchange content as conversation, not composer chrome', () => {
    const { api, document } = clf(exchange(0, 'user-a', 'Question', 'asst-a', 'Answer'));
    const header = document.querySelector('.group\\/activity-header')!;
    // turnMount places the stream inside the assistant turn; it must find the exchange.
    const mount = api.turnMount(api.turns()[1]);
    expect(mount?.host && (mount.host as Element).closest('[data-turn-key]')).not.toBeNull();
    expect(header.closest('[data-turn-key]')?.getAttribute('data-turn-key')).toBe('user-a');
  });
});

describe('fiber evidence on the per-exchange renderer', () => {
  type Fiber = { memoizedProps: Record<string, unknown>; child?: Fiber; sibling?: Fiber; return?: Fiber };
  const user = (id: string, text: string) => ({
    id, author: { role: 'user' }, recipient: 'all', create_time: 1786873600,
    content: { content_type: 'text', parts: [text] }, metadata: {}
  });
  const toolRequest = (id: string, requestId: string) => ({
    id, author: { role: 'assistant' }, recipient: 'api_tool.call_tool', create_time: 1786873658,
    content: { content_type: 'code', language: 'json', text: '{"path":"/ParadigmEve/link_11111111222233334444555555555555/read"}' },
    metadata: { request_id: requestId, tool_icons: ['api_tool'] }
  });
  const reply = (id: string, text: string) => ({
    id, author: { role: 'assistant' }, recipient: 'all', channel: 'final', create_time: 1786873700,
    status: 'finished_successfully', end_turn: true,
    content: { content_type: 'text', parts: [text] }, metadata: {}
  });

  /** A branch the way the probe found it: ids only above, message props below. */
  function exchangeFiber(below: Array<Record<string, unknown>>): Fiber {
    const conversation: Fiber = { memoizedProps: { conversationId: THREAD, isTurnActive: false } };
    const turnFiber: Fiber = { memoizedProps: { observeTurnElement: () => undefined }, return: conversation };
    let previous: Fiber | undefined;
    for (const props of below) {
      const node: Fiber = { memoizedProps: props, return: turnFiber };
      if (previous) previous.sibling = node; else turnFiber.child = node;
      previous = node;
    }
    return turnFiber;
  }

  async function scanPage(body: string, fibers: Record<string, Fiber>, nodes: Record<string, Fiber> = {},
    prepare?: (document: Document) => void) {
    const window = page(body).window as unknown as Window & typeof globalThis & Record<string, any>;
    for (const [key, fiber] of Object.entries(fibers)) {
      (window.document.querySelector(`[data-turn-key="${key}"]`) as any)['__reactFiber$probe'] = fiber;
    }
    for (const [selector, fiber] of Object.entries(nodes)) {
      (window.document.querySelector(selector) as any)['__reactFiber$probe'] = fiber;
    }
    prepare?.(window.document);
    window.eval(fiberSource);
    const nonce = 'exchange-nonce';
    const reply = new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the helper never answered')), 2000);
      window.addEventListener('message', (event: any) => {
        if (event.data?.source !== 'clf-fiber-reply' || event.data.nonce !== nonce) return;
        clearTimeout(timer);
        resolve(event.data);
      });
    });
    window.dispatchEvent(new window.MessageEvent('message', { data: { source: 'clf-fiber-ask', nonce }, source: window }));
    return { data: await reply, document: window.document };
  }

  it('finds the exchange message model below the turn and reports its request ids and conversation', async () => {
    const { data, document } = await scanPage(exchange(0, 'user-a', 'Read my notes', 'asst-a', 'Here they are.'), {
      'user-a': exchangeFiber([
        { message: user('user-a', 'Read my notes') },
        { messages: [toolRequest('call-a', 'wfr_live_request_1')] },
        { message: reply('asst-a', 'Here they are.') }
      ])
    });
    expect(data.scanOk).toBe(true);
    expect(data.turns).toHaveLength(1);
    const turn = data.turns[0];
    expect(turn).toMatchObject({ turnId: 'user-a', conversationId: THREAD, conversationConflict: false, endMessageId: 'asst-a' });
    expect(turn.requests.map((entry: any) => entry.requestId)).toEqual(['wfr_live_request_1']);
    expect(turn.messages.map((message: any) => [message.role, message.rawMessageId])).toEqual([
      ['user', 'user-a'], ['assistant', 'asst-a']
    ]);
    // Both logical turns chatgpt-dom.js reports join the same descriptor.
    const exchangeStamp = document.querySelector('[data-turn-key]')!.getAttribute('data-clf-fiber-turn');
    const userUnit = document.querySelector('[data-chatgpt-search-unit-key$=":user"]')!;
    expect(exchangeStamp).toBe(`${data.scanToken}:0`);
    expect(userUnit.getAttribute('data-clf-fiber-turn')).toBe(exchangeStamp);
    expect(userUnit.getAttribute('data-clf-user-message-id')).toBe('user-a');
  });

  /** A deep activity branch, the way a tool-heavy "Worked for …" tree mounts before the reply. */
  function deepChain(depth: number, head: Record<string, unknown>, stateNode?: unknown): Fiber {
    const top: Fiber & { stateNode?: unknown } = { memoizedProps: head, ...(stateNode ? { stateNode } : {}) };
    let at: Fiber = top;
    for (let i = 0; i < depth; i++) {
      const next: Fiber = { memoizedProps: {}, return: at };
      at.child = next;
      at = next;
    }
    return top;
  }

  it('reaches the reply through its own unit when a large activity tree exhausts the exchange walk', async () => {
    const turnFiber = exchangeFiber([{ message: user('user-a', 'Do the work') }]);
    const activity = deepChain(7000, { messages: [toolRequest('call-a', 'wfr_live_request_2')] });
    activity.return = turnFiber;
    turnFiber.child!.sibling = activity;
    const replyWrapper: Fiber = { memoizedProps: { message: reply('asst-a', 'Done.') }, return: turnFiber };
    activity.sibling = replyWrapper;
    const assistantHost: Fiber = { memoizedProps: {}, return: replyWrapper };
    replyWrapper.child = assistantHost;
    const { data } = await scanPage(exchange(0, 'user-a', 'Do the work', 'asst-a', 'Done.'), { 'user-a': turnFiber },
      { '[data-chatgpt-search-unit-key$=":assistant"]': assistantHost });
    expect(data.turns).toHaveLength(1);
    expect(data.turns[0].requests.map((entry: any) => entry.requestId)).toEqual(['wfr_live_request_2']);
    expect(data.turns[0].messages.map((message: any) => [message.role, message.rawMessageId, message.rawText])).toEqual([
      ['user', 'user-a', 'Do the work'], ['assistant', 'asst-a', 'Done.']
    ]);
  });

  it('does not spend the exchange walk inside rendered prose', async () => {
    const body = exchange(0, 'user-a', 'Explain', 'asst-a', 'Long answer');
    const turnFiber = exchangeFiber([{ message: user('user-a', 'Explain') }]);
    const { data } = await scanPage(body, { 'user-a': turnFiber }, {}, (document) => {
      // An earlier answer's prose mounted as a very deep tree before this reply's model.
      const prose = deepChain(7000, {}, document.querySelector('[data-markdown-text-style]'));
      prose.return = turnFiber;
      turnFiber.child!.sibling = prose;
      prose.sibling = { memoizedProps: { message: reply('asst-a', 'Long answer') }, return: turnFiber };
    });
    expect(data.turns[0].messages.map((message: any) => [message.role, message.rawMessageId])).toEqual([
      ['user', 'user-a'], ['assistant', 'asst-a']
    ]);
  });

  it('prefers a whole turn list in its own order and never borrows a neighbouring exchange', async () => {
    const { data } = await scanPage(
      exchange(0, 'user-a', 'First', 'asst-a', 'One') + exchange(1, 'user-b', 'Second', 'asst-b', 'Two'), {
        'user-a': exchangeFiber([{ turn: { messages: [user('user-a', 'First'), reply('asst-a', 'One')] } }]),
        'user-b': exchangeFiber([{ message: user('user-b', 'Second') }, { message: reply('asst-b', 'Two') }])
      });
    expect(data.turns.map((turn: any) => [turn.turnId, turn.messages.map((message: any) => message.rawMessageId)])).toEqual([
      ['user-a', ['user-a', 'asst-a']],
      ['user-b', ['user-b', 'asst-b']]
    ]);
  });
});

/**
 * The live 2026-09-26 renderer, as probed in the Eve chat that recorded no replies: no message
 * object is reachable through props any more. Each unit renders one `item` (component `c3`) and,
 * below it, a context provider whose `value` names the same message. Everything the recorder
 * needs is in those two, and nothing below is invented beyond the probed field names/values.
 */
describe('fiber evidence on the render-item renderer', () => {
  type Fiber = { memoizedProps: Record<string, unknown>; child?: Fiber; sibling?: Fiber; return?: Fiber; stateNode?: unknown };
  const REPLY_ID = 'b0000001-0000-4000-8000-000000000001';
  const USER_ID = 'b0000002-0000-4000-8000-000000000002';
  // Probed live 2026-09-27: the user text is a plain string and every id names the exchange.
  const userItem = (overrides: Record<string, unknown> = {}) => ({ type: 'user-message', messageId: USER_ID, serverMessageId: USER_ID,
    message: '1+1', renderMarkdown: false, attachments: [], sentAtMs: null, ...overrides });
  const assistantItem = (overrides: Record<string, unknown> = {}) => ({
    type: 'assistant-message', phase: 'final_answer', completed: true, reasoningStatus: undefined,
    messageId: REPLY_ID, latestMessageId: REPLY_ID, sourceMessageIds: [REPLY_ID],
    turnExchangeId: 'b0000003-0000-4000-8000-000000000003', sentAtMs: null, content: '**2**',
    codeBlocks: [], contentReferences: [], ...overrides
  });
  const context = (overrides: Record<string, unknown> = {}) => ({
    messageId: REPLY_ID, turnId: 'fallback-turn-6', conversationId: THREAD, isStreaming: false,
    isLatestActorMessage: true, isReadOnly: false, sourceMessageIds: [REPLY_ID], conversationType: 'primary', ...overrides
  });

  /** exchange -> [user c3 item, assistant c3 item -> provider(value) -> selection holder]. */
  function renderItemExchange(item: Record<string, unknown>, value: Record<string, unknown> | null,
    user = userItem()): Fiber {
    const conversation: Fiber = { memoizedProps: { conversationId: THREAD } };
    const turnFiber: Fiber = { memoizedProps: {}, return: conversation };
    const userFiber: Fiber = { memoizedProps: { item: user }, return: turnFiber };
    const assistant: Fiber = { memoizedProps: { item }, return: turnFiber };
    turnFiber.child = userFiber;
    userFiber.sibling = assistant;
    if (value) assistant.child = { memoizedProps: { value, children: {} }, return: assistant };
    return turnFiber;
  }

  async function scan(item: Record<string, unknown>, value: Record<string, unknown> | null, user = userItem()) {
    const body = exchange(6, USER_ID, '1+1', REPLY_ID, '<strong>2</strong>');
    const window = page(body).window as unknown as Window & typeof globalThis & Record<string, any>;
    (window.document.querySelector(`[data-turn-key="${USER_ID}"]`) as any)['__reactFiber$live'] = renderItemExchange(item, value, user);
    window.eval(fiberSource);
    const reply = new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the helper never answered')), 2000);
      window.addEventListener('message', (event: any) => {
        if (event.data?.source !== 'clf-fiber-reply' || event.data.nonce !== 'render-item') return;
        clearTimeout(timer);
        resolve(event.data);
      });
    });
    window.dispatchEvent(new window.MessageEvent('message', { data: { source: 'clf-fiber-ask', nonce: 'render-item' }, source: window }));
    return reply;
  }

  it('reports a finished reply by its provider id, raw Markdown, rendered HTML and end of turn', async () => {
    const data = await scan(assistantItem(), context());
    expect(data.turns).toHaveLength(1);
    expect(data.turns[0]).toMatchObject({ turnId: USER_ID, conversationId: THREAD, conversationConflict: false, endMessageId: REPLY_ID });
    const [ask, reply] = data.turns[0].messages;
    expect(ask).toMatchObject({ role: 'user', rawMessageId: USER_ID, stable: true, rawText: '1+1' });
    // Final: durable by its provider id, which is what Compact & Resume requires of a brief.
    expect(reply).toMatchObject({ role: 'assistant', rawMessageId: REPLY_ID, messageId: REPLY_ID, rawText: '**2**', stable: true });
    // Joined through the selection holder's provider id, not by position or text.
    expect(reply.renderedHtml).toContain('<strong>2</strong>');
  });

  it('keeps a reply that is still streaming partial however complete it looks', async () => {
    for (const [item, value] of [
      [assistantItem(), context({ isStreaming: true })],
      [assistantItem({ completed: false }), context()],
      [assistantItem({ phase: undefined }), context()],
      [assistantItem(), null]
    ] as Array<[Record<string, unknown>, Record<string, unknown> | null]>) {
      const data = await scan(item, value);
      const replies = data.turns[0].messages.filter((message: any) => message.role === 'assistant');
      expect(replies.map((message: any) => [message.rawMessageId, message.stable])).toEqual([[REPLY_ID, false]]);
      expect(data.turns[0].endMessageId).toBeNull();
    }
  });

  it('fails closed on contradictory identity, another conversation, or an unknown phase', async () => {
    for (const [item, value] of [
      [assistantItem({ latestMessageId: 'another-message' }), context()],
      [assistantItem({ sourceMessageIds: [REPLY_ID, 'another-message'] }), context()],
      [assistantItem(), context({ conversationId: '6ab7efbf-0000-4000-8000-000000000000' })],
      [assistantItem({ phase: 'reasoning' }), context()],
      [assistantItem({ content: '' }), context()]
    ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
      const data = await scan(item, value);
      expect(data.turns.flatMap((turn: any) => turn.messages).filter((message: any) => message.role === 'assistant')).toEqual([]);
    }
  });

  it('reads a handoff marker from the user item exactly, so Compact & Resume can find its brief', async () => {
    const marked = '[[CLF-HANDOFF:b3kK9kF0aaaaaaaaaaaaaa]]\n\nParadigmEve is compacting this conversation.';
    const brief = 'TASK\n\n- Continue.';
    const data = await scan(assistantItem({ content: brief }), context(), userItem({ message: marked }));
    expect(data.turns[0].endMessageId).toBe(REPLY_ID);
    expect(data.turns[0].messages.map((message: any) => [message.role, message.stable, message.rawText])).toEqual([
      ['user', true, marked], ['assistant', true, brief]
    ]);
  });

  it('fails closed on a user item that is not its own exchange or disagrees about its id', async () => {
    for (const user of [
      userItem({ messageId: 'another-user-message', serverMessageId: 'another-user-message' }),
      userItem({ serverMessageId: 'another-user-message' }),
      userItem({ message: { text: '1+1' } }),
      userItem({ message: '' })
    ]) {
      const data = await scan(assistantItem(), context(), user);
      expect(data.turns[0].messages.filter((message: any) => message.role === 'user')).toEqual([]);
    }
  });
});
