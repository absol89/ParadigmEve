import type { PetLibraryState, PetOverlayControlState } from '../shared/pets.js';

export interface PetController {
  toggle(): void;
  isVisible(): boolean;
  refresh(): Promise<void>;
  applyLibraryState(state: PetLibraryState): void;
  onChange(listener: () => void): void;
}

/** Thin main-window controller. All visual/runtime work lives in the native desktop overlay. */
export function initPet(openLibrary: () => void): PetController {
  let library: PetLibraryState = { pets: [] };
  let overlay: PetOverlayControlState = { visible: false, ready: true, activeCount: 0, activityCount: 0 };
  const listeners = new Set<() => void>();
  const changed = (): void => { for (const listener of listeners) listener(); };

  const activeCount = (): number => library.pets.filter(pet => pet.enabled).length;
  const applyLibraryState = (next: PetLibraryState): void => { library = next; changed(); };
  const applyOverlayState = (next: PetOverlayControlState | null | undefined): void => { if (!next) return; overlay = next; changed(); };
  window.api.onPetOverlayStateChanged(applyOverlayState);

  const refresh = async (): Promise<void> => {
    const [libraryReply, overlayReply] = await Promise.all([window.api.petsList(), window.api.petsOverlayState()]);
    if (libraryReply.ok && Array.isArray(libraryReply.data?.pets)) applyLibraryState(libraryReply.data);
    if (overlayReply.ok && overlayReply.data) applyOverlayState(overlayReply.data);
  };

  const toggle = (): void => {
    if (!activeCount()) { openLibrary(); return; }
    const wanted = !overlay.visible;
    applyOverlayState({ ...overlay, visible: wanted, ready: wanted ? overlay.ready : true });
    void window.api.petsSetOverlayVisible(wanted).then(reply => { if (reply?.ok) applyOverlayState(reply.data); });
  };

  void refresh();
  return {
    toggle,
    isVisible: () => overlay.visible && activeCount() > 0,
    refresh,
    applyLibraryState,
    onChange: listener => { listeners.add(listener); }
  };
}
