/**
 * Production executor for one-shot Ollama workers.
 *
 * The durable broker owns worker identity/lifecycle. This module owns only the process-local
 * model/tool loop for workers whose frozen backend is `ollama`. There is deliberately no
 * provider conversation to revive: a completed local worker is terminal, and a process restart
 * fails any in-flight local worker visibly instead of inventing a resumable transcript.
 */

import {
  activateWorkerExecutionPrincipal,
  failAgent,
  finishAgent,
  issueWorkerExecutionPrincipal,
  onExecutorReviveRequest,
  onExecutorSpawnRequest,
  revokeWorkerExecutionPrincipal,
  snapshotSwarm,
  type WorkerSpawn
} from './agents.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { localAgentCoreTools } from './local-agent-tools.js';
import { runLocalAgent } from './local-agent-runtime.js';
import { createOllamaAgentModelRuntime } from './ollama-agent-runtime.js';
import { ensureOllamaModel, resolveOllamaEndpoint } from './ollama-client.js';
import { logInfo, logWarn } from './logger.js';
import type { ToolContext } from './mcp/kernel.js';

const inFlight = new Map<string, AbortController>();

function key(runId: string, agentId: string): string {
  return `${runId}:${agentId}`;
}

function coreContext(): ToolContext {
  const config = getConfig();
  return {
    roots: config.roots,
    caps: effectiveCapabilities(config),
    readOnly: config.readOnly,
    privacyScreenshots: config.ui.privacyScreenshots,
    // Local workers must never gain the broker itself and recursively create another worker.
    agentTools: false,
    sessionTools: false,
    exposedFinishTool: false
  };
}

function failureNote(worker: WorkerSpawn, reason: string): string {
  return `[${worker.id} failed] Ollama worker execution failed before it could report a result: ${reason}. ` +
    'No fallback backend was used.';
}

async function execute(worker: WorkerSpawn): Promise<void> {
  const runKey = key(worker.runId, worker.id);
  if (inFlight.has(runKey)) return;

  const controller = new AbortController();
  inFlight.set(runKey, controller);
  const principal = issueWorkerExecutionPrincipal(worker.runId, worker.id);
  if (!principal || principal.backend !== 'ollama' || !activateWorkerExecutionPrincipal(principal)) {
    inFlight.delete(runKey);
    failAgent(
      worker.id,
      'The broker could not issue and activate exact Ollama worker authority.',
      failureNote(worker, 'The broker could not issue and activate exact Ollama worker authority.'),
      { revivable: false },
      worker.runId
    );
    return;
  }

  try {
    const settings = getConfig().agentRuntime.ollama;
    await ensureOllamaModel(settings.model);
    const tools = localAgentCoreTools(coreContext, principal);
    const result = await runLocalAgent({
      backend: 'ollama',
      principal,
      endpoint: resolveOllamaEndpoint(settings.endpoint) ?? settings.endpoint,
      model: settings.model,
      system:
        'You are a bounded ParadigmEve worker. Complete only the task you were given. ' +
        'Use the available local tools when useful, never invent tool results, and return a concise factual result to the owning agent. ' +
        'You cannot create workers of your own.',
      task: worker.task,
      tools,
      runtime: createOllamaAgentModelRuntime(),
      signal: controller.signal
    });
    const finished = finishAgent({ localPrincipal: principal }, result.final);
    logInfo(
      `multi-agent: ${worker.id} completed in Ollama runtime (${result.turns} turn(s), ${result.toolCalls} tool call(s)); state=${finished.info.state}`
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = failAgent(
      worker.id,
      reason,
      failureNote(worker, reason),
      { revivable: false },
      worker.runId
    );
    if (failed) logWarn(`multi-agent: ${worker.id} Ollama execution failed: ${reason}`);
  } finally {
    revokeWorkerExecutionPrincipal(principal);
    if (inFlight.get(runKey) === controller) inFlight.delete(runKey);
  }
}

/**
 * Registers the Ollama executor after broker restore. Registration replays invited workers that
 * were durably accepted before a crash. Workers that had already started cannot be resumed
 * because the model transcript is process-local, so retire those exact rows visibly first.
 */
export function startOllamaWorkerExecutor(): () => void {
  const snapshot = snapshotSwarm();
  for (const run of snapshot?.activeRuns ?? []) {
    for (const row of run.agents) {
      if (row.backend !== 'ollama' || row.info.role !== 'worker') continue;
      if (!['active', 'waking', 'detached'].includes(row.info.state)) continue;
      failAgent(
        row.info.id,
        'ParadigmEve restarted while this one-shot Ollama worker was running, so its local model transcript cannot be resumed.',
        `[${row.info.id} failed] ParadigmEve restarted while this one-shot Ollama worker was running. ` +
          'Its local model transcript is intentionally not reconstructed; spawn a replacement if the task is still needed.',
        { revivable: false },
        run.runId
      );
    }
  }

  const dropSpawn = onExecutorSpawnRequest('ollama', (workers) => {
    for (const worker of workers) void execute(worker);
  });
  const dropRevive = onExecutorReviveRequest('ollama', (revivals) => {
    for (const revival of revivals) {
      failAgent(
        revival.id,
        'Ollama workers are one-shot and cannot be revived after completion.',
        `[${revival.id} failed] This Ollama worker cannot be revived because local worker transcripts are one-shot. Spawn a new worker instead.`,
        { revivable: false },
        revival.runId
      );
    }
  });

  return () => {
    dropSpawn();
    dropRevive();
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
  };
}

/** Test seam. */
export function resetOllamaWorkerExecutorForTests(): void {
  for (const controller of inFlight.values()) controller.abort();
  inFlight.clear();
}
