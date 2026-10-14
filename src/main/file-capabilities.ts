/**
 * Stable capability inventory for external file/creative handlers.
 *
 * ArtCraft is a suite of independently installable, free and open-source tools. ParadigmEve ships
 * this metadata only: no Craft app is bundled, preinstalled or downloaded at build time. When Eve
 * touches a file one of these apps handles, file_action tells the user the app exists and offers
 * it; it is installed only after the user says yes in Eve's own UI (file-provider-consent.ts), and
 * then only the official build for this machine is fetched and checked against the SHA-256 its
 * release publishes (file-provider-install.ts). Everything below is data: the flow has no
 * per-app code path.
 */
export type CapabilityExecutionMode = 'headless' | 'visible';
export type CapabilityAutomationSurface = 'cli' | 'mcp' | 'json-control' | 'desktop';
/** Upstream's own maturity label, least mature first. */
export const PROVIDER_MATURITY = ['unreleased', 'in-development', 'early-alpha', 'beta', 'stable'] as const;
export type ProviderMaturity = (typeof PROVIDER_MATURITY)[number];
/**
 * The least mature app Eve offers without the preview setting. Every released Craft app is
 * offered today, with the offer saying it is an in-development integration; raise this one value
 * to hold early apps behind the preview setting instead.
 */
export const OFFER_MATURITY_THRESHOLD: ProviderMaturity = 'in-development';

/** `${process.platform}-${process.arch}` of a machine an asset runs on. */
export type ProviderPlatform = 'win32-x64' | 'win32-arm64' | 'win32-ia32' | 'darwin-x64' | 'darwin-arm64' | 'linux-x64' | 'linux-arm64';
const PLATFORMS: readonly ProviderPlatform[] = ['win32-x64', 'win32-arm64', 'win32-ia32', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];

export interface ProviderRelease {
  /** GitHub `owner/name` that publishes the official releases. */
  repo: string;
  /** Basename of the headless CLI inside the archive (`.exe` is added on Windows). */
  cli: string;
  /** Arguments that start the headless MCP server on stdio. */
  mcpArgs: readonly string[];
  /** Release asset name per platform; `{version}` is the release version without its `v`. */
  assets: Readonly<Partial<Record<ProviderPlatform, string>>>;
}

/**
 * Something in a package that upstream documents as lost when the app saves: a ZIP part prefix,
 * optionally narrowed to parts whose text contains a marker.
 */
export interface FidelityRisk { part: string; marker?: string; feature: string }

export interface FileCapabilityProvider {
  id: string;
  displayName: string;
  family: 'artcraft';
  domain: string;
  /** Extensions (without dot) the app opens and saves. */
  formats: readonly string[];
  operations: readonly ('read' | 'write' | 'create')[];
  automation: readonly CapabilityAutomationSurface[];
  executionModes: readonly CapabilityExecutionMode[];
  homepage: string;
  license: string;
  maturity: ProviderMaturity;
  release: ProviderRelease;
  /** Per extension: what upstream's docs say a save through this app drops. Absent means not documented. */
  unpreserved: Readonly<Record<string, readonly FidelityRisk[]>>;
}

const ARTCRAFT_AUTOMATION = Object.freeze(['cli', 'mcp', 'json-control', 'desktop'] as const);
const BOTH_MODES = Object.freeze(['headless', 'visible'] as const);

/**
 * Every Craft app publishes the same artifact shapes: signed Windows portable zips per CPU and a
 * signed universal macOS CLI zip. Linux builds are tar.gz/AppImage/packages, which Eve does not
 * unpack, so Linux has no asset and the offer says the app is not available there yet.
 */
function craftAssets(slug: string): ProviderRelease['assets'] {
  return Object.freeze({
    'win32-x64': `${slug}-{version}-windows-x64-portable.zip`,
    'win32-arm64': `${slug}-{version}-windows-arm64-portable.zip`,
    'win32-ia32': `${slug}-{version}-windows-x86-portable.zip`,
    'darwin-x64': `${slug}-cli-{version}-macos-universal.zip`,
    'darwin-arm64': `${slug}-cli-{version}-macos-universal.zip`
  });
}

function artcraft(
  slug: string,
  displayName: string,
  domain: string,
  maturity: ProviderMaturity,
  formats: readonly string[],
  options: { mcpArgs?: readonly string[]; unpreserved?: Record<string, readonly FidelityRisk[]> } = {}
): FileCapabilityProvider {
  const mcpArgs = options.mcpArgs ?? ['mcp'];
  const unpreserved = Object.fromEntries(Object.entries(options.unpreserved ?? {}).map(([ext, risks]) => [ext, Object.freeze(risks.map((risk) => Object.freeze({ ...risk })))]));
  return Object.freeze({
    id: `artcraft.${slug}`,
    displayName,
    family: 'artcraft' as const,
    domain,
    formats: Object.freeze([...formats]),
    operations: Object.freeze(['read', 'write', 'create'] as const),
    automation: ARTCRAFT_AUTOMATION,
    executionModes: BOTH_MODES,
    homepage: `https://getartcraft.com/apps/${slug}`,
    license: 'Apache-2.0',
    maturity,
    release: Object.freeze({ repo: `storytold/${slug}`, cli: `${slug}-cli`, mcpArgs: Object.freeze([...mcpArgs]), assets: craftAssets(slug) }),
    unpreserved: Object.freeze(unpreserved)
  });
}

/** GridCraft docs/file-format-parity.md, "Not preserved" (union of its rows, 2026-10-14). */
const GRIDCRAFT_XLSX_LOSSES: readonly FidelityRisk[] = [
  { part: 'xl/slicerCaches/', feature: 'slicers' },
  { part: 'xl/slicers/', feature: 'slicers' },
  { part: 'xl/timelineCaches/', feature: 'timelines' },
  { part: 'xl/timelines/', feature: 'timelines' },
  { part: 'xl/model/', feature: 'data model' },
  { part: 'xl/queryTables/', feature: 'query tables' },
  { part: 'xl/externalLinks/', feature: 'external links' },
  { part: 'xl/embeddings/', feature: 'embedded (OLE) objects' },
  { part: 'xl/ctrlProps/', feature: 'form controls' },
  { part: 'xl/activeX/', feature: 'ActiveX controls' },
  { part: 'customXml/', feature: 'custom XML' },
  { part: 'xl/workbook.xml', marker: 'http://purl.oclc.org/ooxml/', feature: 'Strict Open XML content (nothing is kept)' }
];

/** WordCraft docs/file-format-parity.md, "Dropped on write" (2026-10-14). */
const WORDCRAFT_DOCX_LOSSES: readonly FidelityRisk[] = [
  { part: 'word/charts/', feature: 'charts' },
  { part: 'word/diagrams/', feature: 'SmartArt' },
  { part: 'word/ink/', feature: 'ink' },
  { part: 'word/embeddings/', feature: 'embedded (OLE) objects' },
  { part: 'word/document.xml', marker: '<wps:wsp', feature: 'shapes' },
  { part: 'word/document.xml', marker: '<w:txbxContent', feature: 'text boxes' },
  { part: 'word/document.xml', marker: '<wpg:wgp', feature: 'grouped drawings' },
  { part: 'word/document.xml', marker: '<m:oMath', feature: 'equations' }
];

/**
 * The whole suite, from https://getartcraft.com/apps and each app's docs/file-format-parity.md and
 * docs/mcp.md (checked 2026-10-14). Formats are the documented read-and-write ones; maturity is
 * the label on the apps page. All repositories are Apache-2.0.
 */
// Frozen, entries included: nothing at runtime can add an app or re-point its source.
export const FILE_CAPABILITY_PROVIDERS: readonly FileCapabilityProvider[] = Object.freeze([
  artcraft('photocraft', 'PhotoCraft', 'photo editing', 'early-alpha', ['psd', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'ora', 'pcraft']),
  artcraft('vectorcraft', 'VectorCraft', 'vector illustration', 'in-development', ['ai', 'vectorcraft'], { mcpArgs: ['mcp', '--headless'] }),
  artcraft('filmcraft', 'FilmCraft', 'video editing', 'in-development', ['mp4', 'm4v', 'mov', 'fcproj']),
  artcraft('lightcraft', 'LightCraft', 'photo library and RAW development', 'in-development', ['dng', 'jxl']),
  artcraft('pdfcraft', 'PdfCraft', 'PDF editing', 'early-alpha', ['pdf', 'fdf', 'xfdf']),
  artcraft('effectcraft', 'EffectCraft', 'motion graphics and compositing', 'in-development', ['ecproj', 'dpx', 'cin', 'tga']),
  artcraft('designcraft', 'DesignCraft', 'page layout and publishing', 'in-development', ['idml', 'designcraft']),
  artcraft('figcraft', 'FigCraft', 'interface design and prototyping', 'early-alpha', ['fig', 'figcraft']),
  artcraft('wordcraft', 'WordCraft', 'word processing', 'in-development', ['docx', 'docm', 'dotx', 'dotm', 'rtf', 'odt'], { unpreserved: { docx: WORDCRAFT_DOCX_LOSSES } }),
  artcraft('soundcraft', 'SoundCraft', 'audio editing and mixing', 'in-development', ['wav', 'aif', 'aiff', 'flac', 'scraft']),
  artcraft('deckcraft', 'DeckCraft', 'presentations', 'in-development', ['pptx', 'deckcraft']),
  artcraft('cadcraft', 'CADCraft', 'computer-aided design and drafting', 'in-development', ['dwg', 'dxf', 'dwt']),
  artcraft('gridcraft', 'GridCraft', 'spreadsheets and data analysis', 'in-development', ['xlsx', 'xlsm', 'csv', 'tsv'], { unpreserved: { xlsx: GRIDCRAFT_XLSX_LOSSES, xlsm: GRIDCRAFT_XLSX_LOSSES } })
]);

export function capabilityProvidersForFormat(format: string): FileCapabilityProvider[] {
  const normalized = format.toLowerCase().replace(/^\./, '');
  return FILE_CAPABILITY_PROVIDERS.filter((provider) => provider.formats.includes(normalized));
}

export function fileCapabilityProvider(id: string): FileCapabilityProvider | null {
  return FILE_CAPABILITY_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export function currentProviderPlatform(platform: string = process.platform, arch: string = process.arch): ProviderPlatform | null {
  const key = `${platform}-${arch}`;
  return PLATFORMS.find((candidate) => candidate === key) ?? null;
}

/** The asset-name template for this machine, or null when the app publishes nothing Eve can use here. */
export function providerAssetTemplate(provider: FileCapabilityProvider, platform: ProviderPlatform | null = currentProviderPlatform()): string | null {
  return platform ? provider.release.assets[platform] ?? null : null;
}

export function maturityOffered(maturity: ProviderMaturity, preview: boolean, threshold: ProviderMaturity = OFFER_MATURITY_THRESHOLD): boolean {
  if (maturity === 'unreleased') return false;
  return preview || PROVIDER_MATURITY.indexOf(maturity) >= PROVIDER_MATURITY.indexOf(threshold);
}
