import { ensureRequestTrail, listRequestTrail } from './request-trail.js';
import { getSession, readRecentEvents } from './session/store.js';
import { listInputs } from './session/input.js';
import { pinsLibrary } from './pins.js';
import type { PlanView } from '../shared/plans.js';
import type { RequestTrailRecord } from '../shared/request-trail.js';
import type { SessionEvent } from '../shared/session.js';

const REQUEST_SOURCE_SCAN = 64;
type UserMessageEvent = Extract<SessionEvent, { kind: 'user_message' }>;

function eventAnchor(event: UserMessageEvent): number {
  return event.origin ?? event.seq;
}

function requestSummary(event: UserMessageEvent): string {
  // App-authored transport rows preserve the user's original text separately from delivery-only
  // control suffixes. Native ChatGPT messages have no authoredText and use their canonical text.
  const raw = event.authoredText ?? event.message.text;
  return raw.trim().replace(/\s+/g, ' ').slice(0, 1_000);
}

/**
 * Fresh app-authored sends are durably recorded as soon as browser delivery is confirmed. On a
 * brand-new ChatGPT conversation that receipt can precede the page's first `turn_start`, so the
 * canonical user message legitimately has no turnId yet. The lifecycle boundary still makes the
 * ownership exact: within the bounded segment immediately before this active turn start there must
 * be exactly one canonical user row, and it must be a confirmed app-owned input.
 *
 * Do not use this for native/history rows or for a segment with more than one possible request.
 */
function preStartAppRequest(events: readonly SessionEvent[], activeTurnId: string): UserMessageEvent | null {
  const startIndexes = events.flatMap((event, index) =>
    event.kind === 'turn_start' && event.turnId === activeTurnId ? [index] : []);
  if (startIndexes.length !== 1) return null;

  const segment = new Map<number, UserMessageEvent>();
  for (let index = startIndexes[0]! - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === 'turn_start' || event.kind === 'turn_end') break;
    if (event.kind === 'user_message') segment.set(eventAnchor(event), event);
  }
  if (segment.size !== 1) return null;
  const request = [...segment.values()][0]!;
  if (request.turnId || request.source !== 'app' || !request.inputId || request.inputDelivery !== 'confirmed') return null;
  return request;
}

async function originatingThreadId(
  event: Extract<SessionEvent, { kind: 'user_message' }>,
  sessionId: string,
  conversationId: string
): Promise<string | null> {
  if (!event.inputId) return null;
  const matching = (await listInputs()).filter(row => row.id === event.inputId);
  if (matching.length !== 1) throw new Error('Originating request input is missing or ambiguous');
  const input = matching[0]!;
  if (input.deliveredSessionId && input.deliveredSessionId !== sessionId) {
    throw new Error('Originating request input belongs to a different session');
  }
  if (input.conversationId && input.conversationId !== conversationId) {
    throw new Error('Originating request input belongs to a different conversation');
  }
  if (!input.contextQuiltId) return null;
  const library = await pinsLibrary();
  if (!library.quilts.some(thread => thread.id === input.contextQuiltId)) {
    throw new Error('Originating request Thread context no longer resolves to an exact durable Thread');
  }
  return input.contextQuiltId;
}

/**
 * The sole production admission owner for Plan-backed long-running user requests.
 *
 * `update_plan` calls this only after the exact session/conversation accepted the tool update and
 * the app-wide Plan projection exists. The Plan action is the authority boundary; chat prose alone
 * never invokes this function. Human Plans only: worker/helper Plans remain Eve Activity.
 *
 * First admission requires one canonical user message on the exact active turn. Once a Plan is
 * linked, later progress updates reuse that durable Plan→Request Trail relation and never guess a
 * newer request from chat history.
 */
export async function ensureRequestTrailForAcceptedPlan(input: {
  sessionId: string;
  conversationId: string;
  plan: PlanView;
}): Promise<RequestTrailRecord | null> {
  if (input.plan.audience === 'eve') return null;

  // `syncSessionAgentPlan()` returns an immediate projection before listPlans() derives audience,
  // so its default `human` flag is not an authority signal. Resolve worker/helper ownership from
  // durable session ancestry instead; ambiguous/broken resume ancestry fails closed.
  const seen = new Set<string>();
  let ancestry = await getSession(input.sessionId);
  while (ancestry) {
    if (seen.has(ancestry.id)) throw new Error('Accepted Plan session ancestry is cyclic');
    seen.add(ancestry.id);
    const origin = ancestry.origin;
    if (!origin || origin.kind === 'desktop') break;
    if (origin.kind === 'worker' || origin.kind === 'helper') return null;
    if (origin.kind !== 'resume' || !origin.fromSessionId) {
      throw new Error('Accepted Plan session ancestry is not exact');
    }
    ancestry = await getSession(origin.fromSessionId);
    if (!ancestry) throw new Error('Accepted Plan resume source session was not found');
  }

  const records = await listRequestTrail();
  const linked = records.filter(record => record.planId === input.plan.id);
  if (linked.length > 1) throw new Error('High-level Plan is linked to multiple Request Trail records');
  if (linked.length === 1) return linked[0]!;

  const session = await getSession(input.sessionId);
  if (!session || session.conversationId !== input.conversationId) {
    throw new Error('Accepted Plan no longer belongs to the exact caller conversation');
  }
  if (!session.activeTurnId) {
    throw new Error('Accepted Plan has no exact active request turn');
  }

  const recent = await readRecentEvents(input.sessionId, REQUEST_SOURCE_SCAN, {
    kinds: ['user_message', 'turn_start', 'turn_end']
  });
  const candidates = recent.filter((event): event is UserMessageEvent =>
    event.kind === 'user_message' && event.turnId === session.activeTurnId);
  const canonical = new Map<number, UserMessageEvent>();
  for (const event of candidates) canonical.set(eventAnchor(event), event);
  if (canonical.size > 1) {
    throw new Error('Accepted Plan does not have one exact canonical user request message on its active turn');
  }

  const request = canonical.size === 1
    ? [...canonical.values()][0]!
    : preStartAppRequest(recent, session.activeTurnId);
  if (!request) {
    throw new Error('Accepted Plan does not have one exact canonical user request message on its active turn');
  }
  const summary = requestSummary(request);
  if (!summary) throw new Error('Accepted Plan request message has no user-authored text');
  const threadId = await originatingThreadId(request, input.sessionId, input.conversationId);

  const admitted = await ensureRequestTrail({
    origin: {
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      eventSeq: eventAnchor(request),
      ...(request.messageId ? { messageId: request.messageId } : {}),
      ...(request.turnId ? { turnId: request.turnId } : {})
    },
    summary,
    state: input.plan.items.some(item => item.status === 'in_progress') ? 'running' : 'planned',
    planId: input.plan.id,
    ...(threadId ? { threadId } : {})
  });
  if (admitted.planId !== input.plan.id) {
    throw new Error('Exact originating request is already linked to a different high-level Plan');
  }
  return admitted;
}
