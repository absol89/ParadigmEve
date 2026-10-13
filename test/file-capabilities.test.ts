import { describe, expect, it } from 'vitest';
import {
  FILE_CAPABILITY_PROVIDERS,
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

  it('keeps autonomous work headless and teaching/watch workflows visible', () => {
    expect(executionModeForIntent('just-do-it')).toBe('headless');
    expect(executionModeForIntent('teach-me')).toBe('visible');
    expect(executionModeForIntent('watch-me')).toBe('visible');
  });
});
