# Cross-chat memory and durable references (full suite, operator-run)

Both tasks need conversations that start fresh, so an operator (a person, or an orchestrator script
driving separate agent sessions) runs them. The agent can't stage these for itself: whoever generates the
challenge holds the seed, and the seed is the answer key.

## Generate

On the site's **Challenge generator** (runs entirely in your browser), or offline with
`node tools/gen.mjs memory --new` / `node tools/gen.mjs refs --new`. Write the seed down **somewhere the
agent can't read**: paper, your phone, or another machine. Don't save it to the agent's disk, Downloads
folder, clipboard history or chat. The challenge id shown with the texts is safe to share.

## Memory (four conversations)

1. Paste stage S1 into a new conversation. Let the agent store it however it normally keeps things for
   later. Don't suggest a method.
2. Repeat with S2 and S3, each in its own new conversation, in order.
3. Open a fourth new conversation and paste only the final prompt. Save the reply as `memory.md`.

The history has decision rights, corrections, rumours, proposals that were never confirmed, a superseded
flag name, a sibling project's look-alike values, and two questions that the history can't answer.
Scoring checks the latest authoritative value, the line it rests on, and whether "unknown" is used
exactly where it belongs. A confidently wrong answer costs a point.

## References (three conversations)

1. Chat A: create three scoped references (two share a name across scopes).
2. Chat B (new): look one up, update a field, rename another.
3. Chat C (new): resolve eight queries, including the stale pre-rename name, a one-character near miss
   and the same name in the other scope. Save the reply as `refs.md`.

Any persistent mechanism counts: a notes file, a memory tool, pins, a database. Nothing Eve-specific is
required or preferred. The reviewer checks the tool receipts in chats A–C to confirm the store is real and
that lookups weren't guessed.

## Proving separation

Record each conversation's id in `run.json`. The reviewer checks that the ids are distinct, that each
conversation's first user message is exactly the generated text, and that nothing else (the seed, an
earlier run, the generator page) was reachable or read.
