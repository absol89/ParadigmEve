import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { rawPromises as fs } from './rawfs.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { resolvePath } from './sandbox.js';
import { addProject, getProject, linkExpensesProject, listProjects, projectWorkspace } from './projects.js';
import { createQuilt, pinsLibrary } from './pins.js';
import { resolvePinsReference } from '../shared/pins-context.js';
import { authoredPinsReferences } from '../shared/pins-intent.js';
import { emptyExpensesLedger } from '../shared/expenses.js';
import { readExpensesLedger } from './expenses-ledger.js';
import {
  EXPENSES_INSTRUCTIONS,
  EXPENSES_README,
  EXPENSES_TEMPLATE,
  SUPERSEDED_EXPENSES_INSTRUCTIONS_SHA256
} from '../shared/expenses-template.js';
import type { LocalProject } from '../shared/projects.js';

const markerSchema = z.object({ id: z.literal('expenses'), version: z.literal(1) }).strict();
let starts: Promise<unknown> = Promise.resolve();

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Upgrade only exact app-authored predecessors. A custom AGENTS.md is user/project authority and
 * must survive a new installer unchanged.
 */
async function upgradeExpensesInstructions(folder: string): Promise<boolean> {
  const file = await target(folder, 'AGENTS.md');
  const current = await fs.readFile(file, 'utf8');
  if (current === EXPENSES_INSTRUCTIONS) return false;
  if (!SUPERSEDED_EXPENSES_INSTRUCTIONS_SHA256.some(hash => hash === sha256Text(current))) {
    return false;
  }
  const writable = await target(folder, 'AGENTS.md', true);
  await fs.writeFile(writable, EXPENSES_INSTRUCTIONS, 'utf8');
  return true;
}

/** Revalidate before every write; selecting a project does not grant capabilities. */
async function target(folder: string, relative: string, write = false): Promise<string> {
  const caps = effectiveCapabilities(getConfig());
  if (!caps.read || (write && (!caps.create || !caps.edit))) throw new Error('Expenses needs the current read, create and edit permissions');
  const root = await resolvePath(getConfig().roots, folder);
  if (!(await fs.stat(root.real)).isDirectory()) throw new Error('Choose an Expenses folder');
  const resolved = await resolvePath(getConfig().roots, path.join(root.real, relative), { allowMissing: true });
  const within = path.relative(root.real, resolved.real);
  if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) throw new Error('Expenses path leaves its selected folder');
  return resolved.real;
}

export async function validateExpensesProject(folder: string): Promise<void> {
  const marker = await target(folder, '.eve-template.json');
  if ((await fs.stat(marker)).size > 1024) throw new Error('Expenses template marker is invalid');
  const parsed = markerSchema.safeParse(JSON.parse(await fs.readFile(marker, 'utf8')));
  if (!parsed.success) throw new Error('Unsupported Expenses template');
  await readExpensesLedger(folder);
}

/**
 * Startup migration for already-linked Expenses projects. The ledger is only validated/read; this
 * may rewrite AGENTS.md when and only when its exact hash proves it is a known app-authored version.
 */
export async function initializeExpensesProjects(): Promise<number> {
  const caps = effectiveCapabilities(getConfig());
  if (!caps.read) return 0;
  let upgraded = 0;
  for (const project of (await listProjects()).filter(row => row.template?.id === 'expenses')) {
    const folder = await projectWorkspace(project.id);
    await validateExpensesProject(folder.real);
    if (caps.create && caps.edit && await upgradeExpensesInstructions(folder.real)) upgraded += 1;
  }
  return upgraded;
}

/** Empty selected folders only. Exclusive files prevent overwriting an intervening edit. */
export function startExpensesProject(folder: string): Promise<LocalProject> {
  const operation = starts.then(async () => {
    const real = await target(folder, '');
    const snapshot = await pinsLibrary();
    const catalog = await listProjects();
    const samePath = (left: string, right: string) => process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase() : left === right;
    const existing = catalog.find(row => samePath(row.path, real));
    let quilt = existing?.template?.id === 'expenses'
      ? snapshot.quilts.find(row => row.id === existing.template!.quiltId)
      : undefined;
    if (existing?.template?.id === 'expenses' && !quilt) {
      throw new Error('The linked Expenses Thread is unavailable');
    }
    if (!quilt) {
      const named = snapshot.quilts.filter(row => row.title.replace(/^%/u, '').normalize('NFKC').toLowerCase() === 'expenses');
      if (named.length > 1) throw new Error('The expenses Thread reference is ambiguous');
      const linked = named[0] && catalog.find(row => row.template?.quiltId === named[0]!.id);
      if (linked) {
        const current = await projectWorkspace(linked.id);
        if (current.real !== real) throw new Error('The expenses Thread already has a local folder');
      }
      quilt = named[0];
    }
    const files = await fs.readdir(real);
    if (files.length) {
      if (!files.includes('.eve-template.json')) throw new Error('Choose an empty folder or an existing Expenses project');
      await validateExpensesProject(real);
      for (const name of ['AGENTS.md', 'README.md']) {
        const file = await target(real, name);
        if (!(await fs.stat(file)).isFile()) throw new Error('Expenses project is incomplete');
      }
    } else {
      // Publish the marker last. An interrupted initialization is visible and never
      // silently adopted as a valid template or overwritten on the next attempt.
      await fs.mkdir(await target(real, 'data', true));
      await fs.mkdir(await target(real, 'receipts', true));
      for (const [name, content] of [
        ['AGENTS.md', EXPENSES_INSTRUCTIONS],
        ['README.md', EXPENSES_README],
        ['data/ledger.json', JSON.stringify(emptyExpensesLedger(), null, 2) + '\n'],
        ['.eve-template.json', JSON.stringify(EXPENSES_TEMPLATE, null, 2) + '\n']
      ]) await fs.writeFile(await target(real, name!, true), content!, { encoding: 'utf8', flag: 'wx' });
      await validateExpensesProject(real);
    }
    const project = await addProject(real);
    quilt ??= await createQuilt({ title: 'expenses', collectionIds: [], description: 'Spending preferences and useful findings. Purchase records stay in the linked local project.' });
    return linkExpensesProject(project.id, quilt.id);
  });
  starts = operation.catch(() => undefined);
  return operation;
}

/** A canonical project is useful to authenticated cross-chat tools without rebinding that chat. */
export async function resolveCanonicalExpensesProject(): Promise<LocalProject | null> {
  const projects = (await listProjects()).filter(row => row.template?.id === 'expenses');
  if (projects.length > 1) throw new Error('Choose one Expenses project before using cross-chat access');
  const project = projects[0] ?? null;
  if (!project) return null;
  const folder = await projectWorkspace(project.id);
  await validateExpensesProject(folder.real);
  return project;
}

/** True only for authored product syntax; quoted/code/transport text is filtered upstream. */
export function hasExpensesDataReference(text: string): boolean {
  return authoredPinsReferences(text).some(row =>
    row.reference.normalize('NFKC').toLocaleLowerCase() === '#expenses'
  );
}

/**
 * Resolve the built-in #expenses convenience to read-only canonical data.
 *
 * This deliberately does not activate a Thread or grant project authority. A real same-name Quilt
 * shadows the convenience alias completely, and ambiguity/no project abstains rather than guessing.
 */
export async function resolveExpensesDataProject(text: string): Promise<LocalProject | null> {
  if (!hasExpensesDataReference(text)) return null;
  const snapshot = await pinsLibrary();
  const realExpensesQuiltExists = snapshot.collections.some(collection =>
    collection.name.replace(/^#/u, '').normalize('NFKC').toLocaleLowerCase() === 'expenses'
  );
  if (realExpensesQuiltExists) return null;
  const projects = (await listProjects()).filter(row => row.template?.id === 'expenses');
  if (projects.length !== 1) return null;
  const folder = await projectWorkspace(projects[0]!.id);
  await validateExpensesProject(folder.real);
  return projects[0]!;
}

/**
 * Resolve fresh-chat Expenses intent to its exact linked local project.
 *
 * Generic #Quilt references never grant project authority, including #expenses. The built-in
 * #expenses convenience is resolved separately as read-only data. A Pins "Start chat" can select
 * a project only when its durable Thread id is the exact id
 * already bound into that Expenses project.
 */
export async function resolveExpensesProject(
  text: string,
  explicitProjectId?: string | null,
  explicitThreadId?: string | null
): Promise<LocalProject | null> {
  const selectedProject = explicitProjectId ? await getProject(explicitProjectId) : null;
  const references = authoredPinsReferences(text).map(row => row.reference);
  if (!references.length && !explicitThreadId) {
    if (selectedProject?.template?.id !== 'expenses') return null;
    const folder = await projectWorkspace(selectedProject.id);
    await validateExpensesProject(folder.real);
    return selectedProject;
  }
  const snapshot = await pinsLibrary();
  // Project authority comes only from authored %Thread syntax (or an exact durable Start-from-
  // Thread id below). A #Concept may resolve to the same stored Thread for data injection, but it
  // must never be promoted into filesystem/project authority by this resolver.
  const ids = new Set(references.flatMap(reference => {
    if (!reference.startsWith('%')) return [];
    const resolved = resolvePinsReference(snapshot, reference);
    return resolved?.kind === 'thread' ? [resolved.id] : [];
  }));
  if (explicitThreadId) ids.add(explicitThreadId);

  const allExpensesProjects = (await listProjects()).filter(row => row.template?.id === 'expenses');
  const projects = allExpensesProjects.filter(row => ids.has(row.template!.quiltId));
  if (projects.length > 1) throw new Error('Choose one Expenses Thread for this purchase');
  const mentioned = projects[0] ?? null;
  if (explicitProjectId && mentioned && explicitProjectId !== mentioned.id) throw new Error('The selected chat project conflicts with the Expenses Thread');
  const project = explicitProjectId ? selectedProject : mentioned;
  if (!project?.template || project.template.id !== 'expenses') return null;
  const folder = await projectWorkspace(project.id);
  await validateExpensesProject(folder.real);
  return project;
}
