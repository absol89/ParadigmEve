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
  /** A worker Plan's exact parent step, and the parent revision it was delegated from. */
  sourceItemId: planIdSchema.optional(),
  sourceRevision: z.number().int().min(1).optional(),
  label: z.string().trim().min(1).max(240).optional()
}).strict();

/** Most nesting levels a Plan may have (a top-level step is level 1). */
export const PLAN_MAX_DEPTH = 4;
/** Most steps directly under one parent (or at the top level). */
export const PLAN_MAX_SIBLINGS = 100;
/** Most steps in one Plan, all levels together. */
export const PLAN_MAX_ITEMS = 400;

/**
 * Exact conversation material that created or changed one step. Metadata only: the archive is the
 * evidence, and a pruned recording never invalidates the step.
 */
export const planStepSourceSchema = z.object({
  sessionId: z.string().min(1).max(160),
  messageId: z.string().min(1).max(240),
  kind: z.enum(['voice', 'typed', 'tool'])
}).strict();

/** What a claimed step said when its claimant started it. Later revisions never change this. */
const planClaimSnapshotSchema = z.object({
  text: planItemTextSchema,
  details: planItemDetailsSchema,
  intent: z.string().trim().max(1_000).optional(),
  constraints: z.array(z.string().trim().min(1).max(500)).max(20).optional()
}).strict();

export const planItemClaimSchema = z.object({
  /** Who executes this step: an orchestrator or worker identity. */
  by: z.string().trim().min(1).max(120),
  /** The Plan revision the claim was made at. */
  revision: z.number().int().min(1),
  at: timestampSchema,
  snapshot: planClaimSnapshotSchema,
  /** Set when a later revision changed this step's wording, intent or constraints after the claim. */
  superseded: z.literal(true).optional()
}).strict();

const planItemFields = {
  text: planItemTextSchema,
  status: planItemStatusSchema,
  details: planItemDetailsSchema,
  priority: planPrioritySchema.optional(),
  reminderAt: timestampSchema.optional(),
  /** Parent step in this Plan. Absent for a top-level step. Priority applies within a level. */
  parentId: planIdSchema.optional(),
  /** Why this step exists, in the user's terms. Kept apart from `text` so rewording cannot lose it. */
  intent: z.string().trim().max(1_000).optional(),
  constraints: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  sources: z.array(planStepSourceSchema).max(20).optional()
};

/** A created step may carry its own id so later steps in the same request can name it as parent. */
export const planItemCreateSchema = z.object({ id: planIdSchema.optional(), ...planItemFields }).strict();
export const planItemUpdateSchema = z.object({ id: planIdSchema.optional(), ...planItemFields }).strict();
export const planItemSchema = z.object({ id: planIdSchema, ...planItemFields, claim: planItemClaimSchema.optional() }).strict();

type SequenceItem = { id?: string; status: string; parentId?: string; claim?: { by: string } };

/**
 * One in-progress step per claimant: unclaimed steps count as one shared claimant, so a Plan
 * without claims keeps the original "one step in progress" rule.
 */
function oneInProgressPerClaimant(items: ReadonlyArray<SequenceItem>): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.status !== 'in_progress') continue;
    const claimant = item.claim?.by ?? '';
    if (seen.has(claimant)) return false;
    seen.add(claimant);
  }
  return true;
}

/** Parents exist in this Plan, no cycles, at most PLAN_MAX_DEPTH levels and PLAN_MAX_SIBLINGS per level. */
export function validPlanHierarchy(items: ReadonlyArray<SequenceItem>): boolean {
  const byId = new Map(items.flatMap(item => item.id ? [[item.id, item] as const] : []));
  const siblings = new Map<string, number>();
  for (const item of items) {
    const key = item.parentId ?? '';
    siblings.set(key, (siblings.get(key) ?? 0) + 1);
    if (siblings.get(key)! > PLAN_MAX_SIBLINGS) return false;
    let depth = 1;
    let parent = item.parentId;
    while (parent !== undefined) {
      if (parent === item.id) return false;
      const next = byId.get(parent);
      if (!next) return false;
      depth += 1;
      if (depth > PLAN_MAX_DEPTH) return false;
      parent = next.parentId;
    }
  }
  return true;
}

function validItemSequence(items: ReadonlyArray<SequenceItem>): boolean {
  const ids = items.flatMap(item => item.id ? [item.id] : []);
  return new Set(ids).size === ids.length && oneInProgressPerClaimant(items) && validPlanHierarchy(items);
}

const createItemsSchema = z.array(planItemCreateSchema).min(1).max(PLAN_MAX_ITEMS)
  .refine(validItemSequence, 'Plan steps are invalid: ids must be unique, parents must exist without cycles within the depth and per-level limits, and at most one item can be in progress per claimant');
// Claims live in the stored Plan, not in an edit, so an edit's in-progress rule is checked on the
// merged record (planRecordSchema) instead of here.
const updateItemsSchema = z.array(planItemUpdateSchema).min(1).max(PLAN_MAX_ITEMS)
  .refine(items => {
    const ids = items.flatMap(item => item.id ? [item.id] : []);
    return new Set(ids).size === ids.length && validPlanHierarchy(items);
  }, 'Plan steps are invalid: ids must be unique, parents must exist without cycles within the depth and per-level limits, and at most one item can be in progress per claimant');

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
  items: z.array(planItemSchema).min(1).max(PLAN_MAX_ITEMS).refine(validItemSequence, 'Plan steps are invalid: ids must be unique, parents must exist without cycles within the depth and per-level limits, and at most one item can be in progress per claimant'),
  provenance: planProvenanceSchema.optional(),
  /**
   * Plan revision, starting at 1 and advanced by every accepted change to its steps. A claim records
   * the revision it was made at. Absent on Plans written before 2.3.6, which read as revision 1.
   */
  revision: z.number().int().min(1).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  archivedAt: timestampSchema.nullable(),
  /**
   * Set, together with archivedAt, when the user cancels a Plan that is no longer relevant. Its
   * checklist is kept exactly as it was, so an archived Plan is complete unless it was cancelled.
   */
  cancelledAt: timestampSchema.optional(),
  /**
   * The catalog revision written for the source chat's last accepted `update_plan`, kept while
   * the title and step text/order are unchanged. A worker's finish report at or after it proves
   * delivery for this checklist, even after the user archives the Plan and the chat's own
   * plan.json is cleared. A human title or step edit removes it and needs a newer report.
   */
  agentRevision: timestampSchema.optional()
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
export type PlanStepSource = z.infer<typeof planStepSourceSchema>;
export type PlanItemClaim = z.infer<typeof planItemClaimSchema>;
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
