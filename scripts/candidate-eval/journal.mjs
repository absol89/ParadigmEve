/**
 * Append-only run journal and the state folded from it.
 *
 * One fsynced JSON line per event. State is never stored separately, so a crash can only lose
 * the line being written: a torn final line is ignored, any other unreadable line fails closed.
 * Every side effect is preceded by an `*.intent` event, which is what `recover` reconciles.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from './core.mjs';

export const TERMINAL_ATTEMPT_STATES = new Set(['disqualified', 'failed', 'abandoned', 'evaluated']);

export class Journal {
  constructor(runDir) {
    this.runDir = runDir;
    this.file = path.join(runDir, 'journal.jsonl');
  }

  /** Reads every complete event. */
  events() {
    if (!fs.existsSync(this.file)) throw new HarnessError('RUN_MISSING', `no journal at ${this.file}`);
    const text = fs.readFileSync(this.file, 'utf8');
    const lines = text.split('\n');
    const events = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        const isLast = lines.slice(index + 1).every(rest => rest === '');
        if (isLast && !text.endsWith('\n')) break; // torn tail from a crash mid-write
        throw new HarnessError('JOURNAL_CORRUPT', `unreadable journal line ${index + 1}`);
      }
    }
    events.forEach((event, index) => {
      if (event.seq !== index + 1) throw new HarnessError('JOURNAL_CORRUPT', `sequence gap at line ${index + 1}`);
    });
    return events;
  }

  /** Appends one event, after dropping a torn tail so the new line starts cleanly. */
  append(type, data = {}) {
    let events = [];
    if (fs.existsSync(this.file)) {
      events = this.events();
      const text = fs.readFileSync(this.file, 'utf8');
      if (text && !text.endsWith('\n')) fs.truncateSync(this.file, text.lastIndexOf('\n') + 1);
    }
    const event = { seq: events.length + 1, at: Date.now(), type, ...data };
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(event)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return event;
  }

  state() {
    return foldState(this.events());
  }
}

/** Folds the journal into run state. Unknown or out-of-order transitions fail closed. */
export function foldState(events) {
  const state = {
    contractHash: null,
    halted: null,
    calibration: {},
    attempts: new Map(),
    evals: [],
    pendingEvals: [],
    selections: [],
    proposals: new Map(),
    nextOrdinal: 1
  };
  const attempt = (event, allowed) => {
    const found = state.attempts.get(event.attemptId);
    if (!found) throw new HarnessError('JOURNAL_CORRUPT', `event ${event.seq} names unknown attempt ${event.attemptId}`);
    if (allowed && !allowed.includes(found.state)) {
      throw new HarnessError('JOURNAL_CORRUPT', `event ${event.seq} (${event.type}) not allowed from state ${found.state}`);
    }
    return found;
  };
  for (const event of events) {
    switch (event.type) {
      case 'run.created':
        state.contractHash = event.contractHash;
        break;
      case 'run.halted':
        state.halted = { reason: event.reason, details: event.details ?? null, seq: event.seq };
        break;
      case 'calibration.recorded':
        state.calibration[event.taskId] = event.result;
        break;
      case 'attempt.reserve.intent':
        if (state.attempts.has(event.attemptId)) throw new HarnessError('JOURNAL_CORRUPT', `attempt ${event.attemptId} reserved twice`);
        state.attempts.set(event.attemptId, {
          id: event.attemptId,
          ordinal: event.ordinal,
          taskId: event.taskId,
          arm: event.arm,
          strategyId: event.strategyId,
          workspace: event.workspace,
          state: 'reserving',
          flags: [],
          history: [event.seq]
        });
        state.nextOrdinal = Math.max(state.nextOrdinal, event.ordinal + 1);
        break;
      case 'attempt.reserved': {
        const found = attempt(event, ['reserving']);
        Object.assign(found, { state: 'reserved', fixtureCommit: event.fixtureCommit, gitConfigSha: event.gitConfigSha });
        break;
      }
      case 'attempt.started': {
        const found = attempt(event, ['reserved']);
        Object.assign(found, { state: 'running', startedAt: event.at, brief: event.brief, worker: event.worker, preFingerprint: event.preFingerprint });
        break;
      }
      case 'attempt.finished': {
        const found = attempt(event, ['running']);
        Object.assign(found, {
          state: 'finished',
          finishedAt: event.at,
          usage: event.usage,
          wallMs: event.at - found.startedAt,
          postFingerprint: event.postFingerprint
        });
        for (const flag of event.flags ?? []) found.flags.push(flag);
        break;
      }
      case 'attempt.freeze.intent':
        attempt(event, ['finished']).state = 'freezing';
        break;
      case 'attempt.frozen': {
        const found = attempt(event, ['freezing']);
        Object.assign(found, { state: 'frozen', frozen: event.frozen });
        break;
      }
      case 'attempt.disqualified': {
        const found = attempt(event, ['reserving', 'reserved', 'running', 'finished', 'freezing', 'frozen', 'evaluated']);
        Object.assign(found, { state: 'disqualified', disqualification: { reason: event.reason, details: event.details ?? null, evidence: event.evidence ?? null } });
        break;
      }
      case 'attempt.failed': {
        const found = attempt(event, ['reserving', 'reserved', 'running', 'finished', 'freezing']);
        Object.assign(found, { state: 'failed', failure: { reason: event.reason, details: event.details ?? null } });
        break;
      }
      case 'eval.intent':
        attempt(event, ['frozen', 'evaluated']);
        state.pendingEvals.push({ attemptId: event.attemptId, tier: event.tier, seq: event.seq });
        break;
      case 'eval.result': {
        const found = attempt(event, ['frozen', 'evaluated']);
        state.pendingEvals = state.pendingEvals.filter(pending => !(pending.attemptId === event.attemptId && pending.tier === event.result.tier));
        state.evals.push({ ...event.result, seq: event.seq });
        if (event.result.outcome !== 'pass' || event.result.tier === 'T2' || event.result.tier === 'T3') found.state = 'evaluated';
        break;
      }
      case 'eval.abandoned':
        state.pendingEvals = state.pendingEvals.filter(pending => !(pending.attemptId === event.attemptId && pending.tier === event.tier));
        break;
      case 'selection.recorded':
        state.selections.push({ ...event.selection, seq: event.seq });
        break;
      case 'proposal.intent':
        state.proposals.set(event.proposalId, { id: event.proposalId, attemptId: event.attemptId, target: event.target, lockFile: event.lockFile, state: 'intent' });
        break;
      case 'proposal.written':
      case 'proposal.refused':
      case 'proposal.released': {
        const proposal = state.proposals.get(event.proposalId);
        if (!proposal) throw new HarnessError('JOURNAL_CORRUPT', `event ${event.seq} names unknown proposal`);
        proposal.state = event.type.slice('proposal.'.length);
        if (event.type === 'proposal.written') proposal.written = event.proposal;
        if (event.type === 'proposal.refused') proposal.refusal = { code: event.code, details: event.details };
        break;
      }
      default:
        throw new HarnessError('JOURNAL_CORRUPT', `unknown event type ${event.type}`);
    }
    if (event.attemptId && state.attempts.has(event.attemptId)) {
      const found = state.attempts.get(event.attemptId);
      if (found.history.at(-1) !== event.seq) found.history.push(event.seq);
    }
  }
  return state;
}
