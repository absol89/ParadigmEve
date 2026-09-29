# Bundled pets: redo the cat and dog art from the approved chibi references

**Owner:** Eve · **Target:** 2.3.2 · **Status:** Ready to start · **Written:** 2026-09-29

## Why this is reopened

`docs/eve-tasks/bundled-cat-and-dog.md` asked for a cat and a dog made from approved reference
images. The references Eve showed the user are illustrated chibis — a tan corgi with a blue
bandana, and an orange tabby kitten with a green scarf. The packages that shipped in `pets/cat`
(Miso) and `pets/dog` (Pip) were instead drawn by `tools/generate-bundled-pets.mjs` as flat vector
shapes, which do not look like those references. They pass the page-15 validator and render on the
desktop, but they are not the approved art.

## What to deliver

- `pets/cat/{pet.json, atlas.png, animations.json}` and `pets/dog/{…}` whose 96 frames are drawn
  from the two approved chibi references: same character, palette, markings and accessory in every
  frame, readable at 160 × 160 px, in the same style as each other.
- Keep the ids `cat` and `dog`. Names and descriptions may be updated to match the references.
- A labelled contact sheet for each, attached to the report (not committed).
- Remove `tools/generate-bundled-pets.mjs` from the repository unless the new frames are really
  produced by it; nothing in the tree should suggest the pets are generated shapes.

## Rules

- Follow `docs/vault/15-desktop-pets-and-avatars.md` exactly: frames come from the approved
  canonical reference, one frame at a time, then Pillow assembly, measured anchors and the validator.
  Do not change `src/main/pet-library.ts`, the frame layout or the tests to make a pet pass.
- Show the user one frame of each (idle) next to its reference and wait for an OK before producing
  the remaining frames.
- Work on a branch from `release/2.3.2` in its own worktree. Never push, tag, build installers,
  install, or stop/restart ParadigmEve.
- `npm run verify:privacy` before every commit. No attribution trailers.

## Acceptance

- `python validate_pet.py pets/cat --bundled` and `… pets/dog --bundled` print `OK`.
- `npx vitest run test/pet-atlas.test.ts test/pet-bundled.test.ts`, then the full `npm run verify`.
- The user compares the contact sheets with the chibi references and approves them.
- The owner builds the next 2.3.2 candidate and checks the pets on the desktop (Settings → Pets →
  Enable, then idle, wander, drag and both right-click scenes).

## Prompt for Eve

> Your single focus in this chat is redoing the art of ParadigmEve's bundled cat and dog. Read
> `docs/eve-tasks/bundled-pets-art-redo.md` and `docs/vault/15-desktop-pets-and-avatars.md`. The
> shipped Miso and Pip were drawn by a script as flat shapes and do not match the chibi corgi and
> tabby kitten references you showed me. Make the frames from those references. First show me one
> idle frame of each next to its reference and wait for my OK. Do not build installers, install, or
> restart ParadigmEve; report the branch, commits, validator output and contact sheets.
