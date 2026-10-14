import nodePath from 'node:path';
import { z } from 'zod';
import { confirmFileFeatureLoss, requestFileProviderInstall, type FeatureLossChoice } from '../file-provider-consent.js';
import { EditRefused, freeOutputName, INPUT_PLACEHOLDER, openVisibleCopy, OUTPUT_PLACEHOLDER, runProviderEdit } from '../file-edit-transaction.js';
import { pluginManager } from '../plugins/manager.js';
import { toolDeclaration } from './tool-declarations.js';
import { fail, guard, ok, resolveIn, type SurfaceRegistrar, type ToolResult } from './kernel.js';

/**
 * The changing half of the file broker. file_action stays read-only so ChatGPT never asks the user
 * to confirm a read; everything that changes the machine or a file lives here (compare
 * expenses_read / expenses). Provider tools never appear on Core: provider_tools lists an installed
 * app's own tools on demand, and edit drives them only through PluginManager, on a copy.
 */
// One flat object: per-op fields are checked in the handler, because a union repeats every field
// in every chat's tools/list. The provider id is validated against the registry by its owners.
export const fileEditArgs = z.object({
  op: z.enum(['install_provider', 'provider_tools', 'edit', 'open_visible']),
  provider: z.string().regex(/^artcraft\.[a-z]+$/).describe('Id from a file_action provider_offer.'),
  path: z.string().min(1).max(4096).optional().describe('edit/open_visible: source file.'),
  steps: z.array(z.object({
    tool: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    arguments: z.record(z.string(), z.unknown()).optional()
  }).strict()).min(1).max(40).optional().describe(`edit: app tool calls; files only as "${INPUT_PLACEHOLDER}" (a copy) and "${OUTPUT_PLACEHOLDER}" (must be saved).`),
  output_path: z.string().min(1).max(4096).optional().describe('edit/open_visible: new file; default "<name> (Eve edit).<ext>".')
}).strict();

type FileEditArgs = z.output<typeof fileEditArgs>;
const MAX_TOOL_LIST_CHARS = 12_000;
let featureLossConfirm: (choice: FeatureLossChoice) => Promise<boolean> = confirmFileFeatureLoss;
/** Test seam only: production approval always comes from Eve's native dialog. */
export function setFeatureLossConfirmForTests(confirm: ((choice: FeatureLossChoice) => Promise<boolean>) | null): void {
  featureLossConfirm = confirm ?? confirmFileFeatureLoss;
}

async function installProvider(id: string): Promise<ToolResult> {
  const outcome = await requestFileProviderInstall(id);
  switch (outcome.status) {
    case 'installed':
      return ok(`INSTALLED: ${id} ${outcome.version} is installed for this user and passed its health check. Use provider_tools to see what it can do.`);
    case 'already-installed':
      return ok(`ALREADY_INSTALLED: ${id} ${outcome.version} is already installed.`);
    case 'declined':
      return fail('DECLINED: the user chose not to install this app. Do not ask again; continue with file_action reads or Computer use. The user can undo this in Plugins.');
    case 'later':
      return fail('NOT_NOW: the user closed the install prompt. Do not ask again in this task; continue with file_action reads.');
    case 'unavailable':
      return fail(`UNAVAILABLE: ${outcome.reason}`);
    case 'failed':
      return fail(`INSTALL_FAILED: ${outcome.reason} Nothing was left installed.`);
  }
}

function providerTools(id: string): ToolResult {
  const tools = pluginManager.fileProviderTools(id);
  if (tools.length === 0) return fail(`PROVIDER_NOT_READY: ${id} is not installed. Offer it with install_provider first.`);
  const lines: string[] = [];
  let size = 0;
  for (const tool of tools) {
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const params = Object.keys(schema.properties ?? {}).map((key) => (schema.required ?? []).includes(key) ? key : `${key}?`).join(', ');
    const line = `${tool.name}(${params})${tool.description ? `: ${tool.description.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
    if (size + line.length > MAX_TOOL_LIST_CHARS) { lines.push(`… ${tools.length - lines.length} more`); break; }
    lines.push(line);
    size += line.length;
  }
  return ok(`${id} tools (use them as file_edit edit steps; open "${INPUT_PLACEHOLDER}" and save to "${OUTPUT_PLACEHOLDER}"):\n${lines.join('\n')}`);
}

async function copyTarget(reg: SurfaceRegistrar, path: string, outputPath: string | undefined) {
  const source = await resolveIn(reg.ctx.roots, path);
  if (outputPath) {
    const target = await resolveIn(reg.ctx.roots, outputPath, { allowMissing: true });
    return { source, destination: { realDir: nodePath.dirname(target.real), virtualDir: nodePath.posix.dirname(target.virtual), name: nodePath.basename(target.real) } };
  }
  const realDir = nodePath.dirname(source.real);
  return { source, destination: { realDir, virtualDir: nodePath.posix.dirname(source.virtual), name: await freeOutputName(realDir, nodePath.basename(source.real)) } };
}

async function openVisible(reg: SurfaceRegistrar, args: FileEditArgs): Promise<ToolResult> {
  if (!args.path || args.steps) return fail('INVALID_ARGUMENTS: open_visible takes provider, path and optional output_path.');
  if (!reg.caps.create) return fail('TOOL_DISABLED: showing an edit writes a new copy, which needs the Create files permission in ParadigmEve.');
  const { source, destination } = await copyTarget(reg, args.path, args.output_path);
  try {
    const opened = await openVisibleCopy({ providerId: args.provider, source, destination });
    return ok(
      `OPENED: ${opened.copy} is open in ${opened.app}'s window. The original ${source.virtual} was not changed. ` +
      `Work in that window with the Desktop (Computer use) tools so the user can watch, narrating each step. Save in the app when done; it saves to the copy.`
    );
  } catch (error) {
    if (error instanceof EditRefused) return fail(error.message);
    throw error;
  }
}

async function edit(reg: SurfaceRegistrar, args: FileEditArgs): Promise<ToolResult> {
  if (!args.path || !args.steps) return fail('INVALID_ARGUMENTS: edit needs path and steps.');
  if (!reg.caps.create) return fail('TOOL_DISABLED: editing writes a new file, which needs the Create files permission in ParadigmEve.');
  const { source, destination } = await copyTarget(reg, args.path, args.output_path);
  try {
    const outcome = await runProviderEdit({
      providerId: args.provider,
      source,
      destination,
      steps: args.steps,
      confirmFeatureLoss: featureLossConfirm
    });
    const text = [
      `EDITED: wrote ${outcome.output} with ${outcome.provider.id} ${outcome.provider.version}. The original ${source.virtual} was not changed.`,
      `validated: ${outcome.validated ? 'yes, read back with the built-in reader' : 'no built-in reader for this format; size and hash compared'}`,
      'changes:',
      ...outcome.diff,
      'steps:',
      ...outcome.steps,
      ...(outcome.warning ? [outcome.warning] : [])
    ].join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: { output: outcome.output, source: source.virtual, provider: outcome.provider, validated: outcome.validated, changes: outcome.diff, steps: outcome.steps, ...(outcome.warning ? { warning: outcome.warning } : {}) }
    };
  } catch (error) {
    if (error instanceof EditRefused) return fail(error.message);
    throw error;
  }
}

export function registerFileEditTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.edit) return;
  reg.register(
    'file_edit',
    toolDeclaration('file_edit', () => ({
      title: 'Change document files',
      description:
        'install_provider: after the user agreed in chat, ask them in ParadigmEve\'s dialog to install an offered app. ' +
        'provider_tools: list its tools. edit (user wants it done): run them on a copy, saving a new file. open_visible (user wants to watch or learn): open a copy in the app for Computer use. The original never changes.',
      inputSchema: fileEditArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    })),
    async (args) => guard('file_edit', async (): Promise<ToolResult> => {
      if (!reg.caps.edit) return fail('TOOL_DISABLED: file_edit requires the Edit files permission in ParadigmEve.');
      const extra = (['path', 'steps', 'output_path'] as const).filter((key) => args[key] !== undefined);
      if ((args.op === 'install_provider' || args.op === 'provider_tools') && extra.length > 0) return fail(`INVALID_ARGUMENTS: ${args.op} takes only provider (not ${extra.join(', ')}).`);
      if (args.op === 'install_provider') return installProvider(args.provider);
      if (args.op === 'provider_tools') return providerTools(args.provider);
      if (args.op === 'open_visible') return openVisible(reg, args);
      return edit(reg, args);
    })
  );
}
