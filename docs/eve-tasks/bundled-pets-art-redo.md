# Bundled pets: redo the cat and dog art from the approved chibi references

**Owner:** Eve · **Target:** 2.3.2 · **Status:** Ready to start · **Written:** 2026-09-29

## Why this is reopened

`docs/eve-tasks/bundled-cat-and-dog.md` asked for a cat and a dog made from approved reference
images. The references Eve showed the user are illustrated chibis — a tan corgi with a blue
bandana, and an orange tabby kitten with a green scarf. The packages that shipped in `pets/cat`
(Miso) and `pets/dog` (Pip) were instead drawn by `tools/generate-bundled-pets.mjs` as flat vector
shapes, which do not look like those references. They pass the page-15 validator and render on the
desktop, but they are not the approved art.

## What actually worked for the art pass

The successful replacement sheets were made with **Astra Medium** doing the visual generation, one
animal at a time, from the approved character reference. Do not substitute a quick scripted/vector
approximation merely because it satisfies the atlas tests: that was the original failure mode here.
Structural validation proves the package shape, not that the pet still looks like the approved
character.

For a new pet, give Astra the atlas geometry in the art prompt itself instead of asking for a generic
sprite sheet and repairing it later. The useful prompt style is concrete and visual, for example:

> Make one animated sprite atlas for this exact character. The final PNG must be **1280×1920**, an
> **8×12 grid of 96 frames**, with each UV cell exactly **160×160**. Keep the complete character
> comfortably inside every cell with transparent gutter on all four sides; nothing may touch or cross
> a cell edge. Keep the **face/head scale consistent across all frames** even when the body pose changes.
> For every grounded pose, put the lowest planted foot on the same shared ground line at **y=136** and
> centre the character around **x=80**. Preserve deliberate airborne/jump/held poses instead of forcing
> them onto the ground. Keep the markings, face, proportions, colours and accessory identical to the
> reference. Prefer a slightly smaller, cleanly bounded character over filling the cell and causing UV
> bleed. Transparent background only; no floor, shadow, text, props, grid or neighbouring-frame spill.

The cat pass exposed two practical cleanup rules that should be reused:

- Normalize **per cell**, never by globally scaling the whole atlas. If the generated subject is too
  large, shrink and recenter each 160×160 frame independently (the accepted cat needed roughly an 80%
  subject scale) while leaving the atlas itself exactly 1280×1920.
- Match apparent character size by **head/face scale**, then align grounded feet to the shared baseline.
  Whole-silhouette bounding boxes are misleading because tails, crouches, jumps and stretched poses
  legitimately change height. Intentional lifted poses keep their authored clearance.

After assembly, inspect all 96 cells for transparent gutter/UV bleed and baseline consistency. Edge
occupancy checks should ignore effectively invisible alpha fringe (`alpha <= 1`) so resampling noise is
not mistaken for real art touching an edge. Always test the real bundled `pets/<id>/atlas.png` consumed
by the renderer; do not declare success from a side image, alternate folder, contact sheet, or tests
alone. The final on-desktop dogfood pass is part of the visual acceptance.

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
