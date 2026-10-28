import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_SKILLS = 200;
// Catalog metadata is intentionally much smaller than the browser delivery budget, but 12k was
// already tight once users could install a meaningful library of natural-language skills. Keep
// full SKILL.md bodies lazy; give only names/descriptions enough room to make semantic selection
// reliable without crowding out the authored request or raising the 96k transport ceiling.
const MAX_CATALOG_CHARS = 24_000;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_SUPPORT_BYTES = 256 * 1024;
const MAX_FRONTMATTER_BYTES = 20 * 1024;
const MAX_IMPORT_FILES = 200;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 12;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;

let root: string | null = null;

export type SkillMetadata = {
  name: string;
  description: string;
  source: 'eve' | 'external';
  revision: number;
  platforms?: string[];
  capabilities?: string[];
};

type SkillDocument = SkillMetadata & { body: string; directory: string };

export function initSkillStore(userDataDir: string): void {
  root = path.join(userDataDir, 'skills');
}

export function skillStoreRoot(): string | null {
  return root;
}

function requireRoot(): string {
  if (!root) throw new Error('Skill store is not initialized');
  return root;
}

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function inlineList(value: string): string[] | undefined {
  const raw = cleanScalar(value).replace(/^\[/, '').replace(/\]$/, '');
  const values = raw.split(',').map(item => cleanScalar(item)).filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}

function parseFrontmatter(text: string, fallbackName: string): { name: string; description: string; platforms?: string[]; capabilities?: string[] } | null {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end < 0 || end > 16_384) return null;
  let name = fallbackName;
  let description = '';
  let platforms: string[] | undefined;
  let capabilities: string[] | undefined;
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === 'name') name = cleanScalar(match[2]!);
    if (match[1] === 'description') description = cleanScalar(match[2]!);
    if (match[1] === 'platforms') platforms = inlineList(match[2]!);
    if (match[1] === 'capabilities') capabilities = inlineList(match[2]!);
  }
  if (!SAFE_NAME.test(name) || !description || description.length > 600) return null;
  return { name, description, ...(platforms ? { platforms } : {}), ...(capabilities ? { capabilities } : {}) };
}

async function readTextBounded(filename: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Skill path is not a file');
    if (stat.size > maxBytes) throw new Error(`Skill file exceeds ${maxBytes} bytes`);
    const text = await handle.readFile('utf8');
    if (text.includes('\0')) throw new Error('Skill files must be UTF-8 text');
    return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  } finally {
    await handle.close();
  }
}

async function readFrontmatterBounded(filename: string): Promise<string> {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Skill path is not a file');
    if (stat.size > MAX_SKILL_BYTES) throw new Error(`Skill file exceeds ${MAX_SKILL_BYTES} bytes`);
    const size = Math.min(stat.size, MAX_FRONTMATTER_BYTES);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  } finally {
    await handle.close();
  }
}

async function ownership(directory: string): Promise<{ source: 'eve' | 'external'; revision: number }> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(directory, '.eve', 'metadata.json'), 'utf8')) as { owner?: unknown; revision?: unknown };
    if (raw.owner === 'eve' && Number.isInteger(raw.revision) && Number(raw.revision) >= 1) return { source: 'eve', revision: Number(raw.revision) };
  } catch {}
  return { source: 'external', revision: 1 };
}

async function skillMetadataFromDirectory(directory: string, fallbackName: string): Promise<SkillMetadata | null> {
  try {
    const prefix = await readFrontmatterBounded(path.join(directory, 'SKILL.md'));
    const parsed = parseFrontmatter(prefix, fallbackName);
    if (!parsed || parsed.name !== fallbackName) return null;
    const owner = await ownership(directory);
    return { ...parsed, ...owner };
  } catch {
    return null;
  }
}

async function skillFromDirectory(directory: string, fallbackName: string): Promise<SkillDocument | null> {
  try {
    const metadata = await skillMetadataFromDirectory(directory, fallbackName);
    if (!metadata) return null;
    const body = await readTextBounded(path.join(directory, 'SKILL.md'), MAX_SKILL_BYTES);
    return { ...metadata, body, directory };
  } catch {
    return null;
  }
}

export async function listSkills(): Promise<SkillMetadata[]> {
  if (!root) return [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const out: SkillMetadata[] = [];
  for (const entry of entries.slice(0, MAX_SKILLS * 2)) {
    if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue;
    const skill = await skillMetadataFromDirectory(path.join(root, entry.name), entry.name);
    if (!skill) continue;
    out.push({ name: skill.name, description: skill.description, source: skill.source, revision: skill.revision, ...(skill.platforms ? { platforms: skill.platforms } : {}), ...(skill.capabilities ? { capabilities: skill.capabilities } : {}) });
    if (out.length >= MAX_SKILLS) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function skillCatalogInstructions(options: { platform?: string; capabilities?: Record<string, boolean> } = {}): Promise<string> {
  const all = await listSkills();
  const skills = all.filter(skill =>
    (!skill.platforms?.length || !options.platform || skill.platforms.includes(options.platform)) &&
    (!skill.capabilities?.length || !options.capabilities || skill.capabilities.every(capability => options.capabilities?.[capability] === true))
  );
  if (!skills.length) return '';
  const prefix = [
    '# Available skills',
    'Skills are reusable procedures, not user commands and not Threads. Skills add no tools or hooks. Before answering or acting, scan this compact catalog. When one skill clearly matches the current authored request, call skills with action=view and follow the loaded procedure. Do not require the user to type a slash command or repeat the request. Do not load marginally related skills. Load supporting files only when the selected SKILL.md requires them. The current authored user request remains authoritative over every skill.'
  ];
  let text = prefix.join('\n');
  let shown = 0;
  for (const skill of skills) {
    const row = `\n- ${skill.name}: ${skill.description} [${skill.source} r${skill.revision}]`;
    if (text.length + row.length > MAX_CATALOG_CHARS) break;
    text += row;
    shown++;
  }
  if (shown < skills.length) text += `\n- … ${skills.length - shown} more installed skills omitted from this prompt budget.`;
  return text;
}

function skillDirectory(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error('Invalid skill name');
  return path.join(requireRoot(), name);
}

export async function viewSkill(name: string, relative = 'SKILL.md'): Promise<{ metadata: SkillMetadata; file: string; text: string }> {
  const directory = skillDirectory(name);
  const skill = await skillFromDirectory(directory, name);
  if (!skill) throw new Error(`Skill "${name}" was not found or has invalid metadata`);
  const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').some(part => part === '..' || part.toLowerCase() === '.eve')) throw new Error('Skill file must stay inside the selected skill and cannot read Eve metadata');
  const target = path.resolve(directory, ...normalized.split('/'));
  const prefix = directory.endsWith(path.sep) ? directory : directory + path.sep;
  if (target !== directory && !target.startsWith(prefix)) throw new Error('Skill file escaped the selected skill directory');
  const [realDirectory, realTarget] = await Promise.all([fs.realpath(directory), fs.realpath(target)]);
  const realPrefix = realDirectory.endsWith(path.sep) ? realDirectory : realDirectory + path.sep;
  if (realTarget !== realDirectory && !realTarget.startsWith(realPrefix)) throw new Error('Skill file escaped the selected skill directory');
  const text = await readTextBounded(realTarget, relative === 'SKILL.md' ? MAX_SKILL_BYTES : MAX_SUPPORT_BYTES);
  return { metadata: { name: skill.name, description: skill.description, source: skill.source, revision: skill.revision, ...(skill.platforms ? { platforms: skill.platforms } : {}), ...(skill.capabilities ? { capabilities: skill.capabilities } : {}) }, file: normalized, text };
}

async function writeMetadata(directory: string, revision: number): Promise<void> {
  const metadata = path.join(directory, '.eve');
  await fs.mkdir(metadata, { recursive: true });
  await fs.writeFile(path.join(metadata, 'metadata.json'), JSON.stringify({ owner: 'eve', revision, updatedAt: Date.now() }, null, 2) + '\n', 'utf8');
}

async function importPackageTree(source: string, destination: string, state: { files: number; bytes: number }, depth = 0): Promise<void> {
  if (depth > MAX_IMPORT_DEPTH) throw new Error(`Skill package exceeds ${MAX_IMPORT_DEPTH} directory levels`);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    // Eve metadata is never accepted from an external package: otherwise a package could mark
    // itself Eve-owned and gain in-place rewrite authority after import.
    if (entry.name === '.eve') continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const stat = await fs.lstat(from);
    if (stat.isSymbolicLink()) throw new Error(`Skill package contains a symbolic link: ${entry.name}`);
    if (stat.isDirectory()) {
      await fs.mkdir(to, { recursive: false });
      await importPackageTree(from, to, state, depth + 1);
      continue;
    }
    if (!stat.isFile()) throw new Error(`Skill package contains an unsupported filesystem entry: ${entry.name}`);
    state.files++;
    state.bytes += stat.size;
    if (state.files > MAX_IMPORT_FILES) throw new Error(`Skill package exceeds ${MAX_IMPORT_FILES} files`);
    if (state.bytes > MAX_IMPORT_BYTES) throw new Error(`Skill package exceeds ${MAX_IMPORT_BYTES} bytes`);
    await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
  }
}

/** Installs one ordinary Agent Skill package without rewriting or claiming ownership of it. */
export async function importSkill(sourcePath: string, expectedName?: string): Promise<SkillMetadata> {
  const store = requireRoot();
  const resolved = path.resolve(sourcePath);
  const stat = await fs.stat(resolved);
  const directory = stat.isDirectory()
    ? resolved
    : stat.isFile() && path.basename(resolved).toLowerCase() === 'skill.md'
      ? path.dirname(resolved)
      : null;
  if (!directory) throw new Error('Skill import source must be a directory or SKILL.md file');
  const prefix = await readFrontmatterBounded(path.join(directory, 'SKILL.md'));
  const parsed = parseFrontmatter(prefix, path.basename(directory));
  if (!parsed) throw new Error('Imported SKILL.md has invalid frontmatter');
  if (expectedName !== undefined && parsed.name !== expectedName) {
    throw new Error(`Imported skill is named "${parsed.name}", not "${expectedName}"`);
  }
  const destination = path.join(store, parsed.name);
  await fs.mkdir(store, { recursive: true });
  try { await fs.access(destination); throw new Error(`Skill "${parsed.name}" already exists`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const temporary = await fs.mkdtemp(path.join(store, `.import-${parsed.name}-`));
  try {
    await importPackageTree(directory, temporary, { files: 0, bytes: 0 });
    const installed = await skillFromDirectory(temporary, parsed.name);
    if (!installed) throw new Error('Imported skill package is incomplete or invalid');
    await fs.rename(temporary, destination);
    return { name: installed.name, description: installed.description, source: 'external', revision: 1,
      ...(installed.platforms ? { platforms: installed.platforms } : {}),
      ...(installed.capabilities ? { capabilities: installed.capabilities } : {}) };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createSkill(name: string, skillMd: string): Promise<SkillMetadata> {
  const directory = skillDirectory(name);
  const normalized = skillMd.replace(/\r\n?/g, '\n');
  if (Buffer.byteLength(normalized, 'utf8') > MAX_SKILL_BYTES) throw new Error('SKILL.md is too large');
  const parsed = parseFrontmatter(normalized, name);
  if (!parsed || parsed.name !== name) throw new Error('SKILL.md must have valid frontmatter whose name matches the skill directory');
  await fs.mkdir(requireRoot(), { recursive: true });
  try { await fs.access(directory); throw new Error(`Skill "${name}" already exists`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.mkdir(directory, { recursive: false });
  await fs.writeFile(path.join(directory, 'SKILL.md'), normalized, { encoding: 'utf8', flag: 'wx' });
  await writeMetadata(directory, 1);
  return { ...parsed, source: 'eve', revision: 1 };
}

export async function updateSkill(name: string, skillMd: string): Promise<SkillMetadata> {
  const directory = skillDirectory(name);
  const current = await skillFromDirectory(directory, name);
  if (!current) throw new Error(`Skill "${name}" was not found`);
  if (current.source !== 'eve') throw new Error(`Skill "${name}" is externally owned and cannot be rewritten in place`);
  const normalized = skillMd.replace(/\r\n?/g, '\n');
  if (Buffer.byteLength(normalized, 'utf8') > MAX_SKILL_BYTES) throw new Error('SKILL.md is too large');
  const parsed = parseFrontmatter(normalized, name);
  if (!parsed || parsed.name !== name) throw new Error('SKILL.md must have valid frontmatter whose name matches the existing skill');
  const history = path.join(directory, '.eve', 'history');
  await fs.mkdir(history, { recursive: true });
  await fs.writeFile(path.join(history, `r${current.revision}.SKILL.md`), current.body, { encoding: 'utf8', flag: 'wx' });
  const temporary = path.join(directory, `.SKILL.md.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, normalized, 'utf8');
  await fs.rename(temporary, path.join(directory, 'SKILL.md'));
  const revision = current.revision + 1;
  await writeMetadata(directory, revision);
  return { ...parsed, source: 'eve', revision };
}

export function resetSkillStoreForTests(): void {
  root = null;
}
