import type {
  ArchiveHtmlViewModel,
  ArchiveViewAsset,
  ArchiveViewChat,
  ArchiveViewChatHeader,
  ArchiveViewContinuation,
  ArchiveViewMessage,
  ArchiveViewToolGroup,
  ArchiveViewTranscriptItem
} from './archive-view-model.js';

export interface ArchiveHtmlShellViewModel {
  archiveTitle?: string;
  generatedAtLabel?: string;
  selectedChatId?: string;
  chats: readonly ArchiveViewChatHeader[];
}

export interface ArchiveHtmlLazyChat extends ArchiveViewChatHeader {
  /** App-authored archive-relative first classic-script segment. Never derived from provider/user paths. */
  chunkPath: string;
  /** Number of bounded local transcript segments for this chat. */
  segmentCount: number;
}

export interface ArchiveHtmlLazyViewModel {
  archiveTitle?: string;
  generatedAtLabel?: string;
  selectedChatId?: string;
  /** App-authored archive-relative classic-script corpus containing only searchable authored text. */
  searchPath: string;
  chats: readonly ArchiveHtmlLazyChat[];
}

const HTML_VERSION = 1;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function archiveRelativeHref(path: string | undefined): string | null {
  if (!path || path.includes('\\') || path.startsWith('/') || path.includes('\0')) return null;
  const segments = path.split('/');
  if (segments.length === 0 || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':'))) {
    return null;
  }
  return segments.map(segment => encodeURIComponent(segment)).join('/');
}

function humanBytes(value: number | undefined): string | null {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return null;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function assetMetadata(asset: ArchiveViewAsset): string {
  const fields: string[] = [];
  if (asset.mimeType) fields.push(asset.mimeType);
  if (asset.width !== undefined && asset.height !== undefined &&
      Number.isSafeInteger(asset.width) && Number.isSafeInteger(asset.height) && asset.width > 0 && asset.height > 0) {
    fields.push(`${asset.width}×${asset.height}`);
  }
  const bytes = humanBytes(asset.byteLength);
  if (bytes) fields.push(bytes);
  return fields.length > 0 ? `<div class="asset-meta">${escapeHtml(fields.join(' · '))}</div>` : '';
}

function missingAssetText(asset: ArchiveViewAsset): string {
  if (asset.captureState === 'provider-only') return 'Provider-only content was not captured locally.';
  if (asset.captureState === 'metadata-only') return 'Metadata was retained, but the content bytes were not captured.';
  if (asset.captureState === 'capture-error') return asset.detail || 'Local capture failed; no retained bytes are available.';
  if (asset.captureState === 'missing') return asset.detail || 'The retained asset bytes are missing.';
  return 'Retained metadata exists, but no safe archive-relative asset path was supplied.';
}

function renderAsset(asset: ArchiveViewAsset): string {
  const label = escapeHtml(asset.label || (asset.kind === 'image' ? 'Image' : 'File'));
  const metadata = assetMetadata(asset);
  const href = asset.captureState === 'retained' ? archiveRelativeHref(asset.localPath) : null;
  if (!href) {
    return `<article class="asset-card asset-missing" data-asset-state="${escapeHtml(asset.captureState)}">
      <div class="asset-heading"><span class="asset-kind">${asset.kind === 'image' ? 'Image' : 'File'}</span><strong>${label}</strong></div>
      ${metadata}
      <div class="missing-state">${escapeHtml(missingAssetText(asset))}</div>
    </article>`;
  }

  if (asset.kind === 'image') {
    return `<article class="asset-card" data-asset-state="retained">
      <a class="image-link" href="${escapeHtml(href)}" target="_blank" rel="noopener" aria-label="Open full-size local image: ${label}">
        <img src="${escapeHtml(href)}" alt="${label}" loading="lazy" decoding="async">
      </a>
      <div class="asset-heading"><span class="asset-kind">Image</span><strong>${label}</strong></div>
      ${metadata}
      <a class="asset-open" href="${escapeHtml(href)}" target="_blank" rel="noopener">Open local image</a>
    </article>`;
  }

  return `<article class="asset-card" data-asset-state="retained">
    <div class="asset-heading"><span class="asset-kind">File</span><strong>${label}</strong></div>
    ${metadata}
    <a class="asset-open" href="${escapeHtml(href)}" target="_blank" rel="noopener">Open local file</a>
  </article>`;
}

function renderAssets(assets: readonly ArchiveViewAsset[] | undefined): string {
  if (!assets || assets.length === 0) return '';
  return `<div class="asset-grid">${assets.map(renderAsset).join('')}</div>`;
}

function roleLabel(role: ArchiveViewMessage['role']): string {
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  return 'You';
}

function renderMessage(message: ArchiveViewMessage): string {
  const detail = [message.timestampLabel, message.modelLabel].filter((value): value is string => Boolean(value));
  return `<article class="message message-${message.role}" data-message-id="${escapeHtml(message.id)}">
    <header><strong>${roleLabel(message.role)}</strong>${detail.length ? `<span>${escapeHtml(detail.join(' · '))}</span>` : ''}</header>
    <div class="message-text">${escapeHtml(message.text)}</div>
    ${renderAssets(message.assets)}
  </article>`;
}

function renderToolGroup(group: ArchiveViewToolGroup): string {
  const summary = group.summary ? `<span class="tool-summary">${escapeHtml(group.summary)}</span>` : '';
  const calls = group.calls.length === 0
    ? '<div class="missing-state">No tool-call details were retained.</div>'
    : group.calls.map(call => `<article class="tool-call">
        <header><strong>${escapeHtml(call.name)}</strong>${call.status ? `<span>${escapeHtml(call.status)}</span>` : ''}</header>
        ${call.argumentsText === undefined ? '' : `<section><h4>Arguments</h4><pre>${escapeHtml(call.argumentsText)}</pre></section>`}
        ${call.resultText === undefined ? '' : `<section><h4>Result</h4><pre>${escapeHtml(call.resultText)}</pre></section>`}
        ${renderAssets(call.assets)}
      </article>`).join('');
  return `<details class="tool-group" data-tool-group-id="${escapeHtml(group.id)}">
    <summary><span>${escapeHtml(group.label)}</span>${summary}</summary>
    <div class="tool-body">${calls}</div>
  </details>`;
}

function renderContinuation(item: ArchiveViewContinuation, tokenByChatId: ReadonlyMap<string, string>): string {
  const target = item.targetChatId ? tokenByChatId.get(item.targetChatId) : undefined;
  const navigation = item.targetChatId
    ? target
      ? `<a href="#${target}" data-chat-nav="${target}">Open linked archived chat</a>`
      : '<span class="missing-state">Linked chat is not present in this generated archive view.</span>'
    : '';
  return `<article class="continuation-card" data-continuation-id="${escapeHtml(item.id)}">
    <strong>${escapeHtml(item.label)}</strong>
    ${item.detail ? `<div>${escapeHtml(item.detail)}</div>` : ''}
    ${navigation}
  </article>`;
}

function renderNotice(item: Extract<ArchiveViewTranscriptItem, { kind: 'notice' }>): string {
  return `<article class="notice notice-${item.tone}" data-notice-id="${escapeHtml(item.id)}">
    <strong>${escapeHtml(item.title)}</strong>${item.text ? `<div>${escapeHtml(item.text)}</div>` : ''}
  </article>`;
}

export function renderArchiveTranscriptItem(item: ArchiveViewTranscriptItem, tokenByChatId: ReadonlyMap<string, string>): string {
  if (item.kind === 'message') return renderMessage(item);
  if (item.kind === 'tool-group') return renderToolGroup(item);
  if (item.kind === 'continuation') return renderContinuation(item, tokenByChatId);
  return renderNotice(item);
}

function splitPresentationText(value: string, maxChars: number): string[] {
  if (value.length <= maxChars) return [value];
  const parts: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + maxChars);
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (end < value.length && previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * Split unusually large transcript rows into complete inert HTML blocks before static paging.
 * This keeps a single restored overflow tool result from defeating the page-size bound while
 * retaining every locally archived character. Ordinary rows keep their original markup.
 */
export function renderArchiveTranscriptItemParts(
  item: ArchiveViewTranscriptItem,
  tokenByChatId: ReadonlyMap<string, string>,
  maxTextChars: number
): string[] {
  if (!Number.isSafeInteger(maxTextChars) || maxTextChars < 1) throw new Error('Archive transcript part limit is invalid');
  if (item.kind === 'message') {
    if (item.text.length <= maxTextChars) return [renderMessage(item)];
    const textParts = splitPresentationText(item.text, maxTextChars);
    return textParts.map((text, index) => renderMessage({
      ...item,
      id: `${item.id}:part-${index + 1}`,
      text,
      ...(index === 0 ? {} : { assets: undefined })
    }));
  }
  if (item.kind === 'tool-group') {
    const textChars = item.calls.reduce((total, call) => total + (call.argumentsText?.length ?? 0) + (call.resultText?.length ?? 0), 0);
    if (textChars <= maxTextChars) return [renderToolGroup(item)];
    const calls: ArchiveViewToolGroup['calls'][number][] = [];
    for (const call of item.calls) {
      let firstPart = true;
      const add = (field: 'argumentsText' | 'resultText', text: string): void => {
        for (const part of splitPresentationText(text, maxTextChars)) {
          calls.push({
            ...call,
            argumentsText: field === 'argumentsText' ? part : undefined,
            resultText: field === 'resultText' ? part : undefined,
            ...(firstPart ? {} : { assets: undefined })
          });
          firstPart = false;
        }
      };
      if (call.argumentsText !== undefined) add('argumentsText', call.argumentsText);
      if (call.resultText !== undefined) add('resultText', call.resultText);
      if (firstPart) calls.push(call);
    }
    return calls.map((call, index) => renderToolGroup({
      ...item,
      id: `${item.id}:part-${index + 1}`,
      label: calls.length > 1 ? `${item.label} · ${index + 1}/${calls.length}` : item.label,
      calls: [call]
    }));
  }
  if (item.kind === 'notice' && item.text && item.text.length > maxTextChars) {
    const textParts = splitPresentationText(item.text, maxTextChars);
    return textParts.map((text, index) => renderNotice({
      ...item,
      id: `${item.id}:part-${index + 1}`,
      title: textParts.length > 1 ? `${item.title} · ${index + 1}/${textParts.length}` : item.title,
      text
    }));
  }
  return [renderArchiveTranscriptItem(item, tokenByChatId)];
}

function captureBanner(chat: ArchiveViewChatHeader): string {
  if (chat.captureState === undefined || chat.captureState === 'complete') return '';
  const text = chat.captureState === 'metadata-only'
    ? 'This archive contains metadata only for part or all of this chat. Missing content was not reconstructed.'
    : 'This chat was only partially captured. Missing evidence remains explicitly unavailable.';
  return `<div class="capture-banner" data-capture-state="${chat.captureState}">${escapeHtml(text)}</div>`;
}

export function renderArchiveChatStart(chat: ArchiveViewChatHeader, token: string): string {
  const metadata = chat.metadata?.map(row => `<div class="metadata-row"><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`).join('') ?? '';
  return `<section class="chat-panel" id="${token}" data-chat-panel="${token}" hidden>
    <header class="chat-header">
      <div><h1>${escapeHtml(chat.title)}</h1>${chat.subtitle ? `<p>${escapeHtml(chat.subtitle)}</p>` : ''}</div>
      ${metadata ? `<dl class="chat-metadata">${metadata}</dl>` : ''}
    </header>
    ${captureBanner(chat)}
    <div class="transcript">`;
}

export function renderArchiveChatEnd(hasTranscript: boolean): string {
  return `${hasTranscript ? '' : '<div class="empty-transcript">No transcript evidence was retained for this chat.</div>'}</div>
  </section>`;
}

function renderLazyChatFrame(chat: ArchiveViewChatHeader, token: string, segmentCount: number): string {
  const metadata = chat.metadata?.map(row => `<div class="metadata-row"><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`).join('') ?? '';
  const pagingHidden = segmentCount <= 1 ? ' hidden' : '';
  return `<section class="chat-panel" id="${token}" data-chat-panel="${token}" hidden>
    <header class="chat-header">
      <div><h1>${escapeHtml(chat.title)}</h1>${chat.subtitle ? `<p>${escapeHtml(chat.subtitle)}</p>` : ''}</div>
      ${metadata ? `<dl class="chat-metadata">${metadata}</dl>` : ''}
    </header>
    ${captureBanner(chat)}
    <nav class="chat-segment-nav" data-chat-segment-nav aria-label="Archived chat parts"${pagingHidden}>
      <button type="button" data-chat-segment-prev>Previous part</button>
      <span data-chat-segment-status>Part 1 of ${segmentCount}</span>
      <button type="button" data-chat-segment-next>Next part</button>
    </nav>
    <div class="transcript" data-chat-segment-host><div class="empty-transcript">Loading archived chat…</div></div>
  </section>`;
}

function renderChat(chat: ArchiveViewChat, token: string, tokenByChatId: ReadonlyMap<string, string>): string {
  return renderArchiveChatStart(chat, token) +
    chat.transcript.map(item => renderArchiveTranscriptItem(item, tokenByChatId)).join('') +
    renderArchiveChatEnd(chat.transcript.length > 0);
}

function validateViewModel(model: ArchiveHtmlShellViewModel): void {
  if (!model || !Array.isArray(model.chats)) throw new Error('Archive HTML view model is invalid');
  const ids = model.chats.map(chat => chat.id);
  if (ids.some(id => typeof id !== 'string' || id.length === 0)) throw new Error('Archive chat id is invalid');
  if (new Set(ids).size !== ids.length) throw new Error('Archive chat ids must be unique');
}

function archiveChatToken(chat: ArchiveViewChatHeader, index: number): string {
  const conversationId = chat.providerConversationId?.trim();
  return conversationId && /^[A-Za-z0-9_-]{1,128}$/u.test(conversationId)
    ? 'chat-' + index + '/c/' + conversationId
    : 'chat-' + index;
}

const STYLE = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#171717;color:#ececec}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#171717}body{min-height:100vh}
.archive-shell{display:grid;grid-template-columns:minmax(250px,320px) minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;overflow:auto;padding:18px 12px;border-right:1px solid #333;background:#111}
.brand{padding:4px 8px 10px}.brand-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.brand strong{min-width:0;font-size:16px}.chat-generated{display:block;margin-top:4px;color:#999;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chat-sort{flex:0 0 auto;border:1px solid #3d3d3d;background:#202020;color:#d8d8d8;border-radius:8px;padding:6px 9px;font:inherit;font-size:12px;cursor:pointer}.chat-sort:hover,.chat-sort:focus-visible{background:#292929;color:#fff}.chat-sort:focus-visible{outline:2px solid #7aa7e8;outline-offset:2px}
.chat-search{width:100%;border:1px solid #3d3d3d;background:#202020;color:#f5f5f5;border-radius:9px;padding:10px 11px;margin:0 0 10px}
.chat-list{display:flex;flex-direction:column;gap:4px}.chat-link{display:block;padding:10px;border-radius:9px;color:#d6d6d6;text-decoration:none;overflow-wrap:anywhere}
.chat-link:hover,.chat-link.is-active{background:#292929;color:#fff}.chat-link-title{display:block;font-weight:600}.chat-link-subtitle{display:block;color:#929292;font-size:12px;margin-top:3px}
.chat-list-empty{display:none;color:#999;padding:12px 8px;font-size:13px}.chat-list-empty.is-visible{display:block}
.content{min-width:0}.chat-panel{max-width:920px;margin:0 auto;padding:34px 38px 80px}.chat-panel[hidden]{display:none}
.chat-header{padding-bottom:24px;border-bottom:1px solid #333}.chat-header h1{font-size:24px;margin:0}.chat-header p{color:#a8a8a8;margin:7px 0 0}
.chat-metadata{display:flex;flex-wrap:wrap;gap:8px 18px;margin:18px 0 0}.metadata-row{display:flex;gap:6px;font-size:12px}.metadata-row dt{color:#898989}.metadata-row dd{margin:0;color:#c7c7c7}
.capture-banner,.notice,.continuation-card,.empty-transcript{margin:20px 0;padding:12px 14px;border:1px solid #4a4230;border-radius:10px;background:#242018;color:#e8d9b7}
.notice-info,.continuation-card{border-color:#353535;background:#202020;color:#d5d5d5}.notice-missing{border-color:#573838;background:#281c1c;color:#f0caca}
.chat-segment-nav{display:flex;align-items:center;justify-content:center;gap:12px;margin:18px 0 4px}.chat-segment-nav[hidden]{display:none}.chat-segment-nav button{border:1px solid #3d3d3d;background:#202020;color:#d8d8d8;border-radius:8px;padding:7px 10px;font:inherit;font-size:12px;cursor:pointer}.chat-segment-nav button:hover:not(:disabled),.chat-segment-nav button:focus-visible{background:#292929;color:#fff}.chat-segment-nav button:disabled{opacity:.45;cursor:default}.chat-segment-nav span{min-width:90px;text-align:center;color:#999;font-size:12px}
.transcript{padding-top:10px}.message{margin:18px 0;padding:16px 18px;border-radius:16px;background:#202020;border:1px solid #2d2d2d}.message-user{margin-left:12%;background:#2a2a2a}.message-system{border-style:dashed;color:#c9c9c9}
.message header,.tool-call header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.message header span,.tool-call header span{color:#888;font-size:12px}
.message-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}
.tool-group{margin:18px 0;border:1px solid #333;border-radius:12px;background:#1c1c1c}.tool-group>summary{cursor:pointer;padding:12px 14px;display:flex;gap:10px;justify-content:space-between;color:#cfcfcf}.tool-summary{color:#888;font-size:12px}.tool-body{padding:0 12px 12px}.tool-call{margin-top:8px;padding:12px;border-radius:9px;background:#141414}
.tool-call h4{margin:10px 0 5px;color:#999;font-size:11px;text-transform:uppercase;letter-spacing:.06em}.tool-call pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:9px;border-radius:7px;background:#0d0d0d;color:#d8d8d8;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}
.asset-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:12px}.asset-card{min-width:0;padding:10px;border:1px solid #363636;border-radius:10px;background:#181818}.asset-missing{border-color:#543c3c}
.image-link{display:block;background:#0c0c0c;border-radius:7px;overflow:hidden;margin-bottom:9px}.image-link img{display:block;width:100%;max-height:320px;object-fit:contain}.asset-heading{display:flex;gap:8px;align-items:baseline;overflow-wrap:anywhere}.asset-kind{font-size:10px;text-transform:uppercase;color:#818181;letter-spacing:.08em}.asset-meta{color:#858585;font-size:11px;margin-top:5px}.asset-open,.continuation-card a{display:inline-block;color:#9bc4ff;margin-top:8px}.missing-state{color:#e1a9a9;font-size:12px;margin-top:7px;overflow-wrap:anywhere}
@media(max-width:720px){.archive-shell{display:block}.sidebar{position:relative;height:auto;border-right:0;border-bottom:1px solid #333}.chat-list{max-height:220px;overflow:auto}.chat-panel{padding:24px 16px 60px}.message-user{margin-left:5%}}
`;

const SCRIPT = `
(() => {
  'use strict';
  const panels = Array.from(document.querySelectorAll('[data-chat-panel]'));
  const links = Array.from(document.querySelectorAll('[data-chat-nav]'));
  const search = document.querySelector('[data-chat-search]');
  const empty = document.querySelector('[data-chat-list-empty]');
  const list = document.querySelector('.chat-list');
  const sort = document.querySelector('[data-chat-sort]');
  const fallback = document.body.getAttribute('data-default-chat') || '';
  const known = new Set(panels.map(panel => panel.getAttribute('data-chat-panel')));
  let order = 'newer';
  const preferredLanguages = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  const swedish = preferredLanguages.some(value => String(value || '').toLocaleLowerCase().startsWith('sv'));
  const sortLabels = swedish
    ? { newer: 'Nyare först', older: 'Äldre först' }
    : { newer: 'Newer first', older: 'Older first' };
  const sortValue = link => {
    const raw = link.getAttribute('data-chat-updated-at');
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const applySort = () => {
    if (!list || !sort) return;
    const sortable = links.filter(link => link.classList.contains('chat-link'));
    sortable.sort((left, right) => {
      const leftAt = sortValue(left);
      const rightAt = sortValue(right);
      if (leftAt !== null && rightAt !== null && leftAt !== rightAt) {
        return order === 'newer' ? rightAt - leftAt : leftAt - rightAt;
      }
      const leftIndex = Number(left.getAttribute('data-chat-sort-index') || 0);
      const rightIndex = Number(right.getAttribute('data-chat-sort-index') || 0);
      return leftIndex - rightIndex;
    });
    for (const link of sortable) list.append(link);
    sort.textContent = sortLabels[order];
    sort.setAttribute('aria-label', sortLabels[order]);
    sort.setAttribute('data-order', order);
  };
  const activate = () => {
    const requested = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    const exact = known.has(requested) ? requested : '';
    const legacy = !exact && /^chat-\\d+$/u.test(requested)
      ? Array.from(known).find(token => token.startsWith(requested + '/c/')) || ''
      : '';
    const token = exact || legacy || fallback;
    for (const panel of panels) panel.hidden = panel.getAttribute('data-chat-panel') !== token;
    for (const link of links) {
      const active = link.getAttribute('data-chat-nav') === token;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
  };
  const filter = () => {
    const query = search && 'value' in search ? String(search.value).trim().toLocaleLowerCase() : '';
    let visible = 0;
    for (const link of links) {
      if (!link.classList.contains('chat-link')) continue;
      const match = !query || (link.textContent || '').toLocaleLowerCase().includes(query);
      link.hidden = !match;
      if (match) visible += 1;
    }
    if (empty) empty.classList.toggle('is-visible', visible === 0);
  };
  window.addEventListener('hashchange', activate);
  if (search) search.addEventListener('input', filter);
  if (sort) sort.addEventListener('click', () => {
    order = order === 'newer' ? 'older' : 'newer';
    applySort();
  });
  applySort();
  activate();
  filter();
})();
`;

const LAZY_SCRIPT = `
(() => {
  'use strict';
  const links = Array.from(document.querySelectorAll('[data-chat-nav]'));
  const frames = new Map(Array.from(document.querySelectorAll('template[data-chat-frame]')).map(frame => [frame.getAttribute('data-chat-frame'), frame]));
  const search = document.querySelector('[data-chat-search]');
  const empty = document.querySelector('[data-chat-list-empty]');
  const list = document.querySelector('.chat-list');
  const sort = document.querySelector('[data-chat-sort]');
  const host = document.querySelector('[data-chat-host]');
  const fallback = document.body.getAttribute('data-default-chat') || '';
  const known = new Set(links.map(link => link.getAttribute('data-chat-nav')).filter(Boolean));
  const chunkByToken = new Map(links.map(link => [link.getAttribute('data-chat-nav'), link.getAttribute('data-chat-chunk')]));
  const segmentsByToken = new Map(links.map(link => [link.getAttribute('data-chat-nav'), Number(link.getAttribute('data-chat-segments') || 0)]));
  const corpus = globalThis.__EVE_ARCHIVE_SEARCH__ && typeof globalThis.__EVE_ARCHIVE_SEARCH__ === 'object'
    ? globalThis.__EVE_ARCHIVE_SEARCH__
    : Object.create(null);
  let order = 'newer';
  let currentToken = '';
  let currentSegment = -1;
  let loader = null;
  const preferredLanguages = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  const swedish = preferredLanguages.some(value => String(value || '').toLocaleLowerCase().startsWith('sv'));
  const sortLabels = swedish
    ? { newer: 'Nyare först', older: 'Äldre först' }
    : { newer: 'Newer first', older: 'Older first' };
  const segmentLabels = swedish
    ? { navigation: 'Arkiverade chattdelar', previous: 'Föregående del', next: 'Nästa del', part: 'Del', of: 'av', loading: 'Laddar arkiverad chatt…', error: 'Den här arkiverade chattdelen saknas eller kunde inte läsas lokalt.' }
    : { navigation: 'Archived chat parts', previous: 'Previous part', next: 'Next part', part: 'Part', of: 'of', loading: 'Loading archived chat…', error: 'This archived chat part is missing or could not be loaded locally.' };
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\\s+/gu, ' ').trim();
  const sortValue = link => {
    const raw = link.getAttribute('data-chat-updated-at');
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const applySort = () => {
    if (!list || !sort) return;
    const sortable = links.filter(link => link.classList.contains('chat-link'));
    sortable.sort((left, right) => {
      const leftAt = sortValue(left);
      const rightAt = sortValue(right);
      if (leftAt !== null && rightAt !== null && leftAt !== rightAt) {
        return order === 'newer' ? rightAt - leftAt : leftAt - rightAt;
      }
      const leftIndex = Number(left.getAttribute('data-chat-sort-index') || 0);
      const rightIndex = Number(right.getAttribute('data-chat-sort-index') || 0);
      return leftIndex - rightIndex;
    });
    for (const link of sortable) list.append(link);
    sort.textContent = sortLabels[order];
    sort.setAttribute('aria-label', sortLabels[order]);
    sort.setAttribute('data-order', order);
  };
  const segmentPath = (token, index) => {
    const first = chunkByToken.get(token);
    if (typeof first !== 'string') return '';
    const match = /^(data\\/g-[a-f0-9]{32}\\/chat-\\d+-segment-)0(\\.js)$/u.exec(first);
    if (!match || !Number.isSafeInteger(index) || index < 0) return '';
    return match[1] + index + match[2];
  };
  const segmentHost = () => host ? host.querySelector('[data-chat-segment-host]') : null;
  const updateSegmentNav = () => {
    if (!host) return;
    const count = segmentsByToken.get(currentToken) || 0;
    const nav = host.querySelector('[data-chat-segment-nav]');
    const previous = host.querySelector('[data-chat-segment-prev]');
    const next = host.querySelector('[data-chat-segment-next]');
    const status = host.querySelector('[data-chat-segment-status]');
    if (nav) {
      nav.hidden = count <= 1;
      nav.setAttribute('aria-label', segmentLabels.navigation);
    }
    if (previous) {
      previous.textContent = segmentLabels.previous;
      previous.disabled = currentSegment <= 0;
    }
    if (next) {
      next.textContent = segmentLabels.next;
      next.disabled = currentSegment < 0 || currentSegment >= count - 1;
    }
    if (status) status.textContent = segmentLabels.part + ' ' + (Math.max(0, currentSegment) + 1) + ' ' + segmentLabels.of + ' ' + count;
  };
  const showLoadError = (token, index) => {
    if (token !== currentToken || index !== currentSegment) return;
    const target = segmentHost();
    if (target) target.innerHTML = '<div class="empty-transcript">' + segmentLabels.error + '</div>';
    updateSegmentNav();
  };
  const loadSegment = (token, index) => {
    if (!host || !token || !known.has(token)) return;
    const count = segmentsByToken.get(token) || 0;
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) return;
    currentSegment = index;
    const target = segmentHost();
    if (!target) return;
    // Evict the previous heavy transcript DOM before reading the next local script.
    target.innerHTML = '<div class="empty-transcript">' + segmentLabels.loading + '</div>';
    updateSegmentNav();
    if (loader && loader.parentNode) loader.remove();
    const chunk = segmentPath(token, index);
    if (!chunk || !/^data\\/g-[a-f0-9]{32}\\/chat-\\d+-segment-\\d+\\.js$/u.test(chunk)) {
      showLoadError(token, index);
      return;
    }
    const script = document.createElement('script');
    loader = script;
    script.setAttribute('data-archive-chunk-loader', token + ':' + index);
    script.src = chunk;
    script.addEventListener('load', () => { if (script.parentNode) script.remove(); if (loader === script) loader = null; });
    script.addEventListener('error', () => { if (script.parentNode) script.remove(); if (loader === script) loader = null; showLoadError(token, index); });
    document.body.append(script);
  };
  globalThis.__EVE_ARCHIVE_SEGMENT__ = (token, index, html) => {
    if (!host || token !== currentToken || index !== currentSegment || !known.has(token) || typeof html !== 'string') return;
    const target = segmentHost();
    if (!target) { showLoadError(token, index); return; }
    target.innerHTML = html;
    updateSegmentNav();
  };
  const mount = token => {
    if (!host || !token || !known.has(token)) return;
    if (token === currentToken && host.querySelector('[data-chat-panel="' + token + '"]')) return;
    const frame = frames.get(token);
    const count = segmentsByToken.get(token) || 0;
    if (!frame || !Number.isSafeInteger(count) || count < 1) {
      currentToken = token;
      currentSegment = 0;
      host.innerHTML = '<section class="chat-panel"><div class="empty-transcript">' + segmentLabels.error + '</div></section>';
      return;
    }
    currentToken = token;
    currentSegment = -1;
    if (loader && loader.parentNode) loader.remove();
    loader = null;
    host.innerHTML = '';
    host.append(frame.content.cloneNode(true));
    const panel = host.querySelector('[data-chat-panel="' + token + '"]');
    if (!panel) {
      host.innerHTML = '<section class="chat-panel"><div class="empty-transcript">' + segmentLabels.error + '</div></section>';
      return;
    }
    panel.hidden = false;
    const previous = host.querySelector('[data-chat-segment-prev]');
    const next = host.querySelector('[data-chat-segment-next]');
    if (previous) previous.addEventListener('click', () => loadSegment(token, currentSegment - 1));
    if (next) next.addEventListener('click', () => loadSegment(token, currentSegment + 1));
    loadSegment(token, 0);
  };
  const activate = () => {
    const requested = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    const exact = known.has(requested) ? requested : '';
    const legacy = !exact && /^chat-\\d+$/u.test(requested)
      ? Array.from(known).find(token => token.startsWith(requested + '/c/')) || ''
      : '';
    const token = exact || legacy || fallback;
    for (const link of links) {
      const active = link.getAttribute('data-chat-nav') === token;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    mount(token);
  };
  const filter = () => {
    const query = search && 'value' in search ? normalize(search.value) : '';
    let visible = 0;
    for (const link of links) {
      if (!link.classList.contains('chat-link')) continue;
      const token = link.getAttribute('data-chat-nav') || '';
      const authored = Array.isArray(corpus[token]) ? corpus[token] : [];
      const match = !query || normalize(link.textContent).includes(query) || authored.some(value => String(value).includes(query));
      link.hidden = !match;
      if (match) visible += 1;
    }
    if (empty) empty.classList.toggle('is-visible', visible === 0);
  };
  window.addEventListener('hashchange', activate);
  if (search) search.addEventListener('input', filter);
  if (sort) sort.addEventListener('click', () => {
    order = order === 'newer' ? 'older' : 'newer';
    applySort();
  });
  applySort();
  activate();
  filter();
})();
`;

export function archiveChatTokenMap(chats: readonly ArchiveViewChatHeader[]): ReadonlyMap<string, string> {
  return new Map(chats.map((chat, index) => [chat.id, archiveChatToken(chat, index)]));
}

/** Render the static shell up to the first chat panel so callers can append panels incrementally. */
export function renderArchiveHtmlStart(model: ArchiveHtmlShellViewModel): string {
  validateViewModel(model);
  const tokenByChatId = archiveChatTokenMap(model.chats);
  const selected = model.selectedChatId ? tokenByChatId.get(model.selectedChatId) : undefined;
  const defaultToken = selected ?? (model.chats.length > 0 ? tokenByChatId.get(model.chats[0]!.id) ?? '' : '');
  const archiveTitle = model.archiveTitle || 'ParadigmEve Archive';
  const chatLinks = model.chats.map((chat, index) => ({ chat, index })).sort((left, right) => {
    const leftAt = Number.isFinite(left.chat.updatedAt) ? left.chat.updatedAt! : null;
    const rightAt = Number.isFinite(right.chat.updatedAt) ? right.chat.updatedAt! : null;
    if (leftAt !== null && rightAt !== null && leftAt !== rightAt) return rightAt - leftAt;
    return left.index - right.index;
  }).map(({ chat, index }) => {
    const token = tokenByChatId.get(chat.id)!;
    const updatedAt = Number.isFinite(chat.updatedAt) ? ` data-chat-updated-at="${chat.updatedAt}"` : '';
    return `<a class="chat-link" href="#${token}" data-chat-nav="${token}" data-chat-sort-index="${index}"${updatedAt}><span class="chat-link-title">${escapeHtml(chat.title)}</span>${chat.subtitle ? `<span class="chat-link-subtitle">${escapeHtml(chat.subtitle)}</span>` : ''}</a>`;
  }).join('');
  const generated = model.generatedAtLabel ? `<span class="chat-generated">${escapeHtml(model.generatedAtLabel)}</span>` : '';

  return `<!doctype html>
<html lang="en" data-archive-html-version="${HTML_VERSION}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; media-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(archiveTitle)}</title>
  <style>${STYLE}</style>
</head>
<body data-default-chat="${defaultToken}">
  <div class="archive-shell">
    <aside class="sidebar" aria-label="Archived chats">
      <div class="brand"><div class="brand-row"><strong>${escapeHtml(archiveTitle)}</strong><button class="chat-sort" data-chat-sort type="button" data-order="newer">Newer first</button></div>${generated}</div>
      <input class="chat-search" data-chat-search type="search" placeholder="Search chats" aria-label="Search archived chats" autocomplete="off">
      <nav class="chat-list">${chatLinks}</nav>
      <div class="chat-list-empty" data-chat-list-empty>No chats match this search.</div>
    </aside>
    <main class="content">`;
}

export function renderArchiveHtmlEnd(hasChats: boolean): string {
  return `${hasChats ? '' : '<section class="chat-panel"><div class="empty-transcript">No archived chats are available in this generated view.</div></section>'}</main>
  </div>
  <script>${SCRIPT}</script>
</body>
</html>`;
}

/**
 * Lightweight file:// shell. Transcript/tool DOM arrives only from one selected local segment;
 * the parser-blocking search script contains authored-text strings, never executable chat content.
 * Every script path is validated archive-relative before publication.
 */
export function renderLazyArchiveHtml(model: ArchiveHtmlLazyViewModel): string {
  validateViewModel(model);
  const tokenByChatId = archiveChatTokenMap(model.chats);
  const selected = model.selectedChatId ? tokenByChatId.get(model.selectedChatId) : undefined;
  const defaultToken = selected ?? (model.chats.length > 0 ? tokenByChatId.get(model.chats[0]!.id) ?? '' : '');
  const archiveTitle = model.archiveTitle || 'ParadigmEve Archive';
  const searchPath = archiveRelativeHref(model.searchPath);
  const searchMatch = searchPath ? /^data\/(g-[a-f0-9]{32})\/search\.js$/u.exec(searchPath) : null;
  if (!searchMatch) throw new Error('Archive search path is invalid');
  const generation = searchMatch[1]!;
  const chatLinks = model.chats.map((chat, index) => ({ chat, index })).sort((left, right) => {
    const leftAt = Number.isFinite(left.chat.updatedAt) ? left.chat.updatedAt! : null;
    const rightAt = Number.isFinite(right.chat.updatedAt) ? right.chat.updatedAt! : null;
    if (leftAt !== null && rightAt !== null && leftAt !== rightAt) return rightAt - leftAt;
    return left.index - right.index;
  }).map(({ chat, index }) => {
    const token = tokenByChatId.get(chat.id)!;
    const chunkPath = archiveRelativeHref(chat.chunkPath);
    if (!chunkPath || !/^data\/g-[a-f0-9]{32}\/chat-\d+-segment-0\.js$/u.test(chunkPath)) throw new Error('Archive chat chunk path is invalid');
    if (!Number.isSafeInteger(chat.segmentCount) || chat.segmentCount < 1 || chat.segmentCount > 100_000) {
      throw new Error('Archive chat segment count is invalid');
    }
    const updatedAt = Number.isFinite(chat.updatedAt) ? ` data-chat-updated-at="${chat.updatedAt}"` : '';
    return `<a class="chat-link" href="#${token}" data-chat-nav="${token}" data-chat-chunk="${chunkPath}" data-chat-segments="${chat.segmentCount}" data-chat-sort-index="${index}"${updatedAt}><span class="chat-link-title">${escapeHtml(chat.title)}</span>${chat.subtitle ? `<span class="chat-link-subtitle">${escapeHtml(chat.subtitle)}</span>` : ''}</a>`;
  }).join('');
  const chatFrames = model.chats.map(chat => {
    const token = tokenByChatId.get(chat.id)!;
    return `<template data-chat-frame="${token}">${renderLazyChatFrame(chat, token, chat.segmentCount)}</template>`;
  }).join('');
  const generated = model.generatedAtLabel ? `<span class="chat-generated">${escapeHtml(model.generatedAtLabel)}</span>` : '';
  const content = model.chats.length > 0
    ? '<main class="content" data-chat-host><section class="chat-panel"><div class="empty-transcript">Loading archived chat…</div></section></main>'
    : '<main class="content" data-chat-host><section class="chat-panel"><div class="empty-transcript">No archived chats are available in this generated view.</div></section></main>';
  return `<!doctype html>
<html lang="en" data-archive-html-version="${HTML_VERSION}" data-archive-generation="${generation}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; media-src 'self' data:; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(archiveTitle)}</title>
  <style>${STYLE}</style>
</head>
<body data-default-chat="${defaultToken}">
  <div class="archive-shell">
    <aside class="sidebar" aria-label="Archived chats">
      <div class="brand"><div class="brand-row"><strong>${escapeHtml(archiveTitle)}</strong><button class="chat-sort" data-chat-sort type="button" data-order="newer">Newer first</button></div>${generated}</div>
      <input class="chat-search" data-chat-search type="search" placeholder="Search chats" aria-label="Search archived chats" autocomplete="off">
      <nav class="chat-list">${chatLinks}</nav>
      <div class="chat-list-empty" data-chat-list-empty>No chats match this search.</div>
    </aside>
    ${content}
  </div>
  ${chatFrames}
  <script src="${searchPath}"></script>
  <script>${LAZY_SCRIPT}</script>
</body>
</html>`;
}

/** Generate one self-contained static HTML archive projection that is safe to open via file://. */
export function renderArchiveHtml(model: ArchiveHtmlViewModel): string {
  const tokenByChatId = archiveChatTokenMap(model.chats);
  const chats = model.chats.map(chat => renderChat(chat, tokenByChatId.get(chat.id)!, tokenByChatId)).join('');
  return renderArchiveHtmlStart(model) + chats + renderArchiveHtmlEnd(model.chats.length > 0);
}
