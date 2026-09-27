# Expenses inbox specification

This document is the integrated product contract for the Expenses sample project. It ties the
recurring receipt inbox, local ledger, monthly budget view, optional receipt retention and later
bank reconciliation into one workflow. Current user instructions take precedence over older
research notes when they disagree with this file.

## User model: one recurring inbox, one local project

Expenses should feel like one familiar inbox. The user can keep sending purchase text or receipt
images to the established Expenses conversation instead of planning a new chat for every purchase.

The conversation is a convenient entry point, not the data authority. The linked local Expenses
project owns the canonical structured data. Its stored legacy `quiltId` binds the project to its
user-facing `%expenses` Thread even if that Thread is renamed later. A chat already bound to the
Expenses project may accept ordinary purchase messages. A fresh chat can select the linked project by
typing the linked `%thread`, explicitly starting a chat from that Thread in Pins, or using the built-in
`#expenses` convenience alias. The alias exists only when no real user Quilt named `#expenses` exists;
an actual `#expenses` Quilt keeps normal broad, data-only Quilt semantics and does not select the project.

The Thread holds preferences and useful findings. Its editable Thread prompt is standing opening
guidance for how Eve should handle Expenses; it is separate from Pins and from the canonical ledger.
The project folder owns `data/ledger.json`, optional user-retained originals under `receipts/`, and
future local reconciliation state.

## Canonical receipt ledger

Each accepted purchase becomes a structured local record with immutable source provenance and
audited corrections. The useful facts include, when the evidence supports them:

- purchase date, merchant/raw merchant, store or location, currency and paid/printed total;
- subtotal, discounts, tax and other visible arithmetic that explains the total;
- line items, raw and normalized names, category, quantity, unit, unit price and amount;
- confidence and explicit uncertainty rather than invented unreadable values;
- monthly budget allocation; and
- warranty/return candidates plus receipt-retention state.

Receipt layout is not a schema. A date may appear near the header, payment block, footer or another
part of the receipt. Eve should capture the best-supported purchase date from the evidence and keep
uncertainty visible when it cannot be resolved. A faded receipt is still useful evidence; faded text
is not permission to fill in a number from context.

Batch layout is not a transaction boundary either. One phone photo may contain several distinct
receipts; each supported transaction is recorded separately while retaining that photo's source index.
`sourceIndex` is the image ordinal in the current user message, never a receipt ordinal invented from
the contents of the photo. The inverse also occurs: one purchase may have an itemized receipt plus a
matching card slip/customer copy. Matching corroborating papers for the same merchant/date/amount are
one transaction and are counted once.

Corrections change the current structured facts while preserving source identity and correction
history. Monthly reports derive from the current corrected state. They should never be reconstructed
from chat memory or a Thread summary.

## Store/location provenance and monthly budget classification are separate

The user's physical ledger is monthly and store/location oriented, while also carrying separate
monthly totals for budget buckets. Those are two views of the same purchase and must not overwrite
each other.

`merchant`, `rawMerchant` and `location` describe where the purchase came from. Budget allocation
describes where the money belongs in the user's monthly ledger. Changing one must not silently change
the other.

For chain stores and restaurants, preserve the chain/brand separately from the specific branch or
printed address. Distinct ICA, Lidl, Willys and similar branches are distinct locations even when the
merchant normalization is shared. This supports later questions such as where to buy a recurring item,
not merely which chain sold it once. Never invent a street address when only a branch name is printed.

Each receipt has a `defaultBudgetBucket`, such as `groceries`, `food orders`, or the user's own
`Fun` bucket. An item may set `budgetBucket` when that line belongs somewhere else. The record default
owns the remaining paid receipt amount after exact item overrides. This lets one durable or
non-essential item on a grocery receipt move to `Fun` while the purchase still remains visibly from
the same grocery store and location.

Bucket names are user vocabulary. Preserve established spelling/casing in user-facing reports rather
than inventing a replacement category. Item category and warranty durability may inform a suggestion,
but neither automatically assigns a budget bucket.

Monthly summaries are grouped by month and currency. They should expose:

- the month's total recorded receipt amount;
- totals for each budget bucket;
- unclassified residual amounts where classification is genuinely unknown; and
- corrections or reallocation history when the user moves an item between buckets.

Discounts and value checks must conserve the amount actually represented by the receipt record. For
example, if item lines sum to 300 SEK and a visible discount makes the receipt total 290 SEK, moving a
60 SEK item to `Fun` yields 60 SEK `Fun` and 230 SEK in the record's default bucket. Do not turn the
undiscounted 300 SEK item arithmetic into 300 SEK of monthly spending.

## Raw receipt retention is optional

The default durable state is the structured local ledger. Recording a receipt does not create a raw
receipt archive, ChatGPT Library file, report copy or image gallery entry.

Eve should inspect line items for plausible warranty or return value, including a single durable item
inside a grocery receipt. Raw local retention exists for this warranty/return proof use case only.
When that proof would be useful and no standing user preference resolves it, Eve can ask briefly
whether the user wants the full original retained locally. A candidate is only a suggestion; a high
price or durable-looking item is not proof of warranty coverage.

When the user chooses to keep an original, the exact native file belongs under the project's
`receipts/` folder with verified bytes/hash and recorded user-choice provenance. Keep the full receipt
when proof of purchase depends on merchant/date/payment context; an item crop may be insufficient.

ChatGPT may separately retain the native upload according to its own platform settings. ParadigmEve's
receipt-retention rule governs additional feature-owned copies. It cannot promise to erase provider
attachments or prevent platform retention.

## Later opt-out means delete the retained copy and update metadata together

If a user who previously chose retention later says to stop keeping or delete the raw receipt, that
choice applies to ParadigmEve's retained local copy. The operation must target the exact recorded file
inside the project's `receipts/` folder and transition the ledger retention state as one serialized,
fail-closed lifecycle change.

The file path and expected hash must still identify the retained original. A missing, changed, moved
or out-of-folder file produces an explicit safe result; it never triggers broad cleanup. The ledger
must not claim `not-retained` or `declined` while a known retained file is silently left behind, and a
file deletion must not land without the corresponding ledger transition. The correction trail keeps
the previous retention state and the later user-choice provenance.

Deleting ParadigmEve's retained copy does not imply deletion of the original ChatGPT upload, session
attachment staging, another user backup, or any other file that was not the exact retained receipt.

## Bank reconciliation is separate evidence

A later bank or online transaction is another evidence object, not a replacement receipt. It should
carry its own durable identity/provenance, amount and currency, raw merchant, booking date and/or
transaction date, and optional exact hints such as card last four digits or a reference.

Receipt purchase dates and bank dates can legitimately differ because of posting delay. Merchant text
can also differ between the till receipt and the bank statement. Matching may therefore score a nearby
date, normalized merchant, amount, card hint and reference together, but fuzzy similarity alone must
never auto-confirm a link.

Reconciliation links are auditable states such as `unmatched`, `probable`, `confirmed` and `rejected`.
A probable link is a review hint, never confirmation. In the formal receipt+bank reconciliation view,
only a confirmed link suppresses the duplicate receipt side; this keeps unresolved evidence visibly
unresolved. In the separate receipt-first monthly reconstruction, a bank row with a probable receipt
link is not added again as a second outflow, but the month reports that probable link as coverage that
still needs review. Confirmation does not delete or merge either evidence object; the original receipt
record and the bank transaction both remain available for audit and correction.

When receipt arithmetic and the actual bank debit differ, keep both facts. A value check, discount,
gift card or similar adjustment can make merchandise arithmetic differ from cash/card outflow. A
confirmed reconciled cash-spend view may use the bank debit as the actual account outflow while still
showing the receipt's merchandise arithmetic. It must never silently rewrite the receipt to make the
two sources look identical.

There is no live bank connector in this specification. The bank model and matching helpers are a
local ingestion/reconciliation boundary that a future connector can feed without changing receipt
truth.

## Source identity and hash trust

For a receipt/message source, exact provenance is the recorded local session, conversation, user
message and source index. Repeated text in a different user message is a different source. Similar
merchant/date/amount combinations are possible duplicates to review, not proof that one purchase
should disappear.

Text sources never carry image hashes. An image hash may prove a cross-message byte-identical image
only when ParadigmEve derived or verified that hash against the actual source bytes. If trustworthy
bytes are unavailable, leave the source hash unknown and rely on exact message/source identity plus a
similarity warning. Never accept a model-invented hash as authority to discard a purchase.

A retained receipt has a stronger file check: its recorded path must stay within `receipts/`, and the
local bytes must match the expected verified source/retention hash before the ledger can claim the
copy is retained or delete that exact copy later.

## Agent and worker ownership

Workers may read the ledger, inspect images, compare receipts, propose classifications, calculate
candidate matches and return structured analysis to the owning agent. They do not mutate the canonical Expenses
ledger or retained-receipt lifecycle directly.

The configured agent is the canonical mutation owner. Record/correct/delete-retained operations must run through the
Expenses ownership checks with the current project, user message and expected ledger revision still
valid at publication. A stale revision causes a reread/re-evaluation, not a blind write retry.

The same rule applies to a partially rejected batch: a failure on a later write does not prove earlier
writes failed. Reread the ledger revision/tail, identify which source records actually committed, and
continue with only the remaining evidence. This prevents recovery from duplicating legitimate receipts.

## Economic context is derived analysis, not ledger truth

The ledger records what the supported purchase/bank evidence says. A later analysis may need outside
context to answer a specific question—for example inflation/CPI for purchasing-power comparisons,
category price changes for groceries or energy, wages/income for affordability, interest/rent for
household pressure, or an appropriate household benchmark. Those sources are interpretive context;
they are never retroactive facts about what this user actually bought, earned or paid.

Fetch only the context that can materially affect the question being answered. Keep the publisher or
source identity, observation/release date, retrieval date, geography, units/base/method and material
uncertainty with the comparison so it can be reproduced later. If a series is revised, compare against
the dated version or clearly disclose the newer revision; do not silently rebase historical expense
records. Distinguish **observation** (ledger/source facts and external series values) from
**interpretation** (for example, "food spending rose faster than CPI") in the output.

This guidance does not create an automatic economics fetcher or a new ledger field by itself. A future
template implementation that persists analysis context must give that context its own owner/lifecycle
rather than mixing it into `data/ledger.json`. The generic design questions live in the
[Feature Spec Template](feature-spec-template.md).

## Dogfood evaluation: reconstruct first, compare second

The user's physical ledger through December 2025 is a human reference set for validating the model,
not a target that reconstructed data should be forced to equal. Reconstruct historical months from
the available receipt/bank evidence, then compare store/location totals and monthly budget buckets
against the physical ledger. Report exact agreements, explainable adjustments, missing-source
coverage and unresolved discrepancies separately. A mismatch is useful evidence about ingestion,
classification or source coverage; it must not be hidden by silently editing facts to match paper.

For 2026, dogfood the workflow receipt-first using the user's roughly 100 recent receipts. Build the
structured receipt ledger first, including uncertain/faded fields and item-level budget overrides,
then use bank screenshots as complementary evidence. Bank evidence should expose purchases that
receipts naturally miss, such as automatic billing, subscriptions and digital purchases, and can
also show income or other cashflow needed for a broader household picture. Those rows stay visibly
bank-sourced until there is appropriate evidence/classification; they do not receive invented receipt
provenance.

The useful output is coverage as well as totals: which receipt records have confirmed bank links,
which bank rows are probable/unmatched/rejected, which receipt-only purchases remain, and which
months/categories still have unexplained gaps. The 2025 comparison and 2026 receipt-first run should
therefore test the same trust rule: surface discrepancies so the system can improve instead of making
the ledger look artificially complete.

## Regression examples from the user's ledger

These four receipts form a compact acceptance set. Exact receipt wording may vary; the behaviors
below are the durable requirements.

| Case | Required behavior |
| --- | --- |
| **Normal, 320 SEK** mixed retail | Preserve `Normal` and its store/location provenance. Record 320 SEK in the appropriate month/currency. Use the receipt default budget bucket plus any explicit item override; a mixed durable/non-essential line may move to `Fun` without changing where the purchase happened. |
| **Trappan, 135 SEK** restaurant | Preserve restaurant merchant/location evidence and classify the purchase under the user's `food orders`/restaurant budget rule as established by the user. Receipt date placement is irrelevant; capture the supported purchase date wherever it appears. |
| **Lidl, 59.54 SEK** faded grocery | Keep readable facts, mark unreadable lines/fields uncertain, retain 59.54 SEK exactly, and classify the known purchase under `groceries` without inventing faded item text. Raw image retention remains opt-in unless a warranty/return reason exists. |
| **Mio, 921 SEK merchandise/value-check arithmetic; 821 SEK card debit** | Preserve the 921 SEK merchandise/value-check arithmetic separately from the supported 821 SEK paid/card total and keep durable-goods/warranty candidates. The later 821 SEK bank debit is separate bank evidence. A probable link remains reviewable; the receipt-first monthly reconstruction avoids adding that likely duplicate bank row again, while the formal reconciliation view suppresses duplication only after confirmation. Neither path erases the 921 SEK source arithmetic. |

## Regression matrix

| Behavior | Owner module | Focused test surface |
| --- | --- | --- |
| Expenses project + stored `%thread` ownership, renamed Thread reopen | `src/main/expenses-project.ts`, `src/main/projects.ts` | `test/expenses-project.test.ts` |
| Recurring inbox chooses the newest ordinary conversation for the exact Expenses project, then falls back to a project-scoped composer | `src/main/session/store.ts::latestProjectConversation`, `src/main/ipc.ts` `projects:startExpenses`, `src/renderer/chat.ts` | `test/expenses-project.test.ts`, `test/renderer-state.test.ts` Expenses-inbox cases |
| Exact source identity, stale-revision serialization, correction history | `src/main/expenses-ledger.ts`, `src/shared/expenses.ts` | `test/expenses-ledger.test.ts` |
| MCP caller/project/user-message fence; workers read but cannot mutate | `src/main/mcp/expenses-tool.ts` | `test/expenses-tool.test.ts` |
| Merchant/location provenance independent from default/item budget buckets | `src/shared/expenses.ts` | `test/expenses-ledger.test.ts` monthly-budget and item-reallocation cases |
| Monthly bucket totals, discount-conserving remainder, unclassified unknowns | `src/shared/expenses.ts::deriveExpenseSummary` | `test/expenses-ledger.test.ts` monthly summary cases |
| Optional warranty/return retention with exact local file/hash | `src/main/expenses-ledger.ts`, `src/shared/expenses.ts` | `test/expenses-ledger.test.ts` retention/provenance cases |
| Later retained-copy opt-out: exact delete + ledger transition, fail closed | `src/main/expenses-ledger.ts::deleteRetainedExpenseReceipt` + Expenses MCP `delete_retained_receipt` action | `test/expenses-ledger.test.ts`, `test/expenses-tool.test.ts` retained→not-retained/declined, stale revision, changed path/hash, permission and rollback cases |
| Receipt/bank evidence model, probable/confirmed/rejected links | `src/shared/expenses-reconciliation.ts` | `test/expenses-reconciliation.test.ts` Normal/Trappan/Lidl/Mio cases |
| Confirmed match suppresses double counting only in derived view | `src/shared/expenses-reconciliation.ts::deriveExpenseReconciliationSummary` | `test/expenses-reconciliation.test.ts`; prove both evidence sets remain |
| Receipt-first monthly reconstruction avoids probable duplicate outflow while surfacing unresolved coverage | `src/shared/expenses-reconciliation.ts::deriveMonthlyEvidenceSummary` | `test/expenses-reconciliation.test.ts` receipt-first + bank-only subscription/income case |
| Human physical-ledger comparison reports differences and missing evidence | `src/shared/expenses-reconciliation.ts::compareMonthlyEvidenceToReference` | `test/expenses-reconciliation.test.ts` monthly reference/discrepancy case |
| Trusted image-hash dedupe only from app-owned/verified source bytes | `src/main/mcp/expenses-tool.ts::expenseSource` + `src/main/expenses-ledger.ts` | `test/expenses-tool.test.ts`, `test/expenses-ledger.test.ts`; unavailable bytes leave hash unknown and cannot invent cross-message dedupe proof |
