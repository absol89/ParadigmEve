# 12 — Self-reliant AI and the manual

Back to [vault index](README.md).

ParadigmEve should be understandable and repairable by Eve using the same product surface and
documentation available to a human. The internal documentation-architecture shorthand is:

> **Brain = key. Vault = manual. Reality = source of truth.**

This is an architecture boundary, not branding prose and not the default `%how` user experience.
Eve should not lead a normal help conversation with keys, Vault mechanics, connector plumbing, or
filesystem roots unless those details actually answer the user's question.

## Brain = key

For the ParadigmEve repository, the linked project `AGENTS.md` is the injected Brain/key on a fresh
conversation. The bootstrap/agent instructions should contain the minimum durable knowledge needed for Eve to:

- identify the ParadigmEve environment and her role in it;
- locate the engineering vault;
- understand how to choose the relevant vault note;
- inspect live state rather than guessing from stale prose;
- begin the supported recovery path when normal integration is impaired.

The Brain should not become a second copy of every setup, recovery and troubleshooting procedure.
The current `AGENTS.md` is still much larger than this ideal; treat reducing duplicated operational
material there as an ongoing documentation-architecture task rather than creating a third manual.

## Vault = manual

`docs/vault/` is the canonical human-readable operational manual for architecture, setup, recovery,
debugging journeys and the meaning of important controls. Narrow README/UI/code comments may point
to it, but should not grow independent competing procedures.

The vault explains how the system is supposed to work. It is not allowed to overrule observed
reality. Current source/tests and first-hand runtime evidence still decide what the system actually
does today.

On a fresh install, `%how` is the starter Thread for this manual and belongs to `#Eve`. ParadigmEve
packages the current `docs/vault/*.md` pages with the app and exposes them read-only at
`/paradigmeve-manual`, so `%how` does not depend on old chat history or a repository checkout. Its
opening context is budget-aware: include as much of the current manual as safely fits, preserve the
user's current request last, and read a remaining page directly from `/paradigmeve-manual` when the
opening transport budget cannot carry the full Vault.

Startup also mirrors that shipped Markdown set to `%APPDATA%\ParadigmEve\docs\vault` on Windows.
The shipped/repository Vault stays canonical; the AppData copy is managed output for local inspection,
not a second documentation source. Browser-backed ChatGPT should ask ParadigmEve to perform these
reads through its connector (`work_context` then `read` when needed) rather than expecting the Chrome
process itself to hold filesystem permission. The exact installation-owner Eve/Eva conversation may
also read the mirror through `/appdata/docs/vault`.

The `%how` starter prompt is question-first. If the user opens it without a specific request, Eve asks
what they would like to know or do in ParadigmEve, then answers that question in plain language. Eve
quietly consults the packaged current manual with local tools when that would make the answer more
accurate. Product vocabulary such as `%thread` and `#quilt` belongs in the answer only when it helps
with the user's actual question. The operating/evidence instructions in the starter should make
answers more truthful, not become an exposition dump to the user.

`%appdata%`, also under `#Eve`, is the starter self-maintenance Thread. `/appdata` and
`/paradigmeve` are managed app-owned roots rather than ambient Workspace approvals; they become
visible only to the exact installation-owner Eve/Eva conversation. That owner may inspect
`/appdata` under the normal read permissions on a fresh install. Changing managed app state or using
`/paradigmeve` requires settings authority. Live settings with runtime/OS effects use the
`self_settings` action rather than raw `config.json` edits. In particular, start-at-login updates
durable configuration and the OS login registration together.

## Reality = source of truth

When the manual and live system disagree, Eve should not blindly follow either one. Treat the
disagreement as evidence of one of three things:

1. the product changed and the manual is stale;
2. the implementation is wrong relative to the intended contract;
3. the environment is unhealthy or misconfigured.

Inspect the owning state, diagnose the earliest wrong fact, repair the correct layer, verify the
result, and then update the manual if the durable procedure changed.

## The self-reliance loop

```text
Brain/key
   -> Vault/manual
   -> inspect live state
   -> diagnose
   -> repair where authorized and safe
   -> verify end to end
   -> update the manual when new durable knowledge was required
```

A repair that only succeeds because the user supplies an undocumented magic step is not a clean
success. It has discovered a documentation/product gap that should be captured so a future Eve can
solve the same class of problem without rediscovery.

## AI is a first-class product user

Important screens and journeys should work from two perspectives at once:

- **human usability** — calm, clear, appropriately progressive disclosure;
- **AI/computer-use usability** — enough labels, state and outcome evidence to act without guessing
  from coordinates or hidden implementation knowledge.

For an important page, Eve should be able to answer from the visible product plus the manual:

- What page am I on and what is it for?
- What state is the app currently in?
- What actions are available and which are destructive?
- What is the next supported action for my goal?
- How will I know whether it succeeded?
- Can I distinguish disconnected, preparing, needs-user and healthy states?
- If setup is broken, is there a documented route to diagnose and recover it?

A pretty screen that requires hidden tribal knowledge is unfinished. A machine-readable screen that
is awkward for a human is also unfinished.

## Provider-aware operation on ChatGPT Free

ParadigmEve must not rely on a paid model's larger reasoning budget to stay correct. On a ChatGPT
Free account, or whenever the selected provider/model has less reasoning or tool budget, compensate
with product structure rather than asking the model to hold more state in its head.

Use this loop for substantial work:

```text
exact owner
  -> authoritative reads
  -> durable Plan
  -> one bounded step
  -> verify concrete state
  -> persist the useful result
  -> continue or hand off
```

In practice:

- read the owning state before reasoning from remembered chat prose;
- split a large request into a durable Plan with one clear current step and one clear next step;
- use Threads, Quilts, Pins, Plans, Request Trails and session history as external memory instead of
  repeatedly reconstructing context in the model;
- preserve intermediate discoveries that later steps genuinely need, but do not create duplicate
  stores for facts that already have a canonical owner;
- keep tool calls narrow enough that their outcome can be checked independently;
- verify files, UI state, durable records or tool receipts after a mutation rather than trusting a
  confident explanation of what probably happened;
- use workers when the current account/runtime actually exposes them and parallel work is useful, but
  never assume a particular worker model, quota or concurrency exists;
- use the provider's native **Think** or higher-reasoning control when it is available and the step is
  genuinely reasoning-heavy; do not invent a local paid-tier reasoning mode when it is not;
- when a step is too large for the available reasoning budget, reduce the step size or gather better
  evidence rather than weakening provenance, ownership, authorization or completion rules.

Lower model capacity is therefore a reason to make the workflow **more explicit and verifiable**, not
a reason to relax safety or evidence standards. The same durable owner, exact-source and verified-state
rules apply on Free, paid and local-provider paths.

## Regression-test self-reliance

Safe fault-injection journeys can test the architecture itself. Examples include a stale tunnel
identifier, a deliberately disconnected Companion, or an incomplete supported configuration.

The pass condition is not merely "the model was clever enough." Eve should bootstrap from the key,
find the relevant manual, inspect authoritative state, repair only what is safe/authorized, and
prove the integration works again. Any undocumented hint required from the user becomes a concrete
manual/product defect to fix.

## Relationship to Pins context

Architecture decisions can be harvested into an Architecture Thread and brought into a fresh Eve
conversation with `%Architecture`; a broader `#eve` Quilt can bring several related Threads.
Pins are working context, not a replacement for the manual. Once a decision becomes durable
operational policy, reconcile it into the vault so future recovery does not depend on finding one
past chat.
