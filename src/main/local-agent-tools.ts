/**
 * In-process Core tool adapter for app-owned local workers.
 *
 * The model gets only schemas for tools the current Core registrar actually exposes. Every
 * invocation rebuilds that registrar from live settings, so permission/root/read-only changes
 * take effect before execution. The broker-issued principal stays out of model arguments.
 */

import { agentForCaller } from './agents.js';
import type { LocalAgentExecutionPrincipal, LocalAgentTool, LocalAgentToolResult } from './local-agent-runtime.js';
import { createRegistrar, type ToolContext, type ToolResult } from './mcp/kernel.js';
import { emptyEvidence, type CallContext } from './mcp/call-context.js';
import { toolSchemaJson } from './mcp/tool-declarations.js';
import { registerCoreTools } from './mcp/tools-core.js';
import { getConfig } from './config.js';
import { createSession } from './session/store.js';
import { AGENT_BACKEND_LABELS } from '../shared/agent-backends.js';

const LOCAL_CORE_TOOL_NAMES = new Set([
  'read',
  'find',
  'apply_patch',
  'exec_command',
  'write_stdin'
]);

const localRecordingSessions = new Map<string, Promise<string>>();

async function localRecordingSession(principal: LocalAgentExecutionPrincipal): Promise<string | null> {
  if (!getConfig().sessions.record) return null;
  const key = `${principal.runId}:${principal.agentId}`;
  const existing = localRecordingSessions.get(key);
  if (existing) return existing;
  const creating = createSession({
    title: `${principal.agentId} · ${AGENT_BACKEND_LABELS[principal.backend]}`
  }).then((session) => session.id);
  localRecordingSessions.set(key, creating);
  try {
    return await creating;
  } catch (error) {
    if (localRecordingSessions.get(key) === creating) localRecordingSessions.delete(key);
    throw error;
  }
}

function localResult(result: ToolResult): LocalAgentToolResult {
  const text: string[] = [];
  let unsupported = false;
  for (const part of result.content) {
    if (part.type === 'text') text.push(part.text);
    else unsupported = true;
  }
  if (unsupported) {
    text.push('LOCAL_AGENT_UNSUPPORTED_RESULT: this tool returned non-text content that the local runtime does not expose yet.');
  }
  return {
    content: text.join('\n').trim() || (result.isError ? 'Tool call failed.' : 'Tool call completed.'),
    isError: result.isError === true || unsupported
  };
}

function parentContext(principal: LocalAgentExecutionPrincipal, agent: string, sessionId: string | null): CallContext {
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent,
    caller: {
      transportKey: null,
      requestId: null,
      conversationId: null,
      sessionId,
      localPrincipal: principal
    },
    outcome: null,
    evidence: emptyEvidence()
  };
}

/**
 * Builds the currently-authorized text Core surface for one exact broker local worker.
 * Returning an empty list is intentional fail-closed behaviour when the principal is stale.
 */
export function localAgentCoreTools(
  getContext: () => ToolContext,
  principal: LocalAgentExecutionPrincipal
): LocalAgentTool[] {
  const agent = agentForCaller({ localPrincipal: principal });
  if (!agent) return [];

  const initial = getContext();
  const exposedCaps = { ...(initial.exposedCaps ?? initial.caps) };
  const definitions: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
  const catalog = createRegistrar(null, { ...initial, exposedCaps }, 'core', (name, config) => {
    if (!LOCAL_CORE_TOOL_NAMES.has(name)) return;
    definitions.push({
      name,
      description: config.description,
      inputSchema: { type: 'object', ...toolSchemaJson(config.inputSchema) }
    });
  });
  registerCoreTools(catalog);

  return definitions.map((definition) => ({
    ...definition,
    invoke: async (args, presentedPrincipal) => {
      if (presentedPrincipal.runtimeId !== principal.runtimeId) {
        return { content: 'LOCAL_AGENT_CALLER_REJECTED: tool call principal did not match this worker runtime.', isError: true };
      }
      const liveAgent = agentForCaller({ localPrincipal: presentedPrincipal });
      if (!liveAgent || liveAgent !== agent) {
        return { content: 'LOCAL_AGENT_CALLER_REJECTED: this worker is no longer active in its broker run.', isError: true };
      }
      const live = createRegistrar(null, { ...getContext(), exposedCaps }, 'core');
      registerCoreTools(live);
      const sessionId = await localRecordingSession(presentedPrincipal);
      return localResult(await live.invokeNested(
        definition.name,
        args,
        parentContext(presentedPrincipal, liveAgent, sessionId)
      ));
    }
  }));
}

/** Test seam only. Durable session files remain; this forgets only process-local memoization. */
export function resetLocalAgentToolAdapterForTests(): void {
  localRecordingSessions.clear();
}
