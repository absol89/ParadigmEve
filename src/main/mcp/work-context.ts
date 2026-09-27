import { z } from 'zod';
import { effectiveCapabilities, getConfig } from '../config.js';
import { hostPlatformInfo } from '../platform.js';
import { currentCall } from './call-context.js';
import { guard, type SurfaceRegistrar, type ToolContext, type ToolResult } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
import { DEFAULT_CORE_CONNECTOR_NAME } from '../../shared/types.js';
import { sharedEveOwnerForCurrentCall } from '../eve-access.js';

/** Also returned by a tool: MCP initialization instructions need not reach a direct web chat. */
export function connectedWorkGuidance(connectorName = DEFAULT_CORE_CONNECTOR_NAME): string { return (
  'These tools execute on the computer running ParadigmEve, not on the device used to type this message. ' +
  'Being away from its keyboard does not by itself remove tool access. When asked to create, save, document, edit or implement something, ' +
  'use the available tools to complete that work; a chat draft, plan or promise is not a saved file or a dispatched worker. ' +
  'Verify the actual result and report the saved path or concrete blocker. Do not claim the computer is unavailable without checking the tools supplied to this message. ' +
  `If ChatGPT has not supplied this app for the current message, it cannot call these tools: select or @mention ${connectorName} in a supported ChatGPT web conversation. ` +
  'ChatGPT controls client support and per-message app selection; this server cannot enable tools in a client that omits them.'
); }
export const CONNECTED_WORK_GUIDANCE = connectedWorkGuidance();

/** A projection only: no new caller identity, execution queue, browser opener or permission. */
export function workContext(ctx: ToolContext, platform: NodeJS.Platform = process.platform): ToolResult {
  const config = getConfig();
  const connectorName = config.mcp?.connectorName ?? DEFAULT_CORE_CONNECTOR_NAME;
  const caps = effectiveCapabilities({ ...config, capabilities: ctx.caps, readOnly: ctx.readOnly }, platform);
  const caller = currentCall()?.caller;
  const exact = !!(caller?.requestId && caller.conversationId && caller.sessionId);
  const shared = !exact && sharedEveOwnerForCurrentCall() !== null;
  const history = ctx.sessionTools ?? config.sessions.record;
  const workers = ctx.agentTools ?? config.multiAgent.enabled;
  const roots = ctx.roots.map(root => `/${root.name}`);
  const steps: string[] = [];
  if (caps.read || caps.browse || caps.metadata) steps.push(
    'Use read with an explicit approved root to find the requested project, then read its applicable AGENTS.md. Do not guess which nested folder is the project.'
  );
  if (caps.create || caps.edit) steps.push(
    'For requested text or code, use apply_patch with the complete approved path. Read existing content before editing and verify the saved bytes afterward. Preserve unrelated changes.'
  );
  if (caps.saveArtifact) steps.push(
    'For an attached/generated file, use download_artifact with its native file value and an approved destination; report the successful saved path.'
  );
  if (caps.command) steps.push(
    'Use exec_command with explicit workdir for commands, tests and Git. Continue any returned process with write_stdin under the same proven session; inspect completion before reporting success.'
  );
  if (caps.screen) steps.push(platform === 'win32'
    ? 'For Computer Use, call list_windows or list_apps, inspect the exact returned window with get_window_state, then use only enabled input tools and refresh the observation.'
    : 'For Computer Use, observe the exact task window before using enabled computer actions.');
  if (history) steps.push(
    'Use session search/read to recover prior work. A recording or update_plan is not a substitute for saving a requested document.'
  );
  if (workers) steps.push(
    `For authorized independent work, use agents in this conversation's own family. Reuse suitable sleeping workers; if no family belongs here, spawn creates this chat's own workers. A missing family is not a disconnected computer. Never adopt another ${connectorName} conversation by title or recency.`
  );
  steps.push(exact
    ? 'This call has exact Companion conversation/session proof. Every later action still checks current identity, permissions and target state.'
    : shared
    ? 'This call has no exact Companion session proof, but the user enabled Eve in other ChatGPT chats/devices. Connector-authenticated work may borrow Eve’s shared local authority while this setting remains enabled.'
    : 'This call reached the computer but lacks exact Companion conversation/session proof. Identity-sensitive tools remain restricted until the same conversation is observed in the connected Eve Browser.');
  steps.push(
    ...(shared ? [] : ['To establish missing Companion proof, the same conversation must be observed in the connected Eve Browser on the host. A copied URL, this status result, or a successful window launch does not prove caller identity. Do not replay a mutation after an ambiguous outcome.']),
    'This check has not saved a deliverable, started workers, or sent a message. Continue with the concrete tools needed for the user\'s request.'
  );
  const value = {
    host: hostPlatformInfo(platform).name,
    instance: connectorName,
    reachedComputer: true,
    readOnly: ctx.readOnly,
    roots,
    appNamespaces: {
      manual: '/paradigmeve-manual',
      appData: '/appdata',
      installation: '/paradigmeve'
    },
    capabilities: caps,
    recordingEnabled: history,
    workersEnabled: workers,
    callerIdentity: exact ? 'proven' : shared ? 'shared-eve' : 'unproven',
    ...(exact ? { sessionId: caller!.sessionId, conversationId: caller!.conversationId } : {}),
    guidance: connectedWorkGuidance(connectorName),
    nextSteps: steps
  };
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

export function registerWorkContextTool(reg: SurfaceRegistrar): void {
  // No extra surface or permission. An otherwise empty Core remains empty; previously
  // exposed tools keep this read-only diagnostic useful when permissions are revoked.
  if (reg.registered().length === 0) return;
  reg.register('work_context', toolDeclaration('work_context', () => ({
    title: 'Check connected computer work',
    description: 'Check the connected ParadigmEve computer before saying you cannot save files, implement work, use Computer Use or contact workers. Returns live permissions, approved roots, exact-caller status and how to act from this conversation, including away from keyboard. This read-only check does not execute the task; follow it with the available file, command or agent tools and verify the result.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), async () => guard('work_context', async () => workContext(reg.ctx)));
}
