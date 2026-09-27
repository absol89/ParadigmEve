/** Explicit local folder selection. The project grants no filesystem permission. */
export interface LocalProject {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  /** Removed sidebar group; existing conversations and queued work retain their folder. */
  ungrouped?: boolean;
  /** The project catalog owns the link from one Quilt to its local ledger. */
  template?: { id: 'expenses'; version: 1; quiltId: string };
  /**
   * The one native ChatGPT Project (`g-p-` + 32 hex) this folder is explicitly linked to, unique
   * across the catalog. Chats observed inside it join this project; fresh chats open inside it.
   */
  nativeProjectId?: string;
  /**
   * One chat last seen inside that native Project. ChatGPT cannot be cold-loaded at a Project
   * address (its loader errors), so a fresh chat enters the Project through this chat's own
   * native header link, exactly like Compact & Resume. Refreshed by every observation.
   */
  nativeEntryConversationId?: string;
}

/** The chat id of a chatgpt.com URL inside a native Project (`/g/g-p-…/c/<id>`), or null. */
export function nativeProjectConversationId(value: unknown): string | null {
  if (typeof value !== 'string' || !nativeChatGptProjectId(value)) return null;
  try {
    const match = /^\/g\/[^/]+\/c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(new URL(value.trim()).pathname);
    return match ? match[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * A native ChatGPT Project id from either the bare id or a chatgpt.com Project/chat URL.
 *
 * Parity with extension/background.js projectFromUrl() for URLs: only `/g/g-p-<32 hex>[-name]/…`
 * on chatgpt.com or chat.openai.com counts. The display-name suffix is dropped because a rename
 * changes it. Custom GPTs share `/g/` but never have this shape. Anything else is null.
 */
export function nativeChatGptProjectId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (/^g-p-[0-9a-f]{32}$/i.test(raw)) return raw.toLowerCase();
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || (url.hostname !== 'chatgpt.com' && url.hostname !== 'chat.openai.com')) return null;
    if (url.pathname.length > 512) return null;
    const match = /^\/g\/(g-p-[0-9a-f]{32})(?:-[^/]*)?\//i.exec(url.pathname);
    return match ? match[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}
