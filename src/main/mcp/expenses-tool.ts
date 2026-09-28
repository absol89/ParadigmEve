import { createHash } from 'node:crypto';
import { z } from 'zod';
import { currentCaller } from './call-context.js';
import { fail, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
import { getConfig, effectiveCapabilities } from '../config.js';
import { goalWorkerChat } from '../bridge.js';
import { isChatBlocked } from '../session/blocked-chats.js';
import { compactingConversation } from '../session/continuation.js';
import { getSession, readAsset, readEvents } from '../session/store.js';
import { ATTACHMENT_CHUNK_BYTES, readInputAttachmentChunk } from '../session/input-attachments.js';
import { assignSessionProject, getProject, projectWorkspace } from '../projects.js';
import { hasExpensesDataReference, resolveCanonicalExpensesProject, resolveExpensesDataProject, resolveExpensesProject } from '../expenses-project.js';
import { readExpensesLedger, recordExpense, correctExpense, deleteRetainedExpenseReceipt } from '../expenses-ledger.js';
import { expenseFactsInputSchema, expenseRetentionSchema, defaultExpenseRetention, deriveExpenseSummary } from '../../shared/expenses.js';
import { EXPENSES_INSTRUCTIONS } from '../../shared/expenses-template.js';
import { positionOf } from '../../shared/chronology.js';
import { userPromptText } from '../../shared/user-prompt.js';
import { sharedEveOwnerForCurrentCall } from '../eve-access.js';

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const paging = { offset: z.number().int().min(0).max(20000).default(0), limit: z.number().int().min(1).max(25).default(10) };
export const expensesReadToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), ...paging, recordId: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal('summary'), ...paging }).strict()
]);
// correct replaces the whole facts object: omitted keys must not silently erase recorded evidence.
const REPLACED_FACT_KEYS = ['purchasedOn', 'merchant', 'location', 'currency', 'total', 'items', 'notes'] as const;
const correctedFactsSchema = z.preprocess((facts, ctx) => {
  if (facts && typeof facts === 'object' && !Array.isArray(facts)) {
    for (const key of REPLACED_FACT_KEYS) {
      if (!(key in facts)) ctx.addIssue({ code: 'custom', path: [key], message: 'required for correct; resend the full corrected facts from expenses_read', input: facts });
    }
  }
  return facts;
}, expenseFactsInputSchema);
export const expensesMutationToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('record'), expectedRevision: revision,
    sourceIndex: z.number().int().min(0).max(99).default(0).describe('Image ordinal in the current user message. Omit for text or a single image.'),
    sourceKind: z.enum(['text', 'image']).default('text'),
    facts: expenseFactsInputSchema,
    retention: expenseRetentionSchema.default(defaultExpenseRetention) }).strict(),
  z.object({ action: z.literal('correct'), expectedRevision: revision, recordId: z.string().uuid(),
    facts: correctedFactsSchema, retention: expenseRetentionSchema,
    reason: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ action: z.literal('delete_retained_receipt'), expectedRevision: revision, recordId: z.string().uuid(),
    status: z.enum(['not-retained', 'declined']).default('declined'), reason: z.string().trim().min(1).max(1000) }).strict()
]);
export const expensesToolSchema = z.union([expensesReadToolSchema, expensesMutationToolSchema])
  .refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 200_000, 'Expense input exceeds 200 KB');

const expensesReadWireSchema = z.object({
  action: z.enum(['read', 'summary']),
  offset: z.number().optional(),
  limit: z.number().optional(),
  recordId: z.string().optional()
}).strict();
// The wire schema stays permissive so the handler, not an SDK protocol error, owns every
// rejection. It must still publish the exact facts contract: facts is otherwise an opaque value.
const EXPENSE_FACTS_CONTRACT = 'Only these keys. Required, null if absent: purchasedOn YYYY-MM-DD, merchant, currency e.g. SEK, total decimal string e.g. "208.18". Optional: financialKind purchase|bill|transfer|income, location, rawDateText, rawMerchant, subtotal, discount, tax, paymentCardLast4, paymentReference, transferAccount, defaultBudgetBucket, notes, confidence, uncertainties[], items[]. Item: rawName required; optional id, normalizedName, category, quantity, unit, brand, unitPrice, amount, budgetBucket, confidence, warranty{candidate,reason}. Example: {"purchasedOn":"2026-09-28","merchant":"Lidl","currency":"SEK","total":"208.18","items":[{"rawName":"Mjölk","amount":"15.90"}]}';
const expensesMutationWireSchema = z.object({
  action: z.enum(['record', 'correct', 'delete_retained_receipt']),
  expectedRevision: z.number().optional(),
  recordId: z.string().optional(),
  sourceIndex: z.number().optional(),
  sourceKind: z.string().optional(),
  facts: z.unknown().optional().describe(EXPENSE_FACTS_CONTRACT),
  retention: z.unknown().optional(),
  status: z.string().optional(),
  reason: z.string().optional()
}).strict();

/** Names each rejected field so the caller can repair its own call instead of asking the user. */
export function expenseInputIssues(error: z.ZodError, limit = 8): string {
  const issues = error.issues.flatMap(issue => issue.code === 'invalid_union' && issue.errors.length
    ? issue.errors.reduce((best, branch) => branch.length < best.length ? branch : best).map(branch => ({ ...branch, path: [...issue.path, ...branch.path] }))
    : [issue]);
  const lines = issues.slice(0, limit).map(issue => {
    const at = issue.path.reduce<string>((text, key) => typeof key === 'number' ? text + '[' + key + ']' : text ? text + '.' + String(key) : String(key), '') || '(input)';
    return at + ': ' + (issue.code === 'invalid_type' && /received undefined$/.test(issue.message) ? 'required' : issue.message);
  });
  return lines.join('; ') + (issues.length > limit ? '; +' + (issues.length - limit) + ' more' : '');
}

class ExpensesRefusal extends Error {}
const refuse = (message: string): never => { throw new ExpensesRefusal(message); };
const MAX_RESPONSE_BYTES = 96_000;
const MAX_EXPENSE_SOURCE_HASH_BYTES = 20 * 1024 * 1024;

async function latestUser(sessionId: string) {
  // A bounded complete user-message window is required: a revised old message must
  // never become the selector merely because its revision has the newest sequence.
  const events = await readEvents(sessionId, { kinds: ['user_message'], limit: 5001 });
  if (events.length > 5000) return refuse('Expense source history exceeds the bounded window. Open a new Expenses project chat.');
  const event = events.filter(row => row.kind === 'user_message')
    .sort((a, b) => positionOf(a) - positionOf(b) || a.seq - b.seq).at(-1);
  if (!event?.messageId || event.inputDelivery === 'offered' || event.message.truncated) {
    return refuse('The latest complete user message is not recorded yet. Retry after the companion records it.');
  }
  return { event, text: event.authoredText ?? userPromptText(event.message.text) ?? event.message.text };
}

async function hashRecordedAsset(sessionId: string, asset: { id: string; bytes: number }): Promise<string | null> {
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > MAX_EXPENSE_SOURCE_HASH_BYTES) return null;
  const bytes = await readAsset(sessionId, asset.id, asset.bytes);
  if (!bytes || bytes.length !== asset.bytes) return null;
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashStagedAttachment(attachment: { id: string; name: string; size: number; mimeType: string; preview?: string }): Promise<string | null> {
  if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > MAX_EXPENSE_SOURCE_HASH_BYTES) return null;
  const hash = createHash('sha256');
  let total = 0;
  try {
    for (let offset = 0; offset < attachment.size; offset += ATTACHMENT_CHUNK_BYTES) {
      const chunk = Buffer.from(await readInputAttachmentChunk(attachment, offset), 'base64');
      if (!chunk.length || total + chunk.length > attachment.size) return null;
      hash.update(chunk);
      total += chunk.length;
    }
  } catch {
    return null;
  }
  return total === attachment.size ? hash.digest('hex') : null;
}

async function expenseSource(sessionId: string, conversationId: string, event: Awaited<ReturnType<typeof latestUser>>['event'], sourceIndex: number) {
  const assetImages = (event.assets ?? []).filter(asset => asset.mimeType.startsWith('image/'));
  const attachmentImages = (event.attachments ?? []).filter(attachment => attachment.mimeType.startsWith('image/'));
  const imageCount = assetImages.length + attachmentImages.length;
  if (!imageCount) {
    if (sourceIndex !== 0) refuse('The latest user message has no image at that source index.');
    return { kind: 'text' as const, sessionId, conversationId, messageId: event.messageId!, sourceIndex: 0, sha256: null };
  }
  if (sourceIndex >= imageCount) refuse('The selected source index does not name an image in the latest user message.');
  let sha256: string | null = null;
  if (sourceIndex < assetImages.length) {
    sha256 = await hashRecordedAsset(sessionId, assetImages[sourceIndex]!);
  } else if (event.inputId) {
    // Only an app-authored inputId proves these attachment ids still name Eve's immutable
    // staging originals. Native ChatGPT attachment metadata alone grants no byte custody.
    sha256 = await hashStagedAttachment(attachmentImages[sourceIndex - assetImages.length]!);
  }
  return { kind: 'image' as const, sessionId, conversationId, messageId: event.messageId!, sourceIndex, sha256 };
}

/** One transaction adapter over the existing exact-call and local project owners. */
export function registerExpensesTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.read) return;
  const execute = async (args: z.infer<typeof expensesToolSchema>) => {
    try {
      const caller = currentCaller();
      if (!caller.requestId) return fail('A model-issued connector request id is required for Expenses.');
      const sharedOwner = sharedEveOwnerForCurrentCall();
      const exactLocal = Boolean(caller.sessionId && caller.conversationId);
      if (!exactLocal && !sharedOwner) return fail('Exact local chat identity is required unless Eve access from other ChatGPT chats and devices is enabled.');
      const sessionId = caller.sessionId ?? null;
      const conversationId = caller.conversationId ?? null;
      const mutation = args.action === 'record' || args.action === 'correct' || args.action === 'delete_retained_receipt';
      const checkPermissions = () => {
        const live = effectiveCapabilities(getConfig());
        if (!reg.caps.read || !live.read) refuse('TOOL_DISABLED: Expenses requires file read permission.');
        if (args.action === 'delete_retained_receipt') {
          if (!reg.caps.edit || !live.edit || !reg.caps.deleteFile || !live.deleteFile) refuse('TOOL_DISABLED: Retained receipt deletion requires edit and delete-file permissions.');
        } else if (mutation && (!reg.caps.create || !reg.caps.edit || !live.create || !live.edit)) {
          refuse('TOOL_DISABLED: Expenses transactions require create and edit permissions.');
        }
        if (conversationId && (isChatBlocked(conversationId) || compactingConversation(conversationId))) refuse('This chat is blocked or being replaced. No expense was changed.');
        if (mutation && conversationId && goalWorkerChat(conversationId)) refuse('Workers and decision helpers cannot change expense records.');
      };
      checkPermissions();

      let source: Awaited<ReturnType<typeof latestUser>> | null = null;
      let project;
      let authorize: () => Promise<void>;
      if (exactLocal) {
        const exactSessionId = sessionId!;
        const exactConversationId = conversationId!;
        const session = await getSession(exactSessionId);
        if (!session || session.conversationId !== exactConversationId) return fail('This expense call belongs to a replaced chat.');
        if (mutation && (session.origin?.kind === 'worker' || session.origin?.kind === 'helper')) return fail('Workers and decision helpers cannot change expense records.');
        source = await latestUser(exactSessionId);
        const boundProject = session.projectId ? await getProject(session.projectId) : null;
        const boundExpensesId = boundProject?.template?.id === 'expenses' ? boundProject.id : null;
        const explicitlyResolved = await resolveExpensesProject(source.text, boundExpensesId);
        const dataReference = hasExpensesDataReference(source.text);
        const dataProject = !explicitlyResolved && dataReference ? await resolveExpensesDataProject(source.text) : null;
        // A #expenses reference never falls through to broad shared-Eve project borrowing: a real
        // same-name Quilt shadows the built-in alias. The alias does grant ledger authority (a chat
        // may decide to record something after discussing it); it only never activates the Thread prompt.
        project = explicitlyResolved ?? dataProject ?? (!dataReference && sharedOwner ? await resolveCanonicalExpensesProject() : null);
        if (!project) return fail('Select the local Expenses project, or explicitly name its bound %Thread in your message.');
        // The first write from an unbound #expenses chat binds it, like %expenses, so the rest of the
        // conversation keeps ledger authority without repeating the alias. Reads never bind, and a chat
        // already bound to another project is never rebound: it borrows per message instead.
        const bindsDataProject = mutation && !session.projectId && !explicitlyResolved && !!dataProject;
        const borrowedDataProject = !explicitlyResolved && !bindsDataProject && dataProject?.id === project.id;
        const borrowedProject = !explicitlyResolved && !borrowedDataProject && sharedOwner !== null;
        // Read-only queries resolve Threads without changing durable session ownership.
        const readWithoutBinding = !mutation && !!explicitlyResolved && !session.projectId;
        if (mutation && !session.projectId && (explicitlyResolved || bindsDataProject)) await assignSessionProject(exactSessionId, project.id);
        const selectedProject = project;
        const selectedMessage = source;
        authorize = async () => {
          checkPermissions();
          const current = await getSession(exactSessionId);
          if (!current || current.conversationId !== exactConversationId) return refuse('Expense chat ownership changed. Retry from its current project chat.');
          const latest = await latestUser(exactSessionId);
          if (latest.event.messageId !== selectedMessage.event.messageId || latest.event.seq !== selectedMessage.event.seq) refuse('A newer user message changed this expense operation. Read it before retrying.');
          if (borrowedDataProject) {
            const selected = await resolveExpensesDataProject(latest.text);
            if (selected?.id !== selectedProject.id) refuse('The #expenses data reference changed or is now shadowed by a real Quilt.');
          } else if (borrowedProject) {
            if (sharedEveOwnerForCurrentCall() !== sharedOwner) refuse('Cross-chat Eve access changed while this expense operation was running.');
            const selected = await resolveCanonicalExpensesProject();
            if (selected?.id !== selectedProject.id) refuse('The canonical Expenses project changed.');
          } else if (readWithoutBinding) {
            if (current.projectId !== session.projectId) refuse('The chat project changed during this read.');
            const selected = await resolveExpensesProject(latest.text);
            if (selected?.id !== selectedProject.id) refuse('The selected Expenses Thread changed.');
          } else {
            if (current.projectId !== selectedProject.id) return refuse('Expense chat ownership changed. Retry from its current project chat.');
            const selected = await resolveExpensesProject(latest.text, current.projectId);
            if (selected?.id !== selectedProject.id) refuse('The selected Expenses project changed.');
          }
          checkPermissions();
        };
      } else {
        project = await resolveCanonicalExpensesProject();
        if (!project) return fail('No canonical local Expenses project is linked yet. Start %expenses once on this Eve installation.');
        const selectedProject = project;
        const owner = sharedOwner!;
        authorize = async () => {
          checkPermissions();
          if (sharedEveOwnerForCurrentCall() !== owner) refuse('Cross-chat Eve access changed while this expense operation was running.');
          const selected = await resolveCanonicalExpensesProject();
          if (selected?.id !== selectedProject.id) refuse('The canonical Expenses project changed.');
        };
      }
      const folder = await projectWorkspace(project.id);
      const stableFolder = folder.real;
      const guardedAuthorize = async () => {
        await authorize();
        if ((await projectWorkspace(project.id)).real !== stableFolder) refuse('The selected Expenses project changed.');
      };
      await guardedAuthorize();
      let result: unknown;
      if (args.action === 'record') {
        const derivedSource = source
          ? await expenseSource(sessionId!, conversationId!, source.event, args.sourceIndex)
          : { origin: 'connector' as const, kind: args.sourceKind, requestId: caller.requestId!, sourceIndex: args.sourceIndex,
              sha256: args.sourceKind === 'image' && args.retention.status === 'retained' ? args.retention.sha256 : null };
        const remoteRetention = source || args.retention.status === 'not-retained' || args.retention.status === 'retained'
          ? args.retention
          : { ...args.retention, userChoiceMessageId: null, userChoiceRequestId: caller.requestId! };
        const saved = await recordExpense(folder.real, { expectedRevision: args.expectedRevision, draft: {
          source: derivedSource,
          facts: args.facts, retention: remoteRetention
        } }, guardedAuthorize);
        result = { revision: saved.revision, recordId: saved.record.id, duplicate: saved.duplicate, warnings: saved.warnings };
      } else if (args.action === 'correct') {
        const provenance = source
          ? { sourceMessageId: source.event.messageId!, actor: { sessionId: sessionId!, conversationId: conversationId! } }
          : { sourceRequestId: caller.requestId!, actor: { kind: 'connector' as const, requestId: caller.requestId! } };
        const saved = await correctExpense(folder.real, { expectedRevision: args.expectedRevision, recordId: args.recordId,
          facts: args.facts, retention: args.retention, reason: args.reason, ...provenance
        }, guardedAuthorize);
        result = { revision: saved.revision, recordId: saved.record.id };
      } else if (args.action === 'delete_retained_receipt') {
        const provenance = source
          ? { sourceMessageId: source.event.messageId!, actor: { sessionId: sessionId!, conversationId: conversationId! } }
          : { sourceRequestId: caller.requestId!, actor: { kind: 'connector' as const, requestId: caller.requestId! } };
        result = await deleteRetainedExpenseReceipt(folder.real, { expectedRevision: args.expectedRevision, recordId: args.recordId,
          status: args.status, reason: args.reason, ...provenance
        }, guardedAuthorize);
      } else {
        const ledger = await readExpensesLedger(folder.real, guardedAuthorize);
        await guardedAuthorize();
        if (args.action === 'read') {
          if (args.recordId) {
            const record = ledger.records.find(row => row.id === args.recordId);
            if (!record) return fail('Expense record was not found in the selected project.');
            const items = record.facts.items.slice(args.offset, args.offset + args.limit);
            result = { revision: ledger.revision, record: { ...record, facts: { ...record.facts, items } }, itemCount: record.facts.items.length,
              nextOffset: args.offset + items.length < record.facts.items.length ? args.offset + items.length : null };
          } else {
            const records = ledger.records.slice(args.offset, args.offset + args.limit).map(row => ({
              id: row.id, financialKind: row.facts.financialKind, purchasedOn: row.facts.purchasedOn,
              rawDateText: row.facts.rawDateText, merchant: row.facts.merchant, currency: row.facts.currency,
              total: row.facts.total, defaultBudgetBucket: row.facts.defaultBudgetBucket,
              transferAccount: row.facts.transferAccount, itemCount: row.facts.items.length, retention: row.retention.status
            }));
            result = { revision: ledger.revision, records, recordCount: ledger.records.length,
              nextOffset: args.offset + records.length < ledger.records.length ? args.offset + records.length : null };
          }
        } else {
          const summary = deriveExpenseSummary(ledger);
          const candidates = summary.warrantyCandidates.slice(args.offset, args.offset + args.limit);
          result = { ...summary, warrantyCandidates: candidates, warrantyCandidateCount: summary.warrantyCandidates.length,
            nextOffset: args.offset + candidates.length < summary.warrantyCandidates.length ? args.offset + candidates.length : null };
        }
      }
      const text = JSON.stringify({ result, project: folder.virtual, instructions: mutation
        ? EXPENSES_INSTRUCTIONS
        : 'Ledger data only. Use expenses_read for further reads or summary pages. This read does not activate the Expenses Thread prompt.' });
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        return ok(JSON.stringify({ result: 'Operation completed. The detailed result exceeds the response budget; read with a smaller limit.', action: args.action }));
      }
      return ok(text);
    } catch (error) {
      if (error instanceof ExpensesRefusal) return fail(error.message);
      throw error;
    }
  };

  reg.register('expenses_read', toolDeclaration('expenses_read', () => ({
    title: 'Expenses read',
    description: 'Read or summarize the canonical local Expenses ledger. This tool is data-only and never records, corrects, deletes, retains, or rebinds a project. #expenses uses this read-only path; a real same-name #expenses Quilt shadows the built-in alias.',
    inputSchema: expensesReadWireSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), wireArgs => guard('expenses_read', async () => {
    const parsed = expensesReadToolSchema.safeParse(wireArgs);
    if (!parsed.success) return fail('Invalid Expenses read input. Use read or summary with bounded pagination: ' + expenseInputIssues(parsed.error));
    return execute(parsed.data);
  }));

  if (!reg.exposedCaps.create || !reg.exposedCaps.edit) return;
  reg.register('expenses', toolDeclaration('expenses', () => ({
    title: 'Expenses',
    description: 'Mutate the canonical Expenses ledger after reading it with expenses_read. record uses expectedRevision + facts (+ sourceKind/sourceIndex for remote evidence); correct uses expectedRevision + recordId + facts + retention + reason; delete_retained_receipt uses expectedRevision + recordId + reason. %expenses and Start-from-Thread retain normal write-capable use. #expenses is data-only and cannot authorize this tool. Workers and decision helpers cannot mutate.',
    inputSchema: expensesMutationWireSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), wireArgs => guard('expenses', async () => {
    const parsed = expensesMutationToolSchema.safeParse(wireArgs);
    if (!parsed.success) return fail('Invalid Expenses mutation input; the ledger and its revision are unchanged. Fix these fields and retry: ' +
      expenseInputIssues(parsed.error) + '. facts contract: ' + EXPENSE_FACTS_CONTRACT);
    return execute(parsed.data);
  }));
}
