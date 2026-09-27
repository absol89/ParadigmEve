import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rawPromises as fs } from './rawfs.js';
import { readDurable, writeDurableNow } from './durable.js';
import { getConfig } from './config.js';
import { resolvePath } from './sandbox.js';
import { bindSessionProject, findSessionByConversation, getSession } from './session/store.js';
import { nativeChatGptProjectId, nativeProjectConversationId, type LocalProject } from '../shared/projects.js';
import { logInfo } from './logger.js';

const projectSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(160), path: z.string().min(1).max(32768), createdAt: z.number().finite().nonnegative(), ungrouped: z.boolean().optional(), template: z.object({ id: z.literal('expenses'), version: z.literal(1), quiltId: z.string().uuid() }).strict().optional(), nativeProjectId: z.string().regex(/^g-p-[0-9a-f]{32}$/).optional(), nativeEntryConversationId: z.string().regex(/^[0-9a-f-]{8,64}$/).optional() });
const catalogSchema = z.array(projectSchema).max(200);
let mutations: Promise<unknown> = Promise.resolve();
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export async function listProjects(): Promise<LocalProject[]> {
  const raw = await readDurable<unknown>('projects');
  if (raw === null) return [];
  const parsed = catalogSchema.safeParse(raw);
  const natives = parsed.success ? parsed.data.flatMap(row => row.nativeProjectId ? [row.nativeProjectId] : []) : [];
  if (!parsed.success || new Set(parsed.data.map(row => row.id)).size !== parsed.data.length ||
      new Set(natives).size !== natives.length) throw new Error('Project catalog is invalid');
  return parsed.data;
}
export async function getProject(id: string): Promise<LocalProject | null> {
  return (await listProjects()).find(project => project.id === id) ?? null;
}
/** One Quilt has at most one canonical project; linking grants no filesystem permission. */
export function linkExpensesProject(projectId: string, quiltId: string): Promise<LocalProject> {
  return serializeProjectLink();
  function serializeProjectLink(): Promise<LocalProject> {
    const operation = mutations.then(async () => {
      z.string().uuid().parse(quiltId);
      const projects = await listProjects();
      const project = projects.find(row => row.id === projectId);
      if (!project) throw new Error('Project not found');
      await resolveProject(project);
      if (projects.some(row => row.id !== projectId && row.template?.quiltId === quiltId) ||
          (project.template && project.template.quiltId !== quiltId)) throw new Error('Expenses Thread already belongs to another project');
      if (project.template) return project;
      const linked: LocalProject = { ...project, template: { id: 'expenses', version: 1, quiltId } };
      await writeDurableNow('projects', projects.map(row => row.id === projectId ? linked : row));
      return linked;
    });
    mutations = operation.catch(() => undefined);
    return operation;
  }
}
/**
 * Links (or with null unlinks) one local project to one native ChatGPT Project.
 *
 * Explicit and exact: the user supplies the Project's URL or id; names are never compared. One
 * native Project belongs to at most one local project, so ingress and egress each have a single
 * answer. Linking grants no filesystem permission and rebinds no existing session.
 */
export function linkNativeProject(projectId: string, value: string | null): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(projectId);
    const nativeProjectId = value === null || value.trim() === '' ? null : nativeChatGptProjectId(value);
    if (value !== null && value.trim() !== '' && !nativeProjectId) throw new Error('Paste a ChatGPT Project link (chatgpt.com/g/g-p-…)');
    const projects = await listProjects();
    const project = projects.find(row => row.id === projectId);
    if (!project) throw new Error('Project not found');
    if (nativeProjectId && projects.some(row => row.id !== projectId && row.nativeProjectId === nativeProjectId)) {
      throw new Error('That ChatGPT Project is already linked to another Eve project');
    }
    // A pasted chat URL also names a chat inside the Project, which is how fresh chats enter it.
    const entry = nativeProjectId ? nativeProjectConversationId(value) : null;
    if ((project.nativeProjectId ?? null) === nativeProjectId && (!entry || project.nativeEntryConversationId === entry)) return project;
    const { nativeProjectId: _, nativeEntryConversationId: previousEntry, ...rest } = project;
    const keptEntry = entry ?? (project.nativeProjectId === nativeProjectId ? previousEntry : undefined);
    const linked: LocalProject = nativeProjectId
      ? { ...rest, nativeProjectId, ...(keptEntry ? { nativeEntryConversationId: keptEntry } : {}) }
      : rest;
    await writeDurableNow('projects', projects.map(row => row.id === projectId ? linked : row));
    return linked;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}
/** The local project explicitly linked to this native ChatGPT Project, if any. */
export async function projectForNativeProject(nativeProjectId: string | null): Promise<LocalProject | null> {
  if (!nativeProjectId) return null;
  return (await listProjects()).find(project => project.nativeProjectId === nativeProjectId) ?? null;
}
/** Remembers a chat the browser just proved is inside this linked native Project. */
export function noteNativeProjectEntry(nativeProjectId: string | null, conversationId: string): Promise<void> {
  const operation = mutations.then(async () => {
    if (!nativeProjectId || !/^[0-9a-f-]{8,64}$/.test(conversationId)) return;
    const projects = await listProjects();
    const project = projects.find(row => row.nativeProjectId === nativeProjectId);
    if (!project || project.nativeEntryConversationId === conversationId) return;
    await writeDurableNow('projects', projects.map(row => row.id === project.id ? { ...row, nativeEntryConversationId: conversationId } : row));
  });
  mutations = operation.catch(() => undefined);
  return operation;
}
/**
 * Files a chat observed inside a linked native ChatGPT Project under its local project.
 *
 * Only a session with no project of its own and no origin to inherit one from is bound: an
 * explicit binding, an app-opened chat's project, and a worker/resume's inherited project all
 * outrank where the page happens to be. Unlinked native Projects change nothing.
 */
export async function bindSessionNativeProject(sessionId: string, nativeProjectId: string | null): Promise<boolean> {
  const project = await projectForNativeProject(nativeProjectId);
  if (!project) return false;
  const session = await getSession(sessionId);
  if (!session || session.projectId || session.origin?.fromSessionId) return false;
  await assignSessionProject(sessionId, project.id);
  logInfo(`session ${sessionId} joined project ${project.id} from its ChatGPT Project`);
  return true;
}
/** Folder picker callers approve roots separately; project selection cannot widen them. */
export function addProject(folderPath: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    if (!path.isAbsolute(folderPath)) throw new Error('Choose an absolute local project folder');
    const resolved = await resolvePath(getConfig().roots, folderPath);
    if (!(await fs.stat(resolved.real)).isDirectory()) throw new Error('Choose a project folder');
    const projects = await listProjects();
    const existing = projects.find(project => samePath(project.path, resolved.real));
    if (existing) {
      if (!existing.ungrouped) return existing;
      const { ungrouped: _, ...restored } = existing;
      await writeDurableNow('projects', projects.map(project => project.id === existing.id ? restored : project));
      return restored;
    }
    if (projects.length >= 200) throw new Error('Project catalog limit reached');
    const project: LocalProject = { id: randomUUID(), name: (path.basename(resolved.real) || resolved.real).slice(0, 160), path: resolved.real, createdAt: Date.now() };
    await writeDurableNow('projects', [...projects, project]);
    return project;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}
/** Remove only the grouping. One catalog commit also covers unloaded sessions and
 * in-flight inputs without rewriting their durable workspace/receipt identities. */
export function removeProject(id: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(id);
    const projects = await listProjects();
    const project = projects.find(row => row.id === id);
    if (!project) throw new Error('Project not found');
    const removed = { ...project, ungrouped: true };
    if (!project.ungrouped) await writeDurableNow('projects', projects.map(row => row.id === id ? removed : row));
    return removed;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}
export async function assignSessionProject(sessionId: string, projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  await resolveProject(project);
  await bindSessionProject(sessionId, project.id);
}
export async function projectWorkspace(projectId: string): Promise<{ virtual: string; real: string }> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  return resolveProject(project);
}
async function resolveProject(project: LocalProject): Promise<{ virtual: string; real: string }> {
  const resolved = await resolvePath(getConfig().roots, project.path);
  if (!samePath(resolved.real, project.path) || !(await fs.stat(resolved.real)).isDirectory()) throw new Error('Project folder changed or is unavailable');
  return { virtual: resolved.virtual, real: resolved.real };
}
/** Null means no project. A broken explicit binding is an error, never permission to guess cwd. */
export async function getSessionProject(sessionId: string): Promise<{ virtual: string; real: string } | null> {
  const session = await getSession(sessionId);
  if (!session?.projectId) return null;
  const project = await getProject(session.projectId);
  if (!project) throw new Error('The session project is unavailable');
  return resolveProject(project);
}
/** The broker supplies an exact prime conversation; unrelated families are never consulted. */
export async function inheritSessionProject(sessionId: string, primeConversationId: string): Promise<void> {
  const prime = await findSessionByConversation(primeConversationId, { requireUnique: true });
  if (prime?.conversationId !== primeConversationId || !prime.projectId) return;
  await assignSessionProject(sessionId, prime.projectId);
}
