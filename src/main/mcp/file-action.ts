import { DOMParser, onWarningStopParsing, type Document as XmlDocument, type Element as XmlElement } from '@xmldom/xmldom';
import { unzipSync, strFromU8, type UnzipFileInfo } from 'fflate';
import nodePath from 'node:path';
import { z } from 'zod';
import { getDocumentProxy } from 'unpdf';
import { rawPromises as fs } from '../rawfs.js';
import { toolDeclaration } from './tool-declarations.js';
import { fail, guard, ok, resolveIn, type SurfaceRegistrar, type ToolResult } from './kernel.js';

export type BuiltInFileFormat = 'xlsx' | 'docx' | 'pdf' | 'pptx';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_SELECTED_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const DEFAULT_TEXT_CHARS = 32_000;
const MAX_TEXT_CHARS = 96_000;
const DEFAULT_XLSX_ROWS = 50;
const MAX_XLSX_ROWS = 200;
const DEFAULT_XLSX_COLUMNS = 30;
const MAX_XLSX_COLUMNS = 100;
const DEFAULT_PARAGRAPHS = 80;
const MAX_PARAGRAPHS = 300;
const DEFAULT_PAGES = 5;
const MAX_PAGES = 20;
const DEFAULT_SLIDES = 8;
const MAX_SLIDES = 30;
const PDF_PARSE_TIMEOUT_MS = 12_000;
const filePathArg = z.string().min(1).max(4096);

const readArgs = z.object({
  op: z.literal('read'),
  path: filePathArg,
  sheet: z.string().min(1).max(200).optional().describe('XLSX only: sheet name. Defaults to the first sheet.'),
  range: z.string().regex(/^[A-Za-z]{1,3}[1-9]\d*(?::[A-Za-z]{1,3}[1-9]\d*)?$/).optional().describe('XLSX only: A1 range such as A1:F40.'),
  max_rows: z.number().int().min(1).max(MAX_XLSX_ROWS).optional().describe(`XLSX only: maximum rows returned; default ${DEFAULT_XLSX_ROWS}, maximum ${MAX_XLSX_ROWS}.`),
  max_columns: z.number().int().min(1).max(MAX_XLSX_COLUMNS).optional().describe(`XLSX only: maximum columns returned; default ${DEFAULT_XLSX_COLUMNS}, maximum ${MAX_XLSX_COLUMNS}.`),
  paragraph_start: z.number().int().min(1).max(1_000_000).optional().describe('DOCX only: first paragraph, 1-based.'),
  max_paragraphs: z.number().int().min(1).max(MAX_PARAGRAPHS).optional().describe(`DOCX only: maximum paragraphs; default ${DEFAULT_PARAGRAPHS}, maximum ${MAX_PARAGRAPHS}.`),
  page_start: z.number().int().min(1).max(100_000).optional().describe('PDF only: first page, 1-based.'),
  page_end: z.number().int().min(1).max(100_000).optional().describe(`PDF only: last page, inclusive. At most ${MAX_PAGES} pages per call.`),
  slide_start: z.number().int().min(1).max(100_000).optional().describe('PPTX only: first slide, 1-based.'),
  slide_end: z.number().int().min(1).max(100_000).optional().describe(`PPTX only: last slide, inclusive. At most ${MAX_SLIDES} slides per call.`),
  max_chars: z.number().int().min(256).max(MAX_TEXT_CHARS).optional().describe(`Maximum text characters returned; default ${DEFAULT_TEXT_CHARS}, maximum ${MAX_TEXT_CHARS}.`)
}).strict();

export const fileActionArgs = z.union([
  z.object({ op: z.literal('inspect'), path: filePathArg }).strict(),
  readArgs
]);

type FileActionArgs = z.output<typeof fileActionArgs>;

interface SniffedFile {
  format: BuiltInFileFormat;
  extensionFormat: BuiltInFileFormat | null;
  extensionMatches: boolean | null;
  bytes: Uint8Array;
  zipEntries?: string[];
}

interface ZipScan { names: string[]; }

function extensionFormat(path: string): BuiltInFileFormat | null {
  const ext = nodePath.extname(path).toLowerCase().slice(1);
  return ext === 'xlsx' || ext === 'docx' || ext === 'pdf' || ext === 'pptx' ? ext : null;
}

function scanZipSafe(bytes: Uint8Array): ZipScan {
  let count = 0;
  const names: string[] = [];
  unzipSync(bytes, {
    filter(info) {
      count++;
      if (count > MAX_ZIP_ENTRIES) throw new Error(`ARCHIVE_TOO_COMPLEX: more than ${MAX_ZIP_ENTRIES} ZIP entries.`);
      names.push(info.name.replace(/\\/g, '/'));
      return false;
    }
  });
  return { names };
}

function formatFromZipNames(names: string[]): BuiltInFileFormat | null {
  if (names.includes('xl/workbook.xml')) return 'xlsx';
  if (names.includes('word/document.xml')) return 'docx';
  if (names.includes('ppt/presentation.xml')) return 'pptx';
  return null;
}

export function sniffBuiltInFile(path: string, bytes: Uint8Array): SniffedFile {
  const ext = extensionFormat(path);
  let format: BuiltInFileFormat | null = null;
  let zipEntries: string[] | undefined;
  if (bytes.length >= 5 && strFromU8(bytes.subarray(0, 5)) === '%PDF-') {
    format = 'pdf';
  } else {
    try {
      const scan = scanZipSafe(bytes);
      zipEntries = scan.names;
      format = formatFromZipNames(scan.names);
    } catch (err) {
      if (ext && ext !== 'pdf') throw new Error(`MALFORMED_FILE: ${ext.toUpperCase()} must be a readable OOXML ZIP package.`);
    }
  }
  if (!format) throw new Error('UNSUPPORTED_FILE_FORMAT: expected XLSX, DOCX, PDF, or PPTX content.');
  return { format, extensionFormat: ext, extensionMatches: ext ? ext === format : null, bytes, zipEntries };
}

function parseXml(bytes: Uint8Array): XmlDocument {
  const text = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('UNSAFE_XML: OOXML parts may not contain DTD/entity declarations.');
  return new DOMParser({ locator: false, onError: onWarningStopParsing }).parseFromString(text, 'application/xml');
}

function elements(root: XmlDocument | XmlElement, localName: string): XmlElement[] {
  return Array.from(root.getElementsByTagName('*')).filter((node) => node.localName === localName) as XmlElement[];
}

function firstElement(root: XmlDocument | XmlElement, localName: string): XmlElement | null {
  return elements(root, localName)[0] ?? null;
}

function unzipSelected(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> {
  let selectedBytes = 0;
  return unzipSync(bytes, {
    filter(info: UnzipFileInfo) {
      const name = info.name.replace(/\\/g, '/');
      if (!wanted(name)) return false;
      if (info.originalSize > MAX_XML_ENTRY_BYTES) {
        throw new Error(`ARCHIVE_ENTRY_TOO_LARGE: ${name} exceeds ${MAX_XML_ENTRY_BYTES} decompressed bytes.`);
      }
      selectedBytes += info.originalSize;
      if (selectedBytes > MAX_SELECTED_UNCOMPRESSED_BYTES) {
        throw new Error(`ARCHIVE_TOO_LARGE: selected OOXML parts exceed ${MAX_SELECTED_UNCOMPRESSED_BYTES} decompressed bytes.`);
      }
      return true;
    }
  });
}

function truncatedText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 80))}\n… (output truncated; narrow the requested range)`, truncated: true };
}

function colNumber(label: string): number {
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

function colLabel(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function parseCellRef(ref: string): { row: number; col: number } {
  const match = /^([A-Za-z]+)([1-9]\d*)$/.exec(ref);
  if (!match) throw new Error(`INVALID_RANGE: invalid cell reference ${ref}.`);
  return { col: colNumber(match[1]!), row: Number(match[2]!) };
}

function rangeBounds(range: string | undefined, maxRows: number, maxCols: number) {
  if (!range) return { startRow: 1, endRow: maxRows, startCol: 1, endCol: maxCols };
  const [startRef, endRef = startRef] = range.split(':');
  const start = parseCellRef(startRef!);
  const end = parseCellRef(endRef!);
  if (end.row < start.row || end.col < start.col) throw new Error('INVALID_RANGE: range end must not precede range start.');
  return {
    startRow: start.row,
    endRow: Math.min(end.row, start.row + maxRows - 1),
    startCol: start.col,
    endCol: Math.min(end.col, start.col + maxCols - 1)
  };
}

function resolveWorkbookTarget(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/^\//, '');
  return normalized.startsWith('xl/') ? normalized : nodePath.posix.normalize(nodePath.posix.join('xl', normalized));
}

function xlsxRead(file: SniffedFile, args: Extract<FileActionArgs, { op: 'read' }>) {
  const parts = unzipSelected(file.bytes, (name) =>
    name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' || name === 'xl/sharedStrings.xml' || name.startsWith('xl/worksheets/')
  );
  const workbookBytes = parts['xl/workbook.xml'];
  const relBytes = parts['xl/_rels/workbook.xml.rels'];
  if (!workbookBytes || !relBytes) throw new Error('MALFORMED_XLSX: workbook metadata is missing.');
  const workbook = parseXml(workbookBytes);
  const rels = parseXml(relBytes);
  const relations = new Map(elements(rels, 'Relationship').map((rel) => [rel.getAttribute('Id') ?? '', rel.getAttribute('Target') ?? '']));
  const sheets = elements(workbook, 'sheet').map((sheet) => ({
    name: sheet.getAttribute('name') ?? '',
    relationId: sheet.getAttribute('r:id') ?? sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? ''
  })).filter((sheet) => sheet.name && sheet.relationId);
  if (sheets.length === 0) throw new Error('MALFORMED_XLSX: no worksheets found.');
  const chosen = args.sheet ? sheets.find((sheet) => sheet.name === args.sheet) : sheets[0];
  if (!chosen) throw new Error(`SHEET_NOT_FOUND: ${args.sheet}. Available sheets: ${sheets.map((sheet) => sheet.name).join(', ')}`);
  const target = relations.get(chosen.relationId);
  if (!target) throw new Error(`MALFORMED_XLSX: worksheet relationship missing for ${chosen.name}.`);
  const sheetPath = resolveWorkbookTarget(target);
  const sheetBytes = parts[sheetPath];
  if (!sheetBytes) throw new Error(`MALFORMED_XLSX: worksheet part missing for ${chosen.name}.`);

  const sharedStrings = parts['xl/sharedStrings.xml']
    ? elements(parseXml(parts['xl/sharedStrings.xml']), 'si').map((si) => elements(si, 't').map((node) => node.textContent ?? '').join(''))
    : [];
  const sheetDoc = parseXml(sheetBytes);
  const bounds = rangeBounds(args.range, args.max_rows ?? DEFAULT_XLSX_ROWS, args.max_columns ?? DEFAULT_XLSX_COLUMNS);
  const cells = new Map<string, string>();
  for (const cell of elements(sheetDoc, 'c')) {
    const ref = cell.getAttribute('r');
    if (!ref) continue;
    const pos = parseCellRef(ref);
    if (pos.row < bounds.startRow || pos.row > bounds.endRow || pos.col < bounds.startCol || pos.col > bounds.endCol) continue;
    const type = cell.getAttribute('t');
    let value = '';
    if (type === 'inlineStr') value = elements(cell, 't').map((node) => node.textContent ?? '').join('');
    else {
      const raw = firstElement(cell, 'v')?.textContent ?? '';
      value = type === 's' && /^\d+$/.test(raw) ? (sharedStrings[Number(raw)] ?? raw) : type === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE') : raw;
    }
    const formula = firstElement(cell, 'f')?.textContent;
    cells.set(ref.toUpperCase(), formula ? `${value} [formula: ${formula}]` : value);
  }
  const lines: string[] = [];
  lines.push(`sheet: ${chosen.name}`);
  lines.push(`range: ${colLabel(bounds.startCol)}${bounds.startRow}:${colLabel(bounds.endCol)}${bounds.endRow}`);
  const header = ['row', ...Array.from({ length: bounds.endCol - bounds.startCol + 1 }, (_, i) => colLabel(bounds.startCol + i))];
  lines.push(header.join('\t'));
  for (let row = bounds.startRow; row <= bounds.endRow; row++) {
    const values = [String(row)];
    for (let col = bounds.startCol; col <= bounds.endCol; col++) values.push(cells.get(`${colLabel(col)}${row}`) ?? '');
    lines.push(values.join('\t'));
  }
  return { text: lines.join('\n'), details: { sheet: chosen.name, sheets: sheets.map((sheet) => sheet.name), range: lines[1]!.slice(7) } };
}

function docxRead(file: SniffedFile, args: Extract<FileActionArgs, { op: 'read' }>) {
  const parts = unzipSelected(file.bytes, (name) => name === 'word/document.xml');
  const document = parts['word/document.xml'];
  if (!document) throw new Error('MALFORMED_DOCX: word/document.xml is missing.');
  const paragraphs = elements(parseXml(document), 'p').map((p) => elements(p, 't').map((node) => node.textContent ?? '').join('')).filter((text) => text.length > 0);
  const start = (args.paragraph_start ?? 1) - 1;
  const max = args.max_paragraphs ?? DEFAULT_PARAGRAPHS;
  const picked = paragraphs.slice(start, start + max);
  const text = picked.map((paragraph, index) => `${start + index + 1}. ${paragraph}`).join('\n');
  return { text, details: { paragraph_start: start + 1, paragraph_count: picked.length, total_paragraphs: paragraphs.length } };
}

function pptxSlideNumber(name: string): number | null {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name);
  return match ? Number(match[1]) : null;
}

function pptxRead(file: SniffedFile, args: Extract<FileActionArgs, { op: 'read' }>) {
  const available = (file.zipEntries ?? scanZipSafe(file.bytes).names)
    .map((name) => ({ name, number: pptxSlideNumber(name) }))
    .filter((entry): entry is { name: string; number: number } => entry.number !== null)
    .sort((a, b) => a.number - b.number);
  if (available.length === 0) throw new Error('MALFORMED_PPTX: no slide parts found.');
  const start = args.slide_start ?? 1;
  const end = Math.min(args.slide_end ?? (start + DEFAULT_SLIDES - 1), start + MAX_SLIDES - 1);
  if (end < start) throw new Error('INVALID_SLIDE_RANGE: slide_end must be greater than or equal to slide_start.');
  const selected = available.filter((entry) => entry.number >= start && entry.number <= end);
  const wanted = new Set(selected.map((entry) => entry.name));
  const parts = unzipSelected(file.bytes, (name) => wanted.has(name));
  const lines: string[] = [];
  for (const entry of selected) {
    const bytes = parts[entry.name];
    if (!bytes) continue;
    const text = elements(parseXml(bytes), 't').map((node) => node.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
    lines.push(`--- slide ${entry.number} ---\n${text}`);
  }
  return { text: lines.join('\n\n'), details: { slide_start: start, slide_end: end, slides_returned: selected.length, total_slides: available.length } };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`PDF_TIMEOUT: PDF parsing exceeded ${ms} ms.`)), ms); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pdfRead(file: SniffedFile, args: Extract<FileActionArgs, { op: 'read' }>) {
  const pdf = await withTimeout(getDocumentProxy(file.bytes, { maxImageSize: 16_777_216 }), PDF_PARSE_TIMEOUT_MS);
  try {
    const start = args.page_start ?? 1;
    const end = Math.min(args.page_end ?? (start + DEFAULT_PAGES - 1), start + MAX_PAGES - 1, pdf.numPages);
    if (start > pdf.numPages) throw new Error(`PAGE_OUT_OF_RANGE: PDF has ${pdf.numPages} pages.`);
    if (end < start) throw new Error('INVALID_PAGE_RANGE: page_end must be greater than or equal to page_start.');
    const chunks: string[] = [];
    for (let pageNumber = start; pageNumber <= end; pageNumber++) {
      const page = await withTimeout(pdf.getPage(pageNumber), PDF_PARSE_TIMEOUT_MS);
      const content = await withTimeout(page.getTextContent(), PDF_PARSE_TIMEOUT_MS);
      const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
      chunks.push(`--- page ${pageNumber} ---\n${text}`);
      page.cleanup();
    }
    return { text: chunks.join('\n\n'), details: { page_start: start, page_end: end, pages_returned: end - start + 1, total_pages: pdf.numPages } };
  } finally {
    await pdf.cleanup();
  }
}

async function readSource(realPath: string): Promise<Uint8Array> {
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new Error('NOT_A_FILE: file_action requires a file path.');
  if (stat.size > MAX_SOURCE_BYTES) throw new Error(`FILE_TOO_LARGE: source exceeds ${MAX_SOURCE_BYTES} bytes.`);
  const data = await fs.readFile(realPath);
  // PDF.js deliberately rejects Node Buffer even though Buffer subclasses Uint8Array.
  // Copy to a plain Uint8Array so every built-in reader receives the same runtime type.
  return Uint8Array.from(data);
}

function formatInspectText(path: string, stat: { size: number; mtimeMs: number }, file: SniffedFile): string {
  const lines = [
    `path: ${path}`,
    `format: ${file.format}`,
    `size_bytes: ${stat.size}`,
    `modified: ${new Date(stat.mtimeMs).toISOString()}`
  ];
  if (file.extensionFormat) lines.push(`extension_format: ${file.extensionFormat}`, `extension_matches_content: ${file.extensionMatches ? 'yes' : 'no'}`);
  else lines.push('extension_format: unrecognized');
  if (file.format === 'xlsx') {
    const parts = unzipSelected(file.bytes, (name) => name === 'xl/workbook.xml');
    if (parts['xl/workbook.xml']) {
      const names = elements(parseXml(parts['xl/workbook.xml']), 'sheet').map((sheet) => sheet.getAttribute('name')).filter(Boolean);
      lines.push(`sheets: ${names.join(', ') || '(none)'}`);
    }
  } else if (file.format === 'pptx') {
    const slides = (file.zipEntries ?? []).filter((name) => pptxSlideNumber(name) !== null).length;
    lines.push(`slides: ${slides}`);
  }
  return lines.join('\n');
}

export function registerFileActionTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.read) return;
  reg.register(
    'file_action',
    toolDeclaration('file_action', () => ({
      title: 'Inspect and read document files',
      description:
        'Read common document formats through one provider-neutral Eve tool. inspect identifies XLSX/DOCX/PDF/PPTX from file content and reports extension mismatches. ' +
        'read returns only a bounded requested slice: XLSX sheet/range, DOCX paragraph window, PDF page window, or PPTX slide window. File contents returned by this tool become visible to the active conversational model.',
      inputSchema: fileActionArgs,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    })),
    async (args) => guard('file_action', async (): Promise<ToolResult> => {
      if (!reg.caps.read) return fail('TOOL_DISABLED: file_action requires file reading permission in ParadigmEve.');
      const resolved = await resolveIn(reg.ctx.roots, args.path);
      const stat = await fs.stat(resolved.real);
      const bytes = await readSource(resolved.real);
      const file = sniffBuiltInFile(resolved.virtual, bytes);
      if (args.op === 'inspect') return ok(formatInspectText(resolved.virtual, stat, file));

      const maxChars = args.max_chars ?? DEFAULT_TEXT_CHARS;
      const read = file.format === 'xlsx' ? xlsxRead(file, args)
        : file.format === 'docx' ? docxRead(file, args)
          : file.format === 'pptx' ? pptxRead(file, args)
            : await pdfRead(file, args);
      const bounded = truncatedText(read.text || '(no extractable text in requested slice)', maxChars);
      const header = [
        `path: ${resolved.virtual}`,
        `format: ${file.format}`,
        file.extensionMatches === false ? `warning: extension suggests ${file.extensionFormat}, but content is ${file.format}` : null,
        `truncated: ${bounded.truncated ? 'yes' : 'no'}`
      ].filter(Boolean).join('\n');
      return {
        content: [{ type: 'text', text: `${header}\n\n${bounded.text}` }],
        structuredContent: {
          path: resolved.virtual,
          format: file.format,
          extension_format: file.extensionFormat,
          extension_matches_content: file.extensionMatches,
          truncated: bounded.truncated,
          ...read.details
        }
      };
    })
  );
}
