import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { craftZip, mockReleaseServer } from './helpers-release.js';
import { makeTempDir, removeTempDir } from './helpers.js';

vi.mock('../src/main/secrets.js', () => ({ getSecret: vi.fn(async () => null), setSecret: vi.fn(async () => undefined), clearSecret: vi.fn(async () => undefined) }));
// The download, digest check and extraction run for real; only the verified "CLI" (which is a
// fixture zip entry, not a real program) is launched as a Node MCP fixture instead.
const fixturePath = vi.hoisted(() => ({ value: '' }));
vi.mock('../src/main/file-provider-install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/file-provider-install.js')>();
  return {
    ...actual,
    acquireFileProvider: async (...args: Parameters<typeof actual.acquireFileProvider>) => {
      const launch = await actual.acquireFileProvider(...args);
      return { ...launch, command: process.execPath, args: [fixturePath.value, ...launch.args] };
    }
  };
});

const { initDurableStore } = await import('../src/main/durable.js');
const { pluginManager } = await import('../src/main/plugins/manager.js');
const { setProviderAcquireOptionsForTests } = await import('../src/main/file-provider-install.js');
const consent = await import('../src/main/file-provider-consent.js');
const { fileCapabilityProvider } = await import('../src/main/file-capabilities.js');
const { rawPromises } = await import('../src/main/rawfs.js');
const { registerFileActionTool } = await import('../src/main/mcp/file-action.js');
const { registerFileEditTool, setFeatureLossConfirmForTests } = await import('../src/main/mcp/file-edit.js');
const { setVisibleLauncherForTests } = await import('../src/main/file-edit-transaction.js');
const { createRegistrar } = await import('../src/main/mcp/kernel.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');

/** A tiny MCP server standing in for `<app>-cli mcp`: it echoes which app and arguments it got. */
const FIXTURE = `const readline=require('node:readline');
const tools=[{name:'read_range',description:'fixture',inputSchema:{type:'object',properties:{range:{type:'string'}}}}];
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'craft fixture',version:'1'}};
else if(m.method==='tools/list')result={tools};
else if(m.method==='tools/call')result={content:[{type:'text',text:'args='+process.argv.slice(2).join(' ')+' range='+(m.params.arguments.range||'')}]};
else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;

const mock = mockReleaseServer();
let dir = '';
let endpoints: { apiBase: string; downloadBase: string };

beforeAll(async () => { endpoints = await mock.start(); });
afterAll(async () => { setProviderAcquireOptionsForTests({}); await mock.stop(); });
beforeEach(async () => {
  dir = await makeTempDir('eve-provider-broker-');
  fixturePath.value = path.join(dir, 'craft-fixture.cjs');
  await fs.writeFile(fixturePath.value, FIXTURE);
  await fs.mkdir(path.join(dir, 'workspace'));
  initDurableStore(dir);
  await pluginManager.initialize(dir);
  mock.releases.clear();
  mock.requests.length = 0;
  setProviderAcquireOptionsForTests({ ...endpoints, platform: 'win32-x64' });
  consent.resetFileProviderConsentForTests('win32-x64');
});
afterEach(async () => {
  setFeatureLossConfirmForTests(null);
  for (const row of pluginManager.snapshot().plugins) await pluginManager.uninstall(row.id);
  await pluginManager.close();
  await removeTempDir(dir);
});

function publish(slug: string, version: string, digest?: string | null) {
  mock.releases.set(`storytold/${slug}`, {
    tag: `v${version}`,
    assets: [{ name: `${slug}-${version}-windows-x64-portable.zip`, bytes: craftZip(slug), ...(digest === undefined ? {} : { digest }) }]
  });
}

function registrar(caps: Partial<typeof DEFAULT_CAPABILITIES> = {}) {
  const ctx = { roots: [{ name: 'workspace', path: path.join(dir, 'workspace') }], caps: { ...DEFAULT_CAPABILITIES, read: true, edit: true, ...caps }, exposedCaps: { ...DEFAULT_CAPABILITIES, read: true, edit: true, ...caps }, readOnly: false };
  const reg = createRegistrar(null, ctx, 'core');
  registerFileActionTool(reg);
  registerFileEditTool(reg);
  return reg;
}
const caller = () => ({ startedAt: Date.now(), transportKey: null, agent: null, caller: { transportKey: null, requestId: null, conversationId: null, sessionId: null, localPrincipal: null }, outcome: null, evidence: { offeredMessageIds: [], consumedMessageIds: [], createdWorkerIds: [], touchedWorkerIds: [], outputLines: 0, outputBytes: 0, changedFiles: [], count: null, detail: null, execSessionId: null, execCommand: null } }) as any;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? '').join('\n');

describe('file provider broker', () => {
  it('makes Not now the default native install answer so Enter never approves an install', () => {
    const provider = fileCapabilityProvider('artcraft.gridcraft')!;
    const options = consent.providerInstallDialogOptions({
      provider,
      tag: 'v0.6.1',
      version: '0.6.1',
      asset: { name: 'gridcraft.zip', size: 1_048_576, sha256: 'a'.repeat(64), url: 'https://example.invalid/gridcraft.zip' }
    });
    expect(options.buttons).toEqual(['Install', 'No thanks', 'Not now']);
    expect(options.defaultId).toBe(2);
    expect(options.cancelId).toBe(2);
  });

  it.each([
    ['gridcraft', '0.6.1', 'book.xlsx'],
    ['wordcraft', '0.7.0', 'letter.docx']
  ])('detects, offers and on yes installs %s as a broker-only provider', async (slug, version, file) => {
    publish(slug, version);
    // A real built-in file of the format, so file_action reads it and adds the offer.
    const bytes = file.endsWith('.xlsx')
      ? zipSync({ 'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'), 'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'), 'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData/></worksheet>') })
      : zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>') });
    await fs.writeFile(path.join(dir, 'workspace', file), bytes);
    const reg = registrar();

    const inspected = textOf(await reg.invokeNested('file_action', { op: 'inspect', path: `/workspace/${file}` }, caller()));
    expect(inspected).toContain(`provider_offer: ${slug === 'gridcraft' ? 'GridCraft' : 'WordCraft'} (artcraft.${slug})`);
    expect(inspected).toContain('Your original file is left alone: Eve edits a copy');
    expect(mock.requests).toEqual([]); // offering costs no network

    const asked: string[] = [];
    const confirm = vi.fn(async (choice: { provider: { id: string }; version: string; asset: { name: string } }) => { asked.push(`${choice.provider.id}@${choice.version}:${choice.asset.name}`); return 'install' as const; });
    const outcome = await consent.requestFileProviderInstall(`artcraft.${slug}`, confirm);
    expect(outcome).toEqual({ status: 'installed', version });
    expect(asked).toEqual([`artcraft.${slug}@${version}:${slug}-${version}-windows-x64-portable.zip`]);

    // Installed and healthy, but never published on any connector; only the broker can call it.
    expect(pluginManager.fileProvider(`artcraft.${slug}`)).toMatchObject({ status: 'ready', version });
    expect(pluginManager.tools().map((tool) => tool.name)).not.toContain('read_range');
    expect(textOf(await pluginManager.call('read_range', { range: 'A1' }) as any)).toMatch(/PLUGIN_DISABLED/);
    expect(textOf(await pluginManager.call('read_range', { range: 'A1' }, undefined, { broker: `artcraft.${slug}` }) as any)).toBe('args=mcp range=A1');

    // Once installed, the offer is gone.
    expect(textOf(await reg.invokeNested('file_action', { op: 'inspect', path: `/workspace/${file}` }, caller()))).not.toContain('provider_offer');
  });

  it('offers apps for formats the built-in readers cannot open, without reading the file', async () => {
    await fs.writeFile(path.join(dir, 'workspace', 'photo.psd'), Buffer.alloc(64));
    await fs.writeFile(path.join(dir, 'workspace', 'plan.dxf'), Buffer.alloc(64));
    const reg = registrar();
    const psd = textOf(await reg.invokeNested('file_action', { op: 'inspect', path: '/workspace/photo.psd' }, caller()));
    expect(psd).toContain('built_in_reader: none for this format');
    expect(psd).toContain('provider_offer: PhotoCraft (artcraft.photocraft)');
    const read = await reg.invokeNested('file_action', { op: 'read', path: '/workspace/plan.dxf' }, caller());
    expect(read.isError).toBe(true);
    expect(textOf(read)).toContain('provider_offer: CADCraft (artcraft.cadcraft)');
  });

  it('tells the user an app has no build for this system, and offers nothing to install', async () => {
    consent.resetFileProviderConsentForTests('linux-x64');
    await fs.writeFile(path.join(dir, 'workspace', 'clip.wav'), Buffer.alloc(64));
    const text = textOf(await registrar().invokeNested('file_action', { op: 'inspect', path: '/workspace/clip.wav' }, caller()));
    expect(text).toContain('provider_unavailable: SoundCraft has no build for this operating system yet.');
    expect(text).not.toContain('provider_offer');
    const confirm = vi.fn();
    expect(await consent.requestFileProviderInstall('artcraft.soundcraft', confirm)).toMatchObject({ status: 'unavailable' });
    expect(confirm).not.toHaveBeenCalled();
    expect(mock.requests).toEqual([]);
  });

  it('never asks when the release publishes no checksum', async () => {
    publish('deckcraft', '0.6.1', null);
    const confirm = vi.fn();
    const outcome = await consent.requestFileProviderInstall('artcraft.deckcraft', confirm);
    expect(outcome).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('no SHA-256 checksum') });
    expect(confirm).not.toHaveBeenCalled();
    expect(mock.requests.some((url) => url.startsWith('/dl/'))).toBe(false);
  });

  it('remembers No per app until reset, and Not now only for a cool-down', async () => {
    publish('gridcraft', '0.6.1');
    publish('pdfcraft', '0.7.1');
    expect(await consent.requestFileProviderInstall('artcraft.gridcraft', async () => 'decline')).toEqual({ status: 'declined' });
    const again = vi.fn();
    expect(await consent.requestFileProviderInstall('artcraft.gridcraft', again)).toEqual({ status: 'declined' });
    expect(again).not.toHaveBeenCalled();
    expect((await consent.fileProviderOffers('xlsx')).map((offer) => offer.id)).toEqual([]);
    // Durable: a restart still remembers.
    consent.resetFileProviderConsentForTests('win32-x64');
    expect(await consent.fileProviderSettings()).toMatchObject({ declined: ['artcraft.gridcraft'] });

    expect(await consent.requestFileProviderInstall('artcraft.pdfcraft', async () => 'later')).toEqual({ status: 'later' });
    expect(await consent.requestFileProviderInstall('artcraft.pdfcraft', again)).toEqual({ status: 'later' });
    expect(again).not.toHaveBeenCalled();

    await consent.updateFileProviderSettings({ resetDeclined: true });
    expect((await consent.fileProviderOffers('xlsx')).map((offer) => offer.id)).toEqual(['artcraft.gridcraft']);
    expect(pluginManager.snapshot().plugins).toEqual([]);
  });

  it('shares one dialog between concurrent requests and removes an install that never became healthy', async () => {
    publish('gridcraft', '0.6.1');
    let release!: (answer: 'install') => void;
    const confirm = vi.fn(() => new Promise<'install'>((resolve) => { release = resolve; }));
    await fs.writeFile(fixturePath.value, 'process.exit(3)');
    const first = consent.requestFileProviderInstall('artcraft.gridcraft', confirm);
    const second = consent.requestFileProviderInstall('artcraft.gridcraft', confirm);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    release('install');
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ status: 'failed', reason: expect.stringContaining('did not start correctly') });
    expect(b).toBe(a);
    expect(pluginManager.fileProvider('artcraft.gridcraft')).toBeNull();
  });

  it('file_edit install_provider only reports what the user answered', async () => {
    publish('gridcraft', '0.6.1');
    const spy = vi.spyOn(consent, 'requestFileProviderInstall');
    const result = await registrar().invokeNested('file_edit', { op: 'install_provider', provider: 'artcraft.gridcraft' }, caller());
    // In tests the native dialog is unavailable, so the default confirm cannot answer yes.
    expect(result.isError).toBe(true);
    expect(pluginManager.fileProvider('artcraft.gridcraft')).toBeNull();
    spy.mockRestore();
    const unknown = await registrar().invokeNested('file_edit', { op: 'install_provider', provider: 'artcraft.notreal' }, caller());
    expect(textOf(unknown)).toMatch(/UNAVAILABLE/);
    expect(textOf(await registrar().invokeNested('file_edit', { op: 'install_provider', provider: '../../x' }, caller()))).toMatch(/INVALID_ARGUMENTS/);
    expect(registrar({ edit: false }).registered()).not.toContain('file_edit');
  });
});

/**
 * A spreadsheet-app stand-in: open_workbook remembers a file, set_value records an edit,
 * save_workbook writes the edited package, save_garbage writes something unreadable.
 */
const EDIT_FIXTURE = (fflate: string) => `const readline=require('node:readline');const fs=require('node:fs');const {unzipSync,zipSync,strFromU8,strToU8}=require(${JSON.stringify(fflate)});
let opened=null;const edits={};
const tools=['open_workbook','set_value','save_workbook','save_garbage','fail_step'].map(name=>({name,description:name+' fixture',inputSchema:{type:'object',properties:{path:{type:'string'},cell:{type:'string'},value:{type:'string'}}}}));
function save(path){const bytes=fs.readFileSync(opened);if(!opened.endsWith('.xlsx')){fs.writeFileSync(path,Buffer.concat([bytes,Buffer.from([1])]));return;}
const files=unzipSync(bytes);let xml=strFromU8(files['xl/worksheets/sheet1.xml']);for(const [cell,value] of Object.entries(edits))xml=xml.replace(new RegExp('(<c r="'+cell+'"[^>]*>)<v>[^<]*</v>'),'$1<v>'+value+'</v>');files['xl/worksheets/sheet1.xml']=strToU8(xml);fs.writeFileSync(path,zipSync(files));}
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'grid fixture',version:'1'}};
else if(m.method==='tools/list')result={tools};
else if(m.method==='tools/call'){const a=m.params.arguments||{};const n=m.params.name;
 if(n==='open_workbook'){opened=a.path;for(const k of Object.keys(edits))delete edits[k];result={content:[{type:'text',text:'opened'}]};}
 else if(n==='set_value'){edits[a.cell]=a.value;result={content:[{type:'text',text:'set '+a.cell}]};}
 else if(n==='save_workbook'){save(a.path);result={content:[{type:'text',text:'saved'}]};}
 else if(n==='save_garbage'){fs.writeFileSync(a.path,'junk');result={content:[{type:'text',text:'saved'}]};}
 else result={content:[{type:'text',text:'boom'}],isError:true};}
else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;

function workbook(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>'),
    ...extra
  });
}

describe('file_edit edit transaction', () => {
  const workspace = () => path.join(dir, 'workspace');
  const sha = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const leftovers = async () => (await fs.readdir(workspace())).filter((name) => name.startsWith('.eve-staging-'));
  const steps = (value = '99') => [
    { tool: 'open_workbook', arguments: { path: '{{input}}' } },
    { tool: 'set_value', arguments: { cell: 'B1', value } },
    { tool: 'save_workbook', arguments: { path: '{{output}}' } }
  ];

  beforeEach(async () => {
    await fs.writeFile(fixturePath.value, EDIT_FIXTURE(createRequire(import.meta.url).resolve('fflate')));
    publish('gridcraft', '0.6.1');
    publish('soundcraft', '0.6.1');
    expect(await consent.requestFileProviderInstall('artcraft.gridcraft', async () => 'install')).toMatchObject({ status: 'installed' });
  });

  it('edits a copy through the app, re-validates it, reports a compact diff and never touches the original', async () => {
    const source = path.join(workspace(), 'book.xlsx');
    await fs.writeFile(source, workbook());
    const before = await sha(source);
    const reg = registrar({ create: true });

    const tools = textOf(await reg.invokeNested('file_edit', { op: 'provider_tools', provider: 'artcraft.gridcraft' }, caller()));
    expect(tools).toContain('save_workbook(path?, cell?, value?)');

    const result = await reg.invokeNested('file_edit', { op: 'edit', provider: 'artcraft.gridcraft', path: '/workspace/book.xlsx', steps: steps() }, caller());
    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain('EDITED: wrote /workspace/book (Eve edit).xlsx with artcraft.gridcraft 0.6.1. The original /workspace/book.xlsx was not changed.');
    expect(text).toContain('validated: yes');
    expect(text).toContain('~ S!B1: 42 → 99');
    expect(result.structuredContent).toMatchObject({ output: '/workspace/book (Eve edit).xlsx', provider: { id: 'artcraft.gridcraft', version: '0.6.1' } });
    expect(await sha(source)).toBe(before);
    expect(await leftovers()).toEqual([]);

    // A second edit never overwrites the first result.
    const again = textOf(await reg.invokeNested('file_edit', { op: 'edit', provider: 'artcraft.gridcraft', path: '/workspace/book.xlsx', steps: steps('7') }, caller()));
    expect(again).toContain('/workspace/book (Eve edit 2).xlsx');
  });

  it('refuses paths in step arguments, saves to the original, an existing output and a missing save', async () => {
    await fs.writeFile(path.join(workspace(), 'book.xlsx'), workbook());
    await fs.writeFile(path.join(workspace(), 'taken.xlsx'), 'x');
    const reg = registrar({ create: true });
    const run = (extra: Record<string, unknown>) => reg.invokeNested('file_edit', { op: 'edit', provider: 'artcraft.gridcraft', path: '/workspace/book.xlsx', steps: steps(), ...extra }, caller());
    for (const escape of ['D:\\elsewhere\\evil.xlsx', '/etc/passwd', '..\\up.xlsx', '\\\\server\\share\\x.xlsx']) {
      const result = await run({ steps: [{ tool: 'save_workbook', arguments: { nested: [{ path: escape }] } }] });
      expect(textOf(result)).toMatch(/PATH_NOT_ALLOWED: steps\[0\]\.arguments\.nested\[0\]\.path/);
    }
    expect(textOf(await run({ output_path: '/workspace/book.xlsx' }))).toMatch(/SOURCE_PROTECTED/);
    expect(textOf(await run({ output_path: '/workspace/taken.xlsx' }))).toMatch(/OUTPUT_EXISTS/);
    expect(textOf(await run({ steps: steps().slice(0, 2) }))).toMatch(/EDIT_NOT_SAVED/);
    expect(textOf(await run({ steps: [{ tool: 'fail_step' }] }))).toMatch(/STEP_FAILED: step 1 \(fail_step\)/);
    expect(textOf(await run({ steps: [steps()[0]!, { tool: 'save_garbage', arguments: { path: '{{output}}' } }] }))).toMatch(/OUTPUT_INVALID/);
    expect(await leftovers()).toEqual([]);
    expect((await fs.readdir(workspace())).sort()).toEqual(['book.xlsx', 'taken.xlsx']);
  });

  it('does not race a program that has the file open', async () => {
    await fs.writeFile(path.join(workspace(), 'book.xlsx'), workbook());
    await fs.writeFile(path.join(workspace(), '~$book.xlsx'), 'owner');
    const result = await registrar({ create: true }).invokeNested('file_edit', { op: 'edit', provider: 'artcraft.gridcraft', path: '/workspace/book.xlsx', steps: steps() }, caller());
    expect(textOf(result)).toMatch(/FILE_IN_USE: .*~\$book\.xlsx.*Computer use/);
  });

  it('requires app-owned approval for the exact fidelity risk and ignores model-supplied approval', async () => {
    await fs.writeFile(path.join(workspace(), 'pivot.xlsx'), workbook({ 'xl/slicers/slicer1.xml': strToU8('<slicers/>'), 'xl/externalLinks/externalLink1.xml': strToU8('<externalLink/>') }));
    const reg = registrar({ create: true });
    const modelApproved = await reg.invokeNested('file_edit', { op: 'edit', provider: 'artcraft.gridcraft', path: '/workspace/pivot.xlsx', steps: steps(), allow_feature_loss: true }, caller());
    expect(modelApproved.isError).toBe(true);
    expect(textOf(modelApproved)).toMatch(/invalid|unrecognized|argument/i);

    const asked: Array<{ provider: string; source: string; output: string; losses: readonly string[] }> = [];
    setFeatureLossConfirmForTests(async (choice) => { asked.push(choice); return false; });
    const refused = textOf(await reg.invokeNested('file_edit', { op: 'edit', provider: 'artcraft.gridcraft', path: '/workspace/pivot.xlsx', steps: steps() }, caller()));
    expect(refused).toMatch(/FIDELITY_RISK_NOT_APPROVED: GridCraft does not keep slicers, external links/);
    expect(asked).toEqual([{
      provider: 'GridCraft',
      source: '/workspace/pivot.xlsx',
      output: '/workspace/pivot (Eve edit).xlsx',
      losses: ['slicers', 'external links']
    }]);
    expect(consent.featureLossDialogOptions(asked[0]!)).toMatchObject({ defaultId: 1, cancelId: 1, buttons: ['Continue with feature loss', 'Keep features / cancel'] });
    expect(await fs.readdir(workspace())).toEqual(['pivot.xlsx']);

    setFeatureLossConfirmForTests(async (choice) => choice.source === '/workspace/pivot.xlsx' &&
      choice.output === '/workspace/pivot (Eve edit).xlsx' && choice.losses.join('|') === 'slicers|external links');
    const accepted = await reg.invokeNested('file_edit', { op: 'edit', provider: 'artcraft.gridcraft', path: '/workspace/pivot.xlsx', steps: steps() }, caller());
    expect(textOf(accepted)).toContain('EDITED: wrote /workspace/pivot (Eve edit).xlsx');
  });

  it('fails closed if atomic no-clobber publish loses a race instead of overwriting the destination', async () => {
    await fs.writeFile(path.join(workspace(), 'book.xlsx'), workbook());
    const destination = path.join(workspace(), 'book (Eve edit).xlsx');
    const originalLink = rawPromises.link.bind(rawPromises);
    const link = vi.spyOn(rawPromises, 'link').mockImplementationOnce(async (existing, target) => {
      await fs.writeFile(destination, 'raced destination');
      return originalLink(existing, target);
    });
    const result = await registrar({ create: true }).invokeNested('file_edit', {
      op: 'edit', provider: 'artcraft.gridcraft', path: '/workspace/book.xlsx', steps: steps()
    }, caller());
    link.mockRestore();
    expect(textOf(result)).toMatch(/PUBLISH_FAILED/);
    expect(await fs.readFile(destination, 'utf8')).toBe('raced destination');
    const staged = (await fs.readdir(workspace())).filter((name) => name.startsWith('.eve-staging-') && name.endsWith('book (Eve edit).xlsx'));
    expect(staged).toHaveLength(1);
  });

  it('fails closed when atomic no-clobber publishing is unsupported instead of renaming over a future destination', async () => {
    await fs.writeFile(path.join(workspace(), 'book.xlsx'), workbook());
    const link = vi.spyOn(rawPromises, 'link').mockRejectedValueOnce(Object.assign(new Error('links unsupported'), { code: 'ENOTSUP' }));
    const result = await registrar({ create: true }).invokeNested('file_edit', {
      op: 'edit', provider: 'artcraft.gridcraft', path: '/workspace/book.xlsx', steps: steps()
    }, caller());
    link.mockRestore();
    expect(textOf(result)).toMatch(/PUBLISH_FAILED/);
    expect(await fs.stat(path.join(workspace(), 'book (Eve edit).xlsx')).then(() => true, () => false)).toBe(false);
    expect((await fs.readdir(workspace())).some((name) => name.startsWith('.eve-staging-') && name.endsWith('book (Eve edit).xlsx'))).toBe(true);
  });

  it('reports a successful publish and retained staging file when post-link cleanup fails', async () => {
    const source = path.join(workspace(), 'book.xlsx');
    const destination = path.join(workspace(), 'book (Eve edit).xlsx');
    await fs.writeFile(source, workbook());
    const sourceHash = await sha(source);
    const originalRm = rawPromises.rm.bind(rawPromises);
    let linkedBeforeCleanup = false;
    const rm = vi.spyOn(rawPromises, 'rm').mockImplementation(async (target, options) => {
      if (typeof target === 'string' && target.includes('.eve-staging-') && target.endsWith('book (Eve edit).xlsx')) {
        linkedBeforeCleanup = await fs.stat(destination).then(() => true, () => false);
        throw Object.assign(new Error('staging output is locked'), { code: 'EPERM' });
      }
      return originalRm(target, options);
    });
    let result: Awaited<ReturnType<ReturnType<typeof registrar>['invokeNested']>>;
    try {
      result = await registrar({ create: true }).invokeNested('file_edit', {
        op: 'edit', provider: 'artcraft.gridcraft', path: '/workspace/book.xlsx', steps: steps()
      }, caller());
    } finally {
      rm.mockRestore();
    }

    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('EDITED: wrote /workspace/book (Eve edit).xlsx');
    expect(textOf(result)).not.toContain('PUBLISH_FAILED');
    expect(textOf(result)).toMatch(/CLEANUP_WARNING:.*\.eve-staging-.*book \(Eve edit\)\.xlsx/);
    expect(result.structuredContent).toMatchObject({ output: '/workspace/book (Eve edit).xlsx' });
    expect(result.structuredContent).toMatchObject({ warning: expect.stringMatching(/CLEANUP_WARNING:.*\/workspace\/\.eve-staging-/) });
    expect(linkedBeforeCleanup).toBe(true);
    expect(await sha(source)).toBe(sourceHash);
    expect(await fs.stat(destination).then(() => true, () => false)).toBe(true);
    const staged = (await fs.readdir(workspace())).filter((name) => name.startsWith('.eve-staging-') && name.endsWith('book (Eve edit).xlsx'));
    expect(staged).toHaveLength(1);
    expect(await leftovers()).toHaveLength(1);
    expect(await sha(path.join(workspace(), staged[0]!))).toBe(await sha(destination));
  });

  it('compares size and hash for formats without a built-in reader, and needs the app and the permission', async () => {
    await fs.writeFile(path.join(workspace(), 'clip.wav'), Buffer.from('RIFF....WAVE'));
    const reg = registrar({ create: true });
    const missing = textOf(await reg.invokeNested('file_edit', { op: 'edit', provider: 'artcraft.soundcraft', path: '/workspace/clip.wav', steps: steps() }, caller()));
    expect(missing).toMatch(/PROVIDER_NOT_READY: SoundCraft/);
    expect(await consent.requestFileProviderInstall('artcraft.soundcraft', async () => 'install')).toMatchObject({ status: 'installed' });
    const edited = textOf(await reg.invokeNested('file_edit', { op: 'edit', provider: 'artcraft.soundcraft', path: '/workspace/clip.wav', steps: [steps()[0]!, steps()[2]!] }, caller()));
    expect(edited).toContain('validated: no built-in reader for this format');
    expect(edited).toMatch(/bytes: 12 → 13/);
    const denied = textOf(await registrar({ create: false }).invokeNested('file_edit', { op: 'edit', provider: 'artcraft.gridcraft', path: '/workspace/clip.wav', steps: steps() }, caller()));
    expect(denied).toMatch(/TOOL_DISABLED: editing writes a new file/);
    expect(textOf(await reg.invokeNested('file_edit', { op: 'provider_tools', provider: 'artcraft.gridcraft', path: '/workspace/clip.wav' }, caller()))).toMatch(/INVALID_ARGUMENTS: provider_tools takes only provider/);
  });
});

describe('file_edit open_visible ("show me")', () => {
  const workspace = () => path.join(dir, 'workspace');
  afterEach(() => setVisibleLauncherForTests(null));

  it('opens a new copy in the app window for Computer use and leaves the original alone', async () => {
    publish('gridcraft', '0.6.1');
    expect(await consent.requestFileProviderInstall('artcraft.gridcraft', async () => 'install')).toMatchObject({ status: 'installed' });
    const source = path.join(workspace(), 'book.xlsx');
    await fs.writeFile(source, 'original bytes');
    const launched: Array<[string, string]> = [];
    setVisibleLauncherForTests(async (exe, file) => { launched.push([exe, file]); });
    const result = await registrar({ create: true }).invokeNested('file_edit', { op: 'open_visible', provider: 'artcraft.gridcraft', path: '/workspace/book.xlsx' }, caller());
    expect(textOf(result)).toContain("OPENED: /workspace/book (Eve edit).xlsx is open in GridCraft's window. The original /workspace/book.xlsx was not changed.");
    expect(launched).toHaveLength(1);
    expect(path.basename(launched[0]![0])).toBe('gridcraft.exe');
    expect(launched[0]![1]).toBe(path.join(workspace(), 'book (Eve edit).xlsx'));
    expect(await fs.readFile(path.join(workspace(), 'book (Eve edit).xlsx'), 'utf8')).toBe('original bytes');
    expect(await fs.readFile(source, 'utf8')).toBe('original bytes');
  });

  it('says so when only the headless tool exists, the app is missing, or the file is open elsewhere', async () => {
    await fs.writeFile(path.join(workspace(), 'book.xlsx'), 'x');
    const reg = registrar({ create: true });
    const run = () => reg.invokeNested('file_edit', { op: 'open_visible', provider: 'artcraft.gridcraft', path: '/workspace/book.xlsx' }, caller());
    expect(textOf(await run())).toMatch(/PROVIDER_NOT_READY/);
    // A macOS-style install: the archive has only the CLI.
    mock.releases.set('storytold/gridcraft', { tag: 'v0.6.1', assets: [{ name: 'gridcraft-0.6.1-windows-x64-portable.zip', bytes: zipSync({ 'gridcraft-cli.exe': strToU8('cli') }) }] });
    expect(await consent.requestFileProviderInstall('artcraft.gridcraft', async () => 'install')).toMatchObject({ status: 'installed' });
    const launcher = vi.fn(async () => undefined);
    setVisibleLauncherForTests(launcher);
    expect(textOf(await run())).toMatch(/VISIBLE_UNAVAILABLE: only GridCraft's headless tool is installed/);
    expect(launcher).not.toHaveBeenCalled();
    expect((await fs.readdir(workspace())).sort()).toEqual(['book.xlsx']);
  });
});
