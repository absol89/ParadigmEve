# Release-visual design and evaluation

This is shipped, model-agnostic design guidance for Eve's connected assistants when creating
public release visuals, feature explainers, image prompts or a landing-page hero. It is not a
promise that Eve's experimental candidate-evaluation engine is available to end users.
Use the current user's instructions first. For personal artwork or purely decorative images,
do not force a product call to action.

## Start with the viewer and real result

For the 2.3.8 release simulation, the audience is **someone who has never installed Eve** and
wants to know whether the *installable* 2.3.8 build gives them a meaningful improvement over
the previous public build. Their questions are: **What is better? Can I actually use it? How?**

Before writing an image-generation prompt or release claim, pin down:

1. **Audience:** who is seeing it and what they already know.
2. **User benefit:** one concrete outcome that the intended build demonstrably improves.
3. **Entry point:** exact real control/menu/path the user will use, or the honest setup prerequisite.
4. **Action:** one obvious next step, with no more than three short instructions.

Check the source and, where possible, the **actual installable build**. A feature present only in a
prototype, script, design doc, unreleased source branch or manually run engineering experiment
must not be illustrated or described as automatically available to new installers. Never invent
UI labels, a download link, a one-click workflow, or the user's measured benefit. If access
cannot be confirmed, withhold that claim, explicitly label it experimental, or choose a proven
feature instead.

## The winning *recipe*, not a permanently winning picture

- Lead with one recognizable problem and a plain-language outcome, not an internal technology name.
- Use **landing-page hierarchy**: short headline → one strong visual demonstration → a concise
  supporting line → visible action. The illustration should make the benefit easier to grasp.
- Favor one before/after or one concrete use case over a feature collage; minimize decoration and
  copy. Preserve delight and Eve's personality when it serves recognition.
- Make instructions actionable: show the correct destination in the app and the first meaningful
  user step. Do not confuse an installer/download action with an action inside the app.
- Ensure text remains legible at small/mobile sizes, contrast does not rely solely on color,
  labels are meaningful, and alt text or equivalent explanation can communicate the benefit.
- Test against information overload: after a five-second glance, a newcomer should be able to
  answer **what improved** and **what they would do next**.
- When reviewing generated images, treat aesthetic composition, anatomy and hand direction as
  *separate criteria* from clarity, audience fit and reachable actions. An approved hand fix does
  not establish the best overall release communication. A later image may be more useful.

For an image prompt, specify the audience, verified benefit, focal action, accessible typography,
content limits and desired visual style. Keep app-specific instructions in editable release-page
text if precise reproduction inside an image cannot be trusted. Do not generate more variants when
asked only to compare existing work.

## Bounded candidate simulation

Start with one sound concept. Compare up to three **materially different** alternatives only when
the additional choice can teach us something; do not automatically produce three images.
Freeze one audience, build, claimed outcome, entry point and action across the comparison.
Review the actual candidates rather than assuming the most recent or most cinematic one won.

First apply **hard gates**: the claimed feature exists in the proposed build, the improvement
is supported by evidence, and the access path and steps have been verified. Unverifiable
artwork cannot be promoted as a release explainer even when visually beautiful.

Among eligible candidates, rate each 0–4 with the following weights:

| Criterion | Weight | What it means |
| --- | ---: | --- |
| Audience fit | 20 | Understandable to a newcomer, without jargon or context |
| Improvement clarity | 25 | Makes the *verified* benefit over the earlier release clear |
| Actionable steps | 25 | Shows how to get the result through a real entry point |
| Scannability | 15 | One takeaway rather than an information-heavy infographic |
| Accessibility | 10 | Legible type, contrast, semantic labels and small-screen reading |
| Visual polish | 5 | Cohesive composition, expression, anatomy and beauty |

Tie-break on actionable steps, improvement clarity and scannability, in that order. Keep per-image
review notes and evidence references, not just a score. This is a **provisional heuristic**, not
measured conversion, an A/B test with actual users, or a validated model preference.
Use `scripts/candidate-eval/release-visual-selection.mjs` for the simulation if working on
the development source. The coding patch evaluator remains separate.

## What to test with real people before promotion

Show candidates independently to newcomers, without extra explanation. Ask what they think Eve
would improve and exactly how they would use the improvement after installing. Measure comprehension,
correct first action and perceived confidence rather than likes alone. Prefer fewer steps and a
verified route. Retest after any UI/release change, and retain an outcome record before adapting
a background skill. One anecdotal win is a candidate lesson, **not** automatic global training.

This guidance is packaged with Eve and is available even without the source repository at
`/paradigmeve-manual/release-visual-design.md`; prompt delivery still depends on the connected
model/client consuming Core instructions. A source change alone does **not** update installed Eve
or prove that external image models followed the guidance. Build, install and dogfood separately.
