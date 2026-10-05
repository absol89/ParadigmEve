import { z } from 'zod';

/** Codex's update_plan contract, with optional per-step detail for the desktop view. */
// The key shape is checked in validStepTree, not as a JSON-schema pattern, to keep the tool
// declaration ChatGPT downloads small.
const STEP_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/i;
const stepKeySchema = z.string().max(40);

/** Parent keys exist, no cycles, at most 4 levels, keys unique. */
function validStepTree(steps: ReadonlyArray<{ key?: string; parent?: string }>): boolean {
  const byKey = new Map<string, { parent?: string }>();
  for (const step of steps) {
    if (step.parent !== undefined && !STEP_KEY.test(step.parent)) return false;
    if (step.key === undefined) continue;
    if (!STEP_KEY.test(step.key)) return false;
    if (byKey.has(step.key)) return false;
    byKey.set(step.key, step);
  }
  for (const step of steps) {
    let depth = 1;
    let parent = step.parent;
    while (parent !== undefined) {
      if (parent === step.key) return false;
      const next = byKey.get(parent);
      if (!next) return false;
      depth += 1;
      if (depth > 4) return false;
      parent = next.parent;
    }
  }
  return true;
}

export const agentPlanUpdateSchema = z.object({
  explanation: z.string().trim().max(1000).optional().describe('Why the plan changed.'),
  plan: z.array(z.object({
    step: z.string().trim().min(1).max(160).describe('Short headline shown to the user.'),
    status: z.enum(['pending', 'in_progress', 'completed']),
    details: z.string().trim().max(2000).optional().describe('Approach, checks or remaining work.'),
    key: stepKeySchema.optional(),
    parent: stepKeySchema.optional(),
    intent: z.string().trim().max(1000).optional(),
    constraints: z.array(z.string().trim().min(1).max(500)).max(20).optional()
  }).strict()).max(60)
    .refine(steps => steps.filter(step => step.status === 'in_progress').length <= 1, 'At most one step may be in_progress.')
    .refine(validStepTree, 'Step keys (letters, digits, dashes) must be unique; each parent must be another step key, at most 4 levels deep.')
    .refine(steps => steps.reduce((size, step) => size + step.step.length + (step.details?.length ?? 0) + (step.intent?.length ?? 0) +
      (step.constraints ?? []).reduce((sum, constraint) => sum + constraint.length, 0), 0) <= 24000, 'Keep the complete plan below 24,000 characters.')
    .describe('The complete plan; [] clears it.'),
  send_to_orchestrator: z.boolean().optional()
    .describe('Only if the user asked to send it.')
}).strict();

export const agentPlanSchema = agentPlanUpdateSchema.extend({ updatedAt: z.number().finite().nonnegative() });
export type AgentPlanUpdate = z.infer<typeof agentPlanUpdateSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;

/** UTF-8, including JSON escapes and the server timestamp; also the bounded disk-read size. */
export const MAX_AGENT_PLAN_BYTES = 96 * 1024;
