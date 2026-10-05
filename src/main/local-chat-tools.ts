/**
 * Session-bound Core tools for an app-owned local chat model.
 *
 * The runtime principal authenticates the in-process model/tool loop only. Tool identity itself
 * is the real ParadigmEve session + conversation, so a local chat is never disguised as a worker.
 */
import type { LocalAgentExecutionPrincipal, LocalAgentTool, LocalAgentToolResult } from './local-agent-runtime.js';
import { localAgentExecutionPrincipalIssued } from './local-agent-runtime.js';
import { createRegistrar, type ToolContext, type ToolResult } from './mcp/kernel.js';
import { emptyEvidence, type CallContext } from './mcp/call-context.js';
import { toolSchemaJson } from './mcp/tool-declarations.js';
import { registerCoreTools } from './mcp/tools-core.js';
import { registerExpensesTool } from './mcp/expenses-tool.js';
import { registerWorkContextTool } from './mcp/work-context.js';
import { desktopAutomationSupported } from './platform.js';
import { onSwarmChange, statusForCaller } from './agents.js';

const CHAT_LIFECYCLE_ONLY = new Set(['chat_review_plan', 'chat_review_complete', 'session_finish']);
const DELEGATE_TIMEOUT_MS = 10 * 60_000;

function localResult(result: ToolResult): LocalAgentToolResult {
  const text: string[] = [];
  let unsupported = false;
  for (const part of result.content) {
    if (part.type === 'text') text.push(part.text);
    else unsupported = true;
  }
  if (unsupported) text.push('LOCAL_AGENT_UNSUPPORTED_RESULT: this tool returned non-text content.');
  return {
    content: text.join('\n').trim() || (result.isError ? 'Tool call failed.' : 'Tool call completed.'),
    isError: result.isError === true || unsupported
  };
}

async function registerSurface(registrar: ReturnType<typeof createRegistrar>): Promise<void> {
  registerCoreTools(registrar);
  registerExpensesTool(registrar);
  if (desktopAutomationSupported()) {
    if (process.platform === 'win32') {
      const { registerWindowsDesktopTools } = await import('./mcp/tools-desktop-windows.js');
      registerWindowsDesktopTools(registrar);
    } else {
      const { registerMacOSDesktopTools } = await import('./mcp/tools-desktop-macos.js');
      registerMacOSDesktopTools(registrar);
    }
  }
  registerWorkContextTool(registrar);
}

async function waitForWorker(conversationId: string, workerId: string): Promise<LocalAgentToolResult> {
  const completed = (): LocalAgentToolResult | null => {
    try {
      const row = statusForCaller({ conversationId }).state.agents.find(agent => agent.id === workerId);
      if (!row || !['sleeping', 'finished', 'failed'].includes(row.state) || !row.result) return null;
      return {
        content: row.state === 'failed'
          ? `WORKER_FAILED: ${workerId}: ${row.result}`
          : `WORKER_RESULT (${workerId}): ${row.result}`,
        isError: row.state === 'failed'
      };
    } catch {
      return null;
    }
  };
  const now = completed();
  if (now) return now;
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: LocalAgentToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      drop();
      resolve(result);
    };
    const drop = onSwarmChange(() => {
      const result = completed();
      if (result) finish(result);
    });
    const timer = setTimeout(() => finish({
      content: `WORKER_STILL_RUNNING: ${workerId} did not finish within 10 minutes. Its work remains in the broker; do not duplicate it automatically.`,
      isError: false
    }), DELEGATE_TIMEOUT_MS);
  });
}

function parentContext(sessionId: string, conversationId: string | null): CallContext {
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: {
      transportKey: null,
      requestId: null,
      conversationId,
      sessionId,
      localPrincipal: null
    },
    outcome: null,
    evidence: emptyEvidence()
  };
}

export async function localChatCoreTools(input: {
  getContext: () => ToolContext;
  principal: LocalAgentExecutionPrincipal;
  sessionId: string;
  conversationId: string | null;
  /** Direct exposes the normal Core surface; delegate exposes only the worker broker. */
  mode: 'direct' | 'delegate';
}): Promise<LocalAgentTool[]> {
  if (!localAgentExecutionPrincipalIssued(input.principal)) return [];
  const initial = input.getContext();
  const definitions: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
  const registrar = createRegistrar(null, initial, 'core', (name, config) => {
    if (CHAT_LIFECYCLE_ONLY.has(name)) return;
    if (input.mode === 'delegate') return;
    definitions.push({
      name,
      description: config.description,
      inputSchema: { type: 'object', ...toolSchemaJson(config.inputSchema) }
    });
  });
  await registerSurface(registrar);

  if (input.mode === 'delegate') {
    if (!initial.agentTools || !input.conversationId) return [];
    return [{
      name: 'delegate_worker',
      description: 'Delegate one tool-requiring task to a ParadigmEve worker and wait for that exact worker result. Use this instead of performing filesystem, command, or computer actions yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', minLength: 1, maxLength: 4000 },
          label: { type: 'string', minLength: 1, maxLength: 60 }
        },
        required: ['task'],
        additionalProperties: false
      },
      invoke: async (args, presentedPrincipal) => {
        if (presentedPrincipal.runtimeId !== input.principal.runtimeId || !localAgentExecutionPrincipalIssued(presentedPrincipal)) {
          return { content: 'LOCAL_CHAT_CALLER_REJECTED: this local chat runtime is no longer active.', isError: true };
        }
        const row = args && typeof args === 'object' ? args as { task?: unknown; label?: unknown } : {};
        const task = typeof row.task === 'string' ? row.task.trim() : '';
        const label = typeof row.label === 'string' ? row.label.trim() : 'Delegated work';
        if (!task || task.length > 4000 || !label || label.length > 60) {
          return { content: 'INVALID_ARGUMENTS: delegate_worker requires task (1-4000 chars) and optional label (1-60 chars).', isError: true };
        }
        const live = createRegistrar(null, input.getContext(), 'core');
        await registerSurface(live);
        const spawned = await live.invokeNested('agents', {
          action: 'spawn',
          workers: [{ label, task }]
        }, parentContext(input.sessionId, input.conversationId));
        if (spawned.isError) return localResult(spawned);
        const structured = spawned.structuredContent as { workers?: Array<{ id?: unknown }> } | undefined;
        const workerId = structured?.workers?.[0]?.id;
        if (typeof workerId !== 'string' || !workerId) {
          return { content: 'WORKER_DELEGATION_ERROR: the broker accepted the spawn but returned no worker id.', isError: true };
        }
        return waitForWorker(input.conversationId!, workerId);
      }
    }];
  }

  return definitions.map(definition => ({
    ...definition,
    invoke: async (args, presentedPrincipal) => {
      if (presentedPrincipal.runtimeId !== input.principal.runtimeId || !localAgentExecutionPrincipalIssued(presentedPrincipal)) {
        return { content: 'LOCAL_CHAT_CALLER_REJECTED: this local chat runtime is no longer active.', isError: true };
      }
      const live = createRegistrar(null, input.getContext(), 'core');
      await registerSurface(live);
      return localResult(await live.invokeNested(
        definition.name,
        args,
        parentContext(input.sessionId, input.conversationId)
      ));
    }
  }));
}
