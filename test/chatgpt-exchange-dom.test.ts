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

  it('mounts replacement activity inside the virtualized exchange instead of before its measured row', () => {
    const { api, document } = clf(exchange(0, 'user-a', 'Question', 'asst-a', 'Answer'));
    const assistant = api.turns()[1];
    const exchangeNode = document.querySelector('[data-turn-key="user-a"]')!;
    const root = document.createElement('div');
    root.className = 'clf-stream';
    root.textContent = 'Synthetic activity';

    expect(api.replaceActivity(assistant, root, true)).toBe(true);

    // The live regression was a 150px .clf-stream sibling before [data-turn-key]: the stream
    // pushed the exchange's visible contents down while ChatGPT kept the following virtual row
    // at its cached offset. Keeping the stream inside the exchange makes its height part of the
    // exact box the virtualizer measures.
    expect(root.closest('[data-turn-key]')).toBe(exchangeNode);
    expect(root.parentElement).not.toBe(exchangeNode.parentElement);
    expect(exchangeNode.previousElementSibling).not.toBe(root);
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

  it('resolves a Voice content-reference to the provider source message instead of archiving the pointer', async () => {
    const sourceId = 'voice-source-a';
    const finalId = 'voice-final-a';
    const source = {
      id: sourceId, author: { role: 'assistant' }, recipient: 'all', channel: 'final', create_time: 1786873699,
      status: 'finished_successfully', end_turn: false,
      content: { content_type: 'multimodal_text', parts: [
        { content_type: 'audio_transcription', text: 'The spoken answer is preserved.' }
      ] }, metadata: { is_visually_hidden_from_conversation: false }
    };
    const pointer = reply(finalId, `::chatgpt-content-reference{index="0" source_message_id="${sourceId}"}`);
    const { data } = await scanPage(exchange(0, 'user-a', 'Voice question', finalId, 'The spoken answer is preserved.'), {
      'user-a': exchangeFiber([{ turn: { messages: [user('user-a', 'Voice question'), source, pointer] } }])
    });
    const final = data.turns[0].messages.find((message: any) => message.rawMessageId === finalId);
    expect(final).toMatchObject({ role: 'assistant', rawText: 'The spoken answer is preserved.' });
    expect(final.referenceIncomplete).toBeUndefined();
  });

  it('marks a content-reference incomplete when its provider source message is unavailable', async () => {
    const finalId = 'voice-final-missing';
    const pointerText = '::chatgpt-content-reference{index="0" source_message_id="missing-source"}';
    const pointer = reply(finalId, pointerText);
    const { data } = await scanPage(exchange(0, 'user-a', 'Voice question', finalId, pointerText), {
      'user-a': exchangeFiber([{ turn: { messages: [user('user-a', 'Voice question'), pointer] } }])
    });
    const final = data.turns[0].messages.find((message: any) => message.rawMessageId === finalId);
    expect(final).toMatchObject({ role: 'assistant', rawText: pointerText, stable: false, referenceIncomplete: true });
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

  async function scan(item: Record<string, unknown>, value: Record<string, unknown> | null, user = userItem(),
    options: { images?: string[]; model?: Record<string, unknown>; beforeReply?: Record<string, unknown> } = {}): Promise<Record<string, any>> {
    const body = exchange(6, USER_ID, '1+1', REPLY_ID, '<strong>2</strong>');
    const window = page(body).window as unknown as Window & typeof globalThis & Record<string, any>;
    const fiber = renderItemExchange(item, value, user);
    if (options.model) fiber.child!.sibling!.memoizedProps.message = options.model;
    if (options.beforeReply) fiber.child!.sibling = {
      memoizedProps: { item: options.beforeReply }, return: fiber, sibling: fiber.child!.sibling
    };
    (window.document.querySelector(`[data-turn-key="${USER_ID}"]`) as any)['__reactFiber$live'] = fiber;
    const unit = window.document.querySelector('[data-chatgpt-search-unit-key$=":user"]')!;
    for (const id of options.images ?? []) {
      const image = window.document.createElement('img');
      image.src = 'https://chatgpt.com/backend-api/estuary/content?id=' + id + '&sig=private';
      unit.append(image);
    }
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
    const data = await reply;
    return { ...data, imageStamps: [...unit.querySelectorAll('img')].map(node => node.getAttribute('data-clf-fiber-image')) };
  }

  // GPT-6 / DIL renderer (2026-10-08, from Chat On Steroids 2.1.31): content is only a reference to
  // the item itself, and the words are the fallbackMarkdown of its own dil reference.
  const dilReply = (fallbackMarkdown: string, source = REPLY_ID) => assistantItem({
    content: `::chatgpt-content-reference{index="0" source_message_id="${REPLY_ID}"}`,
    contentReferences: [{ type: 'dil', source_message_id: source, model_dil_v2: { fallbackMarkdown } }]
  });

  it('archives a GPT-6 DIL reply as its own fallback words, final and stable', async () => {
    const data = await scan(dilReply('The **real** answer.'), context());
    const reply = data.turns[0].messages.find((message: any) => message.rawMessageId === REPLY_ID);
    expect(reply).toMatchObject({ role: 'assistant', rawText: 'The **real** answer.', stable: true });
    expect(reply.referenceIncomplete).toBeUndefined();
    expect(data.turns[0].endMessageId).toBe(REPLY_ID);
    expect(JSON.stringify(data.turns[0].messages)).not.toContain('chatgpt-content-reference');
  });

  it('drops the escapes GPT-6 fallback Markdown adds outside code, as Markdown renders it', async () => {
    const read = async (markdown: string) => (await scan(dilReply(markdown), context())).turns[0].messages
      .find((message: any) => message.rawMessageId === REPLY_ID).rawText;
    expect(await read('Done.\n\n\\[\\[PARADIGMEVE\\_GOAL:COMPLETE\\]\\]')).toBe('Done.\n\n[[PARADIGMEVE_GOAL:COMPLETE]]');
    expect(await read('## Title\n\n**bold** `code`\n2\\^10 = 1024 \\[ok\\] C:\\\\Users')).toBe('## Title\n\n**bold** `code`\n2^10 = 1024 [ok] C:\\Users');
    expect(await read('```python\nx = a[0] ** 2  # note \\[\n```\n\n`C:\\Users\\[x]` and \\_after\\_'))
      .toBe('```python\nx = a[0] ** 2  # note \\[\n```\n\n`C:\\Users\\[x]` and _after_');
  });

  it('keeps an unresolved GPT-6 reference as incomplete evidence, never as a stable answer', async () => {
    // A dil reference naming another message is not this reply's words.
    const data = await scan(dilReply('Not this one', 'b0000009-0000-4000-8000-000000000009'), context());
    const reply = data.turns[0].messages.find((message: any) => message.rawMessageId === REPLY_ID);
    expect(reply).toMatchObject({ rawText: expect.stringContaining('::chatgpt-content-reference'), stable: false, referenceIncomplete: true });
  });

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

  it.each(['file_00000000000000000000000000000077', 'file-0123456789abcdef'])('retains rendered-item uploads without a model message (%s)', async assetId => {
    const file = { id: assetId, name: 'upload.png', size: 123, mime_type: 'image/png', url: 'must-not-cross-worlds' };
    const data = await scan(assistantItem(), context(), userItem({ message: '', attachments: [file] }),
      { images: [assetId, 'file_00000000000000000000000000000099'] });
    expect(data.turns[0].messages[0]).toMatchObject({ role: 'user', rawText: '',
      attachments: [{ id: assetId, name: 'upload.png', size: 123, mimeType: 'image/png' }] });
    expect(data.turns[0].images).toEqual([expect.objectContaining({ messageId: USER_ID, assetId,
      providerRole: 'user', providerStatus: 'finished_successfully', order: 0 })]);
    // The exchange and its user unit overlap; one DOM node still gets one exact stamp.
    expect(data.imageStamps[0]).toBeTruthy();
    expect(data.imageStamps[1]).toBeNull();
    expect(data.turns[0].imageTraces).toEqual([expect.objectContaining({ source: 'rendered-item', parts: 1, metaAtt: 1,
      attachmentKeys: ['id', 'name', 'size', 'mime_type', 'url'] })]);
    expect(JSON.stringify(data)).not.toMatch(/private|must-not-cross-worlds|estuary/);
  });

  // Live c14 (2026-10-06): a chatgpt.com upload left `attachments` empty; the item also carries
  // chatGptImageAttachments, chatGptFileAttachments and images. Each list yields the exact file id.
  it.each([
    ['chatGptImageAttachments objects without a MIME type', { chatGptImageAttachments: [{ id: 'file_00000000000000000000000000000077', name: 'shot.png', size: 321, width: 800, height: 600 }] }],
    ['images as typed pointers', { images: ['sediment://file_00000000000000000000000000000077'] }],
    ['images as bare provider ids', { images: ['file_00000000000000000000000000000077'] }],
    ['chatGptFileAttachments with an image MIME type and a fileId field', { chatGptFileAttachments: [{ fileId: 'file_00000000000000000000000000000077', mimeType: 'image/png' }] }]
  ])('reads a browser upload from %s', async (_label, lists) => {
    const assetId = 'file_00000000000000000000000000000077';
    const data = await scan(assistantItem(), context(), userItem({ message: 'attached image', attachments: [], ...lists }),
      { images: [assetId, 'file_00000000000000000000000000000099'] });
    expect(data.turns[0].images).toEqual([expect.objectContaining({ messageId: USER_ID, assetId, providerRole: 'user' })]);
    expect(data.imageStamps[0]).toBeTruthy();
    expect(data.imageStamps[1]).toBeNull();
    expect(data.turns[0].imageTraces[0]).toMatchObject({ source: 'rendered-item', parts: 1, metaAtt: 0, uploads: 1 });
    expect(JSON.stringify(data.turns[0].imageTraces)).not.toContain('file_000');
  });

  it('records each upload list shape in the trace without values', async () => {
    const data = await scan(assistantItem(), context(), userItem({ attachments: [],
      chatGptImageAttachments: [{ id: 'file_00000000000000000000000000000077', name: 'secret-name.png', url: 'https://cdn.example/sig' }],
      images: ['blob:https://chatgpt.com/abc'] }), { images: [] });
    expect(data.turns[0].imageTraces[0].uploadShape).toEqual({
      attachments: { len: 0, kind: 'none', keys: [] },
      chatGptImageAttachments: { len: 1, kind: 'object', keys: ['id', 'name', 'url'] },
      images: { len: 1, kind: 'string', keys: [] }
    });
    expect(JSON.stringify(data.turns[0].imageTraces)).not.toMatch(/secret-name|cdn\.example|blob:|sig/);
  });

  it('refuses a file list entry without an image MIME type or with two different ids', async () => {
    const assetId = 'file_00000000000000000000000000000077';
    const data = await scan(assistantItem(), context(), userItem({ attachments: [],
      chatGptFileAttachments: [{ id: assetId }, { id: assetId, mimeType: 'application/pdf' }],
      chatGptImageAttachments: [{ id: assetId, fileId: 'file_00000000000000000000000000000099' }],
      images: ['https://chatgpt.com/backend-api/estuary/content?id=' + assetId] }), { images: [assetId] });
    expect(data.turns[0].images).toEqual([]);
    expect(data.imageStamps).toEqual([null]);
  });

  it('keeps the rendered user before a real model reply with a server timestamp', async () => {
    const model = { id: REPLY_ID, author: { role: 'assistant' }, recipient: 'all', channel: 'final',
      create_time: 1789552100, status: 'finished_successfully', end_turn: true,
      content: { content_type: 'text', parts: ['The model answer'] }, metadata: {} };
    const data = await scan(assistantItem(), context(), userItem(), { model });
    expect(data.turns[0].messages.map((message: any) => [message.role, message.rawText])).toEqual([
      ['user', '1+1'], ['assistant', 'The model answer']
    ]);
    expect(data.turns[0].endMessageId).toBe(REPLY_ID);
  });

  it('uses the real user model image identity instead of a conflicting rendered attachment', async () => {
    const assetId = 'file_00000000000000000000000000000077';
    const otherId = 'file_00000000000000000000000000000099';
    const model = { id: USER_ID, author: { role: 'user' }, recipient: 'all', status: 'finished_successfully',
      content: { content_type: 'multimodal_text', parts: [
        { content_type: 'image_asset_pointer', asset_pointer: 'sediment://' + assetId }, 'Model user text'
      ] }, metadata: {} };
    const data = await scan(assistantItem(), context(), userItem({ attachments: [
      { id: otherId, name: 'stale.png', mime_type: 'image/png', size: 12 }
    ] }), { model, images: [assetId, otherId] });
    expect(data.turns[0].messages[0]).toMatchObject({ role: 'user', rawText: 'Model user text' });
    expect(data.turns[0].images.map((image: any) => image.assetId)).toEqual([assetId]);
    expect(data.imageStamps[0]).toBeTruthy();
    expect(data.imageStamps[1]).toBeNull();
    expect(data.turns[0].imageTraces[0]).toMatchObject({ source: 'model', parts: 1 });
  });

  it('keeps rendered commentary before a timestamped model final in a mixed exchange', async () => {
    const interimId = 'b0000004-0000-4000-8000-000000000004';
    const model = { id: REPLY_ID, author: { role: 'assistant' }, recipient: 'all', channel: 'final',
      create_time: 1789552100, status: 'finished_successfully', end_turn: true,
      content: { content_type: 'text', parts: ['Final answer'] }, metadata: {} };
    const beforeReply = assistantItem({ messageId: interimId, latestMessageId: interimId, sourceMessageIds: [interimId],
      phase: 'commentary', completed: false, content: 'First update' });
    const data = await scan(assistantItem(), context(), userItem(), { model, beforeReply });
    expect(data.turns[0].messages.map((message: any) => message.rawText)).toEqual(['1+1', 'First update', 'Final answer']);
  });

  it('rejects invalid or non-image rendered attachments even when a DOM image offers an id', async () => {
    const assetId = 'file_00000000000000000000000000000077';
    const data = await scan(assistantItem(), context(), userItem({ attachments: [
      { id: assetId, mime_type: 'text/plain', name: 'file.png', size: 123 },
      { id: assetId, mime_type: 'image/png', mimeType: 'text/plain' },
      { id: 'https://chatgpt.com/secret', mime_type: 'image/png' }
    ] }), { images: [assetId] });
    expect(data.turns[0].images).toEqual([]);
    expect(data.turns[0].messages[0].attachments).toBeUndefined();
    expect(data.imageStamps).toEqual([null]);
    expect(data.turns[0].imageTraces[0]).toMatchObject({ parts: 0, metaAtt: 3 });
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
