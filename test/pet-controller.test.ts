import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PetLibraryState, PetOverlayControlState } from '../src/shared/pets.js';

// Ported from Chat On Steroids 2.1.20: the main window only lists and toggles pets; the overlay does the rest.
let dom: JSDOM;
const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
const hammy = (enabled: boolean): PetLibraryState => ({ pets: [{ id: 'hammy', displayName: 'Hammy', description: '', bundled: true, enabled, favorite: false }] });
beforeEach(() => {
  dom = new JSDOM('<body></body>', { url: 'https://pet-controller.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it('keeps the main renderer as a thin overlay controller', async () => {
  let state: PetOverlayControlState = { visible: true, ready: true, activeCount: 1, activityCount: 2 };
  let onState: ((next: PetOverlayControlState) => void) | null = null;
  const openLibrary = vi.fn();
  const setVisible = vi.fn((visible: boolean) => { state = { ...state, visible }; return ok(state); });
  (dom.window as any).api = {
    petsList: () => ok(hammy(true)), petsOverlayState: () => ok(state), petsSetOverlayVisible: setVisible,
    onPetOverlayStateChanged: (listener: (next: PetOverlayControlState) => void) => { onState = listener; return vi.fn(); }
  };
  const { initPet } = await import('../src/renderer/pet.js');
  const controller = initPet(openLibrary);
  await controller.refresh();
  const changed = vi.fn();
  controller.onChange(changed);
  expect(controller.isVisible()).toBe(true);
  expect(dom.window.document.querySelector('.pet-layer, .pet-shell')).toBeNull();
  controller.toggle();
  expect(setVisible).toHaveBeenCalledWith(false);
  onState!({ ...state, visible: true });
  expect(controller.isVisible()).toBe(true);
  expect(changed).toHaveBeenCalled();
});

it('opens the library when no pet is enabled', async () => {
  const openLibrary = vi.fn(), setVisible = vi.fn();
  (dom.window as any).api = { petsList: () => ok(hammy(false)), petsOverlayState: () => ok({ visible: false, ready: true, activeCount: 0, activityCount: 0 }), petsSetOverlayVisible: setVisible, onPetOverlayStateChanged: () => vi.fn() };
  const { initPet } = await import('../src/renderer/pet.js');
  const controller = initPet(openLibrary);
  await controller.refresh();
  controller.toggle();
  expect(openLibrary).toHaveBeenCalledTimes(1);
  expect(setVisible).not.toHaveBeenCalled();
});

it('restores a temporarily hidden active pet through the View toggle', async () => {
  let state: PetOverlayControlState = { visible: false, ready: true, activeCount: 1, activityCount: 0 };
  const openLibrary = vi.fn();
  const setVisible = vi.fn((visible: boolean) => { state = { ...state, visible }; return ok(state); });
  (dom.window as any).api = { petsList: () => ok(hammy(true)), petsOverlayState: () => ok(state), petsSetOverlayVisible: setVisible, onPetOverlayStateChanged: () => vi.fn() };
  const { initPet } = await import('../src/renderer/pet.js');
  const controller = initPet(openLibrary);
  await controller.refresh();
  expect(controller.isVisible()).toBe(false);
  controller.toggle();
  expect(setVisible).toHaveBeenCalledWith(true);
  expect(openLibrary).not.toHaveBeenCalled();
});

it('keeps Pets as a settings page and Desktop Pets in the View menu', () => {
  const page = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'));
  expect(page.window.document.querySelector('button[data-tab="pets"]')).not.toBeNull();
  expect(page.window.document.querySelector('section[data-panel="pets"] #petsImport')).not.toBeNull();
  expect(page.window.document.querySelector('#viewMenu #viewPets')).not.toBeNull();
  page.window.close();
});
