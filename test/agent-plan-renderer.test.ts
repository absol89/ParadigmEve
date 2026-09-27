import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const rendererCss = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

const workspace = vi.hoisted(() => ({
  state: null as null | { pin: { id: string }; quiltTitle: string },
  toggle: vi.fn(async () => true)
}));

vi.mock('../src/renderer/workspace-library.js', () => ({
  pinStateForSessionPlan: () => workspace.state,
  toggleLivePlanPinForSession: workspace.toggle
}));

import { renderAgentPlan } from '../src/renderer/agent-plan.js';

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  workspace.state = null;
  workspace.toggle.mockClear();
});

afterEach(() => dom.window.close());

it('repaints the inline Plan control from durable Pin state and toggles the first-class Plan', async () => {
  const host = document.getElementById('host')!;
  const plan = {
    updatedAt: 1,
    plan: [{ step: 'Verify the live slice', status: 'in_progress' as const }]
  };

  renderAgentPlan(host, 'session-plan-a', plan);
  let button = host.querySelector<HTMLButtonElement>('.agent-plan-pin')!;
  expect(button.textContent).toBe('Pin');
  expect(button.getAttribute('aria-pressed')).toBe('false');

  workspace.state = { pin: { id: 'pin-a' }, quiltTitle: 'Workshop' };
  renderAgentPlan(host, 'session-plan-a', plan);
  button = host.querySelector<HTMLButtonElement>('.agent-plan-pin')!;
  expect(button.textContent).toBe('Unpin · Workshop');
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(button.classList.contains('is-pinned')).toBe(true);

  button.click();
  await Promise.resolve();
  expect(workspace.toggle).toHaveBeenCalledExactlyOnceWith('session-plan-a');

  workspace.state = null;
  renderAgentPlan(host, 'session-plan-a', plan);
  button = host.querySelector<HTMLButtonElement>('.agent-plan-pin')!;
  expect(button.textContent).toBe('Pin');
  expect(button.getAttribute('aria-pressed')).toBe('false');
});

it('keeps completed inline Plan steps readable without striking through their text', () => {
  const host = document.getElementById('host')!;
  renderAgentPlan(host, 'session-plan-done', {
    updatedAt: 1,
    plan: [
      { step: 'Readable completed step', status: 'completed' },
      { step: 'Still pending', status: 'pending' }
    ]
  });

  const marker = host.querySelector<HTMLElement>(".agent-plan-step[data-status='completed'] .agent-plan-marker")!;
  expect(marker.textContent).toBe('✓');
  expect(marker.getAttribute('aria-label')).toBe('Completed');

  const completedTitleRule = rendererCss.match(
    /\.agent-plan-step\[data-status='completed'\] \.agent-plan-step-title\s*\{([^}]*)\}/
  )?.[1];
  expect(completedTitleRule).toBeTruthy();
  expect(completedTitleRule).toContain('color: color-mix(');
  expect(completedTitleRule).toContain('var(--ink) 80%');
  expect(completedTitleRule).not.toContain('text-decoration');
  expect(completedTitleRule).not.toContain('line-through');
});
