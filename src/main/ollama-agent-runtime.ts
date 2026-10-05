/**
 * Ollama worker model transport.
 *
 * This is intentionally separate from Goal/Loop's custom provider. They may point at the same
 * HTTP server, but a successful inference request there is only one prerequisite for this
 * agent runtime; it does not make the Ollama backend executable or ready by itself.
 */

import type {
  LocalAgentCompletion,
  LocalAgentExecutionPrincipal,
  LocalAgentMessage,
  LocalAgentModelRequest,
  LocalAgentModelRuntime,
  LocalAgentRuntimePrerequisites,
  LocalAgentTool,
  LocalAgentToolCall
} from './local-agent-runtime.js';
import { localAgentRuntimePrerequisites } from './local-agent-runtime.js';
import type { AgentRuntimeSettings } from '../shared/agent-backends.js';
import { ollamaHeaders } from './ollama-client.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Execution readiness from app-owned prerequisites only. Deliberately performs no network
 * probe: `/models` or `/chat/completions` reachability cannot prove broker/tool-loop readiness.
 */
export function ollamaAgentRuntimePrerequisites(input: {
  settings: AgentRuntimeSettings['ollama'];
  principal?: LocalAgentExecutionPrincipal | null;
  tools?: readonly LocalAgentTool[] | null;
}): LocalAgentRuntimePrerequisites {
  return localAgentRuntimePrerequisites({
    backend: 'ollama',
    principal: input.principal,
    endpoint: input.settings.endpoint,
    model: input.settings.model,
    tools: input.tools
  });
}

function openAiMessage(message: LocalAgentMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
      }))
    };
  }
  return { role: message.role, content: message.content };
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('OLLAMA_RESPONSE_TOO_LARGE');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('OLLAMA_RESPONSE_TOO_LARGE');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') throw new Error('OLLAMA_PROTOCOL_ERROR: tool arguments were not JSON text');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('OLLAMA_PROTOCOL_ERROR: tool arguments were invalid JSON');
  }
}

function completionFrom(payload: unknown): LocalAgentCompletion {
  if (!payload || typeof payload !== 'object') throw new Error('OLLAMA_PROTOCOL_ERROR: response was not an object');
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') {
    throw new Error('OLLAMA_PROTOCOL_ERROR: response had no completion choice');
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') throw new Error('OLLAMA_PROTOCOL_ERROR: response had no assistant message');
  const row = message as { content?: unknown; tool_calls?: unknown };
  if (Array.isArray(row.tool_calls) && row.tool_calls.length) {
    const calls: LocalAgentToolCall[] = row.tool_calls.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw new Error('OLLAMA_PROTOCOL_ERROR: malformed tool call');
      const tool = entry as { id?: unknown; function?: unknown };
      const fn = tool.function;
      if (!fn || typeof fn !== 'object') throw new Error('OLLAMA_PROTOCOL_ERROR: malformed tool function');
      const named = fn as { name?: unknown; arguments?: unknown };
      if (typeof named.name !== 'string' || !named.name) throw new Error('OLLAMA_PROTOCOL_ERROR: tool name missing');
      return {
        id: typeof tool.id === 'string' && tool.id ? tool.id : `ollama-call-${index + 1}`,
        name: named.name,
        arguments: parseArguments(named.arguments)
      };
    });
    return { type: 'tool_calls', content: typeof row.content === 'string' ? row.content : '', calls };
  }
  if (typeof row.content !== 'string') throw new Error('OLLAMA_PROTOCOL_ERROR: assistant content missing');
  return { type: 'final', content: row.content };
}

/**
 * OpenAI-compatible chat transport used by the dedicated Ollama worker runtime.
 * No OpenRouter/Goal vendor fields are sent. Tool authority remains in runLocalAgent().
 */
export function createOllamaAgentModelRuntime(fetchImpl: typeof fetch = globalThis.fetch): LocalAgentModelRuntime {
  return {
    async complete(request: LocalAgentModelRequest): Promise<LocalAgentCompletion> {
      const response = await fetchImpl(`${request.endpoint}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        headers: await ollamaHeaders(request.endpoint),
        body: JSON.stringify({
          model: request.model,
          stream: false,
          messages: request.messages.map(openAiMessage),
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema
            }
          }))
        }),
        signal: request.signal
      });
      const raw = await boundedText(response);
      if (!response.ok) {
        const detail = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
        throw new Error(`OLLAMA_HTTP_ERROR: ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      let payload: unknown;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error('OLLAMA_PROTOCOL_ERROR: response was not valid JSON');
      }
      return completionFrom(payload);
    }
  };
}
