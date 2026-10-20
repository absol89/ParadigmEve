/**
 * The Activity log: a bounded in-memory ring for the diagnostics panel, mirrored to one
 * bounded file so a run can still be read after the app has quit.
 *
 * Callers are responsible for not passing secrets; as a backstop, anything that looks like
 * an OpenAI key or a tunnel token is masked before it is stored, so a mistake upstream
 * cannot leak a credential into the UI or the file.
 *
 * A line written while a tool call is running inherits that call's agent, which is what
 * makes the per-agent Activity filter mean anything. Lines written outside a call —
 * startup, the tunnel, the servers — stay unattributed, because they genuinely are.
 *
 * The file exists because the 2026-09-02 compaction failure had to be reconstructed from
 * session logs and durable state alone: the five hundred lines in memory were gone with the
 * process, and they were the only record of what the bridge decided and why.
 */

import { promises as fs, statSync, writeFileSync } from 'node:fs';
import type { LogEntry } from '../shared/types.js';
import { currentAgent } from './mcp/call-context.js';

const MAX_ENTRIES = 500;
/** One rotation keeps the previous file, so the last two of these are always on disk. */
const MAX_LOG_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = 64 * 1024;
/** How far a log that cannot rotate may grow before new lines wait for rotation instead. */
const MAX_UNROTATED_BYTES = 2 * MAX_LOG_FILE_BYTES;
/** Retry delays after a failed write, doubling from the first to the last. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 60_000;

const entries: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

interface FileMirror {
  file: string;
  bytes: number;
  pending: string[];
  pendingBytes: number;
  dropped: number;
  work: Promise<void> | null;
  /** The last write failure; cleared by the next successful write. */
  error: unknown;
  /** Failed attempts in a row: sets the retry delay, and one crash snapshot per streak. */
  failures: number;
  retry: NodeJS.Timeout | null;
  /** Appends that failed part-way; the next write says so before the cut line follows in full. */
  cutWrites: number;
  /** Rotation failed and the file grows past its limit; said once in the file until it rotates. */
  rotationNoted: boolean;
}
let mirror: FileMirror | null = null;

/**
 * Mirrors every line from here on to `file`, rotating it once to `file.1` when it fills.
 *
 * Normal writes are ordered asynchronous batches. Teardown explicitly flushes; fatal
 * failure uses a separate bounded synchronous snapshot, never racing the live file writer.
 */
export function initLogFile(file: string): void {
  let bytes = 0;
  try {
    bytes = statSync(file).size;
  } catch { /* A first run has no log yet. */ }
  if (mirror?.retry) clearTimeout(mirror.retry);
  mirror = {
    file, bytes, pending: [], pendingBytes: 0, dropped: 0, work: null, error: null,
    failures: 0, retry: null, cutWrites: 0, rotationNoted: false
  };
}

function boundedText(text: string): string {
  const prefix = text.slice(0, MAX_LINE_BYTES);
  if (prefix.length === text.length && Buffer.byteLength(prefix, 'utf8') <= MAX_LINE_BYTES) return text;
  return Buffer.from(prefix, 'utf8').subarray(0, MAX_LINE_BYTES - 64).toString('utf8') + ' [log text truncated]';
}

function formatEntry(entry: LogEntry): string {
  return `${new Date(entry.time).toISOString()}  ${entry.level.padEnd(5)}  ${entry.agent ? `[${entry.agent}] ` : ''}${entry.message}\n`;
}

async function fileSize(file: string): Promise<number | null> {
  try { return (await fs.stat(file)).size; } catch { return null; }
}

/** The notes at the head of a batch reached the file; counts that grew meanwhile still get a note. */
function settleNotes(state: FileMirror, droppedNoted: number, cutsNoted: number, rotationNote: boolean): void {
  state.dropped -= droppedNoted;
  state.cutWrites -= cutsNoted;
  if (rotationNote) state.rotationNoted = true;
}

/**
 * Writes queued lines in order. A failed write never loses or repeats a line and never stops the
 * log for the rest of the run: what did not reach the file goes back to the front of the queue (a
 * line an append cut off is written again in full, after a note saying so), and the writer tries
 * again with a growing delay. A log that cannot rotate (on Windows: another program holds it open
 * without delete sharing, or something sits where the old log goes) grows to twice its limit and
 * says so once; past that, lines wait in the bounded queue for rotation.
 */
function startWriter(state: FileMirror): void {
  if (state.work || state.retry || (!state.pending.length && !state.dropped && !state.cutWrites)) return;
  state.work = Promise.resolve().then(async () => {
    while (state.pending.length || state.dropped || state.cutWrites) {
      const lines: string[] = [];
      let bytes = 0;
      while (state.pending.length) {
        const line = state.pending[0]!;
        const size = Buffer.byteLength(line, 'utf8');
        if (bytes && bytes + size > MAX_BATCH_BYTES) break;
        state.pending.shift();
        state.pendingBytes -= size;
        lines.push(line);
        bytes += size;
      }
      const cutsNoted = state.cutWrites;
      const droppedNoted = lines.length ? 0 : state.dropped;
      let notes = '';
      // The leading newline ends the fragment the cut left behind, so the note starts its own line.
      if (cutsNoted) notes += `\n${new Date().toISOString()}  warn   ${cutsNoted} log write(s) failed part-way: the cut-off line above follows again in full.\n`;
      if (droppedNoted) notes += `${new Date().toISOString()}  warn   ${droppedNoted} log line(s) omitted: file writer backlog exceeded its byte limit.\n`;
      let rotationNote = false;
      try {
        if (state.bytes && state.bytes + Buffer.byteLength(notes, 'utf8') + bytes > MAX_LOG_FILE_BYTES) {
          try {
            await fs.rename(state.file, `${state.file}.1`);
            state.bytes = 0;
            state.rotationNoted = false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              // The log is already gone; the append below starts a fresh one.
              state.bytes = 0;
              state.rotationNoted = false;
            } else {
              if (state.bytes + Buffer.byteLength(notes, 'utf8') + bytes > MAX_UNROTATED_BYTES) throw error;
              if (!state.rotationNoted) {
                notes = `${new Date().toISOString()}  warn   log rotation failed (${boundedText(redact(String(error))).slice(0, 300)}); writing on into this file until it can rotate.\n${notes}`;
                rotationNote = true;
              }
            }
          }
        }
        const prefix = Buffer.byteLength(notes, 'utf8');
        const size = prefix + bytes;
        const before = state.bytes;
        try {
          await fs.appendFile(state.file, notes + lines.join(''), 'utf8');
          state.bytes = before + size;
        } catch (error) {
          // A rejected append may still have written some or all of the batch: measure, never guess.
          const now = await fileSize(state.file);
          const written = now === null ? 0 : Math.max(0, now - before);
          if (written < size) {
            if (written > 0) {
              state.bytes = now!;
              if (written >= prefix) settleNotes(state, droppedNoted, cutsNoted, rotationNote);
              // Whole lines on disk are done; the cut one and the rest go back to the queue.
              let offset = prefix;
              while (lines.length && offset + Buffer.byteLength(lines[0]!, 'utf8') <= written) {
                const done = Buffer.byteLength(lines.shift()!, 'utf8');
                offset += done;
                bytes -= done;
              }
              if (written !== offset) state.cutWrites += 1;
            }
            throw error;
          }
          state.bytes = now!;
        }
        settleNotes(state, droppedNoted, cutsNoted, rotationNote);
        state.error = null;
        state.failures = 0;
      } catch (error) {
        // The batch goes back to the front, in order. The queue may briefly hold one batch more
        // than its limit, when new lines filled it while this batch was out.
        state.pending.unshift(...lines);
        state.pendingBytes += bytes;
        state.error = error;
        state.failures += 1;
        // No recursive logging and no synchronous writes on the ordinary call path; one snapshot
        // per failure streak, so the retries after it stay quiet.
        if (state.failures === 1) writeCrashSnapshot(state, `log file writer failed: ${String(error)}`);
        const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (state.failures - 1));
        state.retry = setTimeout(() => { state.retry = null; startWriter(state); }, delay);
        state.retry.unref?.();
        return;
      }
    }
  }).finally(() => {
    state.work = null;
    startWriter(state);
  });
}

function mirrorToFile(entry: LogEntry): void {
  const state = mirror;
  if (!state) return;
  const line = formatEntry(entry);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (state.pendingBytes + bytes > MAX_PENDING_BYTES) {
    state.dropped = Math.min(Number.MAX_SAFE_INTEGER, state.dropped + 1);
  } else {
    state.pending.push(line);
    state.pendingBytes += bytes;
  }
  startWriter(state);
}

/** Includes lines accepted while an earlier batch was being written. */
export async function flushLogFile(): Promise<void> {
  const state = mirror;
  if (!state) return;
  // A flush wants the lines on disk now, not after the retry delay.
  if (state.retry) { clearTimeout(state.retry); state.retry = null; }
  startWriter(state);
  while (state.work) await state.work;
  // Set only while the last attempt failed, so something is still waiting.
  if (state.error) throw state.error;
}

function writeCrashSnapshot(state: FileMirror, reason: string): void {
  const lines = [formatEntry({ time: Date.now(), level: 'error', message: boundedText(redact(reason)) })];
  let bytes = Buffer.byteLength(lines[0]!, 'utf8');
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = formatEntry(entries[i]!);
    const size = Buffer.byteLength(line, 'utf8');
    if (bytes + size > MAX_PENDING_BYTES) break;
    lines.splice(1, 0, line);
    bytes += size;
  }
  try {
    writeFileSync(`${state.file}.crash`, lines.join(''), 'utf8');
  } catch { /* The reporting channel cannot report its own storage failure. */ }
}

/** Fatal diagnostics only; does not install an exception handler or suppress a crash. */
export function snapshotLogOnCrash(reason: string): void {
  if (mirror) writeCrashSnapshot(mirror, reason);
}

/** Final exit barrier, including the shutdown sequence's last line. */
export async function flushLogBeforeExit(timeoutMs = 2_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      flushLogFile(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('log flush deadline exceeded')), timeoutMs);
        timer.unref?.();
      })
    ]);
  } catch (error) {
    snapshotLogOnCrash(`final log flush failed: ${String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test seam; callers must finish outstanding file writes first. */
export function resetLoggerForTests(): void {
  if (mirror?.retry) clearTimeout(mirror.retry);
  mirror = null;
  entries.length = 0;
  listeners.clear();
}

/** Masks anything shaped like a credential, wherever it appears in a message. */
export function redact(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\btunnel_[0-9a-f]{32}\b/g, 'tunnel_***')
    .replace(/\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, '***jwt***')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (match) =>
      // Long opaque strings are tokens far more often than they are prose.
      /^[A-Za-z0-9_-]+$/.test(match) ? '***' : match
    );
}

/**
 * Opt-in console echo for troubleshooting a start-up that never reaches the UI.
 * Off unless CLF_DEBUG=1, so logs are not exposed by default, and it prints the
 * redacted text so enabling it can never surface a credential.
 */
const ECHO_TO_CONSOLE = process.env['CLF_DEBUG'] === '1';

export function log(level: LogEntry['level'], message: string): void {
  const agent = currentAgent();
  const entry: LogEntry = {
    time: Date.now(),
    level,
    message: boundedText(redact(message)),
    ...(agent ? { agent: boundedText(redact(agent)).slice(0, 200) } : {})
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  mirrorToFile(entry);
  if (ECHO_TO_CONSOLE) process.stderr.write(`[${level}] ${entry.message}\n`);
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // Writing a log line must never be able to break the code that wrote it. Listeners run
      // synchronously on the caller's stack, and the one that matters here reaches the
      // renderer — which can already be gone while teardown is still logging its own progress.
      // A throw from there used to propagate into the shutdown step doing the logging and kill
      // it outright; that is how a force-close timer stopped forcing anything and left the app
      // draining a half-closed socket forever. There is nowhere useful to report this: the log
      // is the reporting channel.
    }
  }
}

export const logInfo = (message: string): void => log('info', message);
export const logWarn = (message: string): void => log('warn', message);
export const logError = (message: string): void => log('error', message);

export function getLog(): LogEntry[] {
  return [...entries];
}

export function onLog(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatLogForClipboard(): string {
  return entries
    .map((e) => `${new Date(e.time).toISOString()}  ${e.level.padEnd(5)}  ${e.message}`)
    .join('\n');
}

/** Machine-readable diagnostics export. Messages are already redacted on insertion. */
export function formatLogAsJson(): string {
  return JSON.stringify(
    entries.map((e) => ({
      time: new Date(e.time).toISOString(),
      level: e.level,
      message: e.message
    })),
    null,
    2
  );
}
