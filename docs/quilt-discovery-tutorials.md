# Thread and Quilt discovery tutorials

Date: 2026-09-12

See [Product Docs](product/README.md) for the target audience and product promise, and
[Thread/Quilt onboarding themes](product/quilt-onboarding-rides.md) for six ways to personalize these
rides. The three discovery loops below remain the first-build scope and timed acceptance
contract; later themes and proactive features do not expand it implicitly.

## Product constraint

The first Thread/Quilt experiences must pay the user back before they have learned ParadigmEve.
Each tutorial therefore has a useful visible result within **22 minutes**, with a smaller
payoff in the first 5-7 minutes. The tutorials are discovery rides, not documentation:
they teach the product by helping someone finish a real piece of everyday work.

Current-tree finding: **the durable Thread / Pin-to-Thread foundation is implemented.** The session
store provides the provenance substrate: durable local session ids, stable recorded user/assistant
message ids when available, exact ChatGPT conversation history, attachments, and surrounding
timeline events. The current library also supports direct fresh-chat context callouts:
`#quilt` for a wider Quilt and `%thread` for one explicit Thread. The tutorial rides still
describe the intended discovery experience and should not be read as a claim that every later
Stitch/result-template interaction below is already shipped.

Each Thread also has an editable Thread prompt: standing opening guidance that is distinct from saved
Pins, including Pins classified as Prompt because their source was an authored user message. When a
Thread is selected as fresh-chat context, its Thread prompt is supplied before its saved Pins.

The metaphor should stay light:

- a **square** is one Pin worth keeping;
- a **thread** is the focused home for related Pins;
- a **quilt** is a broader grouping of related Threads;
- the **backing** is the source conversation and nearby context, retained for traceability;
- **stitching it together** means asking Eve to turn the saved squares into a result.

The product should not require a user to learn those terms before it is useful.

## What a Thread looks like

The visible Thread is an **ordered responsive checkerboard of equal square tiles**. It is a collage,
not a free-form canvas: order matters, but the user does not drag cards to arbitrary x/y positions.
Each cover is a projection of saved data, not a second editable document:

- a text square shows a short excerpt or title;
- an image square shows a retained thumbnail when ParadigmEve actually has durable image custody;
- a decision, memory, or starter-plan result shows a compact outcome preview;
- a derived result carries a small cue such as **Made from 4 squares**.

Click or tap opens square detail. Detail shows the frozen snapshot, editable title/note, collapsed
backing context, and a human source state. Use **Source linked** when exact retrace is available and
**Saved copy only** when the snapshot remains but exact source reopening is unavailable. “Open
source” is disabled rather than guessed in the latter state. Touch users must have every essential
action without relying on hover.

**Stitch** temporarily turns the checkerboard into multi-select: selected squares gain clear
checkmarks and the primary action says, for example, **4 squares selected · Review & stitch**. The
review step shows the exact saved material/backing that will be supplied before a result is made.
The result becomes a new square; its inputs stay unchanged.

## Discovery ride 1 — Turn a messy idea into a plan you can start today

**Promise:** "Bring the scraps. Leave with the first three things to do."

Good first-user material: photos, screenshots, copied notes, a half-formed room refresh,
garden project, birthday idea, craft, trip, family project, or side project. The user does not
prepare or organize it first.

### 22-minute path

| Time | What happens | Payoff |
| --- | --- | --- |
| 0-2 min | User drops 3-8 scraps into ChatGPT and says what they are hoping to make or change. | No setup worksheet; their real material is already in the conversation. |
| 2-6 min | Eve reflects back three emerging themes/questions and one obvious next move. | **First payoff by minute 6:** the mess has shape. |
| 6-10 min | User creates a focused Thread, edits or accepts a one-line Thread prompt for its purpose, then pins 3-5 useful messages, images, or decisions into it. The first Pin immediately appears as a square in the checkerboard. | A visible durable Thread exists; nothing useful is buried in chat anymore. |
| 10-16 min | Eve asks at most two high-value questions, then the user pins the answers or revised ideas that matter. | The Thread becomes a deliberate brief rather than a transcript dump. |
| 16-20 min | User chooses **Stitch into result** → **Starter plan**. Eve uses only the pinned squares plus their backing context to make a short plan. | A concrete plan with the user's own evidence and decisions. |
| 20-22 min | User edits the top three actions and names the Thread; if useful, they place it in a broader Quilt with related Threads. | **Result:** a saved, traceable starter plan they can use today. |

### What the user learns without a lesson

They learn that ChatGPT can explore freely while ParadigmEve keeps the pieces that deserve to
survive the conversation. They also learn that pinning is selective: a Thread is not a second
chat history, and a Quilt groups Threads rather than individual Pins.

### Success signal

By minute 22 the user can point at one named Thread containing 3-7 Pin squares and a three-step
starter plan. At least one square opens back to the exact source conversation/context.

## Discovery ride 2 — Rescue the golden thread from a long conversation

**Promise:** "Keep the part you would otherwise lose."

This is the traceability tutorial. Start from a real conversation that wandered, changed its
mind, debugged a problem, or finally reached a sentence the user wants to remember. It works
for personal advice, recipes, creative work, troubleshooting, research, or planning.

### 22-minute path

| Time | What happens | Payoff |
| --- | --- | --- |
| 0-3 min | User opens an existing recorded conversation and says, in ordinary language, what they are trying to recover: "where we finally figured out why this failed" or "the version of the idea I liked." | The task starts from existing work, not a blank page. |
| 3-7 min | Eve identifies 1-3 candidate turning points from the recorded conversation and shows why each may be the one. | **First payoff by minute 7:** the lost moment is found. |
| 7-11 min | User pins the winning message. ParadigmEve automatically includes a small backing window of nearby authored messages and provenance, without making all of it a visible square. The detail view explains this once in plain language. | One click saves both the insight and enough context to trust it later. |
| 11-15 min | User adds a plain title such as "Why the installer looked frozen" or "The birthday-cake ratio that worked." | The saved item is recognizable months later. |
| 15-19 min | User chooses **Stitch into result** → **Memory card**. Eve writes a compact "what we learned / when to use it / source" card from the square and backing. | The conversation becomes reusable knowledge, not just archived chat. |
| 19-22 min | User opens the source from the card once, sees the exact message highlighted, then returns to the Thread. | **Result:** a durable wisdom card whose claim can be traced back to where it came from. |

### What the user learns without a lesson

They learn ParadigmEve's distinctive value: preserving the *moment of understanding* together
with provenance, instead of forcing them to reread an entire conversation or trust a summary
with no way back.

### Success signal

By minute 22 the user has one memory card that still works after navigating away and back,
shows **Source linked**, and can reopen the exact source chat/context. A separately tested source-loss
case must instead show **Saved copy only** without corrupting the retained snapshot.

## Discovery ride 3 — Stop comparing and make a decision

**Promise:** "Collect what matters, then choose."

Use a decision with a small number of real options: three paint directions, gifts, weekend
plans, furniture arrangements, sewing patterns, destinations, purchases, names, or project
approaches. This is deliberately not a giant research task.

### 22-minute path

| Time | What happens | Payoff |
| --- | --- | --- |
| 0-3 min | User names the decision, 2-4 options, and the one or two things they care about most. | The decision boundary is explicit before research expands. |
| 3-7 min | Eve produces a small comparison and calls out the one fact or uncertainty most likely to change the choice. | **First payoff by minute 7:** the real decision criterion is visible. |
| 7-12 min | User pins only the evidence/preferences that should influence the choice, one square per meaningful reason. | The Thread shows *why*, not just a pile of options. |
| 12-16 min | Eve may resolve one important uncertainty; user pins the new evidence if it changes the picture. | Research stops when it stops changing the decision. |
| 16-20 min | User chooses **Stitch into result** → **Decision card**. Eve gives a recommendation, two reasons, the trade-off being accepted, and a next action. | A decision artifact replaces an endless comparison loop. |
| 20-22 min | User accepts, edits, or deliberately chooses another option and writes one sentence why. | **Result:** a saved decision with rationale and next action, ready to act on. |

### What the user learns without a lesson

They learn a Thread can be temporary and purposeful. It is not only a scrapbook; it can be the
small evidence set that keeps an agent focused and lets a person see why a recommendation was
made.

### Success signal

By minute 22 the Thread contains no more than 8 visible squares and ends in one decision card
with a next action. A user can **unselect/exclude** one evidence square and stitch again without
deleting it from the Thread or losing either the original square or the earlier result lineage.

## Smallest Thread/Quilt slice these tutorials require

This is the product boundary to hand to architecture work. Anything larger should justify
itself against one of the three rides above.

**Architecture prerequisite:** authored `user_message` / `assistant_message` records must persist
the conversation identity proven when that individual message was captured. The current session
schema does not yet carry that per-message fact. Compact & Resume can move one session from chat A
to chat B, so pinning must not infer an older message's source from the session's current binding or
bulk-backfill ambiguous pre-upgrade history. This provenance gap must close before production Pin to
Thread ships.

1. **Pin an exact recorded message.** User and assistant timeline rows can be pinned. A pin
   retains the durable local `sessionId`, canonical message identity when available, message
   kind, source conversation identity at pin time, and a stable sequence/origin fallback for
   older recordings. Never key a pin by rendered DOM position or message text alone.
2. **Keep an immutable source snapshot plus backing context.** The visible square contains the
   chosen content; the pin also keeps a bounded snapshot of nearby authored context so later
   edits, compaction, retention, or provider-page changes cannot silently rewrite what was
   saved. The source reference remains separately openable when the source still exists.
3. **Create and name a local Thread.** Every Pin has exactly one Thread home. A user can create a
   Thread from the first Pin, add/remove squares, reorder them, and give each square a short optional
   note/title. The Thread's editable prompt is separate standing guidance, not another square.
4. **Show the Thread checkerboard.** The renderer projects the ordered active squares as responsive equal
   square tiles. Covers come from saved snapshots/media/results; there is no separate cover editor
   or free-form positioning in the first build. Source, image, and derived-result squares remain
   visually distinguishable without exposing internal ids.
5. **Open the source.** Every pin with a live source can navigate to the exact recorded session
   and highlight/position the source message. If exact identity is unavailable, say so rather
   than guessing a nearby row.
6. **Stitch into a result.** A Thread can be handed to a ChatGPT conversation as a bounded,
   clearly-delimited context pack containing the visible squares, their notes, and minimal
   provenance. The user chooses the result template: Starter plan, Memory card, or Decision
   card. The pack is data supplied to ChatGPT, not provider-page DOM automation.
7. **Save the stitched result back into the Thread.** The generated result becomes a distinct
   derived square with links to the source squares used to make it. Originals are never
   overwritten.
8. **Group related Threads with a Quilt.** A Quilt is the broader thematic/context scope. It may group
   multiple Threads for later discovery or fresh-chat context, but Pins still belong to Threads.
9. **Stay small by default.** The first-use path should not expose schemas, tokens, session ids,
   agents, IPC, tunnels, browser profiles, or extension mechanics. Advanced provenance can be
   inspected later, but the default experience is "Pin to Thread" and "Open source."

## First-build acceptance criteria

- A completed 2.0.19 user can make their first Thread without revisiting Setup.
- First pin to visible saved square takes at most two user actions after choosing the message.
- The first pin visibly lands in a responsive checkerboard; every essential square action works
  by click/tap and never depends on hover.
- Text/image/source/result covers are defined and derived-result squares visibly retain lineage.
- A Thread, its editable Thread prompt, and its Pins survive app restart.
- A pin never silently rebinds to a different ChatGPT message after Compact & Resume or a
  provider reload.
- Deleting or expiring the source recording does not corrupt the saved square; the UI clearly
  says the live source is unavailable while retaining the snapshot.
- "Open source" fails closed when exact source identity cannot be proven.
- Source state copy distinguishes **Source linked** from **Saved copy only** without upgrading
  preview/metadata into claimed durable media custody.
- Stitch selection is visually obvious, and the user can review exactly which saved squares and
  bounded backing will be supplied before generating the result.
- A stitched context pack is bounded and shows the user what is being sent before or alongside
  delivery; it does not smuggle the entire conversation into a new prompt.
- Each of the three rides can reach its stated result in a timed first-user test within 22
  minutes, with the first visible payoff no later than minute 7.

## What is deliberately not in the first Thread/Quilt build

Free-form canvas layout, Pinterest-scale discovery feeds, automatic background pinning, shared
shared multiplayer Quilts, semantic vector search across every recording, public publishing, and
autonomous reorganization can all be valuable later. None is necessary to prove the core loop:
**discover → pin to Thread → retain context → stitch → act**, with Quilt grouping when broader context helps.
