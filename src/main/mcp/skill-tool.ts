import { z } from 'zod';
import { currentCall } from './call-context.js';
import { fail, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
import { currentAgentConversationId } from '../agent-identity.js';
import { resolvePath } from '../sandbox.js';
import { createSkill, importSkill, updateSkill, viewSkill } from '../skills.js';

const schema = z.object({
  action: z.enum(['view', 'create', 'update', 'import']),
  name: z.string().min(1).max(80),
  file: z.string().min(1).max(240).optional(),
  skill_md: z.string().min(1).max(131_072).optional(),
  source: z.string().min(1).max(4096).optional()
}).strict();

export function registerSkillTools(reg: SurfaceRegistrar): void {
  reg.register('skills', toolDeclaration('skills', () => ({
    title: 'Skills',
    description: 'Load a matching skill lazily. The exact Eve/Eva owner may create/update Eve-owned skills or import an external SKILL.md package from an approved path; external skills are read-only.',
    inputSchema: schema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  })), args => guard('skills', async () => {
    if (args.action === 'view') {
      if (args.skill_md !== undefined || args.source !== undefined) return fail('INVALID_ARGUMENTS: view does not accept skill_md or source.');
      try { return ok(JSON.stringify(await viewSkill(args.name, args.file ?? 'SKILL.md'))); }
      catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    }
    if (args.file !== undefined) return fail('INVALID_ARGUMENTS: create/update/import do not accept file.');
    if (reg.ctx.readOnly) return fail('TOOL_DISABLED: ParadigmEve is in read-only mode; no skill was changed.');
    const owner = currentAgentConversationId();
    if (!owner || currentCall()?.caller.conversationId !== owner) return fail('Exact Eve/Eva owner chat identity is required to change skills; no skill was changed.');
    try {
      if (args.action === 'import') {
        if (!args.source || args.skill_md !== undefined) return fail('INVALID_ARGUMENTS: import requires source and does not accept skill_md.');
        if (reg.ctx.caps.read !== true) return fail('TOOL_DISABLED: importing a skill requires read access to its approved source path.');
        const source = await resolvePath(reg.ctx.roots, args.source);
        const result = await importSkill(source.real, args.name);
        return ok(`Skill ${result.name} imported as externally owned at revision ${result.revision}.`);
      }
      if (args.source !== undefined) return fail('INVALID_ARGUMENTS: create/update do not accept source.');
      if (!args.skill_md) return fail('INVALID_ARGUMENTS: create/update require skill_md.');
      const result = args.action === 'create' ? await createSkill(args.name, args.skill_md) : await updateSkill(args.name, args.skill_md);
      return ok(`Skill ${result.name} ${args.action === 'create' ? 'created' : 'updated'} at revision ${result.revision}.`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }));
}
