import { ui, t } from './i18n.js';
import type { AgentPlan } from '../shared/agent-plan.js';
import { el, icon, run, toast } from './dom.js';
import { pinStateForSessionPlan, toggleLivePlanPinForSession } from './workspace-library.js';

/** One current plan above the composer queue; every model string is text, never HTML. */
type PlanRevisionState = { planId: string; revision: number; sentRevision: number | null; autoSend: boolean };

/** Nesting depth of each step from its parent keys (1 = top level). Unknown parents count as top level. */
function stepDepths(plan: AgentPlan): number[] {
  const byKey = new Map(plan.plan.flatMap(step => step.key ? [[step.key, step] as const] : []));
  return plan.plan.map(step => {
    let depth = 1;
    let parent = step.parent;
    while (parent !== undefined && depth < 4) {
      const next = byKey.get(parent);
      if (!next) break;
      depth += 1;
      parent = next.parent;
    }
    return depth;
  });
}

export function renderAgentPlan(host: HTMLElement, sessionId: string | null, plan: AgentPlan | null, revision: PlanRevisionState | null = null): void {
  if (host.dataset.sessionId !== (sessionId ?? '')) {
    host.replaceChildren();
    host.dataset.sessionId = sessionId ?? '';
    delete host.dataset.signature;
  }
  if (!sessionId || !plan?.plan.length) {
    host.hidden = true;
    host.replaceChildren();
    delete host.dataset.signature;
    return;
  }
  const durablePin = pinStateForSessionPlan(sessionId);
  const signature = JSON.stringify([plan.plan, plan.explanation, durablePin?.pin.id ?? null, durablePin?.quiltTitle ?? null, revision]);
  if (host.dataset.signature === signature) return;
  const previous = host.querySelector<HTMLDetailsElement>('.agent-plan-shell');
  const expanded = new Map([...host.querySelectorAll<HTMLDetailsElement>('[data-step]')].map(row => [row.dataset.step, row.open]));
  const focused = (document.activeElement?.closest('[data-step]') as HTMLElement | null)?.dataset.step;
  const completed = plan.plan.filter(step => step.status === 'completed').length;
  const complete = completed === plan.plan.length;
  // Completed documents remain durable, but only a visible unfinished plan celebrates.
  // Reopening a chat/restarting must not resurrect its completed composer card.
  const celebrate = complete && previous?.dataset.complete === 'false';
  host.hidden = complete && !celebrate;
  if (host.hidden) {
    host.replaceChildren();
    host.dataset.signature = signature;
    return;
  }
  const shell = el('details', 'agent-plan-shell') as HTMLDetailsElement;
  shell.dataset.complete = String(complete);
  shell.open = previous?.open ?? completed < plan.plan.length;
  const heading = el('summary', 'agent-plan-heading');
  heading.append(icon('i-steps'), el('span', 'agent-plan-title', () => completed === plan.plan.length ? t("Plan complete") : t("Plan")),
    el('span', 'agent-plan-count', `${completed} / ${plan.plan.length}`));
  const pin = el('button', `agent-plan-pin${durablePin ? ' is-pinned' : ''}`) as HTMLButtonElement;
  pin.type = 'button';
  const paintPin = () => {
    const state = pinStateForSessionPlan(sessionId);
    pin.textContent = state ? t('Unpin · {0}', [state.quiltTitle]) : t('Pin');
    pin.classList.toggle('is-pinned', state !== null);
    pin.setAttribute('aria-pressed', String(state !== null));
    pin.title = state ? t('Unpin this plan') : t('Pin this plan to a Thread');
  };
  paintPin();
  pin.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    pin.disabled = true;
    void toggleLivePlanPinForSession(sessionId)
      .then(() => paintPin())
      .finally(() => { pin.disabled = false; });
  });
  heading.append(pin);
  // A revision the orchestrator may not act on yet: the user's Send releases exactly this one.
  if (revision && !revision.autoSend && revision.sentRevision !== revision.revision) {
    const send = el('button', 'agent-plan-send') as HTMLButtonElement;
    send.type = 'button';
    ui(send, 'textContent', () => revision.sentRevision === null ? t('Send to orchestrator') : t('Send revision {0}', [String(revision.revision)]));
    ui(send, 'title', () => t('Let the orchestrator act on this revision of the Plan'));
    send.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      send.disabled = true;
      void run(window.api.sendPlanRevision(revision.planId, revision.revision)).then(sent => {
        if (sent) { send.remove(); toast(t('Plan sent to the orchestrator')); }
      }).finally(() => { send.disabled = false; });
    });
    heading.append(send);
  }
  shell.append(heading);
  const body = el('div', 'agent-plan-body');
  if (plan.explanation) body.append(el('p', 'agent-plan-explanation', plan.explanation));
  const depths = stepDepths(plan);
  for (const [index, step] of plan.plan.entries()) {
    const row = el('details', 'agent-plan-step') as HTMLDetailsElement;
    row.dataset.step = step.step;
    row.dataset.status = step.status;
    row.dataset.depth = String(depths[index]);
    row.open = expanded.get(step.step) ?? false;
    const summary = el('summary', 'agent-plan-step-heading');
    const marker = el('span', 'agent-plan-marker', step.status === 'completed' ? '✓' : String(index + 1));
    ui(marker, 'aria-label', () => step.status === 'in_progress' ? t("In progress") : step.status === 'completed' ? t("Completed") : t("Pending"));
    summary.append(marker, el('span', 'agent-plan-step-title', step.step));
    const expandable = Boolean(step.details || step.intent || step.constraints?.length);
    if (!expandable) summary.addEventListener('click', event => event.preventDefault());
    row.append(summary);
    if (step.details) row.append(el('div', 'agent-plan-details', step.details));
    if (step.intent) row.append(el('div', 'agent-plan-intent', () => t('Why: {0}', [step.intent!])));
    if (step.constraints?.length) {
      const list = el('ul', 'agent-plan-constraints');
      for (const constraint of step.constraints) list.append(el('li', '', constraint));
      row.append(list);
    }
    body.append(row);
    if (focused === step.step) queueMicrotask(() => { if (row.isConnected) summary.focus(); });
  }
  shell.append(body);
  host.replaceChildren(shell);
  host.dataset.signature = signature;
  if (celebrate) {
    const dismiss = () => {
      // A late animation completion cannot hide a newer plan or a different chat.
      if (shell.parentElement !== host) return;
      host.hidden = true;
      host.replaceChildren();
    };
    if (typeof shell.animate !== 'function') { dismiss(); return; }
    const reduced = document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const height = shell.getBoundingClientRect().height;
    const animation = shell.animate(reduced ? [
      { opacity: 1 }, { opacity: 0 }
    ] : [
      { height: `${height}px`, opacity: 1, transform: 'scale(1)', boxShadow: 'inset 0 0 0 0 transparent', offset: 0 },
      { height: `${height}px`, opacity: 1, transform: 'scale(1)', boxShadow: 'inset 0 0 28px 0 rgba(70, 210, 150, .25)', offset: .25 },
      { height: `${height}px`, opacity: 1, transform: 'scale(1)', boxShadow: 'inset 0 0 0 0 transparent', offset: .7 },
      { height: '0px', opacity: 0, transform: 'scale(.98)', boxShadow: 'inset 0 0 0 0 transparent', offset: 1 }
    ], { duration: reduced ? 150 : 1800, easing: 'ease-in-out', fill: 'forwards' });
    animation.finished.then(dismiss, () => undefined);
  }
}
