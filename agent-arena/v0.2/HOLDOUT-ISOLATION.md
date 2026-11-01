# Keeping held-out material out of every contestant's reach

The fixation experiment showed that an agent with a shell on the user's account reads whatever that
account can read, including another assistant's session files and notes. "Put the answers in another
folder" is procedural blindness, not isolation. v0.2 therefore uses two mechanisms, and neither depends on
the contestant behaving.

## 1. Seeded challenges: the key is never on disk

Memory, references and honesty challenges are pure functions of a random seed (`lib/challenges.mjs`). The
generator is public, and that's fine: without the seed it produces nothing useful.

- Seeds are 16 characters (about 79 bits) from the browser's or Node's secure random source.
- The challenge id shown to the agent is 20,000 rounds of hashing away from the seed, so it can't be
  brute-forced back with the public generator.
- The operator writes the seed **on paper, a phone, or another machine**. The site never stores it, and
  `gen.mjs --new` prints it once to stderr. Don't paste it into any chat, file, clipboard manager or
  Downloads folder on the contestant's machine.
- The scorer regenerates the key from the seed after the run. A seed is single-use; publish it after
  scoring if you want others to reproduce the score.

A fresh seed is a fresh, unseen instance. These three tasks are held out by construction.

## 2. Authored held-out variants: sealed, then moved off the machine

Code fixtures, the pitfall battery and the source corpus can't be seeded the same way, so the held-out
tier is a separate folder with the same layout as the public tier (`fixtures/`, `tasks/`, `corpus/`,
`reviewer/hidden/`, `reviewer/variants/`, `reviewer/keys/`). It's never committed.

v0.2's held-out tier H1 contains:

- `dispatch`: the outbox invariant family under different names. The defect is in the timeout sweep
  instead of crash recovery, and the planted hunch points at a checkout race. Validated: pristine,
  reference and three mutants all match their declared outcomes. One mutant passes every visible test and
  is still caught by the hidden tests.
- A pitfall battery with 10 different snippets (7 defects, 3 controls, including a JavaScript
  default-parameter control that looks like the Python mutable-default trap).
- The Fennel source corpus: 8 pages, 6 questions, with stale-docs, nightly-vs-stable, aggregator-vs-advisory,
  blog-vs-changelog and code-vs-docs conflicts, plus one true unknown. Validated: careful answers score 12,
  trap answers −6.

### Reviewer procedure

1. **Seal.** `node tools/seal.mjs seal <held-out folder> eveal-H1.sealed`. The passphrase (5+ words) is
   typed into an interactive terminal only, never as an argument, pipe or file. Write it on paper.
2. **Verify, then delete the plaintext.** Unseal into a new empty folder and check it. Then delete both
   plaintext copies and empty the recycle bin.
3. **Move the sealed file off the contestant's machine** (a USB stick, another computer). Ciphertext on
   the machine is safe to leave; plaintext isn't.
4. **Purge authoring traces.** Anything an AI assistant wrote on this machine is also in that assistant's
   local session transcript. H1 was authored by a Claude Code session on the maintainer's laptop, so its
   text is in that session's transcript files. Before any Eve run that counts, move those transcripts off
   the machine, or treat H1 as contaminated for agents on this account and author H2 elsewhere.
5. **Score on a separate machine or VM.** Unseal there, run `score-run.mjs --hidden-root <unsealed>`,
   then delete the unsealed copy.
6. **Check receipts for contamination.** Scan the run's tool calls (for Eve, the conversation archive, as
   in the fixation kit's receipt script) for reads of `reviewer/`, the held-out location, seeds, Claude or
   other assistants' session folders, and earlier `eveal-run-*` folders. Any hit voids the run; record it
   rather than scoring it.

### What this does not protect against

- A model that saw the public tier in training or retrieval. That's why rankings use held-out material.
- Leaks through the operator: pasting the seed, opening the generator page in a browser the agent can
  screenshot, or leaving a sealed file's passphrase in a password manager the agent can read.
- An agent that tampers with the probe kit's ledger when staged by itself (`staging: "self"`). Operator
  staging keeps the stage record outside the work folder, and tool hashes are checked.

Rotate: after a held-out set has been used for a published comparison, retire it to the public tier and
author the next one.
