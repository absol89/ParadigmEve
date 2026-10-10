/**
 * Freezing and verifying the candidate contract.
 *
 * The contract is written once, before any candidate exists, into the run directory outside every
 * candidate workspace. It names every input by content hash: bug report, fixture patches, oracle
 * tests, reference fix and strategy packages. Every later command re-verifies all of them, so an
 * edited oracle or a hand-tuned ranking rule makes the run unusable rather than quietly different.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HarnessError, atomicWrite, canonicalJson, git, packageHash, sha256, sha256File, toPosix } from './core.mjs';
import { Journal } from './journal.mjs';

export const CONTRACT_SCHEMA_VERSION = 1;
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(value, what) {
  if (typeof value !== 'string' || !ID.test(value)) throw new HarnessError('SPEC_INVALID', `${what} must match ${ID}`);
  return value;
}

/** Text of one `## heading` section of a Markdown file at an exact commit. */
export function markdownSection(text, heading) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex(line => line.trim() === `## ${heading}`);
  if (start < 0) throw new HarnessError('SPEC_INVALID', `section "## ${heading}" not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith('## ')) { end = i; break; }
  return lines.slice(start + 1, end).join('\n').trim();
}

/** SKILL.md-compatible wrapper, so a frozen strategy can later be imported as a skill package. */
export function skillDocument(id, description, body) {
  if (/[\r\n]/.test(description)) throw new HarnessError('SPEC_INVALID', `strategy ${id} description must be one line`);
  return `---\nname: ${id}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`;
}

function resolveCommit(repo, ref) {
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

/** Builds the fixture tree with a private index: the product repo's checkout is never touched. */
export function buildFixtureTree(repo, baseCommit, patchFiles, scratchDir) {
  fs.mkdirSync(scratchDir, { recursive: true });
  const index = path.join(scratchDir, `fixture-${process.pid}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(repo, ['read-tree', baseCommit], { env });
    for (const patch of patchFiles) git(repo, ['apply', '--cached', '--whitespace=nowarn', patch], { env });
    return git(repo, ['write-tree'], { env }).trim();
  } finally {
    fs.rmSync(index, { force: true });
  }
}

function verifyOwner(spec, machine) {
  if (!spec.owner) {
    if (typeof spec.ownerNote !== 'string' || !spec.ownerNote.trim()) {
      throw new HarnessError('SPEC_INVALID', 'a run without an owning Plan must say why in ownerNote');
    }
    return { owner: null, ownerNote: spec.ownerNote };
  }
  const { planId, itemId, planRevision } = spec.owner;
  if (!UUID.test(planId ?? '') || !UUID.test(itemId ?? '') || !Number.isInteger(planRevision) || planRevision < 1) {
    throw new HarnessError('SPEC_INVALID', 'owner needs planId, itemId (uuids) and an integer planRevision');
  }
  if (!machine.planCatalog) throw new HarnessError('OWNER_UNVERIFIED', 'an owning Plan is named but no plan catalog was supplied');
  const catalog = JSON.parse(fs.readFileSync(machine.planCatalog, 'utf8'));
  const plan = (catalog.plans ?? []).find(candidate => candidate.id === planId);
  if (!plan) throw new HarnessError('OWNER_UNVERIFIED', `Plan ${planId} is not in the catalog`);
  if ((plan.revision ?? 1) !== planRevision) {
    throw new HarnessError('OWNER_STALE', `Plan ${planId} is at revision ${plan.revision ?? 1}, contract names ${planRevision}`);
  }
  if (plan.archivedAt !== null && plan.archivedAt !== undefined) throw new HarnessError('OWNER_UNVERIFIED', `Plan ${planId} is archived`);
  const item = (plan.items ?? []).find(candidate => candidate.id === itemId);
  if (!item) throw new HarnessError('OWNER_UNVERIFIED', `step ${itemId} is not in Plan ${planId}`);
  // Reference, never copy: the Plan stays the owner of the wording; the contract pins which wording.
  const itemSha256 = sha256(canonicalJson({ text: item.text, intent: item.intent ?? null, constraints: item.constraints ?? null }));
  return { owner: { planId, itemId, planRevision, itemSha256 }, ownerNote: spec.ownerNote ?? null };
}

/**
 * Freezes `spec` (repo-relative experiment definition) plus `machine` (local absolute paths kept
 * out of the public repository) into `runDir`. Refuses to reuse an existing run directory.
 */
export function freezeContract({ specFile, machine, runDir, now = Date.now() }) {
  if (fs.existsSync(path.join(runDir, 'contract.json'))) throw new HarnessError('RUN_EXISTS', `${runDir} already holds a contract`);
  const specText = fs.readFileSync(specFile, 'utf8');
  const spec = JSON.parse(specText);
  const specDir = path.dirname(specFile);
  if (spec.schemaVersion !== CONTRACT_SCHEMA_VERSION) throw new HarnessError('SPEC_INVALID', `schemaVersion must be ${CONTRACT_SCHEMA_VERSION}`);
  requireId(spec.experimentId, 'experimentId');
  for (const key of ['productRepo', 'candidatesRoot']) {
    if (!machine[key] || !path.isAbsolute(machine[key])) throw new HarnessError('MACHINE_INVALID', `${key} must be an absolute path`);
  }
  const repo = machine.productRepo;
  const absRunDir = path.resolve(runDir);
  const candidatesRoot = path.resolve(machine.candidatesRoot);
  const relativeRun = path.relative(candidatesRoot, absRunDir);
  if (relativeRun.startsWith('..') || path.isAbsolute(relativeRun)) {
    throw new HarnessError('MACHINE_INVALID', 'the run directory must live under the candidates root');
  }
  const watch = (machine.watch ?? []).map(entry => path.resolve(entry));
  for (const entry of watch) {
    const relative = path.relative(candidatesRoot, entry);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new HarnessError('MACHINE_INVALID', `watched path ${entry} is inside the candidates root`);
  }
  if (!Array.isArray(spec.scope?.allowedPaths) || !spec.scope.allowedPaths.length) throw new HarnessError('SPEC_INVALID', 'scope.allowedPaths is required');
  if (!Array.isArray(spec.scope?.protectedPaths)) throw new HarnessError('SPEC_INVALID', 'scope.protectedPaths is required');
  if (!(spec.budget?.armBMultiplier > 0)) throw new HarnessError('SPEC_INVALID', 'budget.armBMultiplier is required');

  fs.mkdirSync(absRunDir, { recursive: true });
  const store = (relative, bytes) => {
    const file = path.join(absRunDir, relative);
    atomicWrite(file, bytes);
    return { file: toPosix(relative), sha256: sha256(bytes) };
  };

  const strategies = {};
  for (const source of spec.strategies ?? []) {
    const id = requireId(source.id, 'strategy id');
    if (strategies[id]) throw new HarnessError('SPEC_INVALID', `duplicate strategy ${id}`);
    let body;
    let provenance;
    if (source.kind === 'vault-section') {
      const commit = resolveCommit(repo, source.commit);
      body = markdownSection(git(repo, ['show', `${commit}:${source.path}`]), source.heading);
      provenance = { kind: source.kind, path: source.path, heading: source.heading, commit };
    } else if (source.kind === 'file') {
      body = fs.readFileSync(path.join(specDir, source.path), 'utf8');
      provenance = { kind: source.kind, path: toPosix(source.path) };
    } else throw new HarnessError('SPEC_INVALID', `strategy ${id} has unknown kind ${source.kind}`);
    const relative = path.join('strategies', id, 'SKILL.md');
    store(relative, skillDocument(id, source.description ?? provenance.heading ?? id, body));
    strategies[id] = { source: provenance, file: toPosix(relative), packageSha256: packageHash(path.join(absRunDir, 'strategies', id)) };
  }
  const arms = {};
  for (const [arm, ids] of Object.entries(spec.arms ?? {})) {
    if (!/^[A-Z]$/.test(arm)) throw new HarnessError('SPEC_INVALID', `arm ${arm} must be one capital letter`);
    for (const id of ids) if (!strategies[id]) throw new HarnessError('SPEC_INVALID', `arm ${arm} names unknown strategy ${id}`);
    arms[arm] = [...ids];
  }
  if (!arms.A || arms.A.length !== 1) throw new HarnessError('SPEC_INVALID', 'arm A is the single-candidate baseline');

  const tasks = {};
  for (const task of spec.tasks ?? []) {
    const id = requireId(task.id, 'task id');
    if (tasks[id]) throw new HarnessError('SPEC_INVALID', `duplicate task ${id}`);
    const bugReport = store(path.join('tasks', id, 'bug-report.md'), fs.readFileSync(path.join(specDir, task.bugReport)));
    const baseCommit = resolveCommit(repo, task.fixture.baseCommit);
    const patches = (task.fixture.patches ?? []).map((patch, index) =>
      store(path.join('tasks', id, `fixture-${index}.patch`), fs.readFileSync(path.join(specDir, patch))));
    const tree = buildFixtureTree(repo, baseCommit, patches.map(patch => path.join(absRunDir, patch.file)), path.join(absRunDir, 'tmp'));
    const referenceCommit = resolveCommit(repo, task.reference.commit);
    const reference = {
      commit: referenceCommit,
      ...store(path.join('tasks', id, 'reference.patch'), git(repo, ['diff', '--binary', `${referenceCommit}^`, referenceCommit, '--', ...task.reference.paths]))
    };
    const oracle = task.oracle.map((entry, index) => {
      const fromCommit = resolveCommit(repo, entry.fromCommit);
      const bytes = git(repo, ['show', `${fromCommit}:${entry.path}`], { encoding: 'buffer' });
      const base = path.posix.basename(entry.path);
      const extension = base.slice(base.indexOf('.'));
      return {
        sourcePath: entry.path,
        fromCommit,
        // Same directory keeps relative imports working; a reserved prefix keeps it protected.
        evalPath: `${path.posix.dirname(entry.path)}/candidate-oracle-${id}-${index}${extension}`,
        ...store(path.join('tasks', id, 'oracle', `${index}-${base}`), bytes)
      };
    });
    tasks[id] = { title: task.title, bugReport, fixture: { baseCommit, patches, tree }, reference, oracle, subsystemTests: task.subsystemTests ?? [] };
  }
  if (!Object.keys(tasks).length) throw new HarnessError('SPEC_INVALID', 'no tasks');

  const contract = {
    kind: 'paradigmeve.candidate-contract',
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    experimentId: spec.experimentId,
    frozenAt: now,
    specSha256: sha256(specText),
    ...verifyOwner(spec, machine),
    machine: {
      productRepo: path.resolve(repo),
      candidatesRoot,
      runDir: absRunDir,
      watch,
      nodeModules: machine.nodeModules ? path.resolve(machine.nodeModules) : null
    },
    worker: spec.worker,
    scope: {
      allowedPaths: spec.scope.allowedPaths,
      // The oracle prefix is always protected, whatever the spec says.
      protectedPaths: [...new Set([...spec.scope.protectedPaths, '**/candidate-oracle-*'])]
    },
    strategies,
    arms,
    tasks,
    ladder: spec.ladder,
    budget: spec.budget,
    selection: spec.selection,
    successCriteria: spec.successCriteria
  };
  const contractHash = sha256(canonicalJson(contract));
  const file = path.join(absRunDir, 'contract.json');
  atomicWrite(file, `${JSON.stringify({ ...contract, contractHash }, null, 2)}\n`);
  fs.chmodSync(file, 0o444);
  new Journal(absRunDir).append('run.created', { contractHash });
  return { ...contract, contractHash };
}

/** Loads and fully re-verifies a frozen contract. Any drift is CONTRACT_TAMPERED. */
export function loadContract(runDir) {
  const absRunDir = path.resolve(runDir);
  const file = path.join(absRunDir, 'contract.json');
  if (!fs.existsSync(file)) throw new HarnessError('RUN_MISSING', `no contract in ${absRunDir}`);
  const { contractHash, ...contract } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (sha256(canonicalJson(contract)) !== contractHash) throw new HarnessError('CONTRACT_TAMPERED', 'contract.json does not match its hash');
  const journalHash = new Journal(absRunDir).state().contractHash;
  if (journalHash !== contractHash) throw new HarnessError('CONTRACT_TAMPERED', 'contract hash differs from the one the journal was created with');
  const check = (entry, what) => {
    const target = path.join(absRunDir, entry.file);
    if (!fs.existsSync(target) || sha256File(target) !== entry.sha256) throw new HarnessError('CONTRACT_TAMPERED', `${what} (${entry.file}) changed`);
  };
  for (const [id, strategy] of Object.entries(contract.strategies)) {
    if (packageHash(path.join(absRunDir, 'strategies', id)) !== strategy.packageSha256) throw new HarnessError('CONTRACT_TAMPERED', `strategy ${id} changed`);
  }
  for (const [id, task] of Object.entries(contract.tasks)) {
    check(task.bugReport, `bug report of ${id}`);
    check(task.reference, `reference fix of ${id}`);
    task.fixture.patches.forEach(patch => check(patch, `fixture patch of ${id}`));
    task.oracle.forEach(oracle => check(oracle, `oracle of ${id}`));
  }
  return { ...contract, contractHash };
}
