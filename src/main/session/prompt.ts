import path from 'node:path';
import { readFileStream } from '../codex/filesystem.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { currentCoreInstructions } from '../mcp/instructions.js';
import { getSessionProject, projectWorkspace } from '../projects.js';
import { resolvePath } from '../sandbox.js';
import { MAX_CHATGPT_MESSAGE_CHARS, prependUserPrompt } from '../../shared/user-prompt.js';
import { readVaultManualText, VAULT_CONTEXT_MARKER, VAULT_MANUAL_ROOT } from '../vault-path.js';

type PromptScope = { sessionId?: string | null; projectId?: string | null };
export type PromptLimits = { maxChars: number; maxBytes: number };
type ProjectInstructions = { directory: string; text: string; truncated: boolean };
const limits: PromptLimits = { maxChars: MAX_CHATGPT_MESSAGE_CHARS, maxBytes: Infinity };
const cutNotice = '\n\n[Cut off because of the message limit. Read AGENTS.md yourself for the remaining instructions.]';
const vaultCutNotice = `\n\n[The packaged Vault was shortened only to fit this opening message. Read /${VAULT_MANUAL_ROOT} with the read tool for the remaining current manual pages.]`;
const currentRequestBoundary = '\n\n--- Current request ---\n';

function fitsPrompt(value: string, budget: PromptLimits): boolean {
  return value.length <= Math.min(MAX_CHATGPT_MESSAGE_CHARS, budget.maxChars) &&
    Buffer.byteLength(value, 'utf8') <= budget.maxBytes;
}

function vaultFallback(text: string, core: string, budget: PromptLimits): string {
  const fallback = text.replace(
    VAULT_CONTEXT_MARKER,
    `# Packaged ParadigmEve Vault\nRead /${VAULT_MANUAL_ROOT} for the current manual.`
  );
  if (fitsPrompt(prependUserPrompt(fallback, core), budget)) return fallback;

  const boundary = text.lastIndexOf(currentRequestBoundary);
  if (boundary >= 0) {
    const currentRequest = text.slice(boundary + currentRequestBoundary.length);
    if (fitsPrompt(prependUserPrompt(currentRequest, core), budget)) return currentRequest;
  }
  return text.replace(VAULT_CONTEXT_MARKER, '');
}

async function expandPackagedVault(text: string, core: string, budget: PromptLimits): Promise<string> {
  if (!text.includes(VAULT_CONTEXT_MARKER)) return text;
  let manual: string;
  try {
    manual = await readVaultManualText();
  } catch {
    return vaultFallback(text, core, budget);
  }
  const render = (body: string, shortened: boolean): string => text.replace(
    VAULT_CONTEXT_MARKER,
    `# Packaged ParadigmEve Vault manual\n\n${body}${shortened ? vaultCutNotice : ''}`
  );
  const full = render(manual, false);
  if (fitsPrompt(prependUserPrompt(full, core), budget)) return full;
  if (!fitsPrompt(prependUserPrompt(render('', true), core), budget)) {
    return vaultFallback(text, core, budget);
  }

  let low = 0;
  let high = manual.length;
  while (low < high) {
    let middle = Math.ceil((low + high) / 2);
    if (middle > 0 && /[\uD800-\uDBFF]/.test(manual[middle - 1]!)) middle--;
    const candidate = render(manual.slice(0, middle), true);
    if (fitsPrompt(prependUserPrompt(candidate, core), budget)) low = middle;
    else high = Math.max(0, middle - 1);
  }
  return render(manual.slice(0, low), true);
}

/** One selected folder, never cwd inference, global discovery or a recursive document scan. */
async function projectInstructions(scope: PromptScope): Promise<ProjectInstructions | null> {
  if ((!scope.sessionId && !scope.projectId) || !effectiveCapabilities(getConfig()).read) return null;
  // Existing sessions own their project; a caller-provided project cannot replace that binding.
  const folder = scope.sessionId ? await getSessionProject(scope.sessionId)
    : await projectWorkspace(scope.projectId!);
  if (!folder) return null;
  const filename = path.join(folder.real, 'AGENTS.md');
  try {
    const resolved = await resolvePath(getConfig().roots, filename, { allowMissing: true });
    // At most four UTF-8 bytes per available UTF-16 code unit, plus one byte to detect overflow.
    // Stream a bounded prefix so even a gigabyte AGENTS.md never becomes a gigabyte allocation.
    const budget = MAX_CHATGPT_MESSAGE_CHARS * 4;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of readFileStream(resolved.real)) {
      const kept = chunk.subarray(0, Math.max(0, budget + 1 - bytes));
      chunks.push(kept);
      bytes += kept.length;
      if (bytes > budget) break;
    }
    const data = Buffer.concat(chunks);
    // Streaming decode leaves an incomplete final codepoint out of a shortened prefix.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, budget), { stream: bytes > budget });
    if (text.includes('\0')) throw new Error('AGENTS.md must be a UTF-8 text file');
    // Permission/path changes during the asynchronous read cannot publish another folder's text.
    const current = scope.sessionId ? await getSessionProject(scope.sessionId) : await projectWorkspace(scope.projectId!);
    const checked = await resolvePath(getConfig().roots, filename);
    if (!current || current.real !== folder.real || checked.real !== resolved.real || !effectiveCapabilities(getConfig()).read)
      throw new Error('Project instructions changed location or permission while being read');
    return text.trim() ? { directory: current.virtual, text, truncated: bytes > budget } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Do not expose native filesystem paths through the browser bridge's error response.
    throw new Error('Could not read the selected folder\'s AGENTS.md safely');
  }
}

/** User text and the complete Core prompt are mandatory; only project instructions spend slack. */
export function fitSessionPrompt(text: string, core: string, agents: ProjectInstructions | null = null, budget = limits): string {
  const base = prependUserPrompt(text, core);
  if (!fitsPrompt(base, budget)) throw new Error('The message and main instructions exceed the delivery limit (maximum 96,000 characters). Shorten the message or standing instructions.');
  if (!agents) return base;
  const content = agents.text.replace(/\r\n?/g, '\n');
  const render = (length: number, shortened: boolean): string => {
    // Never split a UTF-16 surrogate pair at the character budget boundary.
    if (length > 0 && /[\uD800-\uDBFF]/.test(content[length - 1]!)) length--;
    const instructions = `# AGENTS.md instructions for ${agents.directory}\n\n<INSTRUCTIONS>\n${content.slice(0, length)}${shortened ? cutNotice : ''}\n</INSTRUCTIONS>`;
    return prependUserPrompt(text, `${core}\n\n${instructions}`);
  };
  const full = render(content.length, agents.truncated);
  if (fitsPrompt(full, budget)) return full;
  // Include the framing, length header and truncation notice in the exact final budget.
  let low = 0, high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsPrompt(render(middle, true), budget)) low = middle;
    else high = middle - 1;
  }
  return low > 0 ? render(low, true) : base;
}

/** Opening normal/worker messages only. Callers own first-message eligibility;
 * follow-ups, helpers, handoff requests and resumed bootstraps never call this. */
export async function prepareSessionPrompt(text: string, scope: PromptScope = {}, budget = limits): Promise<string> {
  const core = await currentCoreInstructions();
  const contextual = await expandPackagedVault(text, core, budget);
  fitSessionPrompt(contextual, core, null, budget); // Reject mandatory overflow before reading optional files.
  return fitSessionPrompt(contextual, core, await projectInstructions(scope), budget);
}
