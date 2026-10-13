/**
 * Passive, bounded page-response projection.
 *
 * Never reads request headers, cookies, credentials or request bodies. Besides
 * quota metadata, it observes the two opaque identifiers ChatGPT itself puts in the live
 * conversation event stream: `conversation_id` and `metadata.request_id`. The latter can
 * reach the stream tens of seconds before React publishes it, which is the difference between
 * an exact Core caller and CALLER_IDENTITY_REQUIRED. A conversation id may also cross worlds
 * alone at a bounded fresh-chat `stream_handoff` -> `input_message` boundary so one already-clicked
 * Compact & Resume bootstrap can bind before React mounts; that projection grants no tool authority.
 */
(() => {
  'use strict';
  if (window.__cosUsageObserver) return;
  window.__cosUsageObserver = true;
  const post = window.postMessage.bind(window);
  let latest = null;
  let requestOrder = 0, latestOrder = 0;
  const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // OpenAI historically used `wfr_…` connector ids, but live 2026-09-25 also emits UUID-shaped
  // x-request-id / metadata.request_id values. Identity is the exact opaque join key, not its
  // marketing-era prefix. Keep this contract identical to local MCP ingress: bounded ASCII
  // alnum/underscore/hyphen only. Browser evidence alone still grants nothing; /correlations
  // requires the same id to have reached a real local MCP dispatch.
  const REQUEST = /^[a-zA-Z0-9_-]{1,100}$/;
  const RESUME = /^\s*\[\[CLF-RESUME:([A-Za-z0-9_-]{16,64})\]\](?:\\?\s|$)/;
  const CONVERSATION_FIELD = /(?:^|[,{\s])\"conversation_id\"\s*:\s*\"([0-9a-f-]{36})\"/gi;
  const project = (data, observedAt, order) => {
    if (!data || typeof data !== 'object') return;
    const rows = [];
    const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9_. /-]{1,100}$/.test(value) ? value : null;
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const add = (value) => { if (rows.length < 80) rows.push(value); };
    const metadata = data.conversation_detail_metadata || data;
    const recognized = Array.isArray(metadata.model_limits) || Array.isArray(metadata.limits_progress) || !!data.rate_limit || Array.isArray(data.additional_rate_limits);
    if (!recognized || order < latestOrder) return;
    for (const row of (Array.isArray(metadata.model_limits) ? metadata.model_limits : []).slice(0, 40)) {
      const model = label(row?.model_slug);
      const reset = typeof row?.resets_after === 'string' ? Date.parse(row.resets_after) : NaN;
      // A reset timestamp alone is not a remaining-message count.
      const remaining = finite(row?.remaining), resetAt = Number.isFinite(reset) && reset > 0 ? reset : null;
      if (model && (remaining !== null || resetAt !== null)) add({ model, scope: 'model', remaining, remainingPercent: null, resetAt, windowSeconds: null });
    }
    for (const row of (Array.isArray(metadata.limits_progress) ? metadata.limits_progress : []).slice(0, 40)) {
      const model = label(row?.model_slug), feature = label(row?.feature_name), remaining = finite(row?.remaining);
      const reset = typeof row?.reset_after === 'string' ? Date.parse(row.reset_after) : NaN;
      if ((model || feature) && remaining !== null) add({ model: model || feature, scope: model ? 'model' : 'feature', remaining, remainingPercent: null, resetAt: Number.isFinite(reset) && reset > 0 ? reset : null, windowSeconds: null });
    }
    const rates = [{ ...data, label: 'Shared usage' }, ...(Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.slice(0, 40) : [])];
    for (const rate of rates) {
      const model = label(rate?.model_slug), name = model || label(rate?.limit_name) || label(rate?.label);
      for (const window of [rate?.rate_limit?.primary_window, rate?.rate_limit?.secondary_window]) {
        const used = finite(window?.used_percent);
        if (!name || used === null || used > 100) continue;
        const reset = finite(window?.reset_at);
        add({ model: name, scope: model ? 'model' : 'shared', remaining: null, remainingPercent: 100 - used, resetAt: reset === null || reset === 0 ? null : reset * 1000, windowSeconds: finite(window?.limit_window_seconds) || null });
      }
    }
    latestOrder = order;
    latest = { type: 'cos-usage', rows, observedAt }; post(latest, location.origin);
  };
  async function inspect(response, observedAt, order) {
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:wham\/usage|conversation\/init|conversation\/prepare|models)(?:\?|$)/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), 10000);
    let bytes = 0, text = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 512 * 1024) return;
        text += decoder.decode(value, { stream: true });
      }
      project(JSON.parse(text + decoder.decode()), observedAt, order);
    } catch { /* Unsupported metadata is unavailable, never guessed. */ }
    finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  }
  /**
   * Reads bounded complete SSE events from a clone without changing the page's response.
   * Only a conversation id and server request metadata from the same event are projected.
   */
  async function inspectRequestOrigins(response, observedAt) {
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), 90_000);
    const decoder = new TextDecoder();
    const emitted = new Set();
    const emittedResumes = new Set();
    let emittedConversation = false;
    let handoffConversation = null;
    let bytes = 0, buffer = '';
    // The one conversation this response has named so far; see scan().
    let responseConversation = null;
    const scan = (frame) => {
      if (!frame || frame.length > 512 * 1024) return;
      const conversations = new Set();
      CONVERSATION_FIELD.lastIndex = 0;
      for (let match; (match = CONVERSATION_FIELD.exec(frame));) {
        if (CONVERSATION.test(match[1])) conversations.add(match[1]);
      }
      // A contradictory frame abstains. Otherwise the join may span events, but only within this
      // one response: ChatGPT's `/f/conversation` stream now opens with a handoff event that
      // carries `conversation_id`, and the `input_message` event after it carries the request id
      // with no conversation at all (upstream chat-on-steroids #414, measured live 2026-09-26).
      // One HTTP response is one conversation; a later event naming another one retires the
      // remembered id, so response order never becomes authority across conversations.
      if (conversations.size > 1) return;
      if (conversations.size === 1) {
        const named = conversations.values().next().value;
        if (responseConversation && responseConversation !== named) {
          responseConversation = null;
          handoffConversation = null;
          return;
        }
        responseConversation = named;
      }
      const conversationId = responseConversation;
      if (!conversationId) return;
      // Only server metadata in a complete JSON event owns a request id. A key in
      // quoted model text, tool arguments or an unrelated nested object is not proof.
      let event;
      try {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        event = JSON.parse(data);
      } catch { return; }
      // Current delta-encoded frames (`{p, o, v, c}`) carry the conversation one level in, on
      // `v.conversation_id`, beside the server message. Read live 2026-10-13: a fresh chat's first
      // answer streams only these frames (no input_message), with the request id on
      // `v.message.metadata`. Dropping them withheld every early identity proof for a Compact &
      // Resume bootstrap until the stream ended minutes later.
      const deltaValue = event?.v && typeof event.v === 'object' && !Array.isArray(event.v) ? event.v : null;
      const eventConversation = typeof event?.conversation_id === 'string' ? event.conversation_id
        : typeof deltaValue?.conversation_id === 'string' ? deltaValue.conversation_id : undefined;
      if (conversations.size === 1 && eventConversation !== conversationId) return;
      // The response's opening event names its conversation: `resume_conversation_token` today,
      // `stream_handoff` before it.
      if ((event?.type === 'stream_handoff' || event?.type === 'resume_conversation_token') && eventConversation === conversationId) {
        handoffConversation = conversationId;
      }
      const serverMessage = deltaValue?.message && typeof deltaValue.message === 'object' && deltaValue.conversation_id === conversationId
        ? deltaValue.message : null;
      // Fresh-chat responses can expose their server-created conversation id before either
      // React mounts the authored user row or `input_message` echoes its content. Wait for that
      // response's input_message boundary before projecting the opaque id: a later contradictory
      // stream_handoff must be able to retire the candidate before anything crosses worlds.
      // The isolated content script may use it only while it owns one exact post-click bootstrap;
      // by itself this grants no authority.
      if (!emittedConversation && (event?.type === 'input_message' || serverMessage) && handoffConversation === conversationId) {
        emittedConversation = true;
        post({ type: 'cos-conversation-origin', conversationId, observedAt }, location.origin);
      }
      // `input_message.metadata` is where the id moved: the same server metadata, one level in.
      const requestIds = new Set([event?.metadata?.request_id, event?.message?.metadata?.request_id,
        event?.input_message?.metadata?.request_id, serverMessage?.metadata?.request_id]
        .filter(id => typeof id === 'string' && REQUEST.test(id)));
      const fresh = [...requestIds].filter((id) => !emitted.has(id)).slice(0, 16 - emitted.size);
      // A fresh Compact & Resume can have a server-created conversation long before React
      // renders its first user row. Project ONLY the marker from the server's own input_message
      // event, never the handoff body, request payload, tool arguments or assistant/model text.
      // The isolated page checks this against its one armed destination command before ACK.
      if (event?.type === 'input_message' && event.input_message && typeof event.input_message === 'object') {
        const content = event.input_message.content;
        const part = Array.isArray(content?.parts) ? content.parts[0] : null;
        const marker = typeof part === 'string' ? part.match(RESUME) : null;
        if (marker && !emittedResumes.has(marker[1]) && emittedResumes.size < 2) {
          emittedResumes.add(marker[1]);
          post({ type: 'cos-resume-origin', conversationId, token: marker[1], observedAt }, location.origin);
        }
      }
      if (fresh.length === 0) return;
      for (const id of fresh) emitted.add(id);
      post({ type: 'cos-request-origin', conversationId, requestIds: fresh, observedAt }, location.origin);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const lf = buffer.indexOf('\n\n');
          const crlf = buffer.indexOf('\r\n\r\n');
          const split = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
          if (split < 0) break;
          const width = buffer.startsWith('\r\n\r\n', split) ? 4 : 2;
          scan(buffer.slice(0, split));
          buffer = buffer.slice(split + width);
        }
        if (buffer.length > 512 * 1024) return;
      }
      buffer += decoder.decode();
      scan(buffer);
    } catch { /* A missing stream observation leaves the existing Fiber path in charge. */ }
    finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  }
  let observedFetch = null;
  const inspectedResponses = new WeakSet();
  const installFetchObserver = () => {
    if (window.fetch === observedFetch || typeof window.fetch !== 'function') return;
    // A page wrapper may still call our earlier wrapper. Capture its downstream
    // function per installation; changing a shared pointer would create a cycle.
    const downstreamFetch = window.fetch;
    observedFetch = function (...args) {
      // Request order fences late responses, not accounts. No account identity is inferred.
      const observedAt = Date.now(), order = ++requestOrder;
      const result = downstreamFetch.apply(this, args);
      void result.then((response) => {
        if (inspectedResponses.has(response)) return;
        inspectedResponses.add(response);
        void inspect(response, observedAt, order).catch(() => {});
        let method = 'GET';
        try {
          const explicit = args[1] && typeof args[1].method === 'string' ? args[1].method : null;
          const inherited = args[0] && typeof args[0] === 'object' && typeof args[0].method === 'string' ? args[0].method : null;
          method = String(explicit || inherited || 'GET').toUpperCase();
        } catch { return; }
        if (method === 'POST') void inspectRequestOrigins(response, observedAt).catch(() => {});
      }).catch(() => {});
      return result;
    };
    // ChatGPT installs its own fetch instrumentation after document_start. Keep that owner in
    // the chain and reattach once at the page-ready boundary; otherwise our flag remains set
    // while the live response observer has silently been replaced.
    window.fetch = observedFetch;
  };
  installFetchObserver();
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', installFetchObserver, { once: true });
  }
  // A provider can replace fetch again after DOMContentLoaded. The isolated Companion
  // signals its one authorized Resume Send synchronously, before the native click can
  // start the request. Reattach only at that boundary, without polling the page or
  // observing request payloads; this event confers no browser or local-tool authority.
  window.addEventListener('cos-resume-send-observer', installFetchObserver);
  window.addEventListener('message', (event) => {
    if (event.source === window && event.origin === location.origin && event.data?.type === 'cos-usage-request' && latest) post(latest, location.origin);
  });
})();
