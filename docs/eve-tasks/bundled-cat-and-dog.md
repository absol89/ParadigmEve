# Bundled pets: a cat and a dog

**Owner:** Eve · **Target:** 2.3.2 · **Status:** Ready to start · **Written:** 2026-09-29

## Goal

ParadigmEve 2.3.2 ports Chat On Steroids' desktop pets. It ships Hammy the hamster from upstream as
the working reference. Make the other two bundled pets, **a cat** and **a dog**, as the first real use of
the Vault page `docs/vault/15-desktop-pets-and-avatars.md`. Users will later follow that same page to
have you make human avatars of Eve, so anything unclear or wrong in it should be fixed while you do this.

## What to deliver

- `pets/cat/{pet.json, atlas.png, animations.json}` with `"id": "cat"`.
- `pets/dog/{pet.json, atlas.png, animations.json}` with `"id": "dog"`.
- The two canonical reference images and a labelled contact sheet for each pet, attached in your
  report (they are not committed).
- Any correction to the Vault page 15 that the work showed was needed, in the same branch.

## Design brief

- **Cat and dog**, each a friendly, original character, readable at 160 × 160 px. Same art style as each
  other, and compatible with Hammy on the same desktop (small, clean silhouette, clear outline).
- Propose a name, personality, palette and one optional accessory for each, with the reference image,
  and **wait for the user's OK** before producing the 96 frames.
- The comedy clips stay friendly: a paw swat or pounce for `punch`/`heavy`, a playful toss for `throw`.
- No text, logos, words or bins in the atlas; the app draws the "Bug"/"TODO" props.

## Rules

- Follow page 15 exactly. The contract is enforced by `src/main/pet-library.ts`; do not change that
  file, the frame layout or the tests to make a pet pass.
- Work on a branch `eve/bundled-cat-and-dog` from `release/2.3.2`, in its own `git worktree`. Never
  push, tag or publish.
- `npm run verify:privacy` before every commit. No attribution trailers.

## Acceptance

- The page-15 validation script, run with `--bundled` (these are ParadigmEve's own pets, so the reserved
  ids are allowed), prints `OK` for both folders.
- These pass, and cover the new pets automatically:
  - `npx vitest run test/pet-atlas.test.ts test/pet-bundled.test.ts`;
  - then the full `npm run verify`.
- In a dev build (`npm run dev`), Settings → Pets lists Hammy, the cat and the dog as Bundled. With all
  three enabled, each spawns, idles, wanders (both directions), can be dragged and dropped, reacts to a
  click and to four quick clicks, and plays both right-click scenes ("Swing at a bug", "Toss a TODO")
  with the word held in the paw during carry.
- A task started in a chat makes the pets react (spawn), and a finished one shows the tray badge and
  celebrate.

## How to report

Reply with:

- the branch and commits;
- the validation and test output;
- the contact sheets;
- what you changed in page 15, and why;
- anything the user should look at by eye.

## Prompt for Eve

> Your single focus for this chat is making ParadigmEve's two new bundled pets, a cat and a dog. First read
> `docs/eve-tasks/bundled-cat-and-dog.md` and `docs/vault/15-desktop-pets-and-avatars.md` in the
> ParadigmEve repository, and look at `pets/hammy/` as a working example.
>
> Before generating any frames:
>
> 1. Propose each pet's name, personality, palette and accessory.
> 2. Show me one canonical reference image for each.
>
> Wait for my OK. Then produce, assemble, validate and QA both packages exactly as page 15 says, on
> branch `eve/bundled-cat-and-dog` in its own worktree. Run the tests the task file lists, fix page 15
> if it misled you anywhere, and report as the task file asks. Do not push, tag or publish anything.
