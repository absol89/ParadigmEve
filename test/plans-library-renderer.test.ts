import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createPlansLibrary,
  workerActivityCardTitle,
  type PlanViewModel
} from '../src/renderer/plans-library.js';

const plansLibraryCss = readFileSync(new URL('../src/renderer/plans-library.css', import.meta.url), 'utf8');
const rendererHtml = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');

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
});

afterEach(() => dom.window.close());

it('renders Create and Review #Plans together in one Plans header action row', () => {
  const host = document.getElementById('host')!;
  const onCreatePlanChat = vi.fn();
  const onReviewPlansChat = vi.fn();
  createPlansLibrary({ host, plans: [], onCreatePlanChat, onReviewPlansChat });

  const create = host.querySelector<HTMLButtonElement>('.plans-header-create')!;
  expect(create.textContent).toBe('Create');
  expect(host.querySelector('use')?.getAttribute('href')).toBe('#i-plan-steps');
  const headActions = host.querySelector<HTMLElement>('.plans-head-actions')!;
  expect(headActions).not.toBeNull();
  expect([...headActions.querySelectorAll('button')].map(button => button.textContent))
    .toEqual(['Create', 'Review #Plans']);
  expect(plansLibraryCss).toMatch(/\.plans-head-actions\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*gap:\s*8px;/s);
  create.click();
  expect(onCreatePlanChat).toHaveBeenCalledTimes(1);
  expect(onReviewPlansChat).not.toHaveBeenCalled();
  const shortcuts = [...host.querySelectorAll<HTMLButtonElement>('.plans-chat-shortcut')];
  expect(shortcuts.map(button => button.textContent)).toEqual(['Review #Plans']);
  shortcuts[0]!.click();
  expect(onReviewPlansChat).toHaveBeenCalledTimes(1);
});

it('uses three visible dots to the left of the three Plans icon lines', () => {
  const symbol = rendererHtml.match(/<g id="i-plan-steps">([\s\S]*?)<\/g>/u)?.[1] ?? '';
  expect(symbol.match(/<circle\b/gu)).toHaveLength(3);
  expect(symbol).toContain('<path d="M8 6h12M8 12h12M8 18h12" />');
});

it('projects durable Plan Pin state as Pin and Unpin instead of mutating button-local state', () => {
  const onPin = vi.fn();
  const plan: PlanViewModel = {
    id: 'plan-a',
    title: 'Dogfood Pins and Plans',
    lifecycle: 'live',
    items: [{ id: 'step-a', title: 'Verify durable state', status: 'in-progress' }]
  };
  const host = document.getElementById('host')!;
  const controller = createPlansLibrary({ host, plans: [plan], onPin });

  let button = host.querySelector<HTMLButtonElement>('.plans-pin')!;
  expect(button.textContent).toBe('Pin');
  expect(button.getAttribute('aria-pressed')).toBe('false');

  controller.update([{ ...plan, pinned: true, pinLabel: 'Unpin · Workshop' }]);
  button = host.querySelector<HTMLButtonElement>('.plans-pin')!;
  expect(button.textContent).toBe('Unpin · Workshop');
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(button.classList.contains('is-pinned')).toBe(true);
  button.click();
  expect(onPin).toHaveBeenCalledExactlyOnceWith('plan-a');

  controller.update([plan]);
  button = host.querySelector<HTMLButtonElement>('.plans-pin')!;
  expect(button.textContent).toBe('Pin');
  expect(button.getAttribute('aria-pressed')).toBe('false');
});

it('keeps checked-off Plan items readable without striking through their text', () => {
  const host = document.getElementById('host')!;
  createPlansLibrary({
    host,
    plans: [{
      id: 'plan-readable-done',
      title: 'Readable checklist',
      lifecycle: 'live',
      items: [{ id: 'step-done', title: 'Keep this easy to read', status: 'done' }]
    }],
    onToggleItemDone: vi.fn()
  });

  const row = host.querySelector<HTMLElement>(".plans-item[data-status='done']")!;
  const toggle = row.querySelector<HTMLButtonElement>('.plans-item-toggle')!;
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(toggle.querySelector('.ico')).not.toBeNull();

  const completedTitleRule = plansLibraryCss.match(
    /\.plans-item\[data-status='done'\] \.plans-item-title > span:first-child\s*\{([^}]*)\}/
  )?.[1];
  expect(completedTitleRule).toBeTruthy();
  expect(completedTitleRule).toContain('color: color-mix(');
  expect(completedTitleRule).toContain('var(--plans-ink)');
  expect(completedTitleRule).not.toContain('text-decoration');
  expect(completedTitleRule).not.toContain('line-through');
});

it('gives installed Computer Use exact semantic handles for a Thread-owned Plan source and user signoff', () => {
  const host = document.getElementById('host')!;
  const onOpenSource = vi.fn();
  const onArchive = vi.fn();
  createPlansLibrary({
    host,
    plans: [{
      id: 'request-plan',
      title: 'Dogfood request continuity',
      lifecycle: 'ready-to-archive',
      audience: 'human',
      items: [{ id: 'done-step', title: 'Verify the result', status: 'done' }],
      provenance: { label: '%requests', sourceState: 'linked' }
    }],
    onOpenSource,
    onArchive
  });

  const card = host.querySelector<HTMLElement>('.plans-card')!;
  const source = host.querySelector<HTMLButtonElement>('.plans-source-open')!;
  const archive = host.querySelector<HTMLButtonElement>('.plans-archive')!;
  expect(card.getAttribute('aria-label')).toBe('Dogfood request continuity');
  expect(card.dataset.lifecycle).toBe('ready-to-archive');
  expect(source.getAttribute('aria-label')).toBe('Open source · %requests');
  expect(archive.getAttribute('aria-label')).toBe('Archive as finished · Dogfood request continuity');

  source.click();
  expect(onOpenSource).toHaveBeenCalledExactlyOnceWith('request-plan', expect.objectContaining({ label: '%requests' }));
  expect(onArchive).not.toHaveBeenCalled();
});

it('uses the app healthy green for completed Plan checkboxes', () => {
  const completedToggleRule = plansLibraryCss.match(
    /\.plans-item\[data-status='done'\] \.plans-item-toggle\s*\{([^}]*)\}/
  )?.[1];
  expect(completedToggleRule).toBeTruthy();
  expect(completedToggleRule).toContain('border-color: var(--green)');
  expect(completedToggleRule).toContain('background: var(--green)');
  expect(completedToggleRule).not.toContain('var(--plans-ready)');
  expect(completedToggleRule).not.toContain('var(--plans-danger)');
});

it('formats Eve Activity worker titles with a short task, zero-padded worker number, date and time', () => {
  const at = new Date(2026, 8, 15, 20, 17).getTime();
  expect(workerActivityCardTitle('worker-1', 'worker-1 · Audit startup', at, 'Fallback task'))
    .toBe('Worker 01 - Audit startup - 15.09.2026 - 20:17');
  expect(workerActivityCardTitle('worker-19', 'Resumed · worker-19', at, 'Finish release review'))
    .toBe('Worker 19 - Finish release review - 15.09.2026 - 20:17');
  const clipped = workerActivityCardTitle('worker-2', 'worker-2', at, 'A very long fallback task title that should be clipped before it overwhelms the activity card');
  expect(clipped).toMatch(/^Worker 02 - .{1,44} - 15\.09\.2026 - 20:17$/);
  expect(clipped).not.toContain('Resumed');
  expect(clipped).not.toContain('worker-2');
});

it('keeps Eve Activity real task checkmarks clickable without a synthetic report row', () => {
  const onToggleItemDone = vi.fn();
  const host = document.getElementById('host')!;
  createPlansLibrary({
    host,
    plans: [{
      id: 'worker-plan',
      title: 'Worker 01 - Audit - 15.09.2026 - 20:17',
      lifecycle: 'live',
      audience: 'eve',
      items: [{ id: 'real-task', title: 'Finish the audit', status: 'todo' }]
    }],
    onToggleItemDone
  });
  const eve = Array.from(host.querySelectorAll<HTMLButtonElement>('.plans-audience-tab'))
    .find(button => button.dataset.audience === 'eve')!;
  eve.click();
  const toggle = host.querySelector<HTMLButtonElement>(".plans-item-toggle[aria-label='Mark Finish the audit done']")!;
  expect(toggle.disabled).toBe(false);
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  toggle.click();
  expect(onToggleItemDone).toHaveBeenCalledExactlyOnceWith('worker-plan', 'real-task', true);
  expect(host.textContent).not.toContain('Report to Primary');
});

it('defaults to manager-facing Plans and keeps worker execution under Eve activity', () => {
  const host = document.getElementById('host')!;
  createPlansLibrary({
    host,
    plans: [
      {
        id: 'prime-plan',
        title: 'Ship 2.1.2',
        lifecycle: 'live',
        audience: 'human',
        items: [{ id: 'prime-step', title: 'Finish release readiness', status: 'in-progress' }]
      },
      {
        id: 'worker-plan',
        title: 'worker-1 · Audit startup',
        lifecycle: 'live',
        audience: 'eve',
        items: [{ id: 'worker-step', title: 'Trace instruction injection', status: 'in-progress' }]
      }
    ]
  });

  expect(host.textContent).toContain('Ship 2.1.2');
  expect(host.textContent).toContain('Verified work');
  expect(host.textContent).toContain('worker-1 · Audit startup');
  const evidence = host.querySelector<HTMLDetailsElement>('.plans-evidence')!;
  expect(evidence.open).toBe(false);
  expect(evidence.textContent).toContain('Trace instruction injection');
  const eve = Array.from(host.querySelectorAll<HTMLButtonElement>('.plans-audience-tab'))
    .find(button => button.dataset.audience === 'eve')!;
  expect(eve.textContent).toContain('1');
  eve.click();
  expect(host.textContent).not.toContain('Ship 2.1.2');
  expect(host.textContent).toContain('worker-1 · Audit startup');
});

it('keeps Live card order stable while card state changes', () => {
  const host = document.getElementById('host')!;
  const plans: PlanViewModel[] = [
    {
      id: 'recent-current',
      title: 'Recent current without priority',
      lifecycle: 'live',
      updatedAt: 500,
      currentItemId: 'current-step',
      items: [{ id: 'current-step', title: 'Live source work', status: 'in-progress' }]
    },
    {
      id: 'medium',
      title: 'Medium explicit priority',
      lifecycle: 'live',
      updatedAt: 900,
      priority: 'medium',
      items: [{ id: 'medium-step', title: 'Medium task', status: 'todo', priority: 'medium' }]
    },
    {
      id: 'high-stale',
      title: 'Older high priority',
      lifecycle: 'live',
      updatedAt: 10,
      priority: 'high',
      items: [{ id: 'high-step', title: 'Important old task', status: 'todo', priority: 'high' }]
    },
    {
      id: 'pinned-low',
      title: 'Pinned low priority',
      lifecycle: 'live',
      updatedAt: 1,
      pinned: true,
      priority: 'low',
      items: [{ id: 'pinned-step', title: 'Pinned task', status: 'todo', priority: 'low' }]
    },
    {
      id: 'recent-unprioritized',
      title: 'Newest unprioritized history',
      lifecycle: 'live',
      updatedAt: 1_000,
      items: [{ id: 'history-step', title: 'Historical task', status: 'todo' }]
    }
  ];

  const controller = createPlansLibrary({ host, plans });
  const titles = () => Array.from(host.querySelectorAll<HTMLElement>('.plans-card h3'), node => node.textContent);
  expect(titles()).toEqual([
    'Recent current without priority',
    'Medium explicit priority',
    'Older high priority',
    'Pinned low priority',
    'Newest unprioritized history'
  ]);
  expect(host.querySelector(".plans-card[data-priority='high'] .plans-priority")?.textContent).toBe('High priority');
  expect(host.querySelector(".plans-card[data-priority='medium'] .plans-priority")?.textContent).toBe('Medium priority');
  expect(host.querySelector(".plans-card[data-priority='low'] .plans-priority")?.textContent).toBe('Low priority');
  expect(Array.from(host.querySelectorAll('.plans-item-relation')).map(node => node.textContent)).toContain('Current');

  // Repaint the same Plans with changed Pin, progress, Current and revision state. Those are card
  // updates, not ordering commands, so every card stays where it was.
  controller.update(plans.map(plan => plan.id === 'recent-current'
    ? {
        ...plan,
        pinned: true,
        updatedAt: 5_000,
        currentItemId: null,
        items: [{ id: 'current-step', title: 'Live source work', status: 'done' as const }]
      }
    : { ...plan, pinned: false }));
  expect(titles()).toEqual([
    'Recent current without priority',
    'Medium explicit priority',
    'Older high priority',
    'Pinned low priority',
    'Newest unprioritized history'
  ]);
  expect(host.querySelector('.plans-item-relation.is-current')).toBeNull();
});
