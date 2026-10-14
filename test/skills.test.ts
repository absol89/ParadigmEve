import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSkill,
  importSkill,
  initSkillStore,
  listSkills,
  resetSkillStoreForTests,
  skillCatalogInstructions,
  updateSkill,
  viewSkill
} from '../src/main/skills.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';

const skill = (name: string, description: string, marker: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# Procedure\n\n${marker}\n`;

beforeEach(async () => {
  directory = await makeTempDir('paradigmeve-skills-');
  initSkillStore(directory);
});

afterEach(async () => {
  resetSkillStoreForTests();
  await removeTempDir(directory);
});

describe('dynamic skill store', () => {
  it('advertises only compact metadata until the model explicitly loads a matching skill', async () => {
    await createSkill('token-insights', skill('token-insights', 'Diagnose context and workflow token pressure.', 'FULL_PROCEDURE_SECRET'));

    const catalog = await skillCatalogInstructions();
    expect(catalog).toContain('token-insights: Diagnose context and workflow token pressure. [eve r1]');
    expect(catalog).toMatch(/do not require the user to type a slash command/i);
    expect(catalog).not.toContain('FULL_PROCEDURE_SECRET');

    const loaded = await viewSkill('token-insights');
    expect(loaded.metadata).toMatchObject({ name: 'token-insights', source: 'eve', revision: 1 });
    expect(loaded.text).toContain('FULL_PROCEDURE_SECRET');
  });

  it('keeps a larger installed catalog metadata-only and bounded without loading skill bodies', async () => {
    for (let index = 0; index < 90; index++) {
      const name = `catalog-${String(index).padStart(3, '0')}`;
      await createSkill(name, skill(name, `Reusable procedure ${index} ${'x'.repeat(180)}`, `SECRET_BODY_${index}`));
    }
    const catalog = await skillCatalogInstructions();
    expect(catalog.length).toBeLessThanOrEqual(24_000 + 120);
    expect(catalog.length).toBeGreaterThan(12_000);
    expect(catalog).toContain('catalog-000');
    expect(catalog).not.toContain('SECRET_BODY_');
  });

  it('filters compact catalog metadata by host and live capabilities before semantic selection', async () => {
    await createSkill('windows-read', '---\nname: windows-read\ndescription: Windows reader.\nplatforms: [win32]\ncapabilities: [read]\n---\nBODY');
    await createSkill('mac-only', '---\nname: mac-only\ndescription: Mac workflow.\nplatforms: [darwin]\n---\nBODY');
    expect(await skillCatalogInstructions({ platform: 'win32', capabilities: { read: true } })).toContain('windows-read');
    expect(await skillCatalogInstructions({ platform: 'win32', capabilities: { read: true } })).not.toContain('mac-only');
    expect(await skillCatalogInstructions({ platform: 'win32', capabilities: { read: false } })).not.toContain('windows-read');
  });

  it('versions Eve-owned rewrites and keeps the previous procedure as history', async () => {
    await createSkill('token-insights', skill('token-insights', 'Old description.', 'REVISION_ONE'));
    const updated = await updateSkill('token-insights', skill('token-insights', 'New description.', 'REVISION_TWO'));
    expect(updated).toMatchObject({ source: 'eve', revision: 2, description: 'New description.' });
    expect((await viewSkill('token-insights')).text).toContain('REVISION_TWO');
    const previous = await fs.readFile(path.join(directory, 'skills', 'token-insights', '.eve', 'history', 'r1.SKILL.md'), 'utf8');
    expect(previous).toContain('REVISION_ONE');
    expect((await listSkills())[0]).toMatchObject({ name: 'token-insights', revision: 2 });
  });

  it('loads externally owned skills but refuses to rewrite them in place', async () => {
    const external = path.join(directory, 'skills', 'external-one');
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(path.join(external, 'SKILL.md'), skill('external-one', 'Imported procedure.', 'EXTERNAL_BODY'), 'utf8');
    expect((await viewSkill('external-one')).metadata.source).toBe('external');
    await expect(updateSkill('external-one', skill('external-one', 'Changed.', 'BAD_REWRITE'))).rejects.toThrow(/externally owned/);
  });

  it('imports an ordinary skill package with scripts/references while keeping external ownership', async () => {
    const source = path.join(directory, 'approved-source', 'get-openai-token-insights');
    await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(source, 'references'), { recursive: true });
    await fs.mkdir(path.join(source, '.eve'), { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), skill('get-openai-token-insights', 'Analyze OpenAI context pressure.', 'MAIN'), 'utf8');
    await fs.writeFile(path.join(source, 'scripts', 'usage-snapshot.mjs'), 'console.log("snapshot")\n', 'utf8');
    await fs.writeFile(path.join(source, 'references', 'heuristics.md'), 'HEURISTICS\n', 'utf8');
    // External packages cannot smuggle Eve ownership into the installed copy.
    await fs.writeFile(path.join(source, '.eve', 'metadata.json'), JSON.stringify({ owner: 'eve', revision: 99 }), 'utf8');

    await expect(importSkill(source, 'wrong-name')).rejects.toThrow(/named "get-openai-token-insights"/);
    expect(await listSkills()).toEqual([]);
    const imported = await importSkill(source, 'get-openai-token-insights');
    expect(imported).toMatchObject({ name: 'get-openai-token-insights', source: 'external', revision: 1 });
    expect((await viewSkill(imported.name, 'scripts/usage-snapshot.mjs')).text).toContain('snapshot');
    expect((await viewSkill(imported.name, 'references/heuristics.md')).text).toContain('HEURISTICS');
    await expect(viewSkill(imported.name, '.eve/metadata.json')).rejects.toThrow(/cannot read Eve metadata/);
    await expect(updateSkill(imported.name, skill(imported.name, 'Changed.', 'BAD_REWRITE'))).rejects.toThrow(/externally owned/);
  });

  it('keeps supporting-file reads inside the selected skill and hides Eve metadata', async () => {
    await createSkill('bounded', skill('bounded', 'Bounded support files.', 'MAIN'));
    const root = path.join(directory, 'skills', 'bounded');
    await fs.mkdir(path.join(root, 'references'));
    await fs.writeFile(path.join(root, 'references', 'guide.md'), 'SUPPORT_FILE', 'utf8');
    expect((await viewSkill('bounded', 'references/guide.md')).text).toBe('SUPPORT_FILE');
    await expect(viewSkill('bounded', '../outside.txt')).rejects.toThrow(/stay inside/);
    await expect(viewSkill('bounded', '.eve/metadata.json')).rejects.toThrow(/cannot read Eve metadata/);
    await expect(viewSkill('bounded', '.EVE/metadata.json')).rejects.toThrow(/cannot read Eve metadata/);
  });
});
