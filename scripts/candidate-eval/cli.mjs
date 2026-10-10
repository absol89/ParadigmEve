#!/usr/bin/env node
/**
 * Candidate-eval Phase 0 command line. See scripts/candidate-eval/README.md.
 *
 *   node scripts/candidate-eval/cli.mjs <command> --run <dir> [options]
 */

import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from './core.mjs';
import { freezeContract } from './contract.mjs';
import {
  calibrateTask,
  checkProposal,
  evaluateAttempt,
  finishAttempt,
  openRun,
  proposePromotion,
  recover,
  releaseProposal,
  reserveAttempt,
  selectArm,
  startAttempt,
  verdict
} from './harness.mjs';
import { renderReport } from './report.mjs';

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new HarnessError('USAGE', `unexpected argument ${rest[i]}`);
    const key = rest[i].slice(2);
    const value = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    options[key] = value;
  }
  return { command, options };
}

const need = (options, key) => {
  if (options[key] === undefined || options[key] === true) throw new HarnessError('USAGE', `--${key} is required`);
  return options[key];
};
const number = (options, key) => options[key] === undefined ? undefined : Number(options[key]);

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  const run = () => need(options, 'run');
  let output;
  switch (command) {
    case 'freeze': {
      const machine = JSON.parse(fs.readFileSync(need(options, 'machine'), 'utf8'));
      const contract = freezeContract({ specFile: need(options, 'spec'), machine, runDir: run() });
      output = { contractHash: contract.contractHash, runDir: contract.machine.runDir, tasks: Object.keys(contract.tasks) };
      break;
    }
    case 'calibrate': {
      const { contract } = openRun(run());
      const ids = options.task ? [options.task] : Object.keys(contract.tasks);
      output = {};
      for (const id of ids) output[id] = await calibrateTask(run(), id);
      break;
    }
    case 'reserve':
      output = reserveAttempt(run(), { taskId: need(options, 'task'), arm: need(options, 'arm'), strategyId: need(options, 'strategy') });
      break;
    case 'start': {
      const { briefFile } = startAttempt(run(), need(options, 'attempt'), { model: need(options, 'model'), agentType: options['agent-type'] ?? null });
      output = { briefFile };
      break;
    }
    case 'finish':
      output = finishAttempt(run(), need(options, 'attempt'), {
        usage: { totalTokens: number(options, 'tokens'), toolUses: number(options, 'tool-uses'), agentDurationMs: number(options, 'duration-ms') },
        reportFile: options.report ?? null
      });
      break;
    case 'evaluate':
      output = (await evaluateAttempt(run(), need(options, 'attempt'), String(options.tiers ?? 'T1,T2').split(','))).map(r => ({ tier: r.tier, outcome: r.outcome, durationMs: r.durationMs, log: r.log.file }));
      break;
    case 'select':
      output = await selectArm(run(), need(options, 'task'), need(options, 'arm'));
      break;
    case 'verdict': {
      const result = verdict(run());
      const { contract } = openRun(run());
      fs.writeFileSync(path.join(contract.machine.runDir, 'verdict.json'), `${JSON.stringify(result, null, 2)}\n`);
      fs.writeFileSync(path.join(contract.machine.runDir, 'report.md'), renderReport(contract, result));
      output = { outcome: result.outcome, criteria: result.criteria, report: path.join(contract.machine.runDir, 'report.md') };
      break;
    }
    case 'propose':
      output = proposePromotion(run(), need(options, 'attempt'), need(options, 'target'));
      break;
    case 'check-proposal':
      output = checkProposal(run(), need(options, 'proposal'));
      break;
    case 'release-proposal':
      releaseProposal(run(), need(options, 'proposal'));
      output = { released: options.proposal };
      break;
    case 'recover':
      output = recover(run());
      break;
    case 'status': {
      const { contract, state } = openRun(run());
      output = {
        contractHash: contract.contractHash,
        halted: state.halted,
        calibration: Object.fromEntries(Object.entries(state.calibration).map(([k, v]) => [k, v.ok])),
        attempts: [...state.attempts.values()].map(a => ({ id: a.id, state: a.state, flags: a.flags, cost: a.usage?.totalTokens ?? null })),
        pendingEvals: state.pendingEvals
      };
      break;
    }
    default:
      throw new HarnessError('USAGE', 'commands: freeze calibrate reserve start finish evaluate select verdict propose check-proposal release-proposal recover status');
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error instanceof HarnessError ? 2 : 1;
});
