/**
 * Eve-owned evidence for a parent ChatGPT Work research request.
 *
 * ChatGPT, not Eve, decides whether hosted subagents actually start. The only
 * verified identity here is the exact parent conversation/session. No entry
 * is a child principal, permission grant, tool receipt, or billing statement.
 */
import { randomUUID } from 'node:crypto';
import { readDurableStrict, writeDurableNow } from './durable.js';
import { logWarn } from './logger.js';
import { debugReliabilityEvent } from './reliability-debug-events.js';
import { getSession } from './session/store.js';

const STATE = 'native-delegations';
const MAX_RECORDS = 1_000;
const MAX_ASSIGNMENTS = 4;

export interface NativeDelegationOwner {
  conversationId: string;
  sessionId: string;
  primeRunId: string | null;
}
export interface NativeDelegationAssignment {
  id: string;
  label: string;
  task: string;
  status: 'prepared' | 'reported_by_prime';
  report: string | null;
  sourceReferences: string[];
  reportedAt: number | null;
}
export type NativeDelegationStatus =
  | 'prepared' | 'reported_by_prime' | 'cancellation_requested'
  | 'unknown' | 'closed' | 'unsupported';
export interface NativeDelegationRecord {
  id: string;
  owner: NativeDelegationOwner;
  acknowledgement: string;
  assignments: NativeDelegationAssignment[];
  status: NativeDelegationStatus;
  createdAt: number;
  updatedAt: number;
  reason: string | null;
  /**
   * The parent turn a close/unsupported settlement was made in. A hosted child runs inside that
   * turn with the parent's exact identity, so a close made there may be the child's: the lock
   * stays until the owner session has left this turn. Absent when the close was made outside one.
   */
  closedInTurn?: string;
}
interface Snapshot { version: 1; records: NativeDelegationRecord[] }

let records: NativeDelegationRecord[] = [];
// An unreadable ledger is not an empty ledger. All Eve effects fail closed
// while provenance cannot be recovered; never overwrite the damaged file.
let unreadable = true;
let mutationTail: Promise<void> = Promise.resolve();
// The ledger as last made durable, while a newer one is being written. Locks are read from both,
// so a prepare locks before it is saved and a close unlocks only once it is: a close that is still
// pending, or that fails to save, would come back after a crash and must not have released effects.
let unsaved: NativeDelegationRecord[] | null = null;
// Settled records whose closing turn has been seen to end. Turns never reopen, so this only grows
// until the ledger is restored, when it is learned again from the session.
const turnEnded = new Set<string>();

const active = (status: NativeDelegationStatus): boolean =>
  status === 'prepared' || status === 'reported_by_prime' ||
  status === 'cancellation_requested' || status === 'unknown';

function validOwner(value: unknown): value is NativeDelegationOwner {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<NativeDelegationOwner>;
  return typeof v.conversationId === 'string' && v.conversationId.length > 0 &&
    typeof v.sessionId === 'string' && v.sessionId.length > 0 &&
    (v.primeRunId === null || typeof v.primeRunId === 'string');
}

function validSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Snapshot>;
  if (v.version !== 1 || !Array.isArray(v.records) || v.records.length > MAX_RECORDS) return false;
  const ids = new Set<string>();
  return v.records.every((record) => {
    if (!record || typeof record !== 'object' || !validOwner(record.owner) ||
        typeof record.id !== 'string' || !record.id || ids.has(record.id) ||
        !['prepared', 'reported_by_prime', 'cancellation_requested', 'unknown', 'closed', 'unsupported'].includes(record.status) ||
        typeof record.acknowledgement !== 'string' ||
        typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) ||
        typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt) ||
        !(record.reason === null || typeof record.reason === 'string') ||
        !(record.closedInTurn === undefined ||
          typeof record.closedInTurn === 'string' && record.closedInTurn.length >= 1 && record.closedInTurn.length <= 256) ||
        !Array.isArray(record.assignments) || record.assignments.length < 1 ||
        record.assignments.length > MAX_ASSIGNMENTS) return false;
    ids.add(record.id);
    const assignmentIds = new Set<string>();
    return record.assignments.every((a) => {
      if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id ||
          assignmentIds.has(a.id) || typeof a.label !== 'string' ||
          a.label.length < 1 || a.label.length > 80 ||
          typeof a.task !== 'string' || a.task.length < 1 || a.task.length > 1200 ||
          !['prepared', 'reported_by_prime'].includes(a.status) ||
          !(a.report === null || typeof a.report === 'string' && a.report.length <= 4000) ||
          !Array.isArray(a.sourceReferences) || a.sourceReferences.length > 12 ||
          !a.sourceReferences.every((ref) => typeof ref === 'string' && ref.length >= 1 && ref.length <= 300) ||
          !(a.reportedAt === null || typeof a.reportedAt === 'number' && Number.isFinite(a.reportedAt))) return false;
      assignmentIds.add(a.id);
      return true;
    });
  });
}

export async function restoreNativeDelegations(): Promise<void> {
  unreadable = true;
  records = [];
  turnEnded.clear();
  try {
    const snapshot = await readDurableStrict<unknown>(STATE);
    if (snapshot === null) {
      unreadable = false;
      return;
    }
    if (!validSnapshot(snapshot)) throw new Error('invalid native delegation ledger structure');
    records = snapshot.records;
    unreadable = false;
  } catch (error) {
    logWarn(`native delegation ledger could not be restored safely: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const heldOpen = (record: NativeDelegationRecord): boolean =>
  record.closedInTurn !== undefined && !turnEnded.has(record.id);
const locking = (record: NativeDelegationRecord): boolean => active(record.status) || heldOpen(record);

function locked(holds: (record: NativeDelegationRecord) => boolean): boolean {
  return records.some((record) => locking(record) && holds(record)) ||
    (unsaved?.some((record) => locking(record) && holds(record)) ?? false);
}

/**
 * Lift the hold on settled records whose closing turn is over. The kernel awaits this before its
 * lock check; it reads nothing unless a hold is still open. A failed or missing read keeps the hold.
 */
export async function settleNativeDelegationHolds(
  currentTurn: (sessionId: string) => Promise<string | null | undefined> =
    async (sessionId) => (await getSession(sessionId))?.activeTurnId ?? null
): Promise<void> {
  for (const record of records.filter((candidate) => !active(candidate.status) && heldOpen(candidate))) {
    const turn = await currentTurn(record.owner.sessionId).catch(() => undefined);
    if (turn !== undefined && turn !== record.closedInTurn) turnEnded.add(record.id);
  }
}

export function nativeDelegationReady(): boolean { return !unreadable; }
export function nativeDelegationHasActiveLocks(): boolean {
  return unreadable || locked(() => true);
}
export function nativeDelegationBlocksEffectful(conversationId: string | null, _sessionId: string | null): boolean {
  if (unreadable) return true;
  if (!conversationId) return nativeDelegationHasActiveLocks();
  // A hosted child can share the parent's conversation proof while its local
  // session join is absent or stale. A session mismatch must not unlock that
  // conversation. Unknown conversation ownership is denied globally above.
  return locked((record) => record.owner.conversationId === conversationId);
}

/** One admission policy for every Eve MCP surface, including nested code-mode calls. */
export function nativeDelegationBlocksTool(
  tool: string,
  args: unknown,
  effectful: boolean,
  conversationId: string | null,
  sessionId: string | null
): boolean {
  if (!effectful) return false;
  const action = args && typeof args === 'object' ? (args as { action?: unknown }).action : null;
  // These are the only ways to inspect/report/settle an already prepared record.
  // A second prepare is never exempt from the live parent lock.
  if (tool === 'native_delegation' && ['status', 'report', 'cancel', 'close'].includes(String(action))) return false;
  if (tool === 'agents' && action === 'status') return false;
  if ((tool === 'pins' || tool === 'schedule') && action === 'list') return false;
  return nativeDelegationBlocksEffectful(conversationId, sessionId);
}

function ownerEquals(a: NativeDelegationOwner, b: NativeDelegationOwner): boolean {
  // The durable local session and exact provider conversation identify the
  // parent at recovery. A run can park or be restored under another run ID;
  // retain its original ID as provenance, not an expiring recovery credential.
  // The MCP boundary independently verifies that this caller still is Prime.
  return a.conversationId === b.conversationId &&
    a.sessionId === b.sessionId;
}
function assertReady(): void {
  if (unreadable) throw new Error('NATIVE_DELEGATION_LEDGER_UNREADABLE: no operation or fallback was executed');
}
function matching(owner: NativeDelegationOwner, requestId: string): NativeDelegationRecord {
  const record = records.find((candidate) => candidate.id === requestId && ownerEquals(candidate.owner, owner));
  if (!record) throw new Error('NATIVE_DELEGATION_NOT_FOUND_OR_OWNER_CHANGED');
  return record;
}
function snapshotCopy(value: NativeDelegationRecord): NativeDelegationRecord {
  return structuredClone(value);
}

async function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(work);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}
async function publish(next: NativeDelegationRecord[]): Promise<void> {
  const previous = records;
  records = next;
  unsaved = previous;
  try {
    await writeDurableNow(STATE, { version: 1, records: next } satisfies Snapshot);
  } catch (error) {
    records = previous;
    throw error;
  } finally {
    unsaved = null;
  }
}

export function listNativeDelegations(owner: NativeDelegationOwner): NativeDelegationRecord[] {
  assertReady();
  if (!validOwner(owner)) throw new Error('NATIVE_DELEGATION_EXACT_OWNER_REQUIRED');
  return records.filter((record) => ownerEquals(record.owner, owner)).map(snapshotCopy);
}

export async function prepareNativeDelegation(input: {
  owner: NativeDelegationOwner;
  assignments: Array<{ label: string; task: string }>;
  acknowledgement: string;
}): Promise<NativeDelegationRecord> {
  return serialized(async () => {
    assertReady();
    if (!validOwner(input.owner)) throw new Error('NATIVE_DELEGATION_EXACT_OWNER_REQUIRED');
    if (!Array.isArray(input.assignments) || input.assignments.length < 1 ||
        input.assignments.length > MAX_ASSIGNMENTS ||
        input.assignments.some((a) => typeof a.label !== 'string' || !a.label.trim() ||
          a.label.length > 80 || typeof a.task !== 'string' || !a.task.trim() || a.task.length > 1200)) {
      throw new Error('NATIVE_DELEGATION_ASSIGNMENTS_REQUIRED: 1–4 bounded research assignments');
    }
    if (typeof input.acknowledgement !== 'string' || input.acknowledgement.length < 1 ||
        input.acknowledgement.length > 1000) throw new Error('NATIVE_DELEGATION_ACKNOWLEDGEMENT_REQUIRED');
    // The bound is on retained records, not lifetime ones. Settled records are history, not locks,
    // so the oldest give way to a new request; an open record is never dropped to make room.
    let kept = records;
    if (kept.length >= MAX_RECORDS) {
      const retire = new Set(records.filter((record) => !locking(record))
        .sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt)
        .slice(0, records.length - MAX_RECORDS + 1).map((record) => record.id));
      kept = records.filter((record) => !retire.has(record.id));
      if (kept.length >= MAX_RECORDS) throw new Error('NATIVE_DELEGATION_LEDGER_FULL: every retained request is still open');
    }
    if (records.some((record) => active(record.status) &&
        record.owner.conversationId === input.owner.conversationId)) {
      throw new Error('NATIVE_DELEGATION_ALREADY_ACTIVE: close the previous exact request first');
    }
    const now = Date.now();
    const record: NativeDelegationRecord = {
      id: randomUUID(), owner: { ...input.owner }, acknowledgement: input.acknowledgement,
      assignments: input.assignments.map(({ label, task }) => ({
        id: randomUUID(), label: label.trim(), task: task.trim(),
        status: 'prepared', report: null, sourceReferences: [], reportedAt: null
      })),
      status: 'prepared', createdAt: now, updatedAt: now, reason: null
    };
    await publish([...kept, record]);
    debugReliabilityEvent('native-delegation-prepared', { owner: input.owner.conversationId, epoch: record.id });
    return snapshotCopy(record);
  });
}

export async function reportNativeDelegation(input: {
  owner: NativeDelegationOwner;
  requestId: string;
  assignmentId: string;
  report: string;
  sourceReferences?: string[];
}): Promise<NativeDelegationRecord> {
  return serialized(async () => {
    assertReady();
    const current = matching(input.owner, input.requestId);
    if (!active(current.status)) throw new Error('NATIVE_DELEGATION_ALREADY_CLOSED');
    if (typeof input.report !== 'string' || !input.report.trim() || input.report.length > 4000 ||
        !Array.isArray(input.sourceReferences ?? []) || (input.sourceReferences ?? []).length > 12 ||
        !(input.sourceReferences ?? []).every((ref) => typeof ref === 'string' && ref.length > 0 && ref.length <= 300)) {
      throw new Error('NATIVE_DELEGATION_REPORT_INVALID');
    }
    const assignment = current.assignments.find((a) => a.id === input.assignmentId);
    if (!assignment) throw new Error('NATIVE_DELEGATION_ASSIGNMENT_NOT_FOUND');
    // The same exact report is safe to re-read after an ambiguous response.
    if (assignment.report !== null) {
      if (assignment.report === input.report &&
          JSON.stringify(assignment.sourceReferences) === JSON.stringify(input.sourceReferences ?? [])) return snapshotCopy(current);
      throw new Error('NATIVE_DELEGATION_REPORT_ALREADY_RECORDED: do not overwrite ambiguous child findings');
    }
    const next = snapshotCopy(current);
    const target = next.assignments.find((a) => a.id === input.assignmentId)!;
    target.report = input.report;
    target.sourceReferences = [...(input.sourceReferences ?? [])];
    target.reportedAt = Date.now();
    target.status = 'reported_by_prime';
    next.updatedAt = Date.now();
    if (next.status === 'prepared' || next.status === 'reported_by_prime') next.status = 'reported_by_prime';
    await publish(records.map((record) => record.id === next.id ? next : record));
    debugReliabilityEvent('native-report-by-prime', { owner: input.owner.conversationId, epoch: next.id });
    return snapshotCopy(next);
  });
}

export async function requestNativeDelegationCancellation(input: {
  owner: NativeDelegationOwner;
  requestId: string;
}): Promise<NativeDelegationRecord> {
  return serialized(async () => {
    assertReady();
    const current = matching(input.owner, input.requestId);
    if (!active(current.status)) return snapshotCopy(current);
    if (current.status === 'cancellation_requested') return snapshotCopy(current);
    const next = { ...current, status: 'cancellation_requested' as const, updatedAt: Date.now() };
    await publish(records.map((record) => record.id === next.id ? next : record));
    debugReliabilityEvent('native-delegation-unresolved', { owner: input.owner.conversationId, epoch: next.id, warning: true });
    return snapshotCopy(next);
  });
}

export async function closeNativeDelegation(input: {
  owner: NativeDelegationOwner;
  requestId: string;
  disposition: 'closed' | 'unsupported' | 'unknown';
  reason?: string;
  /** The owner session's open turn at the time of this call, or null outside a turn. */
  turnId?: string | null;
}): Promise<NativeDelegationRecord> {
  return serialized(async () => {
    assertReady();
    const current = matching(input.owner, input.requestId);
    if (input.reason && input.reason.length > 1000) throw new Error('NATIVE_DELEGATION_REASON_TOO_LONG');
    if (!active(current.status)) {
      if (current.status === input.disposition) return snapshotCopy(current);
      throw new Error('NATIVE_DELEGATION_ALREADY_CLOSED');
    }
    // Unknown means host lifecycle remains unresolved: retain the parent lock.
    const next: NativeDelegationRecord = {
      ...current, status: input.disposition, reason: input.reason ?? null, updatedAt: Date.now(),
      ...(input.disposition !== 'unknown' && input.turnId ? { closedInTurn: input.turnId } : {})
    };
    await publish(records.map((record) => record.id === next.id ? next : record));
    if (input.disposition !== 'closed') debugReliabilityEvent('native-delegation-unresolved', {
      owner: input.owner.conversationId, epoch: next.id, warning: true
    });
    return snapshotCopy(next);
  });
}
