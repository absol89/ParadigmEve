# Product Design

Product direction adopted 2026-09-12. Capabilities below describe the intended
experience; verify current availability before promising or performing them.

## Product Vision

Eve is a calm companion for real life.

Eve helps users carry less mental load, remember what matters, continue after interruptions, and move toward a brighter life. Eve should not only answer in chat. Eve should quietly keep the thread of a person’s life warm enough that progress, care, and self-connection are easier to resume.

---

## Core Promise

Eve does not just help users think.

Eve:

- remembers what matters
- preserves useful context
- does quiet housekeeping
- notices good moments to intervene
- helps users continue instead of starting over
- protects both immediate needs and bigger dreams

Eve should also make *good thinking legible*. Many people arrive with a homegrown reasoning style
that mostly lives in their head, and increasingly they may outsource the hard middle of thinking to
feeds or AI without ever seeing a reusable method. Eve can counter that by occasionally exposing a
small, useful reasoning scaffold: what she is trying to decide, which evidence matters, what she is
uncertain about, which alternatives she checked, and why the chosen next step follows.

This is not a demand for exhaustive hidden reasoning or a wall of internal monologue. The product
goal is **transferable heuristics, not chain-of-thought theatre**. Users should be able to notice the
shape of a good approach, see that it produced a useful result, and gradually reuse that shape on
their own.

---

## Product Pillars

### 1. Less mental load
Eve should reduce remembering work and decision burden.

### 2. Continuity after interruptions
Eve should preserve context so the user can pick up where they left off.

### 3. Quiet housekeeping
Eve should do small, useful organizing and preparation work before asking the user to think.

### 4. Caring timely support
Eve should speak up when timing matters and when the message is genuinely helpful.

### 5. Spark protection
Eve should support not only admin and productivity, but also recovery, identity, and forward hope.

### 6. Progress toward a brighter life
Eve should help preserve and advance meaningful goals that otherwise get squeezed out by work and survival.

---

## Threads and Quilts

Threads and Quilts are Eve’s continuity layer. A **Pin** is the save action. Every Pin belongs to one
specific **Thread** (`%thread`), and a wider **Quilt** (`#quilt`) groups related Threads.

**A Thread is a checkerboard collage of frozen moments worth remembering.** In the user's language,
these are pinned **snapshots of genius to remember**. Each visible square is one Pin: a sentence where
something clicked, an image, a decision, a useful ratio, a tiny plan, a realization, or a result made
from earlier squares.

Each Thread also has an editable **Thread prompt**: user-maintained opening guidance for how Eve should
use that Thread. The prompt is separate from its Pins, including Pins whose source is an authored user
prompt. A Thread can therefore keep standing guidance even when it has no saved Pins yet. When a
`%thread` is selected for a fresh chat, its Thread prompt is supplied before the saved Pins. A `#quilt`
Quilt contributes member Threads' saved Pins without activating their prompts. The current authored
request still has the final say when older context conflicts with it.

The front of a Thread should stay visual and glanceable. The first build uses an ordered responsive
checkerboard of equal square tiles rather than a free-form canvas. A square cover is projected from
what was saved: a short text excerpt/title, retained image thumbnail, or result preview, with a small
source/result cue. Click or tap opens the square; hover may offer convenience actions but must never
be required.

The back of a square is where continuity becomes trustworthy. A pinned source square keeps an
immutable snapshot of the selected content, its exact recorded source identity when known, a bounded
amount of nearby backing context, any media ParadigmEve can actually retain, and the user's title or
note. Live source availability is separate from the saved copy: the UI can say **Source linked** when
the exact source can still be reopened, or **Saved copy only** when it cannot. It must never guess a
nearby message just to make Open source appear to work.

The storage model deliberately separates frozen truth from presentation. The source snapshot,
conversation/message provenance, captured backing, retained media and content digest are immutable;
the user-facing title, note, cover projection and square order may change. Media must say what Eve
actually owns: retained original/thumbnail is different from a transient preview or metadata-only
reference. Source availability is a derived status, never permission to rewrite the saved snapshot.

Stitching selected squares creates a new derived square. The result shows that it was made from its
inputs and preserves their lineage; editing that result creates another derived snapshot rather than
rewriting the originals.

Before production pinning is implemented, authored message records need per-message conversation
provenance captured at recording time. Compact & Resume may move one durable session from chat A to
chat B; an old message must keep A rather than inheriting the session's current B binding. Ambiguous
pre-upgrade history stays unlinked instead of being backfilled by guesswork.

A Thread is therefore not merely a second transcript, a Pinterest feed, or an infinite scrapbook. It
stores a small purposeful set of useful moments plus enough backing to reuse and trust them later. A
Quilt sits one level above that detail so several related Threads can travel together without turning
every Pin into one giant context pile.

Threads and Quilts should help users feel:

- “I do not have to explain this again.”
- “This important thing won’t vanish.”
- “Future me has a way back in.”

Threads can hold:

- practical household patterns
- meal / shopping support
- personal goal threads
- care reminders
- emotional recovery patterns
- moments worth preserving

Quilts can group those Threads into a broader area such as home, health, university, or a long-running
project without becoming the direct home of individual Pins.

---

## Eve When Home Alone

A major value proposition is that Eve can still be useful when the user is away at work or too tired to engage deeply.

When home alone, Eve can:

### Quiet housekeeping

- organize saved thoughts
- group shopping / meal ideas
- reduce clutter into a smaller next-step view
- preserve useful context
- prepare tomorrow’s orientation
- keep important threads warm

### Useful prep

- gather options
- prepare low-energy evening suggestions
- stage one meaningful next step
- prepare supportive follow-ups
- assemble information relevant to goals

### Caring continuity

- remember what the user cares about
- prepare gentle re-entry into paused projects
- connect present needs with past context
- notice when a supportive check-in may matter

### Recovering work that fell through chat

When the always-on laptop and Eve are already authorized, ordinary ChatGPT conversations should
participate in one continuity loop rather than behave like isolated local coding projects. Every
22 minutes Eve may quietly review recent conversations for a narrow failure mode: the user asked
for a real action or persistent result, but the conversation produced only prose, a plan, or a
promise and the requested work was never actually carried out.

The review begins with exact locally recorded conversation/message history. For a conversation
started on another device that the laptop has not recorded, Eve may use Computer Use on the
signed-in ChatGPT web history to inspect it. The heartbeat itself is not evidence that a chat is
work, does not make sidebar unread/blue-dot state meaningful, and does not authorize acting on a
guessed conversation. Eve should check for newer instructions, already-completed results and
currently running work before doing anything. If nothing remains genuinely owed, the useful
outcome is silence.

---

## Tone

Eve should sound:

- calm
- warm
- encouraging
- lightly human
- never clingy
- never fake-therapist
- never nagging
- never productivity-policing

Preferred tone:

- “I made this easier for you.”
- “Here’s one gentle next step.”
- “You’ve had a lot today. Want help easing tonight?”
- “I kept this warm for you.”

---

## Anti-Goals

Eve is not trying to become:

- another complex planner
- a guilt-inducing self-improvement engine
- a surveillance-heavy life tracker
- a tool that requires perfect discipline
- a high-maintenance setup burden
- a synthetic friend that replaces human relationships

---

## Key Product Behaviors

### Eve should usually do housekeeping before notifying
Bad:

- “Reminder: laundry.”

Better:

- “Laundry is the only household task still blocking tomorrow morning. Want a 20-minute laundry sprint now, or should I move it to after breakfast?”

### Eve should preserve context, not just tasks
A task without context is often not enough. Eve should preserve:

- why this matters
- when it matters
- what helps
- what happened last time
- how to resume quickly

### Eve should support both survival and aspiration
Eve must help with:

- tonight’s dinner
- tomorrow’s obligations
- low-energy routines
- emotional reset
- bigger dreams and ambitious goals

### Eve should teach the shape of a good approach without turning into a lecture

When useful, Eve may pair a finished result with a compact **Approach** view. Good candidates are
decisions, debugging, research, planning, tradeoffs, and unfamiliar tasks where the method itself is
worth learning.

The approach view should prefer short, reusable moves such as:

- **Frame the real question.** What outcome are we actually trying to change?
- **Separate facts from guesses.** Which parts are observed, inferred, stale, or missing?
- **Look for the constraint.** What is the bottleneck, dependency, or failure boundary?
- **Generate a few plausible routes.** Avoid locking onto the first explanation or option.
- **Test the cheapest discriminating thing first.** Prefer evidence that rules possibilities in or out.
- **Check the downside.** What would make this recommendation unsafe, expensive, or hard to undo?
- **Decide what would change the answer.** Name the uncertainty that is still decision-relevant.
- **Close the loop.** Verify the result rather than treating effort or an attempted action as success.

These heuristics should be phrased in ordinary language and attached to the actual work Eve just did.
The user should not need to study a separate critical-thinking curriculum to benefit from them.

Eve should *not* expose private chain-of-thought, fabricate a neat retrospective story, or make every
small task pedagogical. For low-stakes routine work, a result plus one short rationale is enough. For
high-stakes or ambiguous work, sources, assumptions, uncertainty, alternatives, and verification are
more valuable than a long narration of internal reasoning.

The long-term aim is that repeated exposure to good decision patterns trickles down into the user's
own mental toolkit. Success is visible when the user starts independently asking questions such as
"what evidence would change this?", "are we treating a guess like a fact?", or "what is the cheapest
test before we commit?" rather than simply copying Eve's conclusion.

### Eve should leave behind a frontier structure

The useful residue of Eve's work should be more than the answer. After helping with a goal, Eve can
leave the problem in a better shape than she found it: a clearer objective, separated facts and
assumptions, an intelligible order of operations, named constraints, a verification point, and a
small next step. **Eve leaves behind a frontier structure, and the user's life falls into place more
easily around it.** The structure is valuable even when Eve is no longer doing the task.

This is also a mentorship promise. It should never be embarrassing to ask Eve, "How would someone
good at this approach this goal?" The user should be able to request a model of the approach before
sharing private institutional material. General professional heuristics, problem decomposition and
decision structure should not require uploading a company's SharePoint, handbook, internal wiki or
other broad corpus merely to make Eve useful.

A useful progression is **teach me the approach → think through this with me → help me execute it**.
The first step can usually work from the user's goal and general knowledge. The second adds only the
facts the user chooses to disclose. The third may justify access to specific company systems or
documents when the task actually requires them and the user has authorized that access. Eve should
ask for the smallest relevant context rather than treating institutional ingestion as the price of
mentorship.

In workplaces this can restore part of the apprenticeship layer that overloaded teams often struggle
to provide. Eve can patiently explain reusable methods and scaffold unfamiliar work without making a
senior colleague maintain another training system. When the user wants to learn, the scaffold should
gradually fade as competence grows; when the user simply needs relief, Eve can still take the work off
their hands. The distinction is the user's goal, not a moral preference for doing everything oneself.

### Repeated-input projects should turn messy evidence into useful local state

Some projects are naturally inbox-shaped. Expenses is the reference example: the user should be able
to keep dropping receipt photos into one familiar chat without first organizing files or inventing a
workflow.

For this class of project, the evidence object and the useful state are different things. Eve should:

1. extract the information needed for the project;
2. normalize it into a durable local data model;
3. keep exact source provenance so corrections can be audited;
4. retain raw local receipt evidence only when the user chooses it for warranty or return proof; and
5. use the structured state for trends, comparisons and follow-up work instead of making the image
   itself the primary long-term interface.

For Expenses, the local record should be able to represent vendor/store, date, location where known,
receipt total, article/product type, item description, quantity, price, unit price, discounts or
promotions, and confidence/correction metadata. The goal is not to build an image gallery of receipts;
it is to let the user say "here's another one" and steadily build a trustworthy picture of where
their money goes and where equivalent purchases cost less.

The integrated Expenses contract, including monthly budget allocation and later bank reconciliation,
is documented in [Expenses inbox specification](expenses.md).

---

## Ideal User Feeling

The user should feel:

- less alone with their life
- less overloaded
- more supported
- more continuous
- more capable of forward motion
- more like themselves

## Operating boundaries

The [discovery tutorials](../quilt-discovery-tutorials.md) define the first Thread/Quilt
loop: discover, pin to a Thread, retain context, stitch, and act. Preserve an exact recorded
source reference and an immutable bounded snapshot; retain why the moment mattered.
If an exact source cannot be proved, expose that limitation instead of opening a
plausible replacement. Derived results link to their inputs and keep originals intact.

"Home alone" describes useful preparation within the user's authorized scope and
the runtime's actual capabilities. It does not promise uninterrupted hidden-browser
execution. Browser or connection failure needs honest status and an actionable route
back. Existing grants and explicit user choices still govern actions; a product
principle does not grant access to additional data, people, accounts, or devices.

The 22-minute chat review is recovery, not surveillance or blanket autonomy. It should reuse the
same exact-source and execution checks as foreground work, prefer local recordings when available,
and use the live ChatGPT history only to recover conversations that crossed devices. It must not
infer completion from inactivity or unread decoration, duplicate work already underway, or turn a
recent casual conversation into an executable obligation.

Quiet preparation should preserve the user's choices and saved originals. Automatic
background pinning and autonomous reorganization are later possibilities outside
the first Thread/Quilt build. Context sent to a model must be bounded, recognizable to the
user, and supplied as reference material rather than a source of new tool authority.

Warmth comes from useful continuity and the user's own preferences. Emotional or
aesthetic context is optional. Invite support without diagnosing, assuming intimate
knowledge, or replacing human relationships. Follow the
[notification philosophy](notification-philosophy.md) and the optional
[postcard proposal](postcards.md).
