/** Markdown rendering of a verdict. Pure: it reads the verdict object, never the run. */

const seconds = ms => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(0)} s`);
const number = value => (value === null || value === undefined ? '—' : String(value));

export function renderReport(contract, result) {
  const lines = [
    `# Candidate-eval report — ${result.experimentId}`,
    ``,
    `Contract \`${result.contractHash}\` · cost metric \`${result.metric}\` · worker \`${contract.worker.backend}\` / \`${contract.worker.model}\``,
    ``,
    `**Outcome: ${result.outcome}**${result.halted ? ` (run halted: ${result.halted.reason})` : ''}`,
    ``,
    `| Criterion | Value |`,
    `| --- | --- |`,
    `| Tasks verified, arm A | ${result.criteria.aVerified} |`,
    `| Tasks verified, arm B | ${result.criteria.bVerified} |`,
    `| (a) B verified on ≥ 1 more task | ${result.criteria.criterionA} |`,
    `| B winner patch smaller by ${contract.successCriteria.patchSizeMeasure ?? 'srcLines'} (tasks) | ${result.criteria.bSmaller} |`,
    `| (b) equal verification and smaller patch on ≥ ${contract.successCriteria.smallerPatchTasks} tasks | ${result.criteria.criterionB} |`,
    `| B within ${contract.budget.armBMultiplier}× A cost on every task | ${result.criteria.budgetOk} |`,
    ``
  ];
  for (const task of result.tasks) {
    lines.push(`## ${task.taskId}`, ``);
    lines.push(`| Arm | Winner | Winner size | Cost | Agent wall | Eval machine | Active time to first verified (sequential) | Projected parallel |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const [arm, data] of Object.entries(task.arms)) {
      lines.push(`| ${arm} | ${data.winner ?? 'none'} | ${number(data.winnerSize)} | ${number(data.cost)} | ${seconds(data.agentWallMs)} | ${seconds(data.evalMs)} | ${seconds(data.timeToVerifiedMs)} | ${seconds(data.projectedParallelMs)} |`);
    }
    lines.push(``, `| Attempt | Strategy | State | Flags | Cost | Tool uses | Test files | Wall | Eval | Similarity to reference fix |`, `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const data of Object.values(task.arms)) {
      for (const attempt of data.attempts) {
        lines.push(`| ${attempt.id} | ${attempt.strategyId} | ${attempt.state} | ${attempt.flags.join(', ') || '—'} | ${number(attempt.cost)} | ${number(attempt.toolUses)} | ${number(attempt.testFiles)} | ${seconds(attempt.wallMs)} | ${seconds(attempt.evalMs)} | ${number(attempt.similarity)} |`);
      }
    }
    lines.push(``);
  }
  lines.push(
    `Times are active time (agent wall + own T1/T2 evaluation), measured under strictly sequential`,
    `execution (one candidate at a time, required for attributable contamination checks).`,
    `"Projected parallel" is the fastest verified attempt's own active time: an estimate, not a measurement.`,
    `Similarity is an added-line overlap with the real historical fix; it is a leak signal, not proof.`,
    ``
  );
  return `${lines.join('\n')}\n`;
}
