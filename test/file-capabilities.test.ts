import { describe, expect, it } from 'vitest';
import {
  FILE_CAPABILITY_PROVIDERS,
  capabilityProvidersForFormat,
  currentProviderPlatform,
  maturityOffered,
  providerAssetTemplate,
  type FileCapabilityProvider
} from '../src/main/file-capabilities.js';

describe('file capability registry', () => {
  it('covers the whole ArtCraft suite from its official repositories', () => {
    expect(FILE_CAPABILITY_PROVIDERS.map((provider) => provider.displayName)).toEqual([
      'PhotoCraft', 'VectorCraft', 'FilmCraft', 'LightCraft', 'PdfCraft', 'EffectCraft', 'DesignCraft',
      'FigCraft', 'WordCraft', 'SoundCraft', 'DeckCraft', 'CADCraft', 'GridCraft'
    ]);
    for (const provider of FILE_CAPABILITY_PROVIDERS) {
      const slug = provider.id.replace('artcraft.', '');
      expect(provider.release.repo).toBe(`storytold/${slug}`);
      expect(provider.release.cli).toBe(`${slug}-cli`);
      expect(provider.release.mcpArgs[0]).toBe('mcp');
      expect(provider.license).toBe('Apache-2.0');
      expect(provider.formats.length).toBeGreaterThan(0);
    }
    expect(capabilityProvidersForFormat('.xlsx').map((provider) => provider.id)).toEqual(['artcraft.gridcraft']);
    expect(capabilityProvidersForFormat('docx').map((provider) => provider.id)).toEqual(['artcraft.wordcraft']);
    expect(capabilityProvidersForFormat('pptx').map((provider) => provider.id)).toEqual(['artcraft.deckcraft']);
    expect(capabilityProvidersForFormat('pdf').map((provider) => provider.id)).toEqual(['artcraft.pdfcraft']);
  });

  it('cannot be mutated at runtime: no new entry and no re-pointed source', () => {
    const gridcraft = FILE_CAPABILITY_PROVIDERS.find((provider) => provider.id === 'artcraft.gridcraft')!;
    expect(() => { (FILE_CAPABILITY_PROVIDERS as FileCapabilityProvider[]).push(gridcraft); }).toThrow(TypeError);
    expect(() => { (gridcraft.release as { repo: string }).repo = 'attacker/gridcraft'; }).toThrow(TypeError);
    expect(() => { (gridcraft.release.assets as Record<string, string>)['win32-x64'] = 'other.zip'; }).toThrow(TypeError);
    expect(() => { (gridcraft.formats as string[]).push('exe'); }).toThrow(TypeError);
  });

  it('selects only the build for this machine; Linux and unknown machines have none', () => {
    const gridcraft = FILE_CAPABILITY_PROVIDERS.find((provider) => provider.id === 'artcraft.gridcraft')!;
    expect(currentProviderPlatform('win32', 'x64')).toBe('win32-x64');
    expect(currentProviderPlatform('freebsd', 'x64')).toBeNull();
    expect(providerAssetTemplate(gridcraft, 'win32-x64')).toBe('gridcraft-{version}-windows-x64-portable.zip');
    expect(providerAssetTemplate(gridcraft, 'win32-ia32')).toBe('gridcraft-{version}-windows-x86-portable.zip');
    expect(providerAssetTemplate(gridcraft, 'darwin-arm64')).toBe('gridcraft-cli-{version}-macos-universal.zip');
    expect(providerAssetTemplate(gridcraft, 'linux-x64')).toBeNull();
    expect(providerAssetTemplate(gridcraft, null)).toBeNull();
  });

  it('offers every released maturity by default and never an unreleased app', () => {
    expect(maturityOffered('in-development', false)).toBe(true);
    expect(maturityOffered('early-alpha', false)).toBe(true);
    expect(maturityOffered('unreleased', true)).toBe(false);
    expect(maturityOffered('in-development', false, 'beta')).toBe(false);
    expect(maturityOffered('in-development', true, 'beta')).toBe(true);
  });
});
