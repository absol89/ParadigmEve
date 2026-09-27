# ADR 0001: Quilt Is a Continuity Layer, Not a Collection Feature

## Status

Accepted as product direction, 2026-09-12. This does not assert implementation.

## Context
There is a risk that Quilt could be treated as a generic save-board or scrapbook feature.

## Decision
Quilt is defined as a continuity-preserving layer that stores useful moments, context, and patterns so the user can resume, reuse, and re-understand what matters later.

## Consequences

- onboarding should teach relief and continuity, not collection management
- Quilt should preserve context, not just snippets
- the value proposition is “you do not have to start over”

- Keep exact source references separate from immutable saved snapshots.
- Source loss must remain explicit; it must never silently rebind a saved moment.
- The [three discovery tutorials](../../quilt-discovery-tutorials.md) bound the first implementation.
