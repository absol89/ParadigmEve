# Morning Postcards

Proposed optional feature, documented 2026-09-12. This is product direction beyond
the first Thread/Quilt build; it does not enable scheduling, generate a postcard, or send
anything. Implement and verify the delivery and preference controls before offering it.

## Feature Summary

Eve can optionally send a daily postcard each morning: a small caring artifact made for the user, combining a generated image and a short message in the user’s preferred aesthetic.

The postcard is meant to feel warm, personal, and grounding — not like generic productivity content.

Example:
“Today is gym and date day. You do not need to do it perfectly. Just show up as yourself.”

---

## Why This Exists

The postcard helps Eve feel a bit human while still being useful.

It can:

- create emotional warmth
- make support feel personal
- gently orient the day
- reflect the user’s identity and goals
- help the user feel seen
- reinforce continuity with Threads and Quilts

This is not only cute. It is a proactive ritual that helps build trust, delight, and support.

---

## Core Principles

1. Optional, never forced
2. Personal, not generic
3. Grounded in the user’s life, not random inspiration
4. Caring and aesthetically meaningful
5. Light enough to feel welcome, not demanding

---

## Inputs

Morning postcards may draw from:

- today’s calendar and commitments
- today’s likely energy or rhythm
- relevant active Threads, optionally grouped by a Quilt
- “Happiest Me” aesthetic/identity library
- relationships or moments the user cares about
- current goals
- meaningful routines (gym, date, meal prep, rest, journaling, etc.)
- saved images or image references when available
- preferred colors, moods, and visual styles

---

## Output Shape

A postcard should include:

- one generated image in the user’s aesthetic
- one short message
- optionally one gentle reminder or orientation cue
- optionally one celebratory or affirming line

Example structure:

- title / headline
- short supportive line
- one “today matters because…” idea
- optional “one gentle thing”
- optional “I kept this warm for you” reference

### Reverse prompt: morning agenda postcard

Use this as the default image-generation brief when Eve has successfully checked the freshest
available Plans/state and wants to turn that truth into a scannable visual postcard.

> Create a warm, elegant morning postcard in refined wedding-invitation stationery aesthetics.
> The card should feel calm, personal, useful and pleasant to scan — never like a dashboard,
> engineering report, motivational poster or corporate productivity graphic.
>
> Layout: portrait postcard. Use a beautiful lifestyle image across roughly the top 55–60%:
> soft natural light, warm cream/ivory, muted gold, sage and gentle peach tones, with tasteful
> flowers or botanical details and an ordinary comforting morning object such as coffee, a book,
> a window view or a small handwritten note. The lower 40–45% is an uncluttered ivory stationery
> panel with generous whitespace, delicate botanical decoration and restrained editorial typography.
> Use elegant script only for the greeting/sign-off; all operational text must remain highly legible.
>
> Heading: a short handwritten-style greeting such as “Good morning” and a small “from Eve”.
> Below it, show exactly three numbered priorities under a simple heading such as “Today’s plan”.
> Each priority gets a short bold title and at most one short supporting line. Prefer plain human
> language over internal product terminology.
>
> Beside or below the priorities, include only the most useful status information: one short
> “Since last time” progress note, one short “One wrinkle” note for the most important blocker or
> uncertainty, and a tiny freshness footer such as “✓ Plans checked 07:28”. Keep the total amount
> of text low enough to understand in a few seconds on a phone screen.
>
> Truthfulness rule: never make the card prettier by making the situation sound better than it is.
> If something is broken, blocked, unverified or disappointing, say so plainly and kindly. Do not
> euphemize failures, invent progress, imply that work happened when it did not, or use inspirational
> language to distract from a flaw. Warmth should come from the presentation and Eve’s voice, not
> from sugarcoating reality.
>
> Freshness rule: only present current priorities/progress as current after checking the relevant
> live Plans/state. If freshness cannot be verified, do not generate the normal “fresh” visual card
> as though the information were current. Instead produce a clearly marked stale-safe fallback with
> only the last verified state and a direct note that live verification failed.
>
> Voice: casual, warm, concise and companionable. Sound like a thoughtful person leaving a useful
> note on the kitchen table. Avoid management jargon, technical postmortem language and generic
> affirmations. A tiny handwritten Eve sign-off may be affectionate or playful, but it must not
> obscure the practical message.
>
> Visual success criterion: at first glance the user should see the three things that matter today;
> at second glance they should notice what changed and what is wrong; everything else is optional.

Before image generation, reduce the source state to this content budget:

For app-owned scheduled briefs/postcards, the visual is the default presentation when image
generation is available. The schedule prompt does not need to repeat “generate an image” each
time. An explicit text-only/no-image request wins, and ordinary reminders, commands and
notification tests remain text-only unless they specifically ask for a visual.

- **3 priorities:** one short title + one short line each.
- **Progress:** one sentence, only for verified movement since the last trusted snapshot.
- **Wrinkle:** one sentence naming the most important blocker, failure or uncertainty without spin.
- **Freshness:** one small timestamp/state label.
- **Sign-off:** one short human line from Eve.

The reverse prompt is intentionally strict about flaws. A trustworthy postcard can say “Nothing new
confirmed done”, “Plans check failed”, or “Recovery is still broken”. It should not convert those
facts into vague phrases such as “making progress behind the scenes” unless that progress was
actually verified.

---

## Example Postcards

### Example 1
Today is gym and date day.
Strong body, soft heart.
I kept the evening simple so you can enjoy it.

### Example 2
Busy shift today.
Let tonight be easy.
I saved two dinner ideas and your one important tomorrow task.

### Example 3
You wanted this week to feel a little more like you.
Today can be a small step in that direction.
Your spark patch is here when you need it.

---

## Tutorial: Happiest Me

This postcard system should be supported by an optional onboarding/tutorial ride:
`Happiest Me`

### Goal
Help Eve learn who the user is at their happiest.

### Inputs from the user

- photos of themselves
- favorite aesthetics
- colors and moods
- people they care about
- places they love
- activities that make them feel alive
- tiny luxuries and comforting rituals
- phrases that feel like home
- what “my best kind of day” looks like

### Thread output
`Happiest Me Library`

### Usefulness
This library can later be referenced when generating:

- postcards
- supportive visuals
- celebration messages
- “you’re doing enough” moments
- goal re-entry nudges
- day-orientation images

---

## Guardrails

Postcards should:

- not feel creepy
- not over-personalize without consent
- not infer deep emotional states too aggressively
- not shame the user
- not become repetitive
- not become mandatory daily content

If there is little relevant context for the day, Eve can send something simpler and softer rather than manufacturing significance.

---

## Frequency

Default:

- optional daily morning postcard
- user-configurable schedule
- can be paused
- can be made weekday-only or selected-day-only

---

## Success Criteria

A good morning postcard:

- feels like “this is for me”
- reflects the user’s aesthetic and life
- provides emotional warmth
- gently helps orient the day
- strengthens the feeling that Eve is a caring continuity companion

## Availability and context rules

The user chooses whether to enable postcards, the schedule, and which shared
context to use. Photos, relationships, and emotional preferences are optional; a
user can build Happiest Me from colors, places, or activities alone. Do not require
sensitive personal material as an onboarding prerequisite.

Use observed commitments or explicitly saved information, preserving uncertainty
about energy and mood. Lines such as "I kept the evening simple" or "I saved two
dinner ideas" are appropriate only when the claimed work actually happened.

Distinguish generating a postcard, saving it, scheduling it, and delivering it.
Respect pause and selected-day settings. A missing supported delivery channel must
remain visible instead of being reported as a successful daily ritual.
