import { readEvents, readOverflowText } from './store.js';

/** One message that holds a find-in-chat phrase; `seq` is the timeline row's `data-event-seq`. */
export interface ChatFindMatch {
  seq: number;
  kind: 'user_message' | 'assistant_message';
  messageId: string | null;
}

/** Most matches one find returns; a chat with more is searched with a longer phrase. */
const MAX_FIND_RESULTS = 500;

const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/**
 * Find in chat (⌘F / Ctrl+F): every user or assistant message of one chat holding the phrase, in
 * the order they were said. Case and runs of white space do not matter. It reads the whole
 * recording, including overflow text, so a passage far above the loaded page is found too.
 * Ported from Chat On Steroids 2.1.37 (305e530a) onto Eve's canonical message store, which already
 * keeps one record per message in spoken order.
 */
export async function findInSession(id: string, query: string): Promise<ChatFindMatch[]> {
  const phrase = fold(query);
  if (!phrase) return [];
  const events = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  const found: ChatFindMatch[] = [];
  for (const event of events) {
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message') continue;
    const stored = event.message;
    const text = stored.truncated && stored.assetId ? (await readOverflowText(id, stored.assetId)) ?? stored.text : stored.text;
    if (!fold(text).includes(phrase)) continue;
    found.push({ seq: event.seq, kind: event.kind, messageId: event.messageId ?? null });
    if (found.length >= MAX_FIND_RESULTS) break;
  }
  return found;
}
