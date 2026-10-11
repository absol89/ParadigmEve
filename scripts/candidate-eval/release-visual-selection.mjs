/**
 * Provisional design-eval selector for release artwork, NOT the Phase-0 coding harness.
 * Judges enter ratings based on images and independently verified product evidence.
 * It does not generate images, activate skills, or change the app/release.
 */
export const CRITERIA = Object.freeze({
  audienceFit: 20,
  improvementClarity: 25,
  actionableSteps: 25,
  scannability: 15,
  accessibility: 10,
  visualPolish: 5
});

const criteria = Object.keys(CRITERIA);
const requiredEvidence = ['featureAvailable', 'improvementConfirmed', 'entryPointVerified', 'stepsVerified', 'claimsAccurate'];
const isText = value => typeof value === 'string' && value.trim().length > 0;

/**
 * brief: { audience, previousVersion, targetVersion, desiredResult, entryPoint, steps }
 * candidates: [{ id, ratings: { [criterion]: integer 0..4 }, evidence:
 *   { [requiredEvidence]: boolean }, reviewNotes: string }]
 * Ratings are descriptive judgment, never substituted for live user-testing evidence.
 */
export function selectReleaseVisual(brief, candidates) {
  for (const field of ['audience', 'previousVersion', 'targetVersion', 'desiredResult', 'entryPoint']) {
    if (!isText(brief?.[field])) throw new Error(`Visual brief is missing ${field}`);
  }
  if (!Array.isArray(brief.steps) || brief.steps.length < 1 || brief.steps.length > 3 ||
      brief.steps.some(step => !isText(step))) throw new Error('Supply one to three verified user steps');
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3) {
    throw new Error('Compare one to three materially different candidates');
  }
  const seen = new Set();
  const rows = candidates.map(candidate => {
    if (!isText(candidate?.id) || seen.has(candidate.id)) throw new Error('Candidate ids must be unique and nonempty');
    seen.add(candidate.id);
    for (const key of criteria) {
      if (!Number.isInteger(candidate.ratings?.[key]) || candidate.ratings[key] < 0 || candidate.ratings[key] > 4) {
        throw new Error(`Candidate ${candidate.id} requires a 0..4 rating for ${key}`);
      }
    }
    const missing = requiredEvidence.filter(key => candidate.evidence?.[key] !== true);
    if (!isText(candidate.reviewNotes)) missing.push('reviewNotes');
    const score = criteria.reduce((total, key) => total + CRITERIA[key] * candidate.ratings[key] / 4, 0);
    return {
      id: candidate.id,
      eligible: missing.length === 0,
      missing,
      score,
      actionableSteps: candidate.ratings.actionableSteps,
      improvementClarity: candidate.ratings.improvementClarity,
      scannability: candidate.ratings.scannability,
      reviewNotes: candidate.reviewNotes
    };
  });
  // If tied, prefer easier action and clearer benefit before aesthetics.
  const eligible = rows.filter(row => row.eligible);
  eligible.sort((a, b) => b.score - a.score ||
    b.actionableSteps - a.actionableSteps ||
    b.improvementClarity - a.improvementClarity ||
    b.scannability - a.scannability ||
    a.id.localeCompare(b.id));
  return { brief, criteria: CRITERIA, rows, provisionalWinner: eligible[0]?.id ?? null };
}
