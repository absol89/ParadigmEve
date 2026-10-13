/**
 * Stable capability inventory for external file/creative handlers.
 *
 * This is intentionally broader than Office formats. ArtCraft is a suite of independently
 * installable tools, so Eve should acquire only the handler a task needs instead of treating
 * one spreadsheet provider as the architecture. Exact download version/hash data belongs in
 * the curated installer registry before any entry becomes auto-installable.
 */
export type CapabilityExecutionMode = 'headless' | 'visible';
export type CapabilityAutomationSurface = 'cli' | 'mcp' | 'json-control' | 'desktop';

export interface FileCapabilityProvider {
  id: string;
  displayName: string;
  family: 'artcraft';
  domain: string;
  formats: readonly string[];
  operations: readonly ('read' | 'write' | 'create')[];
  automation: readonly CapabilityAutomationSurface[];
  executionModes: readonly CapabilityExecutionMode[];
  install: {
    granularity: 'standalone-app-or-cli';
    autoInstallEligible: boolean;
    reason: string;
  };
}

const ARTCRAFT_AUTOMATION = ['cli', 'mcp', 'json-control', 'desktop'] as const;
const BOTH_MODES = ['headless', 'visible'] as const;

function artcraft(
  id: string,
  displayName: string,
  domain: string,
  formats: readonly string[],
  operations: FileCapabilityProvider['operations'] = ['read', 'write', 'create']
): FileCapabilityProvider {
  return {
    id,
    displayName,
    family: 'artcraft',
    domain,
    formats,
    operations,
    automation: ARTCRAFT_AUTOMATION,
    executionModes: BOTH_MODES,
    install: {
      granularity: 'standalone-app-or-cli',
      autoInstallEligible: false,
      reason: 'Exact platform artifact, version, source and hash have not yet been curated into ParadigmEve.'
    }
  };
}

/**
 * Whole-suite inventory. A provider being listed here does not mean ParadigmEve may install it:
 * auto-install stays false until its exact artifact metadata is separately vetted.
 */
export const FILE_CAPABILITY_PROVIDERS: readonly FileCapabilityProvider[] = [
  artcraft('artcraft.photocraft', 'PhotoCraft', 'raster image editing', []),
  artcraft('artcraft.vectorcraft', 'VectorCraft', 'vector illustration', []),
  artcraft('artcraft.filmcraft', 'FilmCraft', 'video editing', []),
  artcraft('artcraft.lightcraft', 'LightCraft', 'photo library and RAW development', []),
  artcraft('artcraft.pdfcraft', 'PdfCraft', 'PDF editing and organization', ['pdf']),
  artcraft('artcraft.effectcraft', 'EffectCraft', 'motion graphics and visual effects', []),
  artcraft('artcraft.designcraft', 'DesignCraft', 'page layout and publishing', []),
  artcraft('artcraft.figcraft', 'FigCraft', 'interface design and prototyping', []),
  artcraft('artcraft.wordcraft', 'WordCraft', 'word processing', ['docx']),
  artcraft('artcraft.soundcraft', 'SoundCraft', 'audio editing and mixing', []),
  artcraft('artcraft.deckcraft', 'DeckCraft', 'presentations and slide shows', ['pptx']),
  artcraft('artcraft.cadcraft', 'CADCraft', 'computer-aided design and drafting', []),
  artcraft('artcraft.gridcraft', 'GridCraft', 'spreadsheets and data analysis', ['xlsx', 'csv'])
] as const;

export function capabilityProvidersForFormat(format: string): FileCapabilityProvider[] {
  const normalized = format.toLowerCase().replace(/^\./, '');
  return FILE_CAPABILITY_PROVIDERS.filter((provider) => provider.formats.includes(normalized));
}

/**
 * User intent decides whether automation should stay headless or be demonstrated visibly.
 * Provider choice comes afterwards; this policy must not be tied to ChatGPT/Ollama/OpenRouter.
 */
export function executionModeForIntent(intent: 'just-do-it' | 'teach-me' | 'watch-me'): CapabilityExecutionMode {
  return intent === 'just-do-it' ? 'headless' : 'visible';
}
