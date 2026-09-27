# Product Docs

This folder preserves the user and product guidance for ParadigmEve / Eve.

**Want the human version before the product documents?** Open the local
[`Eve HTML tour`](../readme/index.html). It is intentionally written for the “coffee has not
kicked in yet” version of the reader, with small interactive examples instead of architecture
or feature vocabulary.

## Purpose

Eve is a calm, caring, household-friendly companion that helps people carry less
mental load, remember what matters, continue after interruptions, and protect the
goals and parts of life that make them feel like themselves.

## Status and source

Adopted as product direction on 2026-09-12 from the user-supplied product-guidance
draft. The persona is a design lens, not a diagnosis or a claim about any particular
user. Examples describe intended experiences; they do not establish shipped
capabilities, permission to act, or successful delivery.

The [three 22-minute discovery tutorials](../quilt-discovery-tutorials.md) remain
the first Thread/Quilt build's acceptance scope. In current user-facing terminology, a Pin is saved
to one specific `%thread`, and a wider `#quilt` Quilt groups related Threads. Each Thread may also keep an
editable Thread prompt: standing opening guidance that is separate from the Thread's saved Pins. The
six themes in this folder personalize
that loop and describe future opportunities. Documenting them does not expand the
MVP to six independently implemented flows, autonomous housekeeping, deal monitoring,
or scheduled postcards.

Current user instructions govern scope. Use [AGENTS.md](../../AGENTS.md) for the
technical contracts and current source plus appropriate evidence for implementation
status. These documents guide product choices across implementation work.

## Files

- [Personas](personas.md) — who we are designing for.
- [User research](user-research.md) — why everyday chat users do not naturally imagine what Eve can take off their hands, and the “Donna” service model.
- [Product design](design.md) — vision, pillars, behavior, and operating boundaries.
- [Expenses inbox specification](expenses.md) — recurring receipt inbox, local ledger, monthly budget allocation, optional receipt retention, and bank reconciliation contract.
- [Marketing positioning](marketing-positioning.md) — plain-language product promise, discovery copy, and the “less advice, more handled” distinction.
- [Thread/Quilt onboarding rides](quilt-onboarding-rides.md) — six themes mapped to the first three discovery rides.
- [Notification philosophy](notification-philosophy.md) — when Eve should speak up or stay quiet.
- [Morning postcards](postcards.md) — an optional future ritual grounded in the user's preferences.
- [Feature spec template](feature-spec-template.md) — a reusable format for evaluating future features.
- [ADR 0001](adrs/0001-quilt-is-a-continuity-layer.md) — Quilt preserves continuity.
- [ADR 0002](adrs/0002-proactive-support-must-reduce-load.md) — proactive support must reduce load.

## Where user needs and product behavior meet

| User need | Product response | Evidence of value |
| --- | --- | --- |
| Too much to remember | Preserve a useful moment and enough source context to understand it later. | The user can reopen a saved insight without reconstructing the conversation. |
| Interruptions and low energy | Keep a small next step and a gentle way back in. | Progress resumes after leaving and returning. |
| Food and shopping decisions after work | Prepare realistic options, fallbacks, constraints, and substitutions. | Tonight's decision becomes easier with little additional planning. |
| Invisible household load | Keep the reason, timing, and relevant context together. | Less re-explaining and fewer loose obligations. |
| Joy and ambitious goals squeezed out | Preserve recovery preferences and a meaningful next action. | The relevant Thread contains something the user wants for themselves as well as admin, and a Quilt can keep related Threads together. |
| Notifications becoming another burden | Do useful preparation first; speak when timing and usefulness justify it. | The user feels helped and can pause or decline the interaction. |
| Desire for personally meaningful support | Use explicitly shared aesthetics and context in optional postcards. | Warmth and orientation without assumed intimacy or invented facts. |

## Product principles

1. Reduce mental load instead of creating another system to maintain.
2. Preserve continuity across interruptions.
3. Do authorized quiet housekeeping before asking the user to think.
4. Be kind and practical, with no guilt or pressure.
5. Protect wellbeing, identity, relationships, and long-term goals alongside tasks.
6. Make an early useful result visible: first payoff by minute 7, a saved result by minute 22.

## How to use these docs

Start with the persona and the concrete need. Use the feature template to connect
that need to behavior, saved context, and an observable result. Keep speculative
features labeled as such. Preserve source identity, user control, and truthful
status even when the interface keeps the technical details out of the first-use path.
