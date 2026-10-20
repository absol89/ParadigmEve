import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  flushLogBeforeExit, flushLogFile, getLog, initLogFile, logInfo,
  onLog, resetLoggerForTests, snapshotLogOnCrash
} from '../src/main/logger.js';
import { runShutdownSequence } from '../src/main/shutdown.js';

const cleanup: string[] = [];
afterEach(async () => {
  await flushLogFile().catch(() => undefined);
  vi.restoreAllMocks();
  resetLoggerForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function logFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-logger-'));
  cleanup.push(dir);
  const file = path.join(dir, 'app.log');
  initLogFile(file);
  return file;
}

describe('bounded asynchronous diagnostic mirror', () => {
  it('returns immediately during slow IO, preserving file order and listeners', async () => {
    const file = await logFile();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realAppend = fs.appendFile.bind(fs);
    const append = vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return realAppend(...args);
    });
    const messages: string[] = [];
    onLog(entry => messages.push(entry.message));
    logInfo('first');
    await blocked;
    logInfo('second');
    logInfo('third');
    expect(messages).toEqual(['first', 'second', 'third']);
    expect(append).toHaveBeenCalledTimes(1);
    release();
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'));
    expect(append).toHaveBeenCalledTimes(2);
  });

  it('rotates serially and keeps both files bounded', async () => {
    const file = await logFile();
    await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024));
    initLogFile(file);
    logInfo('after rotation');
    await flushLogFile();
    expect((await fs.stat(`${file}.1`)).size).toBe(4 * 1024 * 1024);
    expect(await fs.readFile(file, 'utf8')).toContain('after rotation');
  });

  it('bounds queued bytes and individual ring entries and records overload', async () => {
    const file = await logFile();
    // All calls happen in one turn, before the writer can consume its first batch.
    for (let i = 0; i < 600; i++) logInfo(`${i}: ${'🙂 '.repeat(20_000)}`);
    expect(getLog()).toHaveLength(500);
    expect(getLog().every(entry => Buffer.byteLength(entry.message) <= 16 * 1024)).toBe(true);
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThan(257 * 1024);
    expect(text).toContain('log line(s) omitted');
    expect(text).toContain('[log text truncated]');
  });

  it('redacts the normal and synchronous fatal snapshots without touching the writer', async () => {
    const file = await logFile();
    logInfo('credential sk-secret123456789');
    snapshotLogOnCrash('uncaught: sk-secret123456789');
    await flushLogFile();
    for (const target of [file, `${file}.crash`]) {
      const text = await fs.readFile(target, 'utf8');
      expect(text).not.toContain('secret123456789');
      expect(text).toContain('sk-***');
    }
  });

  it('isolates file errors, saves forensic context once, and writes the failed batch on the next attempt', async () => {
    const file = await logFile();
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk failure'));
    expect(() => logInfo('before failure')).not.toThrow();
    await vi.waitFor(async () => expect(await fs.readFile(`${file}.crash`, 'utf8')).toContain('disk failure'));
    expect(await fs.readFile(`${file}.crash`, 'utf8')).toContain('before failure');
    expect(() => logInfo('UI still works')).not.toThrow();
    // Nothing reached the file, so a flush retries at once and writes both lines, in order, once.
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(text.split('before failure')).toHaveLength(2);
    expect(text.indexOf('UI still works')).toBeGreaterThan(text.indexOf('before failure'));
  });

  it('retries a failed write by itself after a short delay, without a flush', async () => {
    const file = await logFile();
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('busy'));
    logInfo('written by the retry');
    await vi.waitFor(
      async () => expect(await fs.readFile(file, 'utf8').catch(() => '')).toContain('written by the retry'),
      { timeout: 3_000, interval: 50 }
    );
  });

  it('keeps every line when rotation cannot rename the full log, says so once, and rotates once it can', async () => {
    const file = await logFile();
    await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024));
    // A real rename failure on every platform: a directory sits where the old log would go.
    await fs.mkdir(`${file}.1`);
    initLogFile(file);
    logInfo('while the old log is in the way');
    await flushLogFile();
    logInfo('still writing');
    await flushLogFile();
    const grown = await fs.readFile(file, 'utf8');
    expect(grown).toContain('while the old log is in the way');
    expect(grown).toContain('still writing');
    expect(grown.split('log rotation failed')).toHaveLength(2);
    await fs.rmdir(`${file}.1`);
    logInfo('rotated at last');
    await flushLogFile();
    expect(await fs.readFile(`${file}.1`, 'utf8')).toContain('still writing');
    expect(await fs.readFile(file, 'utf8')).toContain('rotated at last');
  });

  it('holds lines in order while a log far past its limit cannot rotate, then writes each once', async () => {
    const file = await logFile();
    await fs.writeFile(file, 'x'.repeat(8 * 1024 * 1024));
    await fs.mkdir(`${file}.1`);
    initLogFile(file);
    logInfo('first held'); logInfo('second held');
    await expect(flushLogFile()).rejects.toThrow();
    expect((await fs.stat(file)).size).toBe(8 * 1024 * 1024);
    await fs.rmdir(`${file}.1`);
    logInfo('third');
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(text.split('first held')).toHaveLength(2);
    expect(text.indexOf('first held')).toBeLessThan(text.indexOf('second held'));
    expect(text.indexOf('second held')).toBeLessThan(text.indexOf('third'));
  });

  it('rewrites a line an append cut off after a note, and repeats or loses no line', async () => {
    const file = await logFile();
    const realAppend = fs.appendFile.bind(fs);
    logInfo('reached the file before the cut');
    await flushLogFile();
    vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (target, data) => {
      const text = String(data);
      // The first line of the batch lands whole, the second only in part.
      await realAppend(target, text.slice(0, text.indexOf('\n') + 1 + 20));
      throw new Error('short write');
    });
    logInfo('first in the batch'); logInfo('cut off part-way'); logInfo('never started');
    await vi.waitFor(async () => expect(await fs.readFile(`${file}.crash`, 'utf8').catch(() => '')).toContain('short write'));
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    for (const line of ['reached the file before the cut', 'first in the batch', 'cut off part-way', 'never started']) {
      expect(text.split(line), line).toHaveLength(2);
    }
    expect(text.indexOf('first in the batch')).toBeLessThan(text.indexOf('failed part-way'));
    expect(text.indexOf('failed part-way')).toBeLessThan(text.indexOf('cut off part-way'));
    expect(text.indexOf('cut off part-way')).toBeLessThan(text.indexOf('never started'));
    // The note starts its own line after the fragment.
    expect(text.split('\n').find(l => l.includes('failed part-way'))).toMatch(/^\d{4}-/);
  });

  it('treats an append that rejected after landing whole as written, without repeating it', async () => {
    const file = await logFile();
    const realAppend = fs.appendFile.bind(fs);
    vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (target, data) => {
      await realAppend(target, data);
      throw new Error('late failure');
    });
    logInfo('landed despite the error');
    await vi.waitFor(async () => expect(await fs.readFile(file, 'utf8').catch(() => '')).toContain('landed despite the error'));
    logInfo('next');
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(text.split('landed despite the error')).toHaveLength(2);
    expect(text).not.toContain('failed part-way');
  });

  it.skipIf(process.platform !== 'win32')('keeps logging while another program holds app.log without delete sharing, then rotates', async () => {
    const file = await logFile();
    await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024));
    initLogFile(file);
    // A log viewer: the file open for reading and writing, but not shared for delete or rename.
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','ReadWrite','ReadWrite'); ` +
      `Write-Output locked; [void][Console]::In.ReadLine(); $f.Close()`]);
    const exited = new Promise<void>(resolve => holder.on('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on('data', d => { if (String(d).includes('locked')) resolve(); });
        holder.on('exit', () => reject(new Error('lock holder exited early')));
      });
      await expect(fs.rename(file, `${file}.probe`)).rejects.toThrow();
      logInfo('while a viewer holds the log');
      await flushLogFile();
      const during = await fs.readFile(file, 'utf8');
      expect(during).toContain('while a viewer holds the log');
      expect(during).toContain('log rotation failed');
    } finally {
      holder.stdin.end();
      await exited;
    }
    logInfo('after the viewer closed it');
    await flushLogFile();
    expect(await fs.readFile(`${file}.1`, 'utf8')).toContain('while a viewer holds the log');
    expect(await fs.readFile(file, 'utf8')).toContain('after the viewer closed it');
  }, 20_000);

  it('includes the final shutdown line before completing the exit barrier', async () => {
    const file = await logFile();
    let finalFlush: Promise<void> | undefined;
    await runShutdownSequence([], {
      info: logInfo, warn: logInfo, error: logInfo,
      exit: () => { finalFlush = flushLogBeforeExit(); }
    });
    await finalFlush;
    expect(await fs.readFile(file, 'utf8')).toContain('shutdown sequence complete');
  });

  it('bounds exit waiting and snapshots recent lines when the asynchronous writer is stuck', async () => {
    const file = await logFile();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realAppend = fs.appendFile.bind(fs);
    vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args) => {
      await gate;
      return realAppend(...args);
    });
    logInfo('last forensic line');
    try {
      await flushLogBeforeExit(10);
      const crash = await fs.readFile(`${file}.crash`, 'utf8');
      expect(crash).toContain('last forensic line');
      expect(crash).toContain('deadline exceeded');
      expect(Buffer.byteLength(crash)).toBeLessThanOrEqual(256 * 1024);
    } finally { release(); }
    await flushLogFile();
  });
});
