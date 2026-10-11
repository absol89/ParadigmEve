import { currentCall, type CallContext } from './call-context.js';
import { guard, fail, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { codeModeSchema, runCodeMode, CODE_MODE_LIMITS, type CodeModeTool, type CodeModeOptions } from './code-mode-runtime.js';
import { toolDeclaration } from './tool-declarations.js';
import { sharedEveOwnerForCurrentCall } from '../eve-access.js';
import { getConfig } from '../config.js';
import { CORE_CONNECTOR_NAME, SURFACES, surfaceDefinition, type SurfaceId } from './surfaces.js';

/** Contract checked against OpenAI Codex 634ebc1865c6ac840ed3ba118f040d527bf4b55d,
 * code-mode-protocol/src/description.rs and core/src/tools/code_mode/execute_spec.rs.
 * MCP requires an object argument; it cannot advertise Codex's freeform grammar/namespace. */
export const codeModeDeclaration = (options: CodeModeOptions = {}) => toolDeclaration('exec', () => ({
  title: 'Run JavaScript',
  description: options.windowsDesktop
    ? 'Run Windows Computer Use JavaScript with sky: list_apps, list_windows, get_window, launch_app, get_window_state, click, press_key, type_text, scroll, set_value, drag, perform_secondary_action, activate_window. Same arguments as direct tools; sky returns native values and throws tool errors. get_window_state displays its screenshots. Use nodeRepl.write(value) or text(value) for text. sky.target is windows. sky is supplied; no import needed. Fresh runtime per call: variables do not persist; use get_window across calls. tools.<name> returns MCP result objects; ALL_TOOLS lists methods. No Node/filesystem/network, timers or setTimeout. 64k source, 32 MiB JS memory, 2s CPU, 60s total, 32 calls, 8 concurrent, 4 images and 12 MiB output. Live permissions and the current Eve cross-chat access setting apply. Observe and inspect before choosing an action; then act and refresh. Script failure does not undo dispatched inputs; observe before retrying.'
    : 'Run JavaScript to compose this connector’s tools. MCP arguments: {code: "raw JavaScript"}; the host chooses the outer namespace (Codex calls this functions.exec). Inside code, use await tools.<tool_name>(args), await Promise.all([...]), text(value), and image(dataUrlOrMcpImageContent). tools return their normal MCP result objects, including content and isError. Only explicit text/image output reaches the model; intermediate results stay in the runtime and local tool recording. ALL_TOOLS lists {name,description}; use the individual tools’ schemas for arguments. Fresh isolated JavaScript runtime, top-level await, no Node, filesystem, network, console or imports. Requires exact companion chat/session identity unless the user enabled Eve in other ChatGPT chats/devices for this connector. Limits: 64k source characters, 32 MiB JS memory, 2s active JS time, 60s total, 32 calls, 8 concurrent calls, 40k text bytes, 4 images, 12 MiB emitted payload. Await every call. Termination stops JavaScript/new calls, not actions already dispatched. Individual tools remain available. session_finish, chat_review_plan, chat_review_complete and agents action=finish must be direct calls. No recursive exec, pragma, wait/yield or persistent globals. See the connector instructions for examples.',
  inputSchema: codeModeSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}), options.windowsDesktop ? 'windows-desktop' : 'standard');

/** Preserve an upstream tool named exec; code mode must never replace its direct contract. */
export function canAddCodeMode(tools: ReadonlyArray<{ name: string }>): boolean {
  return tools.length > 0 && !tools.some(tool => tool.name === 'exec');
}

/** Names a script calls on `tools` (dotted or quoted bracket access) that this connector lacks. */
export function unknownToolReferences(code: string, available: readonly string[]): string[] {
  const names = new Set<string>();
  // Only calls count: `typeof tools.x` and `if (tools.x)` are a script checking, not failing.
  for (const match of code.matchAll(/\btools\s*(?:\??\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"`])([^'"`\n]{1,64})\2\s*\])\s*(?:\?\.\s*)?\(/g)) names.add(match[1] ?? match[3]!);
  return [...names].filter(name => !available.includes(name)).slice(0, 8);
}

/** Connectors whose configured Secure Tunnel ID equals this connector's. */
function sharedTunnelConnectors(surface: SurfaceId): SurfaceId[] {
  const tunnel = getConfig().tunnel;
  const ids: Record<SurfaceId, string> = { core: tunnel.tunnelId ?? '', desktop: tunnel.desktopTunnelId ?? '', plugins: tunnel.pluginsTunnelId ?? '' };
  const own = ids[surface].trim();
  return own ? (Object.keys(ids) as SurfaceId[]).filter(other => other !== surface && ids[other].trim() === own) : [];
}

const connectorName = (surface: SurfaceId): string =>
  surfaceDefinition(surface, getConfig().mcp?.connectorName ?? CORE_CONNECTOR_NAME).connectorName;

/**
 * Says what a bare "not a function" means: the script called a tool this connector does not have,
 * usually another connector's. With two connectors on one Secure Tunnel ID, ChatGPT sends calls to
 * either, so a script written for Core can run on Plugins half the time. Ported from Chat On
 * Steroids 2.1.34 (27e5d1f0, #1287).
 */
export function unknownToolNote(surface: SurfaceId, unknown: readonly string[]): string {
  const here = connectorName(surface);
  const named = unknown.map(name => {
    // ParadigmEve's Core declares Computer use itself; permissions or platform can leave it off.
    if (name !== 'exec' && SURFACES[surface].tools.includes(name)) return `${name} (not enabled on ${here} right now)`;
    const owner = (Object.keys(SURFACES) as SurfaceId[]).find(id => id !== surface && name !== 'exec' && SURFACES[id].tools.includes(name));
    return owner ? `${name} (a ${connectorName(owner)} tool)` : name;
  });
  const shared = sharedTunnelConnectors(surface);
  return `UNKNOWN_TOOL_NAMES: this script used tools.${named.join(', tools.')}, which ${here} does not offer; ` +
    'calling one fails with "not a function". ALL_TOOLS lists this connector\'s tools; call other tools through their own connector.' +
    (shared.length ? ` ${here} shares its Secure Tunnel ID with ${shared.map(connectorName).join(' and ')}, ` +
      'so ChatGPT sends calls to either connector and a script meant for one can run on the other. Give each connector its own tunnel ID in Setup.' : '');
}

export function codeModeHandler(
  getTools: () => CodeModeTool[], invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>,
  options: CodeModeOptions = {}
): (args: { code: string }) => Promise<ToolResult> {
  return ({ code }) => guard('exec', async () => {
    const parent = currentCall();
    if (!parent?.caller.requestId || ((!parent.caller.conversationId || !parent.caller.sessionId) && !sharedEveOwnerForCurrentCall())) {
      return fail('CALLER_IDENTITY_REQUIRED: code mode needs this request’s exact companion chat/session proof. No JavaScript or nested tool ran. Individual tools remain available.');
    }
    const tools = getTools().filter(tool => tool.name !== 'exec');
    const result = await runCodeMode(code, tools, (name, args) => invoke(name, args, parent), CODE_MODE_LIMITS, options);
    const unknown = options.surface ? unknownToolReferences(code, tools.map(tool => tool.name)) : [];
    return unknown.length ? { ...result, content: [...result.content, { type: 'text', text: unknownToolNote(options.surface!, unknown) }] } : result;
  });
}

export function registerCodeMode(
  reg: SurfaceRegistrar, invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>,
  options: CodeModeOptions = {}
): void {
  if (!canAddCodeMode(reg.descriptions())) return;
  reg.register('exec', codeModeDeclaration(options), codeModeHandler(() => reg.descriptions(), invoke, options));
}

export const CODE_MODE_INSTRUCTIONS = `Code mode: use exec with a code string for bounded tool composition and filtering. Inside JavaScript, call tools by their existing names and arguments. Results are normal MCP objects; inspect content, structuredContent and isError. Only text(...) and image(...) emit data to the model. Given requests you define using this connector's listed tool schemas:
const results = await Promise.all(requests.map(({name, args}) => tools[name](args)));
text(results.map((result, index) => ({index, isError: result.isError ?? false, content: result.content})));
Keep independent calls parallel only when their operations do not conflict; await mutations before dependent work. Use image(result.content.find(item => item.type === "image")) to forward a native image explicitly. A script without text/image returns no intermediate data. All nested calls still run under live permissions and this chat’s identity and are individually recorded. New user instructions and worker inbox messages arrive with the outer result, outside filtering. Call lifecycle tools (chat_review_plan, chat_review_complete, session_finish, agents finish) directly. Use individual tools for simple calls, native file arguments, or when a result needs fresh model judgment. No persistent script state or code-mode wait tool; long-running tools retain their existing continuation contracts.`;
