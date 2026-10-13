#!/usr/bin/env node
// Read-only health report of an installed Eve's local state. It never writes, so it is safe while Eve runs.
//
//   node scripts/eve-doctor.mjs [--data DIR] [--stuck-minutes 10] [--json]
//
// DIR defaults to %APPDATA%\paradigmeve (~/.config/paradigmeve elsewhere). Reports stuck input-queue rows,
// state that points at deleted sessions, open Compact & Resume tickets and the Eva identity pointer.
// Exit code 1 when anything needs attention.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ACTIVE_INPUT = new Set(['queued', 'browser', 'tool']);
const CLOSED_TICKET = new Set(['committed', 'aborted']);

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

export function loadState(dataDir) {
  const state = (name) => readJson(path.join(dataDir, 'state', `${name}.json`));
  const sessionsDir = path.join(dataDir, 'sessions');
  const sessions = existsSync(sessionsDir) ? readdirSync(sessionsDir).map((id) => {
    const meta = readJson(path.join(sessionsDir, id, 'meta.json')) ?? {};
    return { id, title: meta.title ?? '', conversationId: meta.conversationId ?? null, chatIds: meta.chatIds ?? [], endedAt: meta.endedAt ?? null };
  }) : [];
  return {
    sessions,
    input: state('session-input') ?? [],
    continuations: state('continuations')?.entries ?? [],
    correlations: state('request-correlations')?.entries ?? [],
    goalReplies: state('goal-replies')?.replies ?? [],
    bridge: state('bridge-commands') ?? { commands: [] },
    identity: state('agent-identity'),
    swarm: state('swarm'),
    running: readJson(path.join(dataDir, 'RECOVERY-RUNNING.json'))
  };
}

const minutes = (ms) => `${Math.round(ms / 60_000)} min`;

export function diagnose(state, { now = Date.now(), stuckMs = 10 * 60_000 } = {}) {
  const findings = [];
  const add = (level, area, message) => findings.push({ level, area, message });
  const sessionIds = new Set(state.sessions.map(s => s.id));
  const sessionOfChat = new Map();
  for (const s of state.sessions) for (const chat of [s.conversationId, ...s.chatIds]) if (chat) sessionOfChat.set(chat, s);

  // Input queue.
  const counts = {};
  for (const row of state.input) counts[row.state] = (counts[row.state] ?? 0) + 1;
  add('info', 'queue', `${state.input.length} input row(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'empty'}`);
  for (const row of state.input) {
    if (!ACTIVE_INPUT.has(row.state)) continue;
    const age = now - (row.sendAuthorizedAt ?? row.offeredAt ?? row.createdAt ?? now);
    if (age >= stuckMs) add('warn', 'queue', `row ${row.id} stuck in "${row.state}" for ${minutes(age)} (session ${row.sessionId}, mode ${row.mode}${row.purpose ? `, ${row.purpose}` : ''})`);
  }

  // State that points at sessions which no longer exist.
  const dangling = (label, rows) => {
    const ids = [...new Set(rows.map(r => r.sessionId).filter(id => id && !sessionIds.has(id)))];
    if (ids.length) add('warn', 'sessions', `${label} reference ${ids.length} deleted session(s): ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}`);
  };
  dangling('input rows', state.input.filter(r => ACTIVE_INPUT.has(r.state)));
  dangling('Compact & Resume tickets', state.continuations);
  dangling('goal replies', state.goalReplies);
  dangling('request correlations', state.correlations);

  // Compact & Resume tickets.
  for (const t of state.continuations) {
    const age = minutes(now - (t.touchedAt ?? t.openedAt ?? now));
    if (!CLOSED_TICKET.has(t.state)) {
      add('warn', 'compact', `open ticket in "${t.state}" for session ${t.sessionId}, ${t.from} -> ${t.to ?? '(no destination yet)'}, last touched ${age} ago`);
    } else if (t.state === 'committed' && t.to && sessionIds.has(t.sessionId)) {
      const owner = sessionOfChat.get(t.to);
      if (!owner || owner.id !== t.sessionId) add('warn', 'compact', `committed ticket moved session ${t.sessionId} to ${t.to}, but no session lists that chat`);
    }
  }
  const open = state.continuations.filter(t => !CLOSED_TICKET.has(t.state)).length;
  add('info', 'compact', `${state.continuations.length} ticket(s), ${open} open`);

  // Bridge commands waiting for the extension.
  for (const cmd of state.bridge.commands ?? []) {
    const age = now - (cmd.createdAt ?? cmd.queuedAt ?? now);
    if (age >= stuckMs) add('warn', 'bridge', `command ${cmd.id ?? '?'} (${cmd.type ?? cmd.kind ?? 'unknown'}) pending for ${minutes(age)}`);
  }

  // Eva identity pointer.
  const pointer = state.identity?.conversationId ?? null;
  if (!pointer) add('warn', 'identity', 'no Eva identity pointer (state/agent-identity.json)');
  else {
    const owner = sessionOfChat.get(pointer);
    if (!owner) add('warn', 'identity', `identity points at chat ${pointer}, which no session owns`);
    else add(owner.endedAt ? 'warn' : 'info', 'identity', `identity -> ${pointer} in session ${owner.id} "${owner.title}"${owner.endedAt ? ' (session ended)' : ''}${owner.conversationId !== pointer ? ` (session's current chat is ${owner.conversationId})` : ''}`);
    const swarmPointer = state.swarm?.currentAgentConversationId;
    if (swarmPointer && swarmPointer !== pointer) add('warn', 'identity', `swarm.json points at ${swarmPointer}, agent-identity.json at ${pointer}`);
  }
  return findings;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
  const dataDir = option('data') ?? (process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'paradigmeve')
    : path.join(os.homedir(), '.config', 'paradigmeve'));
  if (!existsSync(path.join(dataDir, 'state'))) { console.error(`no Eve state under ${dataDir}`); process.exit(2); }
  const state = loadState(dataDir);
  const findings = diagnose(state, { stuckMs: Number(option('stuck-minutes') ?? 10) * 60_000 });
  const pid = state.running?.pid;
  findings.unshift({ level: 'info', area: 'app', message: pid && processAlive(pid) ? `Eve running (pid ${pid}); ${state.sessions.length} session(s)` : `Eve not running; ${state.sessions.length} session(s)` });
  if (args.includes('--json')) console.log(JSON.stringify({ dataDir, findings }, null, 2));
  else {
    console.log(`Eve doctor: ${dataDir}`);
    for (const f of findings) console.log(`${f.level === 'warn' ? 'WARN' : ' ok '}  ${f.area.padEnd(8)} ${f.message}`);
    const warnings = findings.filter(f => f.level === 'warn').length;
    console.log(warnings ? `\n${warnings} item(s) need attention.` : '\nNothing needs attention.');
  }
  process.exit(findings.some(f => f.level === 'warn') ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
