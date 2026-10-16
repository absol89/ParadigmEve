/**
 * Every text file in this repository uses LF (`.gitattributes`: `* text=auto eol=lf`).
 *
 * Several writers (people, Claude, Eve) edit the same tree on Windows, where an editor or a stale
 * checkout can leave CRLF on disk that git hides until it breaks something byte-exact, such as
 * a pinned checksum. `crlfFiles` lists tracked and new untracked text files whose working copy
 * has CRLF; files marked `-text` (verbatim upstream legal text) are exempt. Run directly
 * (`npm run fix:eol`) it converts those files to LF in place.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function crlfFiles(root) {
  let listing;
  try {
    listing = execFileSync('git', ['ls-files', '--eol', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return []; // Not a git checkout (a source archive): there is no attribute authority to check against.
  }
  const files = [];
  for (const entry of listing.split('\0')) {
    // "i/lf    w/crlf  attr/text=auto eol=lf\tpath"
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, worktree, ...attributes] = entry.slice(0, tab).trim().split(/\s+/);
    if (worktree === 'w/crlf' && !attributes.join(' ').includes('-text')) files.push(entry.slice(tab + 1));
  }
  return [...new Set(files)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = crlfFiles(root);
  for (const file of files) {
    const absolute = path.join(root, file);
    writeFileSync(absolute, readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
    console.log(`LF: ${file}`);
  }
  console.log(files.length ? `Converted ${files.length} file(s) to LF.` : 'All text files already use LF.');
}
