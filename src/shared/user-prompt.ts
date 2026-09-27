/** Transport framing, not a second prompt source. Length keeps marker-like user text literal. */
export const MAX_CHATGPT_MESSAGE_CHARS = 96_000;
const CONTEXT_MARKER = 'PARADIGMEVE_CONTEXT';
const continuation = (text: string): string => /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/.exec(text)?.[0] ?? '';
export function userPromptText(text: string): string | null {
  text = text.replace(/\r\n?/g, '\n');
  const identity = continuation(text);
  const header = /^\[\[(PARADIGMEVE_CONTEXT|COS_CONTEXT):(\d{1,6})\]\]\n/.exec(text.slice(identity.length));
  if (!header) return null;
  const end = identity.length + header[0].length + Number(header[2]);
  const boundary = `\n[[/${header[1]}]]\n\n`;
  return text.startsWith(boundary, end) ? identity + text.slice(end + boundary.length) : null;
}

export function prependUserPrompt(text: string, instructions: string): string {
  text = text.replace(/\r\n?/g, '\n');
  instructions = instructions.replace(/\r\n?/g, '\n');
  const authored = userPromptText(text) ?? text;
  const identity = continuation(authored);
  return `${identity}[[${CONTEXT_MARKER}:${instructions.length}]]\n${instructions}\n[[/${CONTEXT_MARKER}]]\n\n${authored.slice(identity.length)}`;
}
