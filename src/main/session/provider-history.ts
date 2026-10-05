/**
 * The chat owns its history; providers only execute turns.
 *
 * One session archive holds every user and assistant message, whichever provider produced it.
 * This module projects that archive for the provider about to answer:
 *
 * - an Ollama turn receives the whole conversation, attachments included (it has no memory of
 *   its own, so every request carries the history);
 * - a ChatGPT turn after turns it did not see receives a bounded catch-up of exactly those
 *   turns, because the ChatGPT conversation only knows what was typed into it.
 *
 * "Seen" is derived from the archive alone: a provider route has seen every turn up to and
 * including the newest turn it answered, because answering a turn means it received the history
 * before it. Nothing here is a privacy boundary by itself. The switch preview exists so the user
 * sees what a different provider is about to receive, and `localOnly` is the enforced lock.
 */

import sharp from 'sharp';
import type { ChatProvider, SessionEvent } from '../../shared/session.js';
import type { InputAttachment, InputImage } from '../../shared/input.js';
import { readAsset, readCanonicalTranscriptEvents, readOverflowText } from './store.js';
import { readStagedAttachment } from './input-attachments.js';
import { archivableAttachment } from './input-history.js';
import { knownCloudModel, resolveOllamaEndpoint, type OllamaChatContent, type OllamaChatMessage } from '../ollama-client.js';

export type ProviderRoute = 'chatgpt' | 'ollama-local' | 'ollama-cloud';

/** Honest labels: "local" means this computer, not merely "not OpenAI". */
export const PROVIDER_ROUTE_LABELS: Record<ProviderRoute, string> = {
  chatgpt: 'ChatGPT (OpenAI)',
  'ollama-local': 'Ollama on this computer',
  'ollama-cloud': 'Ollama Cloud'
};

/** Ollama's cloud model ids end in `cloud` (`gemma4:cloud`, `gpt-oss:120b-cloud`). */
export function isOllamaCloudModel(model: string): boolean {
  return /(?:^|[:-])cloud$/i.test(model.trim());
}

/** Where a turn's history actually goes. A loopback daemon serving a cloud model is still cloud. */
export function providerRoute(provider: ChatProvider | null | undefined, endpoint = resolveOllamaEndpoint()): ProviderRoute {
  if (!provider) return 'chatgpt';
  if (!endpoint || endpoint.startsWith('https://') || isOllamaCloudModel(provider.model) || knownCloudModel(provider.model)) return 'ollama-cloud';
  return 'ollama-local';
}

interface ArchivedImage { sessionId: string; assetId: string; mimeType: string }
interface ArchivedFile {
  name: string;
  mimeType: string;
  /** Archive copy, when one was made. */
  assetId?: string;
  /** The staged upload, for a turn recorded before archive copies existed. */
  staged?: InputAttachment;
}

export interface ArchivedTurn {
  role: 'user' | 'assistant';
  /** The route that answered (assistant) or was sent (user) this turn. */
  route: ProviderRoute;
  model?: string;
  text: string;
  images: ArchivedImage[];
  files: ArchivedFile[];
  inputId?: string;
}

async function fullText(sessionId: string, message: { text: string; truncated: boolean; assetId?: string }): Promise<string> {
  if (message.truncated && message.assetId) return (await readOverflowText(sessionId, message.assetId)) ?? message.text;
  return message.text;
}

const IMAGE_ASSET_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** The archive as conversation turns, oldest first. Streaming partials and empty rows are skipped. */
export async function archivedTurns(sessionId: string): Promise<ArchivedTurn[]> {
  // Provider context is the canonical conversation, not the forensic tool/activity journal.
  // Keeping this on the message projection prevents a long tool-heavy chat from blocking the
  // provider-switch preview and then blocking the send-time privacy gate a second time.
  const events = await readCanonicalTranscriptEvents(sessionId);
  const turns: ArchivedTurn[] = [];
  for (const event of events as SessionEvent[]) {
    if (event.kind === 'user_message') {
      const archived = new Map((event.archivedAttachments ?? []).map((row) => [row.attachmentId, row.asset]));
      const files: ArchivedFile[] = [];
      const images: ArchivedImage[] = (event.assets ?? [])
        .filter((asset) => IMAGE_ASSET_TYPES.has(asset.mimeType))
        .map((asset) => ({ sessionId, assetId: asset.id, mimeType: asset.mimeType }));
      for (const attachment of event.attachments ?? []) {
        const copy = archived.get(attachment.id);
        if (copy && archivableAttachment(attachment.mimeType) === 'image') {
          images.push({ sessionId, assetId: copy.id, mimeType: copy.mimeType });
          continue;
        }
        files.push({ name: attachment.name, mimeType: attachment.mimeType, ...(copy ? { assetId: copy.id } : { staged: attachment }) });
      }
      turns.push({
        role: 'user',
        route: providerRoute(event.provider),
        ...(event.provider ? { model: event.provider.model } : {}),
        text: event.authoredText ?? await fullText(sessionId, event.message),
        images,
        files,
        ...(event.inputId ? { inputId: event.inputId } : {})
      });
    } else if (event.kind === 'assistant_message') {
      if (!(event.final === true || event.state === 'final')) continue;
      const text = await fullText(sessionId, event.message);
      if (!text.trim()) continue;
      turns.push({
        role: 'assistant',
        route: providerRoute(event.provider),
        ...(event.provider ? { model: event.provider.model } : {}),
        text,
        images: [],
        files: []
      });
    } else if (event.kind === 'native_image' && event.asset && event.previewStatus === 'available') {
      // ChatGPT-generated images belong to the nearest assistant turn before them.
      const owner = [...turns].reverse().find((turn) => turn.role === 'assistant');
      owner?.images.push({ sessionId, assetId: event.asset.id, mimeType: event.asset.mimeType });
    }
  }
  return turns;
}

/** Turns after the newest turn this route answered or was sent. All turns when it never was. */
export function unseenBy(turns: readonly ArchivedTurn[], route: ProviderRoute): ArchivedTurn[] {
  let last = -1;
  turns.forEach((turn, index) => { if (turn.route === route) last = index; });
  return turns.slice(last + 1);
}

export interface ProviderSwitchPreview {
  /** True when this turn goes to a different route than the chat's previous turn and exposes earlier history to it. */
  switching: boolean;
  from: ProviderRoute | null;
  to: ProviderRoute;
  fromLabel: string | null;
  toLabel: string;
  /** What the target route will receive for the first time. */
  messages: number;
  images: number;
  files: number;
  /** The chat is locked to this computer; this target is refused. */
  blockedByLocalOnly: boolean;
}

export async function providerSwitchPreview(
  sessionId: string,
  provider: ChatProvider | null,
  localOnly = false
): Promise<ProviderSwitchPreview> {
  const turns = await archivedTurns(sessionId);
  const to = providerRoute(provider);
  const users = turns.filter((turn) => turn.role === 'user');
  const from = users.length ? users[users.length - 1]!.route : null;
  const unseen = unseenBy(turns, to);
  return {
    switching: from !== null && from !== to && unseen.length > 0,
    from,
    to,
    fromLabel: from ? PROVIDER_ROUTE_LABELS[from] : null,
    toLabel: PROVIDER_ROUTE_LABELS[to],
    messages: unseen.length,
    images: unseen.reduce((sum, turn) => sum + turn.images.length, 0),
    files: unseen.reduce((sum, turn) => sum + turn.files.length, 0),
    blockedByLocalOnly: localOnly && to !== 'ollama-local'
  };
}

/** A switch the user has confirmed, frozen as the counts they saw. */
export interface ProviderSwitchConsent { to: ProviderRoute; messages: number; images: number; files: number }

/**
 * Refuses a turn that would expose unseen history to a different provider without the user's
 * confirmation of at least that scope, and any non-local turn in a local-only chat.
 */
export async function assertProviderSwitchAllowed(
  sessionId: string,
  provider: ChatProvider | null,
  localOnly: boolean,
  consent: ProviderSwitchConsent | undefined
): Promise<void> {
  const preview = await providerSwitchPreview(sessionId, provider, localOnly);
  if (preview.blockedByLocalOnly) {
    throw new Error(`This chat is local only. ${preview.toLabel} cannot read it; choose a local Ollama model or turn local only off.`);
  }
  if (!preview.switching) return;
  if (!consent || consent.to !== preview.to || consent.messages < preview.messages ||
      consent.images < preview.images || consent.files < preview.files) {
    throw new Error(`PROVIDER_SWITCH_CONSENT_REQUIRED: ${preview.toLabel} would receive ${preview.messages} earlier message(s), ${preview.images} image(s) and ${preview.files} file(s) from this chat. Confirm the switch to send.`);
  }
}

// ------------------------------------------------------------------ readers

const MAX_INLINE_FILE_CHARS = 60_000;

async function fileText(sessionId: string, file: ArchivedFile): Promise<string | null> {
  if (archivableAttachment(file.mimeType) !== 'text') return null;
  const bytes = file.assetId
    ? await readAsset(sessionId, file.assetId, 8 * 1024 * 1024)
    : file.staged ? await readStagedAttachment(file.staged, 8 * 1024 * 1024) : null;
  if (!bytes) return null;
  const text = bytes.toString('utf8');
  return text.length > MAX_INLINE_FILE_CHARS
    ? `${text.slice(0, MAX_INLINE_FILE_CHARS)}\n…[${text.length - MAX_INLINE_FILE_CHARS} more characters not included]`
    : text;
}

async function fileImage(file: ArchivedFile): Promise<Buffer | null> {
  if (archivableAttachment(file.mimeType) !== 'image' || !file.staged) return null;
  return readStagedAttachment(file.staged, 32 * 1024 * 1024);
}

/** Normalizes an archived image for a provider request. */
async function imageBytes(image: ArchivedImage, maxSide: number, format: 'png' | 'webp'): Promise<Buffer | null> {
  const raw = await readAsset(image.sessionId, image.assetId, 16 * 1024 * 1024);
  if (!raw) return null;
  return normalizeImage(raw, maxSide, format);
}

async function normalizeImage(raw: Buffer, maxSide: number, format: 'png' | 'webp'): Promise<Buffer | null> {
  try {
    const pipeline = sharp(raw, { limitInputPixels: 36_000_000, animated: false }).rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
    return format === 'png' ? await pipeline.png().toBuffer() : await pipeline.webp({ quality: 80 }).toBuffer();
  } catch {
    return null;
  }
}

function speaker(turn: ArchivedTurn): string {
  if (turn.role === 'user') return 'User';
  return turn.route === 'chatgpt' ? 'Assistant (ChatGPT)' : `Assistant (${PROVIDER_ROUTE_LABELS[turn.route]}${turn.model ? ` · ${turn.model}` : ''})`;
}

// ---------------------------------------------------------------- ChatGPT

export interface ChatGptCatchUp { preamble: string; images: InputImage[] }

/**
 * The turns ChatGPT has not seen, as a preamble for its next message, plus up to `imageSlots`
 * of their images (newest first). Bounded to `maxChars`; the oldest turns are dropped first and
 * the preamble says so. Null when ChatGPT has seen everything.
 */
export async function chatGptCatchUp(sessionId: string, maxChars: number, imageSlots: number): Promise<ChatGptCatchUp | null> {
  const turns = await archivedTurns(sessionId);
  // The message being delivered is already recorded only after delivery, so every unseen turn
  // here is history. Drop a trailing user turn identical to nothing: there is none by design.
  const unseen = unseenBy(turns, 'chatgpt');
  if (!unseen.length) return null;
  const header = '[Context from Eve: earlier turns of this same chat were answered by another provider, so this ChatGPT conversation has not seen them. They are part of this conversation. Read them, then answer the message after the context.]';
  const footer = '[End of context]';
  const blocks: string[] = [];
  for (const turn of unseen) {
    const lines = [`${speaker(turn)}:`, turn.text];
    for (const file of turn.files) {
      const text = await fileText(sessionId, file);
      lines.push(text !== null ? `[Attached file ${file.name}]\n${text}\n[End of ${file.name}]` : `[Attached file ${file.name} (${file.mimeType}) is not available as text]`);
    }
    if (turn.images.length) lines.push(`[${turn.images.length} image(s) in this turn]`);
    blocks.push(lines.join('\n'));
  }
  const budget = Math.max(0, maxChars - header.length - footer.length - 200);
  const kept: string[] = [];
  let used = 0;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (used + block.length + 2 > budget) break;
    kept.unshift(block);
    used += block.length + 2;
  }
  const omitted = blocks.length - kept.length;
  if (!kept.length) {
    // One enormous turn: keep its newest tail rather than nothing.
    const last = blocks[blocks.length - 1]!;
    kept.push(`…${last.slice(-Math.max(0, budget - 1))}`);
  }
  const preamble = [header, ...(omitted > 0 ? [`(${omitted} older turn(s) omitted for length; they remain in Eve's archive.)`] : []), ...kept, footer].join('\n\n');

  const images: InputImage[] = [];
  const candidates = unseen.flatMap((turn) => turn.images).reverse();
  for (const image of candidates) {
    if (images.length >= imageSlots) break;
    const webp = await imageBytes(image, 1600, 'webp');
    if (!webp) continue;
    const dataUrl = `data:image/webp;base64,${webp.toString('base64')}`;
    if (dataUrl.length > 512_000) continue;
    images.push({ name: `earlier-image-${images.length + 1}.webp`, dataUrl });
  }
  return { preamble, images };
}

// ----------------------------------------------------------------- Ollama

export class ProviderCapabilityError extends Error {}

const MAX_OLLAMA_HISTORY_CHARS = 400_000;
const MAX_OLLAMA_IMAGES = 8;

/**
 * The whole conversation for an Ollama request, oldest first. `vision` is the model's declared
 * capability (null = unknown). The newest user turn's images and files must be readable, or the
 * turn fails with a clear error and the attachment stays in the archive. Older images beyond the
 * newest {@link MAX_OLLAMA_IMAGES}, or any image for a model without vision, become text notes.
 */
export async function ollamaConversation(sessionId: string, vision: boolean | null, system: string): Promise<OllamaChatMessage[]> {
  const turns = await archivedTurns(sessionId);
  const lastUser = turns.map((turn) => turn.role).lastIndexOf('user');
  if (lastUser < 0) throw new Error('OLLAMA_NO_MESSAGE: this chat has no user message to answer');
  const current = turns[lastUser]!;
  if (vision === false && current.images.length + current.files.filter((file) => archivableAttachment(file.mimeType) === 'image').length > 0) {
    throw new ProviderCapabilityError(`${current.model ?? 'This Ollama model'} cannot read images. The image stays in this chat; pick a vision model (for example one with "vision" in its capabilities) or send it to ChatGPT.`);
  }
  const unreadable = current.files.filter((file) => !archivableAttachment(file.mimeType));
  if (unreadable.length) {
    throw new ProviderCapabilityError(`Ollama cannot read ${unreadable.map((file) => `${file.name} (${file.mimeType})`).join(', ')}. The file stays in this chat; attach text or images, or send this turn to ChatGPT.`);
  }

  // Newest images first get the budget.
  let imageBudget = vision === false ? 0 : MAX_OLLAMA_IMAGES;
  const allowedImages = new Set<ArchivedImage>();
  for (let index = turns.length - 1; index >= 0; index--) {
    for (const image of turns[index]!.images) {
      if (imageBudget <= 0) break;
      if (turns[index]!.role === 'user') { allowedImages.add(image); imageBudget--; }
    }
  }

  const messages: OllamaChatMessage[] = [];
  for (const [index, turn] of turns.entries()) {
    const isCurrent = index === lastUser;
    const notes: string[] = [];
    const parts: Exclude<OllamaChatContent, string> = [];
    for (const file of turn.files) {
      const kind = archivableAttachment(file.mimeType);
      if (kind === 'text') {
        const text = await fileText(sessionId, file);
        if (text !== null) notes.push(`[Attached file ${file.name}]\n${text}\n[End of ${file.name}]`);
        else if (isCurrent) throw new ProviderCapabilityError(`The attached file ${file.name} is no longer readable; attach it again.`);
        else notes.push(`[Attached file ${file.name} is no longer available]`);
      } else if (kind === 'image' && turn.role === 'user' && vision !== false && isCurrent) {
        const bytes = await fileImage(file);
        const png = bytes ? await normalizeImage(bytes, 2048, 'png') : null;
        if (!png) throw new ProviderCapabilityError(`The attached image ${file.name} is no longer readable; attach it again.`);
        parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } });
      } else {
        notes.push(`[Attached file ${file.name} (${file.mimeType}) not included]`);
      }
    }
    for (const image of turn.images) {
      if (turn.role === 'user' && allowedImages.has(image)) {
        const png = await imageBytes(image, 2048, 'png');
        if (png) { parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }); continue; }
        if (isCurrent) throw new ProviderCapabilityError('An image in this message is no longer readable; attach it again.');
      }
      notes.push(turn.role === 'assistant' ? '[The assistant showed an image here]' : '[An earlier image is not included]');
    }
    const text = [turn.text, ...notes].filter(Boolean).join('\n\n');
    if (turn.role === 'assistant') messages.push({ role: 'assistant', content: text });
    else messages.push({ role: 'user', content: parts.length ? [{ type: 'text', text }, ...parts] : text });
  }

  // Bound the request: keep the newest messages, always including the current one.
  const size = (message: OllamaChatMessage) => typeof message.content === 'string'
    ? message.content.length
    : message.content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 1_000), 0);
  let total = 0;
  let start = messages.length;
  while (start > 0 && total + size(messages[start - 1]!) <= MAX_OLLAMA_HISTORY_CHARS) {
    total += size(messages[start - 1]!);
    start--;
  }
  if (start === messages.length) start = messages.length - 1;
  const bounded = messages.slice(start);
  const omitted = start;
  return [
    { role: 'system', content: system + (omitted ? `\n\n${omitted} older message(s) of this chat were omitted for length.` : '') },
    ...bounded
  ];
}

/**
 * Gate for every composer send into an existing chat, to either provider. A chat locked to this
 * computer refuses every other provider, and a switch that would hand earlier turns to a
 * different provider needs the scope the user confirmed in the composer.
 */
export async function admitChatProvider(input: {
  sessionId: string | null;
  provider?: 'ollama';
  model: string | null;
  providerConsent?: ProviderSwitchConsent;
  localOnly?: true;
}, session: { id: string; localOnly?: boolean } | null): Promise<void> {
  if (!input.sessionId) {
    if (input.localOnly && providerRoute(input.provider === 'ollama' && input.model ? { id: 'ollama', model: input.model } : null) !== 'ollama-local') {
      throw new Error('This new chat is local only, so it needs a model on this computer, not a cloud model.');
    }
    return;
  }
  if (!session) throw new Error('This chat no longer exists');
  const provider: ChatProvider | null = input.provider === 'ollama' && input.model ? { id: 'ollama', model: input.model } : null;
  await assertProviderSwitchAllowed(session.id, provider, session.localOnly === true, input.providerConsent);
}
