import { describe, expect, it } from 'vitest';
// @ts-ignore The optional, simulation-only design selector is plain ESM JavaScript.
import { selectReleaseVisual } from '../scripts/candidate-eval/release-visual-selection.mjs';

const brief = {
  audience: 'Someone who has not installed Eve',
  previousVersion: '2.3.7',
  targetVersion: '2.3.8',
  desiredResult: 'Understand the verified improvement and know how to try it',
  entryPoint: 'A verified control in the installable app',
  steps: ['Install the verified release build', 'Open the verified feature', 'Try the result']
};
const evidence = {
  featureAvailable: true,
  improvementConfirmed: true,
  entryPointVerified: true,
  stepsVerified: true,
  claimsAccurate: true
};
const candidate = (id: string, ratings: Record<string, number>, overrides: Record<string, unknown> = {}) =>
  ({ id, ratings, evidence, reviewNotes: 'Review notes tied to an inspected candidate.', ...overrides });
const score = (overrides: Record<string, number> = {}) => ({
  audienceFit: 3, improvementClarity: 3, actionableSteps: 3, scannability: 3, accessibility: 3, visualPolish: 3,
  ...overrides
});

describe('release visual comparison (simulation only)', () => {
  it('prefers a clear user action over an art-only winner', () => {
    const pretty = candidate('hero', score({ improvementClarity: 1, actionableSteps: 0, visualPolish: 4 }));
    const useful = candidate('explainer', score({ improvementClarity: 4, actionableSteps: 4, visualPolish: 1 }));
    expect(selectReleaseVisual(brief, [pretty, useful]).provisionalWinner).toBe('explainer');
  });
  it('does not choose artwork that claims unverified functionality', () => {
    const unsupported = candidate('unsupported', score({ audienceFit: 4, improvementClarity: 4, actionableSteps: 4 }), {
      evidence: { ...evidence, featureAvailable: false }
    });
    const checked = candidate('checked', score());
    const result = selectReleaseVisual(brief, [unsupported, checked]);
    expect(result.provisionalWinner).toBe('checked');
    expect(result.rows.find((row: { id: string }) => row.id === 'unsupported').missing).toContain('featureAvailable');
  });
  it('selects nothing when release functionality is not verified', () => {
    const result = selectReleaseVisual(brief, [candidate('unverified', score(), {
      evidence: { ...evidence, entryPointVerified: false }
    })]);
    expect(result.provisionalWinner).toBeNull();
  });
  it('rejects missing use steps, duplicate candidates and invented rating scales', () => {
    expect(() => selectReleaseVisual({ ...brief, steps: [] }, [candidate('one', score())])).toThrow('verified user steps');
    expect(() => selectReleaseVisual(brief, [candidate('one', score()), candidate('one', score())])).toThrow('unique');
    expect(() => selectReleaseVisual(brief, [candidate('one', score({ accessibility: 5 }))])).toThrow('0..4');
  });
});
