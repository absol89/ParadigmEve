import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDurableStore, readDurableStrict, resetDurableForTests } from '../src/main/durable.js';
import {
  admitWorkerExecution,
  resetWorkerExecutionReceiptsForTests,
  settleWorkerExecution,
  type WorkerExecutionIdentity
} from '../src/main/session/recorder.js';
import type { WorkerExecutionReceipt } from '../src/shared/session.js';

describe('durable exact-worker effect receipts', () => {
  let directory: string;
  const identity = (overrides: Partial<WorkerExecutionIdentity> = {}): WorkerExecutionIdentity => ({
    conversationId: 'conversation-a',
    sessionId: 'session-a',
    principalKind: 'chatgpt',
    workerId: 'worker-65',
    runId: 'run-a',
    invocationId: 'request-a',
    tool: 'exec_command',
    args: { cmd: 'single-effect', workdir: '/projects/repo' },
    ...overrides
  });
  const saved = () => readDurableStrict<WorkerExecutionReceipt[]>('worker-execution-receipts');

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-worker-receipt-'));
    resetDurableForTests();
    resetWorkerExecutionReceiptsForTests();
    initDurableStore(directory);
  });
  afterEach(async () => {
    resetWorkerExecutionReceiptsForTests();
    resetDurableForTests();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('rejects unknown conversation/session/worker/run/invocation before effect and writes nothing', async () => {
    for (const field of ['conversationId', 'sessionId', 'workerId', 'runId', 'invocationId'] as const) {
      expect(await admitWorkerExecution(identity({ [field]: '' }))).toMatchObject({ accepted: false });
    }
    expect(await saved()).toBeNull();
  });

  it('persists intent before effect and settles only one authoritative outcome', async () => {
    const admitted = await admitWorkerExecution(identity());
    expect(admitted.accepted).toBe(true);
    if (!admitted.accepted) return;
    expect((await saved())?.[0]).toMatchObject({ id: admitted.id, state: 'admitted' });
    await settleWorkerExecution(admitted.id, 'completed', 'ok', 'result-sha256');
    expect((await saved())?.[0]).toMatchObject({
      state: 'completed', outcome: 'ok', resultDigest: 'result-sha256'
    });
    expect(await admitWorkerExecution(identity())).toMatchObject({
      accepted: false, reason: 'WORKER_RECEIPT_ALREADY_COMPLETED'
    });
    await expect(settleWorkerExecution(admitted.id, 'completed', 'ok')).rejects.toThrow('NOT_ADMITTED');
  });

  it('rejects recycled worker identity with a stale invocation even under a new run', async () => {
    expect((await admitWorkerExecution(identity())).accepted).toBe(true);
    expect(await admitWorkerExecution(identity({ runId: 'run-b' }))).toMatchObject({
      accepted: false, reason: 'WORKER_RECEIPT_STALE_INVOCATION'
    });
    // A genuinely new run with a new invocation is a distinct principal.
    expect((await admitWorkerExecution(identity({ runId: 'run-b', invocationId: 'request-b' }))).accepted).toBe(true);
  });

  it('admits an exact app-owned local worker without inventing a ChatGPT conversation or recorded session', async () => {
    const local = identity({
      principalKind: 'local-agent', conversationId: null, sessionId: null,
      runId: 'local-run', invocationId: 'app-issued-1'
    });
    const admitted = await admitWorkerExecution(local);
    expect(admitted.accepted).toBe(true);
    expect((await saved())?.[0]).toMatchObject({
      principalKind: 'local-agent', conversationId: null, sessionId: null, runId: 'local-run'
    });
    resetWorkerExecutionReceiptsForTests();
    expect(await admitWorkerExecution({ ...local, invocationId: 'app-issued-2' })).toMatchObject({
      accepted: false, reason: 'WORKER_RECEIPT_EFFECT_UNKNOWN'
    });
    expect(await admitWorkerExecution({ ...local, principalKind: 'chatgpt' })).toMatchObject({ accepted: false });
  });

  it('refuses a duplicate after an ambiguous effect even with a fresh request id', async () => {
    const first = await admitWorkerExecution(identity());
    if (!first.accepted) throw new Error('expected admission');
    await settleWorkerExecution(first.id, 'unknown', 'tool_execution_error');
    expect(await admitWorkerExecution(identity({ invocationId: 'request-retry' }))).toMatchObject({
      accepted: false, reason: 'WORKER_RECEIPT_EFFECT_UNKNOWN'
    });
    expect((await saved())?.length).toBe(1);
  });

  it('reconciles a crash between effect and result as unknown without replaying it', async () => {
    expect((await admitWorkerExecution(identity())).accepted).toBe(true);
    // Simulate process-memory loss, not a second dispatch or a successful result.
    resetWorkerExecutionReceiptsForTests();
    expect(await admitWorkerExecution(identity({ invocationId: 'request-retry' }))).toMatchObject({
      accepted: false, reason: 'WORKER_RECEIPT_EFFECT_UNKNOWN'
    });
    expect((await saved())?.[0]?.state).toBe('unknown');
  });

  it('keeps a pre-dispatch refusal distinct from an unknown external effect', async () => {
    // An upstream ChatGPT approval refusal that never reaches Eve has no
    // fabricated receipt. A locally admitted operation refused before effect
    // may be settled as refused only by its authoritative owner.
    expect(await saved()).toBeNull();
    const first = await admitWorkerExecution(identity());
    if (!first.accepted) throw new Error('expected admission');
    await settleWorkerExecution(first.id, 'refused', 'tool_rejected');
    expect((await saved())?.[0]?.state).toBe('refused');
    expect((await admitWorkerExecution(identity({ invocationId: 'new-invocation' }))).accepted).toBe(true);
  });

  it('fails closed when the durable receipt file is corrupt instead of overwriting it', async () => {
    await fs.mkdir(path.join(directory, 'state'), { recursive: true });
    const file = path.join(directory, 'state', 'worker-execution-receipts.json');
    await fs.writeFile(file, '{torn', 'utf8');
    await expect(admitWorkerExecution(identity())).rejects.toThrow('Could not read');
    expect(await fs.readFile(file, 'utf8')).toBe('{torn');
  });
});
