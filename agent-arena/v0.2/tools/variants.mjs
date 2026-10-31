// Applies a reviewer variant (reference fix or known-bad mutant) to a fresh copy of a fixture.
import fs from 'node:fs';
import path from 'node:path';

export function applyVariant(variantsDir, fixture, spec, dest) {
  fs.cpSync(fixture, dest, { recursive: true });
  if (!spec) return;
  if (spec.overlay) fs.cpSync(path.join(variantsDir, path.basename(fixture), spec.overlay), dest, { recursive: true });
  for (const edit of spec.edits ?? (Array.isArray(spec) ? spec : [])) {
    const file = path.join(dest, edit.file);
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const count = text.split(edit.find).length - 1;
    if (count !== 1) throw new Error(`${path.basename(fixture)}: edit find occurs ${count} times in ${edit.file}`);
    fs.writeFileSync(file, text.replace(edit.find, () => edit.replace));
  }
}
