import { z } from 'zod';

export const PLAN_ITEM_STATUSES = ['todo', 'in_progress', 'done'] as const;
export const PLAN_PRIORITIES = ['low', 'medium', 'high'] as const;
export const PLAN_PROVENANCE_KINDS = ['manual', 'message', 'result', 'plan'] as const;

const timestampSchema = z.number().finite().int().nonnegative();
const planTitleSchema = z.string().trim().min(1).max(160);
const planItemTextSchema = z.string().trim().min(1).max(1_000);
const planItemDetailsSchema = z.string().trim().max(2_000).optional();

export const planPrioritySchema = z.enum(PLAN_PRIORITIES);
export const planItemStatusSchema = z.enum(PLAN_ITEM_STATUSES);
export const planIdSchema = z.string().uuid();

/**
 * Exact source identifiers are retained as metadata only. A Plan does not depend on the
 * source chat/session continuing to exist, so pruning recordings cannot invalidate it.
 */
export const planProvenanceSchema = z.object({
  kind: z.enum(PLAN_PROVENANCE_KINDS),
  /** Exact owning user-facing Thread. When present, this is the Plan's primary Source/context anchor. */
  threadId: z.string().uuid().optional(),
  sessionId: z.string().min(1).max(160).optional(),
  conversationId: z.string().min(1).max(160).optional(),
  messageId: z.string().min(1).max(240).optional(),
  toolCallId: z.string().min(1).max(240).optional(),
  sourcePlanId: planIdSchema.optional(),
  label: z.string().trim().min(1).max(240).optional()
}).strict();

const planItemFields = {
  text: planItemTextSchema,
  status: planItemStatusSchema,
  details: planItemDetailsSchema,
  priority: planPrioritySchema.optional(),
  reminderAt: timestampSchema.optional()
};

export const planItemCreateSchema = z.object(planItemFields).strict();
export const planItemUpdateSchema = z.object({ id: planIdSchema.optional(), ...planItemFields }).strict();
export const planItemSchema = z.object({ id: planIdSchema, ...planItemFields }).strict();

function validItemSequence(items: ReadonlyArray<{ id?: string; status: string }>): boolean {
  const ids = items.flatMap(item => item.id ? [item.id] : []);
  return new Set(ids).size === ids.length && items.filter(item => item.status === 'in_progress').length <= 1;
}

const createItemsSchema = z.array(planItemCreateSchema).min(1).max(100)
  .refine(validItemSequence, 'A Plan can have at most one in-progress item');
const updateItemsSchema = z.array(planItemUpdateSchema).min(1).max(100)
  .refine(validItemSequence, 'Plan item ids must be unique and at most one item can be in progress');

export const planCreateSchema = z.object({
  title: planTitleSchema,
  items: createItemsSchema,
  provenance: planProvenanceSchema.optional()
}).strict();

export const planPatchSchema = z.object({
  title: planTitleSchema.optional(),
  items: updateItemsSchema.optional()
}).strict().refine(value => value.title !== undefined || value.items !== undefined, 'Plan update is empty');

export const planUpdateRequestSchema = z.object({
  id: planIdSchema,
  expectedUpdatedAt: timestampSchema,
  patch: planPatchSchema
}).strict();

export const planArchiveRequestSchema = z.object({ id: planIdSchema }).strict();

export const planRecordSchema = z.object({
  id: planIdSchema,
  title: planTitleSchema,
  items: z.array(planItemSchema).min(1).max(100).refine(validItemSequence, 'Plan items are invalid'),
  provenance: planProvenanceSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  archivedAt: timestampSchema.nullable(),
  /**
   * Set, together with archivedAt, when the user cancels a Plan that is no longer relevant. Its
   * checklist is kept exactly as it was, so an archived Plan is complete unless it was cancelled.
   */
  cancelledAt: timestampSchema.optional()
}).strict().refine(plan => plan.updatedAt >= plan.createdAt, 'Plan update time is invalid')
  .refine(plan => plan.archivedAt === null || plan.archivedAt >= plan.createdAt, 'Plan archive time is invalid')
  .refine(plan => plan.cancelledAt === undefined || plan.cancelledAt === plan.archivedAt, 'Plan cancel time is invalid')
  .refine(plan => plan.archivedAt === null || plan.cancelledAt !== undefined || plan.items.every(item => item.status === 'done'),
    'Archived Plans must be complete unless cancelled');

/**
 * Most Plans the catalog holds, live and archived together. Every reader and writer of the catalog
 * (including the chat review heartbeat) uses this one bound; see MAX_PLANS in main/plans.ts.
 */
export const PLAN_CATALOG_MAX = 5_000;

export const planCatalogSchema = z.object({
  version: z.literal(1),
  plans: z.array(planRecordSchema).max(PLAN_CATALOG_MAX)
}).strict().refine(value => new Set(value.plans.map(plan => plan.id)).size === value.plans.length, 'Plan ids must be unique');

export type PlanPriority = z.infer<typeof planPrioritySchema>;
export type PlanItemStatus = z.infer<typeof planItemStatusSchema>;
export type PlanProvenance = z.infer<typeof planProvenanceSchema>;
export type PlanItemCreate = z.infer<typeof planItemCreateSchema>;
export type PlanItemUpdate = z.infer<typeof planItemUpdateSchema>;
export type PlanItem = z.infer<typeof planItemSchema>;
export type PlanCreate = z.infer<typeof planCreateSchema>;
export type PlanPatch = z.infer<typeof planPatchSchema>;
export type PlanRecord = z.infer<typeof planRecordSchema>;

export type PlanSection = 'live' | 'done';
export type PlanAudience = 'human' | 'eve';

/** Renderer-facing projection. Completion and navigation hints are derived, never persisted. */
export type PlanView = PlanRecord & {
  section: PlanSection;
  /** Human-facing milestones stay in Plans; worker execution history is grouped for Eve. */
  audience: PlanAudience;
  /**
   * Non-persisted worker identity/report proof for Eve Activity presentation.
   * `reportedToPrime` is true only when a finish report generated at or after this Plan revision
   * has the same stable broker message id as a durable recipient-side delivery receipt. Worker
   * finish success or sender-side queue acceptance alone is not enough. This proof is informative:
   * it does not create a Plan step and does not gate Ready-to-archive once the real work is done.
   */
  worker?: { id: string; reportedToPrime: boolean; reportMessageId?: string };
  readyToArchive: boolean;
  currentItemId: string | null;
  nextItemId: string | null;
  nextReminderAt: number | null;
};

export interface PlanLibrary {
  live: PlanView[];
  done: PlanView[];
}
