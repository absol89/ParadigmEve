import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Installed c6, 2026-10-23 (worker-65): one interrupted turn showed "Error in message stream" with
 * Retry, and after two reloads the chat showed "Something went wrong. Please try again" while its
 * own conversation fetch answered 401. The first is a broken answer stream; the second is the
 * conversation failing to load, which a reload makes worse (upstream chat-on-steroids #1405).
 */
const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const THREAD = '6ada510f-62fc-83ed-a841-dd4d609190e8';

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; });

function errorsOf(body: string): Array<{ text: string; recoverable: boolean; kind?: string; blocking?: boolean }> {
  dom = new JSDOM(`<!doctype html><html><body><main>${body}</main></body></html>`, {
    url: `https://chatgpt.com/c/${THREAD}`, runScripts: 'outside-only', pretendToBeVisual: true
  });
  const window = dom.window as unknown as { eval(source: string): void; CLF_DOM: { errors(): any[] } };
  window.eval(domSource);
  return window.CLF_DOM.errors().map(({ text, recoverable, kind, blocking }) => ({ text, recoverable, kind, blocking }));
}

const retryCard = (text: string) => `<div class="card"><div>${text}</div> <button>Retry</button></div>`;

describe('page failure kinds for interrupted-response recovery', () => {
  it('keeps a broken answer stream recoverable', () => {
    const found = errorsOf(retryCard('Error in message stream'));
    expect(found.length).toBeGreaterThan(0);
    for (const error of found) expect(error).toMatchObject({ recoverable: true, kind: 'transport' });
  });

  it.each([
    'Something went wrong. Please try again',
    'Something went wrong.',
    'Could not load this ChatGPT conversation'
  ])('records "%s" with Retry as the conversation failing to load, never as a reloadable stream', (text) => {
    const [error] = errorsOf(retryCard(text));
    expect(error).toMatchObject({ recoverable: false, kind: 'conversation-unavailable' });
  });

  it('classifies the same wording in a role=alert banner the same way', () => {
    const [error] = errorsOf('<div role="alert">Something went wrong. Please try again</div>');
    expect(error).toMatchObject({ recoverable: false, kind: 'conversation-unavailable' });
  });

  it('still recognises the explicit generation failure as a stream failure', () => {
    const [error] = errorsOf(retryCard('Something went wrong while generating the response.'));
    expect(error).toMatchObject({ recoverable: true, kind: 'transport' });
  });

  it('ignores unrelated prose with a Retry control', () => {
    expect(errorsOf(retryCard('Your upload is ready'))).toEqual([]);
  });
});
