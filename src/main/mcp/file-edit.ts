import { z } from 'zod';
import { requestFileProviderInstall } from '../file-provider-consent.js';
import { toolDeclaration } from './tool-declarations.js';
import { fail, guard, ok, type SurfaceRegistrar, type ToolResult } from './kernel.js';

/**
 * The changing half of the file broker. file_action stays read-only so ChatGPT never asks the user
 * to confirm a read; everything that changes the machine or a file lives here (compare
 * expenses_read / expenses). Provider tools never appear on Core: this tool reaches an installed
 * provider only through PluginManager.
 */
export const fileEditArgs = z.object({
  op: z.literal('install_provider'),
  // Validated against the registry by the consent owner; an enum would cost every chat's tools/list.
  provider: z.string().regex(/^artcraft\.[a-z]+$/).describe('Id from a file_action provider_offer.')
}).strict();

type FileEditArgs = z.output<typeof fileEditArgs>;

async function installProvider(args: FileEditArgs): Promise<ToolResult> {
  const outcome = await requestFileProviderInstall(args.provider);
  switch (outcome.status) {
    case 'installed':
      return ok(`INSTALLED: ${args.provider} ${outcome.version} is installed for this user and passed its health check.`);
    case 'already-installed':
      return ok(`ALREADY_INSTALLED: ${args.provider} ${outcome.version} is already installed.`);
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

export function registerFileEditTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.edit) return;
  reg.register(
    'file_edit',
    toolDeclaration('file_edit', () => ({
      title: 'Change document files',
      description: 'install_provider: ask the user, in ParadigmEve\'s own dialog, to install the free app from a file_action provider_offer. Call only after the user agreed in chat.',
      inputSchema: fileEditArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    })),
    async (args) => guard('file_edit', async (): Promise<ToolResult> => {
      if (!reg.caps.edit) return fail('TOOL_DISABLED: file_edit requires the Edit files permission in ParadigmEve.');
      return installProvider(args);
    })
  );
}
