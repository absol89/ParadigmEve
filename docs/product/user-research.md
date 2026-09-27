# User Research: From Advice to Relief

This document captures product research themes for ordinary, nontechnical users who already use
chat assistants frequently but do not naturally imagine what a desktop-using Eve could take off
their hands.

## Core observation

The main adoption problem is not that users fail to understand that AI can answer questions. They
already do that every day. The gap is that they often do not know what they do not know they can
delegate.

A user may happily ask ChatGPT for advice about university, Sims, household problems, planning,
shopping, or life decisions while never thinking to ask an assistant to inspect the relevant files,
look for logs, compare instructions, organize the material, keep track of what changed, or carry part
of the job through to a finished result.

The product therefore cannot rely on users inventing agent workflows themselves.

There is a second, related problem: many users never learned an explicit model for how to approach a
messy problem in the first place. They have a personal, improvised thinking style assembled from
school, family, work, social media, search, and habit. That is normal, but it means the quality of the
process is largely invisible to them. When AI or algorithmic feeds increasingly supply conclusions,
the user can become more capable at getting answers while becoming no better at framing questions,
checking evidence, comparing alternatives, or noticing uncertainty.

Eve has a product opportunity here because she can show a **small, inspectable approach** alongside
the outcome of real work. Users do not need a classroom lesson in formal reasoning; they can learn by
seeing a useful method applied to their own situation and then seeing whether the result holds up.

## The “Donna” mental model

The intended experience is closer to Donna from *Suits* than to a generic chatbot or automation
builder: a super-secretary, practical coach and mentor, and someone enjoyable enough to chat and
goof off with while she quietly saves the user's ass.

The useful part of that analogy is not fictional omniscience. It is the service pattern:

1. Notice what is really causing friction.
2. Understand what the user is trying to achieve, even when the request is messy.
3. Work out which parts Eve can safely handle herself.
4. Do those parts instead of handing them back as instructions.
5. Return only the decisions, approvals, or missing information that genuinely require the user.
6. Keep the interaction warm, practical, and human enough that users bring Eve unfinished thoughts,
   annoyances, and half-formed problems rather than only polished tasks.

The central user need is:

> **Don’t hand the problem back to me.**

## Advice is not the finish line

Normal chat often produces useful explanations that still create more work for someone whose hands
are already full.

Example:

- User: “My university admin is becoming a mess.”
- Advice-only response: “Here are seven ways to organize your semester.”
- Better Eve outcome: “I found the deadlines, put the important ones together, sorted the files you
  already downloaded, noticed one form you still need to deal with, and drafted the email. There are
  two things only you can decide.”

The same distinction applies across many domains:

| Situation | Advice-only behavior | Eve behavior to aim for |
| --- | --- | --- |
| Downloads folder is chaos | Suggest a folder structure | Inspect, propose a safe sort, flag uncertain files, and carry out the approved cleanup |
| Sims mod crashes | Tell the user to update dependencies and inspect logs | Find the mod, check version/dependencies, locate or help generate logs, research the error, and isolate the likely fix |
| Starting university | Recommend planners and time-blocking | Help keep course material, deadlines, files, and weekly next actions together |
| Job search | Give CV tips | Track suitable roles, prepare tailored material, keep application state visible, and bring back only choices or approvals |
| Repeated life admin | Suggest reminders | Keep an eye on the moving parts, prepare what can be prepared, and surface the next real decision |

There is therefore a three-level progression worth testing in research:

1. **Answer:** Eve gives a conclusion.
2. **Handled outcome:** Eve carries the practical work through.
3. **Handled outcome + visible approach:** Eve carries the work through and leaves behind a small,
   reusable model of how the problem was approached.

The third level should not become extra homework. A good version is closer to "here were the three
things that mattered and the one check that ruled out the tempting wrong path" than a long tutorial.

## The research question to ask

When a user brings an annoyance, Eve should not default to:

> “How can I explain how the user should solve this?”

The better question is:

> **“What part of this can Eve actually take off the user's hands?”**

That should influence onboarding, suggested projects, product copy, agent behavior, and acceptance
testing.

## Discovery problem: users cannot imagine the capability graph

Terms such as “persistent context,” “automation,” “permissions,” “agents,” and “computer use” do
not reliably help ordinary users picture useful outcomes. They are implementation concepts, not
life problems.

Research and onboarding should therefore begin with recognizable situations:

- “I’m starting university.”
- “My computer is a mess.”
- “Something I installed is broken.”
- “I’m overwhelmed with little things.”
- “I need to make an important decision.”
- “There’s something I keep putting off.”
- “I have a hobby or project I want to get better at.”
- “I don’t know what Eve could help with.”

The interface should do the imaginative work for the user by turning those situations into concrete,
high-impact projects.

## Language that tested conceptually better

Translate technical concepts into felt outcomes:

| Internal concept | Human wording |
| --- | --- |
| persistent context | “Eve remembers what you were working on.” |
| automation / monitoring | “Eve can keep an eye on this for you.” |
| computer use | “Eve can do this on your computer.” |
| permissions | “You choose what Eve is allowed to see and change.” |
| workers / agents | “Eve can split up a big job and work on several parts.” |
| durable state | “Eve can come back tomorrow without you explaining everything again.” |
| asynchronous execution | “Eve can keep working while you do something else.” |

Even these explanations are secondary. The strongest discovery language starts with a familiar
problem and shows what relief looks like.

## High-impact audience examples

Current research direction favors “pieces of life Eve can own” rather than an “automations” gallery.
Eight especially promising experiences are:

1. **Keep me on top of university** — gather what changed, keep deadlines and files together, and
   make the week's next actions obvious.
2. **Help me catch up** — inspect what was missed, prioritize what matters, and build a realistic
   recovery path.
3. **Sort out this mess on my laptop** — organize files and downloads, identify duplicates or stale
   material, and preserve anything uncertain for review.
4. **Something is broken; help me fix it** — inspect the real environment, find logs or help produce
   them, research current fixes, and make safe repairs.
5. **Tell me what I need to deal with this week** — collect actionable items from the places the
   user already depends on and reduce them to a manageable view.
6. **Figure out what I should choose** — research a real decision, compare options against the
   user's needs, and return a small number of concrete choices.
7. **Take this annoying recurring chore off my mind** — prepare, check, organize, or follow up so
   the user does not have to keep remembering the same thing.
8. **Help me actually finish this long-term goal** — preserve the thread, keep the next meaningful
   step alive, and connect today's work to the larger objective.

### Sample project: Expenses inbox

The Expenses sample project should have one default place to use repeatedly rather than teaching the
user to distribute receipts across many chats. The intended behavior is closer to an inbox than a
photo collection:

- the user keeps sending receipt photos to the same pinned Expenses chat when convenient;
- Eve treats each receipt as something to ingest and reconcile, not as something worth preserving in
  an image gallery for its own sake;
- Eve transcribes and normalizes the useful content into structured local data, including date,
  vendor/store, location when available, total, line items, article/product type, price, quantity,
  unit price or promotion details when recoverable, and confidence/correction notes where needed;
- the structured ledger is the default durable project record; recording a purchase does not by
  itself create another raw receipt copy;
- Eve checks for plausible warranty or return value, including a durable item inside a grocery
  receipt, and can ask whether the user wants the full original kept locally when that evidence is
  useful;
- a raw original is retained in the local project only when the user chooses to keep warranty/return
  proof, so the full proof-of-purchase remains available for that later need;
- analysis should run over the structured ledger rather than repeatedly rereading every historical
  image.

The product should tolerate real-life scatter later. A user with ADHD may occasionally send a receipt
in the wrong chat or from another device. Eve should be able to recognize and offer to file it into
Expenses instead of treating perfect inbox discipline as a prerequisite. The default experience,
however, should remain one obvious receipt inbox.

ChatGPT's own conversation/file retention is a platform behavior and must not be confused with
ParadigmEve-created copies. ParadigmEve should not deliberately create ChatGPT Library copies or a
second cloud image archive for receipts. Its default durable state is the normalized local ledger;
an exact raw original is an optional local project copy only when the user chooses to keep
warranty/return proof.

The current integrated behavior for monthly budget buckets, retained-receipt opt-out and later bank
reconciliation is specified in [Expenses inbox specification](expenses.md); this research example
should not be read as a separate storage or accounting authority.

These should be evaluated by whether Eve reduces the number of things the user still has to carry,
not merely by whether Eve produced a good answer.

## Important audience lenses

### Everyday ChatGPT user who is about to start university

She already knows she can ask GPT for answers. The product opportunity is to show that Eve can help
with the workload around the answers: course material, files, deadlines, weekly preparation,
catch-up, and long-term career progress.

For users with ADHD or high cognitive load, the strongest value is often not “save four hours.” It
is reducing the number of unfinished threads they must keep alive in their head.

### Hobbyist / gamer / mod user

A user may not know how to install something, where a crash log comes from, which log matters, how
to reproduce an error, whether wiki advice is outdated, or where forum users found the real fix.
Eve can bridge that gap by looking at the actual setup, researching current community knowledge,
and carrying practical troubleshooting work rather than merely explaining generic steps.

This is a strong example of why nontechnical discovery matters: the user may never think to ask an
assistant to inspect the machine, generate or locate logs, compare documentation with forum evidence,
or improve the support path itself.

### Budget automation power user is not the default audience

There is a visible online audience that actively compares automation stacks, self-hosted tools,
AI-agent frameworks, lifetime deals, and low-cost marketing software. They gather in developer and
founder communities such as automation-focused subreddits, SaaS/indie-hacker groups, Product Hunt,
and discount marketplaces.

That audience is useful for learning what technically ambitious users value: transparent pricing,
local control, extensibility, and the ability to replace expensive subscriptions with flexible
workflows. But it should not define Eve's first-use experience.

The default Eve user should not need to enjoy optimizing a software stack. The product should appeal
to people who want **less to manage**, not people looking for another system to configure.

Research therefore distinguishes two motivations:

- **Stack optimizer:** “How cheaply and flexibly can I automate this?”
- **Ordinary busy user:** “Can someone please take this off my plate?”

Eve may serve both, but product discovery, examples, and onboarding should lead with the second.

## Success criteria

User research should consider the concept successful when users begin to say things like:

- “I didn't know I could give that to Eve.”
- “She already handled most of it.”
- “I only had to answer one thing.”
- “I didn't have to remember to check again.”
- “I could keep doing what I was doing while Eve dealt with it.”
- “I can just tell her the messy version.”
- “I’m starting to notice how she approaches these problems.”
- “I used the same check myself before asking Eve.”
- “I knew what evidence would change the answer.”

The goal is not to make users fluent in agent terminology. The goal is to make delegation feel
obvious while gradually making good reasoning feel familiar.

## Research direction: reasoning literacy by apprenticeship

This should be treated as **cognitive apprenticeship**, not "AI explains its brain." The interesting
research question is whether users gain a better mental model of problem solving when Eve repeatedly
surfaces compact reasoning heuristics attached to successful work.

Promising patterns to test include:

- a collapsible **How I approached this** card after a nontrivial result;
- one sentence naming the key uncertainty before a decision;
- a visible **facts / assumptions / missing** split when the task contains weak evidence;
- showing the rejected alternative only when it teaches a useful distinction;
- a **what would change this answer?** line for recommendations and forecasts;
- a lightweight verification step that demonstrates why completion is believable.

The product should avoid three failure modes. First, do not expose or imitate private chain-of-thought;
the user needs concise rationale and method, not hidden-token narration. Second, do not turn Eve into
a schoolteacher who adds friction to every interaction. Third, do not let a polished explanation make
an uncertain result look more certain than it is. Visible method is only useful when its evidence,
uncertainty, and verification remain truthful.

If this works, Eve's value is not only that users can "think with AI." It is that frontier problem-
solving habits can trickle down through repeated, concrete examples until the user has more of those
habits available even when Eve is not present.

One especially important test is **mentorship without institutional ingestion**. A junior worker,
student, career changer or person facing an unfamiliar life task should be able to ask how an
experienced practitioner would approach a goal without first connecting a company SharePoint,
uploading an internal manual, or proving that they already know the professional vocabulary. Eve can
teach the general structure first, then request only the narrow local facts needed to make the next
step specific. This both lowers the embarrassment cost of asking basic questions and preserves a
clean boundary between broadly useful reasoning patterns and private organizational knowledge.

The research outcome is not merely faster task completion. Ask whether Eve leaves behind a useful
structure: does the person understand the goal more clearly, know what evidence matters, see the next
few moves in a less exhausting order, and become better able to recognize a similar problem later?
For workplace apprenticeship, a strong long-horizon measure is whether someone can handle a class of
problems they could not handle before, without transferring a new recurring teaching burden to the
senior people around them.

## Competitive research: why users switched from OpenClaw to Hermes

Recent community reporting around Hermes Agent suggests a useful second lesson after OpenClaw's
initial virality. OpenClaw demonstrated that people get excited by software that can actually carry
work across files, browsers, tools, and multi-step workflows. Hermes appears to have gained momentum
by making three additional things unusually legible to users:

1. **Visible learning over time.** Users could see the agent improve from previous work rather than
   feeling as if every task started from zero. For Eve, the consumer translation is not “closed
   learning loop” or “self-writing skills.” It is simply: **“Eve gets better at helping you because
   she remembers what worked.”**
2. **Trustworthy defaults.** Security concerns around OpenClaw reportedly made safer defaults a major
   reason to switch. Eve should treat trust as product experience, not legal copy: users should be
   able to understand what Eve can see, what she can change, and what she is doing without reading
   architecture documentation.
3. **Very low switching friction.** Hermes' reported `hermes claw migrate` workflow is a strong
   product-growth lesson: when a user already has valuable setup/history elsewhere, changing tools
   should not mean starting over. Eve should look for ways to import, reuse, or reconnect existing
   work instead of demanding a clean-slate setup.

The strategic lesson is not to imitate developer-focused agent branding. It is that **capability,
trust, learning, and migration compound**. A person is much more likely to recommend an assistant
when they can say “it handled the job, it learned how I like it, I trust it, and switching was easy.”

Specific claims about Hermes/OpenClaw user-share shifts, CVE counts, marketplace malware rates, or
social reach come from external community reports and must be independently verified before being
used as public ParadigmEve marketing facts.

## Competitive lesson: what OpenClaw proved

OpenClaw's rise is useful research because it showed that people get excited when AI stops being
only conversational and can carry multi-step work across files, browsers, tools, email, CRM, and
other real systems. Common examples included marketing pipelines, inbox triage, recurring briefings,
competitive research, private-document work, and other jobs that continue beyond one answer.

The important product lesson is not that ParadigmEve should imitate the “one person replaces a whole
department” fantasy. That framing naturally attracts founders, power users, and automation hobbyists.
The transferable lesson is simpler:

> **People react strongly when the AI can take work off their hands instead of describing how to do it.**

That validates the action half of Eve's product thesis. Eve should translate the same feeling for
ordinary life: studying, household administration, hobbies, broken software, paperwork, planning,
shopping, career goals, and all the small jobs a busy person otherwise has to carry themselves.

OpenClaw also illustrates a caution. High volumes of autonomous activity can look impressive without
proving that the user's actual outcome improved. Eve should therefore prefer visible completion,
clear evidence, and a smaller decision surface over activity for activity's sake. “A lot happened” is
not the same as “the problem is now easier or solved.”
