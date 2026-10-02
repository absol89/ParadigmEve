import type { PetLibraryState, PetRecord } from '../shared/pets.js';
import type { PetController } from './pet.js';
import { $, el, run, toast } from './dom.js';
import { currentLanguage, t, ui } from './i18n.js';

/**
 * What the user pastes into an Eve chat to have her make a pet or an avatar of herself. The full
 * production contract is the packaged Vault page, so this stays short and never drifts from it.
 */
const PET_PROMPT = `Eve, please make me a desktop pet for ParadigmEve: <describe the character, or say "an avatar of you">.

Follow the Vault page 15-desktop-pets-and-avatars.md exactly: one consistent character across all 96 frames, the 1280×1920 atlas with 8 columns of 160px cells, animations.json with every clip and the hand anchors for frames 69–84, and a pet.json. Check it with the page's acceptance checks, then save the three files in one folder and tell me its path so I can import it on the Pets page.`;

function button(label: string | (() => string), work: () => void | Promise<void>): HTMLButtonElement {
  const node = el('button', 'btn', label) as HTMLButtonElement;
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await work(); } catch (error) { toast(error instanceof Error ? error.message : t('Avatar operation failed')); }
    finally { if (node.isConnected) node.disabled = false; }
  });
  return node;
}

/** The description in the app language when the package ships one, else the package's own. */
function petDescription(pet: PetRecord): string {
  return pet.descriptions?.[currentLanguage()] ?? pet.description;
}

function preview(pet: PetRecord): HTMLElement {
  const shell = el('div', 'pet-library-preview');
  const frame = el('span', 'pet-library-preview-frame');
  if (pet.previewDataUrl) frame.style.backgroundImage = `url("${pet.previewDataUrl}")`;
  void window.api.petsAsset(pet.id, true).then(reply => {
    if (!frame.isConnected || !reply.ok) return;
    frame.style.backgroundImage = `url("${reply.data.atlasDataUrl}")`;
    frame.classList.add('is-animated');
  });
  shell.append(frame);
  return shell;
}

function renameDialog(pet: PetRecord, save: (name: string) => Promise<boolean>): void {
  document.querySelector('#petRenameDialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'petRenameDialog';
  dialog.className = 'plugin-dialog pet-delete-dialog';
  const head = el('div', 'plugin-dialog-head');
  const title = el('h2', '', () => t('Rename {0}', [pet.displayName]));
  title.id = 'petRenameTitle';
  dialog.setAttribute('aria-labelledby', title.id);
  head.append(title, button(() => t('Close'), () => dialog.close()));
  const body = el('div', 'plugin-dialog-body');
  const field = el('label', 'plugin-field');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 100;
  input.value = pet.displayName;
  input.autocomplete = 'off';
  input.spellcheck = false;
  field.append(el('span', '', () => t('Name')), input);
  body.append(field, el('p', 'muted', () => t('Only the name shown in ParadigmEve changes. The avatar’s folder and files stay as they are.')));
  const actions = el('div', 'pet-delete-actions');
  const apply = async (name: string): Promise<void> => { if (await save(name)) dialog.close(); };
  const cancel = button(() => t('Cancel'), () => dialog.close());
  const confirm = button(() => t('Save'), () => apply(input.value));
  const originalName = pet.originalName;
  if (originalName) actions.append(button(() => t('Reset to {0}', [originalName]), () => apply('')));
  actions.append(cancel, confirm);
  input.addEventListener('input', () => { confirm.disabled = !input.value.trim(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && input.value.trim()) { event.preventDefault(); confirm.click(); }
  });
  body.append(actions);
  dialog.append(head, body);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  input.select();
}

function confirmDelete(pet: PetRecord, remove: () => Promise<boolean>): void {
  document.querySelector('#petDeleteDialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'petDeleteDialog';
  dialog.className = 'plugin-dialog pet-delete-dialog';
  const head = el('div', 'plugin-dialog-head');
  const title = el('h2', '', () => t('Delete {0}?', [pet.displayName]));
  title.id = 'petDeleteTitle';
  dialog.setAttribute('aria-labelledby', title.id);
  head.append(title, button(() => t('Close'), () => dialog.close()));
  const body = el('div', 'plugin-dialog-body');
  body.append(el('p', '', () => t('This removes the avatar from your local library. You can import it again later.')));
  const actions = el('div', 'pet-delete-actions');
  const cancel = button(() => t('Cancel'), () => dialog.close());
  const confirm = button(() => t('Delete avatar'), async () => { if (await remove()) dialog.close(); });
  confirm.classList.add('plugin-destructive');
  actions.append(cancel, confirm);
  body.append(actions);
  dialog.append(head, body);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
}

export function initPets(runtime: PetController): void {
  let state: PetLibraryState = { pets: [] };
  let epoch = 0;

  $('petsPrompt').textContent = PET_PROMPT;

  const apply = (next: PetLibraryState): void => { state = next; runtime.applyLibraryState(next); render(); };
  const mutate = async (request: ReturnType<typeof window.api.petsList>): Promise<boolean> => {
    const own = ++epoch;
    const next = await run(request);
    if (!next || own !== epoch) return false;
    apply(next);
    return true;
  };

  const renderCard = (pet: PetRecord): HTMLElement => {
    const card = el('article', 'plugin-card pet-library-card');
    card.dataset.petId = pet.id;
    const entry = el('div', 'plugin-entry pet-library-entry');
    const title = el('div', 'plugin-card-title');
    title.append(el('h2', '', pet.displayName), el('p', 'muted', () => petDescription(pet)));
    const foot = el('div', 'plugin-card-foot');
    foot.append(el('span', `pill${pet.enabled ? ' is-live' : ''}`, () => t(pet.enabled ? 'Active' : 'Inactive')));
    if (pet.bundled) foot.append(el('span', 'muted', () => t('Bundled')));
    const originalName = pet.originalName;
    if (originalName) foot.append(el('span', 'muted', () => t('Original name: {0}', [originalName])));
    title.append(foot);
    entry.append(preview(pet), title);

    const favorite = document.createElement('button');
    favorite.type = 'button';
    favorite.className = 'pet-favorite';
    favorite.textContent = pet.favorite ? '★' : '☆';
    favorite.setAttribute('aria-pressed', String(pet.favorite));
    ui(favorite, 'aria-label', () => t(pet.favorite ? 'Remove {0} from favorites' : 'Favorite {0}', [pet.displayName]));
    favorite.addEventListener('click', () => void mutate(window.api.petsSetFavorite(pet.id, !pet.favorite)));

    const menu = document.createElement('details');
    menu.className = 'plugin-menu';
    const summary = el('summary', '', '•••');
    ui(summary, 'aria-label', () => t('Actions for {0}', [pet.displayName]));
    const actions = el('div', 'plugin-menu-actions');
    actions.append(button(() => t(pet.enabled ? 'Disable' : 'Enable'), async () => { await mutate(window.api.petsSetEnabled(pet.id, !pet.enabled)); }));
    actions.append(button(() => t('Rename'), () => renameDialog(pet, async name => {
      const saved = await mutate(window.api.petsRename(pet.id, name));
      if (saved) toast(t(name.trim() ? 'Avatar renamed' : 'Avatar name reset'));
      return saved;
    })));
    if (!pet.bundled) {
      const remove = button(() => t('Delete'), () => confirmDelete(pet, () => mutate(window.api.petsDelete(pet.id))));
      remove.classList.add('plugin-destructive');
      actions.append(remove);
    }
    menu.append(summary, actions);
    card.append(entry, favorite, menu);
    return card;
  };

  const render = (): void => {
    const favoritesList = $('petsFavorites');
    const libraryList = $('petsInstalled');
    favoritesList.replaceChildren();
    libraryList.replaceChildren();
    const query = $<HTMLInputElement>('petsSearch').value.trim().toLowerCase();
    const visible = state.pets.filter(pet => `${pet.displayName} ${pet.originalName ?? ''} ${petDescription(pet)} ${pet.description}`.toLowerCase().includes(query));
    const favorites = visible.filter(pet => pet.favorite);
    const library = visible.filter(pet => !pet.favorite);
    const libraryCount = state.pets.filter(pet => !pet.favorite).length;
    const favoriteCount = state.pets.length - libraryCount;
    ui($('petsCount'), 'textContent', () => t(libraryCount === 1 ? '{0} avatar' : '{0} avatars', [libraryCount]));
    $('petsFavoritesSection').hidden = favorites.length === 0;
    ui($('petsFavoritesCount'), 'textContent', () => t(favoriteCount === 1 ? '{0} avatar' : '{0} avatars', [favoriteCount]));
    for (const pet of favorites) favoritesList.append(renderCard(pet));
    for (const pet of library) libraryList.append(renderCard(pet));
    if (!library.length && visible.length) libraryList.append(el('p', 'plugin-no-results muted', () => t('All matching avatars are in Favorites.')));
    if (!visible.length) libraryList.append(el('p', 'plugin-no-results muted', () => t('No avatars match your search.')));
  };

  $('petsSearch').addEventListener('input', render);
  const guide = $<HTMLDialogElement>('petFormatDialog');
  $('petsFormatGuide').addEventListener('click', () => guide.showModal());
  $('petsFormatClose').addEventListener('click', () => guide.close());
  $('petsCopyPrompt').addEventListener('click', () => void (async () => {
    if (await run(window.api.writeClipboard(PET_PROMPT))) toast(t('Prompt for Eve copied'));
  })());
  $('petsImport').addEventListener('click', () => void (async () => {
    const next = await run(window.api.petsImport());
    if (next) apply(next);
  })());
  void (async () => {
    const next = await run(window.api.petsList());
    if (next) apply(next);
  })();
}
