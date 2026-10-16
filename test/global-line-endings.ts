// Runs once before any test file, so even a single-file `vitest run` fails at once on CRLF.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crlfFiles } from '../scripts/line-endings.mjs';

export default function setup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files: string[] = crlfFiles(root);
  if (!files.length) return;
  const shown = files.slice(0, 20).map(file => `  ${file}`).join('\n');
  const more = files.length > 20 ? `\n  …and ${files.length - 20} more` : '';
  throw new Error(`CRLF line endings in ${files.length} text file(s); this repository uses LF. Run \`npm run fix:eol\`.\n${shown}${more}`);
}
