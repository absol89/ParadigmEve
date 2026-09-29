import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { PetLibraryState } from '../src/shared/pets.js';
import authoredManifest from './fixtures/pet-animations.json';

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; vi.unstubAllGlobals(); vi.resetModules(); });

const initial: PetLibraryState = { pets: [
  { id: 'hammy', displayName: 'Hammy', description: 'Bundled friend', bundled: true, enabled: true, favorite: false },
  { id: 'willow', displayName: 'Willow', description: 'Forest friend', enabled: false, favorite: false, previewDataUrl: 'data:image/png;base64,c3RpbGw=' }
] };

// Ported from Chat On Steroids 2.1.20 and adapted to ParadigmEve: the page hands users a short
// prompt for Eve instead of an embedded production brief, which lives in the packaged Vault.
it('renders the library and wires import, multi-enable, favorite, delete, preview and the Eve prompt', async () => {
  dom = new JSDOM(`<!doctype html><body>
    <input id="petsSearch"><button id="petsImport"></button><button id="petsFormatGuide"></button>
    <dialog id="petFormatDialog"><button id="petsFormatClose"></button><button id="petsCopyPrompt"></button><pre id="petsPrompt"></pre></dialog>
    <span id="petsCount"></span>
    <section id="petsFavoritesSection" hidden><span id="petsFavoritesCount"></span><div id="petsFavorites"></div></section>
    <div id="petsInstalled"></div>
  </body>`, { url: 'https://pets.test/' });
  const w = dom.window;
  for (const [key, value] of Object.entries({ window: w, document: w.document, HTMLElement: w.HTMLElement, HTMLButtonElement: w.HTMLButtonElement, HTMLDialogElement: w.HTMLDialogElement, HTMLInputElement: w.HTMLInputElement })) vi.stubGlobal(key, value);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };

  let state = structuredClone(initial);
  const petsSetFavorite = vi.fn(async (id: string, favorite: boolean) => {
    state = { pets: state.pets.map(pet => pet.id === id ? { ...pet, favorite } : pet) }; return { ok: true as const, data: state };
  });
  const petsSetEnabled = vi.fn(async (id: string, enabled: boolean) => {
    state = { pets: state.pets.map(pet => pet.id === id ? { ...pet, enabled } : pet) }; return { ok: true as const, data: state };
  });
  const petsDelete = vi.fn(async (id: string) => {
    state = { pets: state.pets.filter(pet => pet.id !== id) }; return { ok: true as const, data: state };
  });
  const petsImport = vi.fn(async () => ({ ok: true as const, data: state }));
  const petsAsset = vi.fn(async (id: string) => ({ ok: true as const, data: { id, atlasDataUrl: 'data:image/png;base64,YXRsYXM=', manifest: authoredManifest } }));
  const writeClipboard = vi.fn(async (_text: string) => ({ ok: true as const, data: true }));
  (w as any).api = { petsList: () => Promise.resolve({ ok: true as const, data: state }), petsSetFavorite, petsSetEnabled, petsDelete, petsImport, petsAsset, writeClipboard };
  const runtime = { applyLibraryState: vi.fn() } as any;
  const { initPets } = await import('../src/renderer/pets.js');
  initPets(runtime);

  await vi.waitFor(() => expect(w.document.querySelectorAll('.pet-library-card')).toHaveLength(2));
  expect(w.document.getElementById('petsCount')!.textContent).toContain('2 pets');
  // A bundled pet can be turned off but never deleted.
  expect(w.document.querySelector('[data-pet-id="hammy"] .plugin-destructive')).toBeNull();

  (w.document.getElementById('petsFormatGuide') as HTMLButtonElement).click();
  expect((w.document.getElementById('petFormatDialog') as HTMLDialogElement).open).toBe(true);
  (w.document.getElementById('petsFormatClose') as HTMLButtonElement).click();
  expect((w.document.getElementById('petFormatDialog') as HTMLDialogElement).open).toBe(false);
  const prompt = w.document.getElementById('petsPrompt')!.textContent!;
  expect(prompt).toContain('15-desktop-pets-and-avatars.md');
  expect(prompt).toContain('an avatar of you');
  expect(prompt).toContain('hand anchors for frames 69–84');
  expect(prompt).not.toMatch(/OpenAI|Anthropic|ClosedAI|hatch-pet/);

  await vi.waitFor(() => expect(w.document.querySelector('[data-pet-id="willow"] .pet-library-preview-frame')!.classList.contains('is-animated')).toBe(true));
  expect(petsAsset).toHaveBeenCalledWith('willow', true);

  (w.document.getElementById('petsSearch') as HTMLInputElement).value = 'forest';
  w.document.getElementById('petsSearch')!.dispatchEvent(new w.Event('input'));
  expect(w.document.querySelectorAll('.pet-library-card')).toHaveLength(1);
  (w.document.getElementById('petsSearch') as HTMLInputElement).value = '';
  w.document.getElementById('petsSearch')!.dispatchEvent(new w.Event('input'));

  (w.document.querySelector('[data-pet-id="willow"] .pet-favorite') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(petsSetFavorite).toHaveBeenCalledWith('willow', true));
  await vi.waitFor(() => expect(runtime.applyLibraryState).toHaveBeenCalledWith(expect.objectContaining({ pets: expect.arrayContaining([expect.objectContaining({ id: 'willow', favorite: true })]) })));
  await vi.waitFor(() => expect(w.document.getElementById('petsFavoritesSection')!.hasAttribute('hidden')).toBe(false));
  expect(w.document.querySelectorAll('#petsFavorites [data-pet-id="willow"]')).toHaveLength(1);
  expect(w.document.querySelectorAll('#petsInstalled [data-pet-id="willow"]')).toHaveLength(0);

  (w.document.querySelector('[data-pet-id="willow"] .plugin-menu-actions .btn') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(petsSetEnabled).toHaveBeenCalledWith('willow', true));
  expect(state.pets.filter(pet => pet.enabled)).toHaveLength(2);

  (w.document.querySelector('[data-pet-id="willow"] .plugin-destructive') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(w.document.getElementById('petDeleteDialog')).not.toBeNull());
  const cancel = w.document.querySelector<HTMLButtonElement>('#petDeleteDialog .pet-delete-actions .btn')!;
  expect(w.document.activeElement).toBe(cancel);
  cancel.click();
  await vi.waitFor(() => expect(w.document.getElementById('petDeleteDialog')).toBeNull());
  expect(petsDelete).not.toHaveBeenCalled();

  (w.document.querySelector('[data-pet-id="willow"] .plugin-destructive') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(w.document.getElementById('petDeleteDialog')).not.toBeNull());
  (w.document.querySelector('#petDeleteDialog .plugin-destructive') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(petsDelete).toHaveBeenCalledWith('willow'));
  await vi.waitFor(() => expect(w.document.getElementById('petDeleteDialog')).toBeNull());

  (w.document.getElementById('petsImport') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(petsImport).toHaveBeenCalledTimes(1));

  (w.document.getElementById('petsCopyPrompt') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(writeClipboard).toHaveBeenCalledTimes(1));
  expect(writeClipboard.mock.calls[0]![0]).toBe(prompt);
});
