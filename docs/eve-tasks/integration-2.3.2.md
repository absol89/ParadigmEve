# 2.3.2 integration checkpoint

Date: 2026-09-29. Destination: `release/2.3.2`, cumulative over `v2.3.1` (`209d3d2`).

The release branch at `31854c9` already contained the desktop pet runtime, tab-safety,
resume continuity, restart handover, queued-input delivery and tunnel-status fixes.
`git cherry` confirmed both commits on `fix/user-tab-safety` and the artifact-host
change on `eve/bundled-cat-and-dog` were already present as equivalent patches.

Merged `eve/bundled-cat-and-dog` (`fb1a280`) into the release branch. The resulting
code/assets delta contains only the cat and dog packages and their generator;
no existing runtime file changed and no conflict resolution was needed.

Validation: staged whitespace check, privacy check, dependency notices and
TypeScript checks passed. Full `npm.cmd run verify` reached 260 passing test files,
5,285 passing tests and 42 skips, with one failure in the Setup Unicode connector-name
test (`test/renderer-state.test.ts:1142`). That exact test passed on a focused rerun
without any source or test changes. The full run is therefore not a clean pass;
its subsequent isolated computer and MCP-shutdown stages did not run. All pet,
atlas, bundled-library, resume, continuation, bridge and extension tests passed.
No installer, installation, tag or push is part of this checkpoint.
Live recovery and on-screen pet acceptance remain separate from automated checks.
