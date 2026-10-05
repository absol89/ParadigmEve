/**
 * App-owned local agent runtime primitives.
 *
 * This is deliberately below the broker/executor activation boundary. A local model must not
 * inherit ChatGPT's conversation-id authority, and a reachable inference endpoint is not a
 * worker identity. The broker will eventually re-issue one of these principals from its own
 * durable run/worker record before handing work to a local executor.
 */

import { randomUUID } from 'node:crypto';
import type { AgentBackendId } from '../shared/agent-backends.js';

export type LocalAgentBackendId = Extract<AgentBackendId, 'ollama' | 'custom'>;

export interface LocalAgentExecutionPrincipal {
  kind: 'local-agent';
  /** Process-local unguessable handle. Never sent to the model. */
  runtimeId: string;
  /** Exact backend frozen on the worker that owns this runtime. */
  backend: LocalAgentBackendId;
  /** Exact broker incarnation. A restarted/re-keyed run must receive a new principal. */
  runId: string;
  /** Exact worker slot inside that run. */
  agentId: string;
}

const issuedPrincipals = new Map<string, Omit<LocalAgentExecutionPrincipal, 'runtimeId'>>();

/**
 * Issues local execution authority inside the app process.
 *
 * This is not a credential for a model to carry. It is an internal capability handed directly
 * to the runtime/tool adapter after the broker has already decided which durable worker owns it.
 */
export function issueLocalAgentExecutionPrincipal(input: {
  backend: LocalAgentBackendId;
  runId: string;
  agentId: string;
}): LocalAgentExecutionPrincipal {
  if (!input.runId.trim()) throw new Error('LOCAL_AGENT_PRINCIPAL_INVALID: run id is required');
  if (!input.agentId.trim()) throw new Error('LOCAL_AGENT_PRINCIPAL_INVALID: agent id is required');
  const principal: LocalAgentExecutionPrincipal = {
    kind: 'local-agent',
    runtimeId: randomUUID(),
    backend: input.backend,
    runId: input.runId,
    agentId: input.agentId
  };
  issuedPrincipals.set(principal.runtimeId, {
    kind: principal.kind,
    backend: principal.backend,
    runId: principal.runId,
    agentId: principal.agentId
  });
  return principal;
}

export function revokeLocalAgentExecutionPrincipal(principal: LocalAgentExecutionPrincipal): void {
  issuedPrincipals.delete(principal.runtimeId);
}

export function localAgentExecutionPrincipalIssued(principal: LocalAgentExecutionPrincipal | null | undefined): boolean {
  if (!principal || principal.kind !== 'local-agent') return false;
  const issued = issuedPrincipals.get(principal.runtimeId);
  return !!issued &&
    issued.kind === principal.kind &&
    issued.backend === principal.backend &&
    issued.runId === principal.runId &&
    issued.agentId === principal.agentId;
}

export interface LocalAgentToolResult {
  content: string;
  isError?: boolean;
}

export interface LocalAgentTool {
  name: string;
  description: string;
  /** JSON Schema supplied to the local model. The adapter remains the execution authority. */
  inputSchema: Record<string, unknown>;
  invoke: (args: unknown, principal: LocalAgentExecutionPrincipal) => Promise<LocalAgentToolResult>;
}

export interface LocalAgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type LocalAgentContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
>;

export type LocalAgentMessage =
  | { role: 'system' | 'user'; content: LocalAgentContent }
  | { role: 'assistant'; content: LocalAgentContent; toolCalls?: LocalAgentToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string; isError: boolean };

export type LocalAgentCompletion =
  | { type: 'final'; content: string }
  | { type: 'tool_calls'; content?: string; calls: LocalAgentToolCall[] };

export interface LocalAgentModelRequest {
  endpoint: string;
  model: string;
  messages: readonly LocalAgentMessage[];
  tools: ReadonlyArray<Pick<LocalAgentTool, 'name' | 'description' | 'inputSchema'>>;
  signal?: AbortSignal;
}

export interface LocalAgentModelRuntime {
  complete(request: LocalAgentModelRequest): Promise<LocalAgentCompletion>;
}

export type LocalAgentRuntimePrerequisiteReason =
  | 'principal-not-issued'
  | 'principal-backend-mismatch'
  | 'endpoint-missing'
  | 'endpoint-invalid'
  | 'model-missing'
  | 'tools-unavailable';

export type LocalAgentRuntimePrerequisites =
  | { ready: true; endpoint: string; model: string }
  | { ready: false; reason: LocalAgentRuntimePrerequisiteReason; detail: string };

/**
 * Runtime endpoint policy is intentionally narrower than "fetch accepts this URL".
 * Local HTTP is allowed only on loopback; anything remote must be HTTPS. Credentials,
 * fragments and query strings are refused so a model endpoint cannot smuggle secrets or route
 * one worker call somewhere different from the configured base.
 */
export function normalizeLocalAgentEndpoint(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  return url.toString().replace(/\/+$/, '');
}

export function localAgentRuntimePrerequisites(input: {
  backend: LocalAgentBackendId;
  principal?: LocalAgentExecutionPrincipal | null;
  endpoint?: string | null;
  model?: string | null;
  tools?: readonly LocalAgentTool[] | null;
  allowNoTools?: boolean;
}): LocalAgentRuntimePrerequisites {
  const principal = input.principal;
  if (!localAgentExecutionPrincipalIssued(principal)) {
    return {
      ready: false,
      reason: 'principal-not-issued',
      detail: 'A local worker needs an app-issued execution principal before it may call a model or a tool.'
    };
  }
  if (principal!.backend !== input.backend) {
    return {
      ready: false,
      reason: 'principal-backend-mismatch',
      detail: `The issued principal belongs to ${principal!.backend}, not ${input.backend}.`
    };
  }
  if (!input.endpoint?.trim()) {
    return { ready: false, reason: 'endpoint-missing', detail: 'No local-agent endpoint is configured.' };
  }
  const endpoint = normalizeLocalAgentEndpoint(input.endpoint);
  if (!endpoint) {
    return {
      ready: false,
      reason: 'endpoint-invalid',
      detail: 'The local-agent endpoint must be HTTPS, or HTTP on loopback, with no credentials/query/fragment.'
    };
  }
  const model = input.model?.trim() ?? '';
  if (!model || model.length > 160) {
    return { ready: false, reason: 'model-missing', detail: 'A concrete local-agent model id is required.' };
  }
  if (!input.allowNoTools && !input.tools?.length) {
    return {
      ready: false,
      reason: 'tools-unavailable',
      detail: 'No app-authorized local tool surface is available for this worker.'
    };
  }
  const names = new Set<string>();
  for (const tool of input.tools ?? []) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name) || names.has(tool.name)) {
      return {
        ready: false,
        reason: 'tools-unavailable',
        detail: 'The local tool surface contains an invalid or duplicate tool name.'
      };
    }
    names.add(tool.name);
  }
  return { ready: true, endpoint, model };
}

export interface RunLocalAgentOptions {
  backend: LocalAgentBackendId;
  principal: LocalAgentExecutionPrincipal;
  endpoint: string;
  model: string;
  system: string;
  task: string;
  /** Exact prebuilt conversation, used by direct local chat. Worker callers omit this. */
  initialMessages?: readonly LocalAgentMessage[];
  tools: readonly LocalAgentTool[];
  runtime: LocalAgentModelRuntime;
  signal?: AbortSignal;
  maxTurns?: number;
  maxToolCalls?: number;
  allowNoTools?: boolean;
}

export interface LocalAgentRunResult {
  final: string;
  turns: number;
  toolCalls: number;
}

/**
 * Minimal app-owned model/tool loop.
 *
 * The model chooses only tool *names + arguments*. The principal never enters the prompt or
 * request body and is supplied to the app-owned tool adapter out-of-band. Unknown tools are
 * returned to the model as an error result rather than executed by guessing another surface.
 */
export async function runLocalAgent(options: RunLocalAgentOptions): Promise<LocalAgentRunResult> {
  const prerequisites = localAgentRuntimePrerequisites(options);
  if (!prerequisites.ready) {
    throw new Error(`LOCAL_AGENT_NOT_READY: ${prerequisites.reason}: ${prerequisites.detail}`);
  }
  const maxTurns = Math.max(1, Math.min(128, Math.floor(options.maxTurns ?? 32)));
  const maxToolCalls = Math.max(1, Math.min(512, Math.floor(options.maxToolCalls ?? 64)));
  const messages: LocalAgentMessage[] = options.initialMessages?.length
    ? options.initialMessages.map(message => ({ ...message })) as LocalAgentMessage[]
    : [
        { role: 'system', content: options.system },
        { role: 'user', content: options.task }
      ];
  const tools = new Map(options.tools.map((tool) => [tool.name, tool] as const));
  let toolCalls = 0;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    options.signal?.throwIfAborted();
    const completion = await options.runtime.complete({
      endpoint: prerequisites.endpoint,
      model: prerequisites.model,
      messages,
      tools: options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      signal: options.signal
    });
    options.signal?.throwIfAborted();

    if (completion.type === 'final') {
      const final = completion.content.trim();
      if (!final) throw new Error('LOCAL_AGENT_PROTOCOL_ERROR: model returned an empty final answer');
      return { final, turns: turn, toolCalls };
    }
    if (!completion.calls.length) {
      throw new Error('LOCAL_AGENT_PROTOCOL_ERROR: tool-call completion contained no calls');
    }
    if (toolCalls + completion.calls.length > maxToolCalls) {
      throw new Error(`LOCAL_AGENT_TOOL_LIMIT: more than ${maxToolCalls} tool calls were requested`);
    }
    const ids = new Set<string>();
    for (const call of completion.calls) {
      if (!call.id || ids.has(call.id)) throw new Error('LOCAL_AGENT_PROTOCOL_ERROR: tool call ids must be non-empty and unique per turn');
      ids.add(call.id);
    }
    messages.push({ role: 'assistant', content: completion.content ?? '', toolCalls: completion.calls.map((call) => ({ ...call })) });
    for (const call of completion.calls) {
      toolCalls += 1;
      const tool = tools.get(call.name);
      let result: LocalAgentToolResult;
      if (!tool) {
        result = { content: `UNKNOWN_TOOL: ${call.name} is not available to this local worker.`, isError: true };
      } else {
        try {
          result = await tool.invoke(call.arguments, options.principal);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          result = { content: `TOOL_EXECUTION_ERROR: ${detail}`, isError: true };
        }
      }
      messages.push({
        role: 'tool',
        content: result.content,
        toolCallId: call.id,
        name: call.name,
        isError: result.isError === true
      });
    }
  }
  throw new Error(`LOCAL_AGENT_TURN_LIMIT: model did not finish within ${maxTurns} turns`);
}

/** Test seam only. Production principals are process-lifetime capabilities. */
export function resetLocalAgentRuntimeForTests(): void {
  issuedPrincipals.clear();
}
