# 15 — Desktop pets and Eve avatars

This page is the production contract for a **desktop pet**: a small animated character that lives on
the user's desktop, reacts to what Eve is doing, and can be dragged, poked and hidden. It covers
animals (the bundled Hammy, cat and dog) and a **human avatar of Eve** made for a particular user.

Read it whenever a user asks you to make a pet, an avatar of yourself, or to fix one that does not
import. Follow it exactly: the app rejects any package that differs from the contract, and a pet that
passes the contract but drifts in identity or cuts off at a cell edge looks broken on the desktop.

The format is shared with Chat On Steroids ("cos-pet" format, 96 frames), so packages made for either
app import into both. ParadigmEve's source is `src/main/pet-library.ts` (validation and import),
`src/main/pet-overlay.ts` (the desktop window) and `src/renderer/pet-machine.ts` (animation).

## What the user does, and what you do

1. The user opens **Settings → Pets → How do I make one?**, copies the prompt, describes the pet (or
   asks for "an avatar of you") and sends it to you.
2. **You** design the character, generate every frame, assemble and validate the package, and save the
   three files in one folder inside an approved folder. Report the folder's full path.
3. The user presses **+** on the Pets page and chooses that folder. The app validates it, copies it
   into its own library, and the user enables it.

You cannot import or enable a pet yourself. Never ask the user to fix frames, measure anchors or edit
JSON: that is your job, and a rejected import means you repair and re-deliver.

## Before you draw: the brief and one canonical reference

Agree on the character first, in one short exchange:

- **Name and id.** `id` is lowercase letters, digits and single hyphens (`eve-avatar`, `ginger-cat`).
  It must not be the id of a bundled pet (`hammy`, `cat`, `dog`).
- **Look.** Silhouette, proportions, palette (3–6 colours), outline style, one optional
  character-owned accessory, and pixel art or smooth style. Everything must stay readable at 160 px.
- **Personality**, which drives the timing and the poses: calm, bouncy, grumpy, curious.

Then make **one canonical reference image** (front three-quarter view, neutral pose, transparent or
flat background) and show it to the user. Do not produce the 96 frames until they approve it. Every
frame is drawn from that reference: same face, silhouette, proportions, palette, outline, accessory
and handedness.

### A human avatar of Eve

- If the user already has an image of Eve they like, use it as the reference and say so. Otherwise
  propose a design: friendly, approachable, clearly a stylised character rather than a photo.
- Never copy the likeness of a real person, a celebrity or an existing copyrighted character, even on
  request. A user may ask for an avatar *inspired by* their own description of Eve; that is fine.
- Keep the whole body in frame (a chibi / small-body proportion reads best at 160 px), feet on the
  shared baseline, and give her a visible hand for the grab and carry poses.
- The comedy clips below must stay friendly for a person: a playful swat with a rolled-up paper or a
  big "fixed" stamp for `punch`/`heavy`, a cheerful toss for `throw`. No weapons, no injury, no
  aggression aimed at the viewer.

## The package: exactly three files in one folder

```
<folder>/
  pet.json
  atlas.png
  animations.json
```

Keep contact sheets, previews, references and working files **outside** this folder. The app copies
only these three files and ignores anything else.

### pet.json

```json
{
  "format": "cos-pet",
  "version": 1,
  "id": "eve-avatar",
  "displayName": "Eve",
  "description": "A short, friendly description."
}
```

`displayName` must be non-empty (100 characters are shown); `description` is a string (500 shown).

### atlas.png

- PNG with alpha, at most 12 MiB, **exactly 1280 × 1920 px**.
- 8 columns × 12 rows of **160 × 160 px cells**, 96 frames in row-major order: frame 0 is top-left,
  frame 7 ends the first row, frame 95 is bottom-right. Frame `n` sits at column `n % 8`, row `⌊n / 8⌋`.
- Transparent background. No white, black or checkerboard backdrop, and no leftover colour in fully
  transparent pixels.
- One complete, centred character per cell with a stable scale. The **anchor is `[80, 136]`**: the
  horizontal centre and the ground line the feet stand on.
- **Nothing may touch or cross a cell edge**: keep at least one fully transparent pixel on every side
  of every cell. The desktop shows exactly one cell, so anything past the edge is cut off or bleeds
  into the neighbouring frame.
- No scenery, floor, cast shadow, glow, UI, speech bubble, text, logo, frame number, grid or
  watermark. Prefer pose and expression over blur, smears, speed lines or loose sparkles.
- The runtime **mirrors the character horizontally** when it walks the other way. Every pose must still
  look right mirrored.
- Frame 7 (the last idle frame) is the library thumbnail. Make it a good portrait.

### animations.json

The root object contains exactly this data plus `animations` and `hands`:

```json
{
  "version": 1,
  "image": "atlas.png",
  "width": 1280,
  "height": 1920,
  "columns": 8,
  "cellWidth": 160,
  "cellHeight": 160,
  "frameCount": 96,
  "anchor": [80, 136],
  "animations": { "…all 14 clips below…": {} },
  "hands": { "…every frame 69 through 84…": [0, 0, 1] }
}
```

Each clip is `{ "frames": [...], "ms": [...], "loop": true | false }`. `frames` and `loop` must be
**exactly** as in the table. `ms` has one positive duration (≤ 10000) per frame; the values given are
good starting timings, which you may tune to the character's personality.

| Clip | Frames | Loop | Starting ms | When the desktop plays it |
| --- | --- | --- | --- | --- |
| `spawn` | 0–3 | no | 130 110 100 140 | Appears, and Eve starts working on a task |
| `idle` | 4–7 | yes | 600 200 220 650 | Resting between events: calm breathing/blinking |
| `look` | 8–11 | no | 90 100 330 200 | A task is waiting (e.g. a sleeping worker); must differ from idle |
| `walk` | 12–19 | yes | 95 × 8 | Wandering along the desktop; clean, mirror-safe cycle |
| `held` | 20–23 | no | 100 100 160 200 | Picked up and dragged: body visibly suspended |
| `landing` | 24–27 | no | 70 100 130 170 | Recovering after being dropped |
| `poke` | 28–31 | no | 130 180 260 300 | A single click: a friendly reaction |
| `angry` | 32–37 | no | 150 110 90 180 150 200 | A task failed or the user blocked it; four quick clicks |
| `punch` | 38–55 | no | 140 70 65 80 100 90 130 70 65 80 100 90 150 70 65 80 100 120 | "Swing at a bug": three light hits toward the open side |
| `heavy` | 56–65 | no | 110 150 180 140 70 90 100 120 150 180 | The finishing hit: anticipation, contact on frame 61, recovery |
| `grab` | 66–71 | no | 100 120 150 160 140 170 | "Toss a TODO": reach for the word and pick it up |
| `carry` | 72–79 | yes | 110 × 8 | Carry the word while walking |
| `throw` | 80–87 | no | 150 150 190 100 90 130 160 180 | Throw it into the bin; the word leaves the hand after frame 83 |
| `celebrate` | 88–95 | no | 140 120 100 150 100 110 250 250 | A task finished and is ready for review; the end of both scenes |

The app draws the words ("Bug" → "Fixed", "TODO") and the bin itself as live elements. **Do not draw
any word, bin or target into the atlas**; draw only the character and its own accessory.

Loops (`idle`, `walk`, `carry`) must close cleanly: the last frame flows into the first with no jump.
Non-looping clips need anticipation, action and recovery, and must not "pop" on their last frame.
The four idle frames must keep the same outline: their bounding boxes may differ by at most 6 px.

### Hand anchors (frames 69–84)

`hands` has one entry for every string key `"69"` through `"84"`: `[x, y, side]`. `x` and `y` are
0–160, measured inside that frame's cell, at the point where the carried word's edge should touch the
character's leading hand (or paw). `side` is `1` or `-1` and chooses which edge of the word touches that
point. Measure them from your finished frames; never copy another character's numbers. Check them
visually: in `grab` from frame 69 on, in every `carry` frame, and in `throw` up to the release.

## Workflow inside ChatGPT

1. **Brief and reference.** Agree the brief, generate the canonical reference, get approval.
2. **Frames.** Generate each clip as a horizontal strip of its frames from the reference, one clip at
   a time, and reject any strip whose identity drifts. Crop each frame to a 160 × 160 cell with the feet
   on y = 136 and the body centred on x = 80, on a transparent background.
3. **Assemble** the atlas deterministically in Python (Pillow): paste frame `n` at
   `(160 × (n % 8), 160 × ⌊n / 8⌋)` on a transparent 1280 × 1920 RGBA canvas, and clear the colour
   channels of fully transparent pixels before saving.
4. **Measure** the hand anchors from the assembled cells and write `animations.json` and `pet.json`.
5. **Validate** with the script below. Fix only the failing clip and run it again. Do not deliver while
   anything fails.
6. **Look at it.** Render a labelled 96-frame contact sheet and an animated preview of each clip at its
   authored timing, including both scenes (walk → angry → punch → heavy → celebrate and
   walk → grab → carry → throw → celebrate) and a mirrored walk. Show the user the contact sheet.
7. **Deliver.** Save the three files into one new folder inside an approved folder (for example
   `<project>/pets/<id>/`) with your file tools, or download them there with `download_artifact`.
   Reply with the absolute folder path, the id and name, the atlas size in bytes, and the validation
   result, and tell the user to import it with the **+** button on the Pets page.

### Validation script

This checks everything the app's import checks, plus the quality rules ParadigmEve's own bundled pets
must meet. Run it on the finished folder: `python validate_pet.py <folder>`. Only when you are making one of
ParadigmEve's bundled pets (in the repository's `pets/<id>/`) add `--bundled`, which allows the reserved ids.

```python
import json, os, sys, hashlib
from PIL import Image

LAYOUT = {"spawn": range(0, 4), "idle": range(4, 8), "look": range(8, 12), "walk": range(12, 20),
          "held": range(20, 24), "landing": range(24, 28), "poke": range(28, 32), "angry": range(32, 38),
          "punch": range(38, 56), "heavy": range(56, 66), "grab": range(66, 72), "carry": range(72, 80),
          "throw": range(80, 88), "celebrate": range(88, 96)}
LOOPS = {"idle", "walk", "carry"}

def check(folder, bundled=False):
    errors = []
    names = sorted(os.listdir(folder))
    for required in ("pet.json", "atlas.png", "animations.json"):
        if required not in names: errors.append(f"missing {required}")
    for name in ("pet.json", "animations.json"):
        if os.path.getsize(os.path.join(folder, name)) > 64 * 1024: errors.append(f"{name} is over 64 KiB")
    pet = json.load(open(os.path.join(folder, "pet.json"), encoding="utf-8"))
    import re
    if pet.get("format") != "cos-pet" or pet.get("version") != 1: errors.append("pet.json format/version")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(pet.get("id", ""))): errors.append("pet.json id")
    if not bundled and pet.get("id") in ("hammy", "cat", "dog"): errors.append("id is reserved for a bundled pet")
    if not str(pet.get("displayName", "")).strip() or not isinstance(pet.get("description"), str): errors.append("pet.json name/description")
    atlas_path = os.path.join(folder, "atlas.png")
    if os.path.getsize(atlas_path) > 12 * 1024 * 1024: errors.append("atlas.png is over 12 MiB")
    atlas = Image.open(atlas_path)
    if atlas.format != "PNG" or atlas.size != (1280, 1920): errors.append(f"atlas.png is {atlas.format} {atlas.size}")
    atlas = atlas.convert("RGBA")
    anim = json.load(open(os.path.join(folder, "animations.json"), encoding="utf-8"))
    fixed = {"version": 1, "image": "atlas.png", "width": 1280, "height": 1920, "columns": 8,
             "cellWidth": 160, "cellHeight": 160, "frameCount": 96, "anchor": [80, 136]}
    for key, value in fixed.items():
        if anim.get(key) != value: errors.append(f"animations.json {key} must be {value}")
    for clip, frames in LAYOUT.items():
        entry = anim.get("animations", {}).get(clip)
        if not entry or entry.get("frames") != list(frames): errors.append(f"{clip} frames"); continue
        if entry.get("loop") is not (clip in LOOPS): errors.append(f"{clip} loop")
        ms = entry.get("ms", [])
        if len(ms) != len(frames) or not all(isinstance(v, (int, float)) and 0 < v <= 10000 for v in ms): errors.append(f"{clip} ms")
    for frame in range(69, 85):
        hand = anim.get("hands", {}).get(str(frame))
        if not (isinstance(hand, list) and len(hand) == 3 and 0 <= hand[0] <= 160 and 0 <= hand[1] <= 160 and hand[2] in (1, -1)):
            errors.append(f"hand anchor {frame}")
    hashes, idle = set(), []
    for frame in range(96):
        cell = atlas.crop((160 * (frame % 8), 160 * (frame // 8), 160 * (frame % 8) + 160, 160 * (frame // 8) + 160))
        alpha = cell.getchannel("A")
        box = alpha.getbbox()
        opaque = 160 * 160 - alpha.histogram()[0]
        if not box or opaque <= 400: errors.append(f"frame {frame} is empty or tiny"); continue
        left, top, right, bottom = box
        if left == 0 or top == 0 or right == 160 or bottom == 160: errors.append(f"frame {frame} touches a cell edge")
        hashes.add(hashlib.sha256(cell.tobytes()).hexdigest())
        if 4 <= frame <= 7: idle.append(box)
    if len(hashes) != 96: errors.append(f"only {len(hashes)} distinct frames")
    if len(idle) == 4 and any(max(b[i] for b in idle) - min(b[i] for b in idle) > 6 for i in range(4)):
        errors.append("idle outline moves more than 6 px")
    return errors

# `python validate_pet.py <folder>`; add `--bundled` only for ParadigmEve's own pets/<id> packages.
problems = check(sys.argv[1], bundled="--bundled" in sys.argv[2:])
print("\n".join(problems) if problems else "OK: package passes every check")
```

## When an import fails

The Pets page shows the app's reason. The common ones:

| Message | Fix |
| --- | --- |
| `atlas.png must be 1280×1920px.` | Re-assemble on an exact 1280 × 1920 canvas; do not resize the finished sheet. |
| `animations.json <clip> must use the required frame range and loop behavior.` | Copy `frames` and `loop` from the table exactly. |
| `animations.json needs a valid [x, y, side] hand anchor for frame N.` | Add or fix `hands["N"]` for every frame 69–84. |
| `The folder needs a valid pet.json manifest …` | Check `format`, `version`, `id` pattern and a non-empty `displayName`. |
| `That pet id is reserved for a bundled pet.` / `… is already imported.` | Choose another id, or ask the user to delete the old one first. |
| `Pet packages may not use symbolic links.` | Save real files, not links. |

## Bundled pets

The app ships Hammy (from Chat On Steroids) plus a cat and a dog made with this page. Bundled pets live
read-only in `pets/<id>/` in the repository and `resources/pets/<id>/` in an installed app, and are off
until the user enables them. `test/pet-atlas.test.ts` and `test/pet-bundled.test.ts` apply the checks
above to every bundled pet, so a new bundled pet must pass them before it ships.
