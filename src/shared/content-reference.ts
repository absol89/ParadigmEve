/**
 * ChatGPT's `::chatgpt-content-reference{…}` directive: a pointer to another message's content,
 * which the page renders and plain text does not. Under GPT-6 a reply's own content is only such a
 * pointer while its words live elsewhere (the DIL fallback, or the source message). A row holding
 * nothing but references has not delivered its words yet and must never be shown or archived as them.
 */
const ONLY_CONTENT_REFERENCES = /^\s*(?:::chatgpt-content-reference\{[^}\n]*\}\s*)+$/;

/** True when the text is nothing but content references, i.e. the reply's words are not here. */
export function isUnresolvedContentReference(text: string | null | undefined): boolean {
  return typeof text === 'string' && ONLY_CONTENT_REFERENCES.test(text);
}
