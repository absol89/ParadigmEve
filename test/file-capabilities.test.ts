import { describe, expect, it } from 'vitest';
import {
  FILE_CAPABILITY_PROVIDERS,
  type FileCapabilityProvider,
  capabilityProvidersForFormat,
  executionModeForIntent
} from '../src/main/file-capabilities.js';

describe('file capability registry', () => {
  it('covers the whole ArtCraft suite without making any unvetted app auto-installable', () => {
    expect(FILE_CAPABILITY_PROVIDERS.map((provider) => provider.displayName)).toEqual([
      'PhotoCraft', 'VectorCraft', 'FilmCraft', 'LightCraft', 'PdfCraft', 'EffectCraft', 'DesignCraft',
      'FigCraft', 'WordCraft', 'SoundCraft', 'DeckCraft', 'CADCraft', 'GridCraft'
    ]);
    expect(FILE_CAPABILITY_PROVIDERS).toHaveLength(13);
    expect(FILE_CAPABILITY_PROVIDERS.every((provider) => provider.install.autoInstallEligible === false)).toBe(true);
    expect(capabilityProvidersForFormat('.xlsx').map((provider) => provider.id)).toEqual(['artcraft.gridcraft']);
    expect(capabilityProvidersForFormat('docx').map((provider) => provider.id)).toEqual(['artcraft.wordcraft']);
    expect(capabilityProvidersForFormat('pptx').map((provider) => provider.id)).toEqual(['artcraft.deckcraft']);
    expect(capabilityProvidersForFormat('pdf').map((provider) => provider.id)).toContain('artcraft.pdfcraft');
  });

  it('cannot be mutated into an installable provider at runtime', () => {
    const gridcraft = FILE_CAPABILITY_PROVIDERS.find((provider) => provider.id === 'artcraft.gridcraft')!;
    expect(() => { (gridcraft.install as { autoInstallEligible: boolean }).autoInstallEligible = true; }).toThrow(TypeError);
    expect(() => { (FILE_CAPABILITY_PROVIDERS as FileCapabilityProvider[]).push(gridcraft); }).toThrow(TypeError);
    expect(gridcraft.install.autoInstallEligible).toBe(false);
  });

  it('keeps autonomous work headless and teaching/watch workflows visible', () => {
    expect(executionModeForIntent('just-do-it')).toBe('headless');
    expect(executionModeForIntent('teach-me')).toBe('visible');
    expect(executionModeForIntent('watch-me')).toBe('visible');
  });
});
