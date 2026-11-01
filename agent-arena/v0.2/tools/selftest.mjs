// Validates every code fixture against its hidden tests: the pristine fixture must fail in the declared
// way, the reference fix must pass everything, and every known-bad mutant must fail exactly the declared
// tag groups. Works for the public tier (default roots) and for a held-out tier (--root <dir>), which
// must have the same fixtures/, reviewer/hidden/ and reviewer/variants/ layout.
//
// usage: node selftest.mjs [--root <tier-root>] [--json results.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCode, failedTags } from './score-code.mjs';
import { applyVariant } from './variants.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const root = path.resolve(flag('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const variantsDir = path.join(root, 'reviewer', 'variants');

const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && a.every(x => b.includes(x));
const rows = [];
let failures = 0;
for (const name of fs.readdirSync(variantsDir).filter(f => f.endsWith('.json')).sort()) {
  const def = JSON.parse(fs.readFileSync(path.join(variantsDir, name), 'utf8'));
  const fixture = path.join(root, 'fixtures', def.fixture);
  const hidden = path.join(root, 'reviewer', 'hidden', def.fixture);
  const allowTestEdits = def.allow_test_edits ?? [];
  const cases = [
    ['pristine', null, def.pristine_expect],
    ['reference', def.reference, { visible: 'pass', fail_tags: [] }],
    ...Object.entries(def.mutants ?? {}).map(([id, m]) => ['mutant:' + id, m, m.expect])
  ];
  for (const [label, spec, expect] of cases) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-selftest-'));
    try {
      const dir = path.join(tmp, def.fixture);
      applyVariant(variantsDir, fixture, spec, dir);
      const receipt = scoreCode({ pristine: fixture, submitted: dir, hidden, allowTestEdits });
      const visible = receipt.visible.fail === 0 && receipt.visible.pass > 0 ? 'pass' : 'fail';
      const tags = failedTags(receipt);
      const ok = !expect || (expect.visible === visible && sameSet(expect.fail_tags, tags));
      if (!ok) failures++;
      rows.push({ fixture: def.fixture, case: label, ok, visible: `${receipt.visible.pass}/${receipt.visible.pass + receipt.visible.fail}`,
        hidden: `${receipt.hidden.results.filter(r => r.ok).length}/${receipt.hidden.results.length}`, failed_tags: tags,
        expected: expect ?? null, lines_changed: receipt.diff.lines_changed });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}
for (const r of rows)
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.fixture.padEnd(14)} ${r.case.padEnd(36)} visible ${r.visible.padEnd(5)} hidden ${r.hidden.padEnd(6)} lines ${String(r.lines_changed).padEnd(4)} failed: ${r.failed_tags.join(', ') || '-'}`);
const json = flag('--json');
if (json) fs.writeFileSync(json, JSON.stringify({ node: process.version, root: path.basename(root), rows }, null, 2) + '\n');
console.log(failures ? `${failures} case(s) did not match their declared expectation` : `all ${rows.length} cases match`);
process.exitCode = failures ? 1 : 0;
