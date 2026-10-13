import path from 'node:path';
import { promises as fs } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { createRegistrar } from '../src/main/mcp/kernel.js';
import { registerFileActionTool, sniffBuiltInFile } from '../src/main/mcp/file-action.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir = '';
const root = () => ({ name: 'workspace', path: dir });

beforeAll(async () => { dir = await makeTempDir('eve-file-action-'); });
afterAll(async () => { await removeTempDir(dir); });

function xml(text: string): Uint8Array { return strToU8(text); }

function xlsx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'xl/workbook.xml': xml('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': xml('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Name</t></si><si><t>Ada</t></si></sst>'),
    'xl/worksheets/sheet1.xml': xml('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>B1*2</f><v>84</v></c></row></sheetData></worksheet>')
  });
}

function docx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/document.xml': xml('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>')
  });
}

function pptx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'ppt/presentation.xml': xml('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'),
    'ppt/slides/slide1.xml': xml('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:t>Title</a:t><a:t>Body text</a:t></p:cSld></p:sld>'),
    'ppt/slides/slide2.xml': xml('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:t>Second slide</a:t></p:cSld></p:sld>')
  });
}

function pdf(): Uint8Array {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 50 100 Td (Hello PDF) Tj ET\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) { offsets.push(Buffer.byteLength(body, 'binary')); body += object; }
  const xref = Buffer.byteLength(body, 'binary');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'binary'));
}

function registrar() {
  const ctx = {
    roots: [root()],
    caps: { ...DEFAULT_CAPABILITIES, read: true },
    exposedCaps: { ...DEFAULT_CAPABILITIES, read: true },
    readOnly: true
  };
  const definitions: Array<{ name: string; config: any }> = [];
  const reg = createRegistrar(null, ctx, 'core', (name, config) => definitions.push({ name, config }));
  registerFileActionTool(reg);
  return { reg, definitions };
}

describe('file_action built-in read fallback', () => {
  it('sniffs content rather than trusting extensions', () => {
    expect(sniffBuiltInFile('wrong.docx', xlsx())).toMatchObject({ format: 'xlsx', extensionFormat: 'docx', extensionMatches: false });
    expect(sniffBuiltInFile('report.bin', docx())).toMatchObject({ format: 'docx', extensionFormat: null });
    expect(() => sniffBuiltInFile('fake.xlsx', xml('not a zip'))).toThrow(/MALFORMED_FILE/);
  });

  it('publishes one read-only, explicit inspect/read Core tool', () => {
    const { definitions } = registrar();
    const tool = definitions.find((entry) => entry.name === 'file_action');
    expect(tool?.config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const json = tool?.config.inputSchema.toJSONSchema?.() ?? {};
    expect(JSON.stringify(json)).toContain('inspect');
    expect(JSON.stringify(json)).toContain('read');
  });

  it('reads bounded XLSX, DOCX, PPTX and PDF slices through the same broker', async () => {
    await fs.writeFile(path.join(dir, 'book.xlsx'), xlsx());
    await fs.writeFile(path.join(dir, 'letter.docx'), docx());
    await fs.writeFile(path.join(dir, 'slides.pptx'), pptx());
    await fs.writeFile(path.join(dir, 'paper.pdf'), pdf());
    const { reg } = registrar();
    const caller = { startedAt: Date.now(), transportKey: null, agent: null, caller: { transportKey: null, requestId: null, conversationId: null, sessionId: null, localPrincipal: null }, outcome: null, evidence: { offeredMessageIds: [], consumedMessageIds: [], createdWorkerIds: [], touchedWorkerIds: [], outputLines: 0, outputBytes: 0, changedFiles: [], count: null, detail: null, execSessionId: null, execCommand: null } } as any;
    const call = (args: unknown) => reg.invokeNested('file_action', args, caller);

    expect((await call({ op: 'read', path: '/workspace/book.xlsx', sheet: 'Budget', range: 'A1:B2', max_rows: 2, max_columns: 2 })).content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Ada') });
    expect((await call({ op: 'read', path: '/workspace/letter.docx', paragraph_start: 2, max_paragraphs: 1 })).content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Second paragraph') });
    expect((await call({ op: 'read', path: '/workspace/slides.pptx', slide_start: 2, slide_end: 2 })).content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Second slide') });
    expect((await call({ op: 'read', path: '/workspace/paper.pdf', page_start: 1, page_end: 1 })).content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Hello PDF') });
  });

  it('keeps output bounded and refuses sandbox traversal', async () => {
    await fs.writeFile(path.join(dir, 'long.docx'), zipSync({ 'word/document.xml': xml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${'x'.repeat(5000)}</w:t></w:r></w:p></w:body></w:document>`) }));
    const { reg } = registrar();
    const caller = { startedAt: Date.now(), transportKey: null, agent: null, caller: { transportKey: null, requestId: null, conversationId: null, sessionId: null, localPrincipal: null }, outcome: null, evidence: { offeredMessageIds: [], consumedMessageIds: [], createdWorkerIds: [], touchedWorkerIds: [], outputLines: 0, outputBytes: 0, changedFiles: [], count: null, detail: null, execSessionId: null, execCommand: null } } as any;
    const bounded = await reg.invokeNested('file_action', { op: 'read', path: '/workspace/long.docx', max_chars: 512 }, caller);
    expect((bounded.content[0] as any).text.length).toBeLessThan(800);
    expect((bounded.content[0] as any).text).toContain('truncated: yes');
    const escaped = await reg.invokeNested('file_action', { op: 'inspect', path: '/workspace/../escape.docx' }, caller);
    expect(escaped.isError).toBe(true);
  });
});
