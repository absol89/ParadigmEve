import { pinsContextReferences } from './pins-context.js';
import { userPromptText } from './user-prompt.js';

/**
 * One product-shaped reference the user actually authored.
 *
 * This is deliberately syntax metadata, not creation or routing authority. A later owner must
 * resolve the exact durable Quilt/Thread identity and may still decide that an unknown reference
 * is ordinary prose. Keeping that distinction prevents every hashtag from becoming a prompt to
 * create product state.
 */
export interface PinsReferenceIntent {
  kind: 'quilt' | 'thread';
  reference: string;
}

const CONTINUATION = /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/;
const CONTEXT_PREFIX = /^\[\[(?:PARADIGMEVE_CONTEXT|COS_CONTEXT):/;
const PASTED_BLOCK_HEADER = /^\s*(?:logs?|output|console|stdout|stderr|trace|stack trace)\s*:?\s*$/i;
const LOG_LINE = /^\s*(?:(?:\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?)|(?:\[\d{2}:\d{2}(?::\d{2})?\])|(?:\[(?:trace|debug|info|warn|warning|error|fatal)\])|(?:(?:trace|debug|info|warn|warning|error|fatal)\b[:\s]))/i;

const spaces = (value: string): string => ' '.repeat(value.length);

/**
 * Leaves only prose that can safely express product syntax.
 *
 * The exclusions are intentionally conservative. Missing a reference means the literal message
 * still reaches ChatGPT unchanged; a false positive could route durable product context. Transport
 * payloads, quoted examples, code, URLs and pasted diagnostics therefore abstain.
 */
function inspectableAuthoredText(value: string): string | null {
  let text = value.replace(/\r\n?/g, '\n');
  const authored = userPromptText(text);
  if (authored !== null) text = authored;
  else if (CONTEXT_PREFIX.test(text)) return null;

  if (CONTINUATION.test(text)) return null;

  let inFence = false;
  let pastedBlock = false;
  const lines = text.split('\n').map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return '';
    }
    if (inFence || pastedBlock || /^\s*>/.test(line) || LOG_LINE.test(line)) return '';
    if (PASTED_BLOCK_HEADER.test(line)) {
      pastedBlock = true;
      return '';
    }

    return line
      .replace(/`[^`\n]*`/g, spaces)
      .replace(/"[^"\n]*"/g, spaces)
      .replace(/'[^'\n]*'/g, spaces)
      .replace(/“[^”\n]*”/g, spaces)
      .replace(/‘[^’\n]*’/g, spaces)
      .replace(/\b(?:https?|ftp):\/\/[^\s<>()]+/gi, spaces)
      .replace(/\bwww\.[^\s<>()]+/gi, spaces)
      .replace(/\S*%[0-9a-f]{2}\S*/gi, spaces);
  });
  return lines.join('\n');
}

/**
 * Derives inert #Quilt / %Thread syntax from canonical authored text.
 *
 * This function never reads the Pins library and never throws for unknown product references.
 * Callers use it only after proving that the canonical row crossed a fresh authored-send boundary.
 */
export function authoredPinsReferences(text: string): PinsReferenceIntent[] {
  const inspectable = inspectableAuthoredText(text);
  if (inspectable === null) return [];
  return pinsContextReferences(inspectable).map((reference) => ({
    kind: reference.startsWith('#') ? 'quilt' : 'thread',
    reference
  }));
}
