# Feature Spec Template

## Title

## Summary
One-paragraph overview.

## Problem
What user pain or gap does this feature solve?

## Primary Persona
Who is this mainly for?

## User Need
In plain language: “When X, I want Y, so that Z.”

## Why Now
Why this matters in the current product phase.

## User Experience
Describe the ideal flow.

## Inputs
What data or context the feature may use.

## Canonical Project State
If this is a recurring/template project, what local structured state is authoritative? Is the chat
an inbox/review surface rather than the database? If a `%thread` binds the project, state what context
belongs there, what its editable Thread prompt should say, what belongs in Pins instead, and what must
stay in the project record. A broad `#quilt` Quilt is context grouping,
not an implicit project selector.

## Raw Artifact Retention
Which originals, if any, need to survive after structured ingestion? Default to the minimum durable
artifact set that serves the user's purpose. State the exact user choice/retention rule, provenance,
deletion/opt-out behavior and which provider copies are outside the template's authority.

## Eve Behavior
What Eve should do proactively or reactively.

## Quiet Housekeeping
What Eve should do before notifying the user.

## Notifications / Timing
When Eve should speak up.

## Guardrails
What the feature must not do.

## Thread / Quilt Integration
What gets saved as Pins and why it matters later? What standing guidance belongs in the editable
Thread prompt rather than in a Pin? Which broader Quilt, if any, should group this Thread with related
Threads?

## Success Signals
What would make us say the feature is working?

## Anti-Metrics / Failure Modes
What failure looks like.

## Open Questions
Unknowns that still need testing.

## Status and Scope
Separate product intent, proposed work, implemented behavior, and verified runtime
evidence. State the smallest release slice and deferred capabilities.

## First Useful Result
What is visible by minute 7, and what tangible result can be saved by minute 22?
How can the user pause and resume?

## Source and Trust
Which exact records support the output? What survives source deletion or compaction?
What happens when identity or evidence is missing?

For repeated evidence, define correction history and duplicate handling. Similar text, merchant/date,
or other resemblance is a review hint unless exact source identity or verified bytes prove identity.
Never make a derived summary, chat recollection or benchmark the source of raw facts.

## Interpretive / External Context
What outside context is actually needed to answer the user's question? Fetch it only when it can
materially change the interpretation. Examples include inflation/CPI, category price movement,
wages/income, interest, rent, energy or household benchmarks appropriate to the analysis.

Keep raw project facts separate from this context. For every external series/benchmark needed for a
reproducible result, retain or cite the publisher/source, series or reference identity, observation or
release date, retrieval date, geography, units/base/method and material uncertainty. Record any
transformation or comparison rule. Never silently mutate, rebase or backfill the user's original
records to fit the benchmark.

State the result in two layers: **observation** (what the project and external sources actually say)
and **interpretation** (what comparison or conclusion Eve draws). If no external context is needed,
say so rather than fetching a generic economics bundle.

## User Control and Authority
Which existing grants and explicit user choices apply? What can be declined,
paused, edited, or removed? Which external actions need separate authorization?

## Verification
Name the acceptance evidence that demonstrates the user outcome, including an
interruption/re-entry check where relevant. Do not treat a test or mock as live
delivery evidence.
