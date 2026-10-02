/**
 * The desktop pet library (ported from Chat On Steroids 2.1.20). Bundled pets ship read-only in
 * resources/pets; imported pets are copied into userData/pets after validation. A package is
 * exactly pet.json + atlas.png + animations.json: the PNG is size- and dimension-checked, and both
 * JSON files are parsed against the fixed frame contract and re-serialized, so nothing executable
 * ever enters the library.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage } from 'electron';
import { readDurable, writeDurableSoon } from './durable.js';
import {
  COS_PET_ANIMATION_NAMES,
  COS_PET_ATLAS,
  COS_PET_FRAME_LAYOUT,
  COS_PET_LOOPING,
  type PetAnimationManifest,
  type PetAnimationName,
  type PetLibraryState,
  type PetRecord,
  type PetRuntimeAsset
} from '../shared/pets.js';

export const PET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATE_KEY = 'pet-library';
const STATE_VERSION = 1;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ATLAS_BYTES = 12 * 1024 * 1024;
const MAX_PACKAGES = 100;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_DESCRIPTION_LANGUAGES = 8;
const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const DEFAULT_ENABLED_BUNDLED_PETS = ['luna'];
const DEFAULT_FAVORITE_BUNDLED_PETS = ['cat', 'dog'];

interface StoredPetLibraryState {
  version: 1;
  enabled: string[];
  favorites: string[];
  /** User-chosen display names by pet id. They never touch the package folder or its pet.json. */
  names: Record<string, string>;
}

interface InspectedPet {
  record: Omit<PetRecord, 'enabled' | 'favorite'>;
  atlas: string;
  manifest: PetAnimationManifest;
}

let directory = '';
let stored: StoredPetLibraryState = { version: STATE_VERSION, enabled: [], favorites: [], names: {} };
const listeners = new Set<(state: PetLibraryState) => void>();

/** Read-only pet packages that ship with the app (resources/pets/<id>). */
let bundledDirectory: string | null = null;

function validPreferenceIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && PET_ID_PATTERN.test(value)))];
}

function validNames(values: unknown): Record<string, string> {
  const names: Record<string, string> = {};
  const source = object(values);
  if (!source) return names;
  for (const [id, name] of Object.entries(source)) {
    if (!PET_ID_PATTERN.test(id) || typeof name !== 'string') continue;
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (trimmed) names[id] = trimmed;
  }
  return names;
}

/** Optional per-language descriptions. Anything malformed is ignored rather than rejecting the pet. */
function parseDescriptions(value: unknown): Record<string, string> | undefined {
  const source = object(value);
  if (!source) return undefined;
  const descriptions: Record<string, string> = {};
  for (const [language, text] of Object.entries(source).slice(0, MAX_DESCRIPTION_LANGUAGES)) {
    if (!LANGUAGE_TAG_PATTERN.test(language) || typeof text !== 'string') continue;
    const trimmed = text.trim().slice(0, MAX_DESCRIPTION_LENGTH);
    if (trimmed) descriptions[language] = trimmed;
  }
  return Object.keys(descriptions).length ? descriptions : undefined;
}

function defaultBundledPreferences(ids: readonly string[]): string[] {
  const bundled = new Set(bundledIds());
  return ids.filter(id => bundled.has(id));
}

function restoredPreferenceIds(values: unknown): string[] {
  const ids = validPreferenceIds(values);
  // `eve` was the temporary bundled id before the companion was named Luna. Preserve an
  // existing user's choice across that package rename without reviving the obsolete id.
  if (ids.includes('eve') && isBundled('luna') && !isBundled('eve')) {
    return [...new Set(ids.map(id => id === 'eve' ? 'luna' : id))];
  }
  return ids;
}

function persist(): void {
  writeDurableSoon(STATE_KEY, stored);
}

function bundledIds(): string[] {
  if (!bundledDirectory) return [];
  try {
    return fs.readdirSync(bundledDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && PET_ID_PATTERN.test(entry.name))
      .map(entry => entry.name).slice(0, MAX_PACKAGES);
  } catch { return []; }
}

function isBundled(id: string): boolean { return bundledIds().includes(id); }

export async function initPetLibrary(userData: string, bundled: string | null = null): Promise<void> {
  bundledDirectory = bundled;
  directory = path.join(userData, 'pets');
  fs.mkdirSync(directory, { recursive: true });
  const restored = await readDurable<Partial<StoredPetLibraryState>>(STATE_KEY);
  if (restored?.version === STATE_VERSION) {
    stored = {
      version: STATE_VERSION,
      enabled: restoredPreferenceIds(restored.enabled),
      favorites: restoredPreferenceIds(restored.favorites),
      names: validNames(restored.names)
    };
  } else {
    stored = {
      version: STATE_VERSION,
      enabled: defaultBundledPreferences(DEFAULT_ENABLED_BUNDLED_PETS),
      favorites: defaultBundledPreferences(DEFAULT_FAVORITE_BUNDLED_PETS),
      names: {}
    };
  }
}

export function onPetLibraryChange(listener: (state: PetLibraryState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): PetLibraryState {
  const state = petLibraryState();
  for (const listener of listeners) listener(state);
  return state;
}

function ensureReady(): string {
  if (!directory) throw new Error('The pet library is not ready.');
  return directory;
}

function readJson(file: string): Record<string, unknown> {
  const info = fs.statSync(file);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_JSON_BYTES) throw new Error('Pet metadata is invalid.');
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pet metadata must be a JSON object.');
  return value as Record<string, unknown>;
}

function contained(base: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Invalid pet file path.');
  const root = fs.realpathSync(base);
  const candidate = path.resolve(base, relative);
  if (!candidate.startsWith(path.resolve(base) + path.sep)) throw new Error('A pet file escapes its package.');
  const info = fs.lstatSync(candidate);
  if (info.isSymbolicLink()) throw new Error('Pet packages may not use symbolic links.');
  const real = fs.realpathSync(candidate);
  if (!real.startsWith(root + path.sep)) throw new Error('A pet file escapes its package.');
  return real;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactFrames(value: unknown, expected: readonly number[]): value is number[] {
  return Array.isArray(value) && value.length === expected.length && value.every((frame, index) => frame === expected[index]);
}

export function parsePetAnimations(raw: Record<string, unknown>): PetAnimationManifest {
  if (
    raw['version'] !== 1 || raw['image'] !== 'atlas.png' ||
    raw['width'] !== COS_PET_ATLAS.width || raw['height'] !== COS_PET_ATLAS.height ||
    raw['columns'] !== COS_PET_ATLAS.columns || raw['cellWidth'] !== COS_PET_ATLAS.cellWidth ||
    raw['cellHeight'] !== COS_PET_ATLAS.cellHeight || raw['frameCount'] !== COS_PET_ATLAS.frameCount
  ) throw new Error('animations.json must use the pet atlas layout (1280×1920, 8 columns, 160px cells, 96 frames).');
  const anchor = raw['anchor'];
  if (!Array.isArray(anchor) || anchor.length !== 2 || anchor[0] !== 80 || anchor[1] !== 136) {
    throw new Error('animations.json anchor must be [80, 136].');
  }
  const sourceAnimations = object(raw['animations']);
  if (!sourceAnimations) throw new Error('animations.json is missing its animations object.');
  const animations = {} as Record<PetAnimationName, PetAnimationManifest['animations'][PetAnimationName]>;
  for (const name of COS_PET_ANIMATION_NAMES) {
    const source = object(sourceAnimations[name]);
    const expected = COS_PET_FRAME_LAYOUT[name];
    if (!source || !exactFrames(source['frames'], expected) || source['loop'] !== COS_PET_LOOPING[name]) {
      throw new Error(`animations.json ${name} must use the required frame range and loop behavior.`);
    }
    const ms = source['ms'];
    if (!Array.isArray(ms) || ms.length !== expected.length || !ms.every(value => Number.isFinite(value) && Number(value) > 0 && Number(value) <= 10_000)) {
      throw new Error(`animations.json ${name} needs one positive duration per frame.`);
    }
    animations[name] = { frames: [...expected], ms: ms.map(Number), loop: COS_PET_LOOPING[name] };
  }
  const sourceHands = object(raw['hands']);
  if (!sourceHands) throw new Error('animations.json needs hand anchors for frames 69–84.');
  const hands: PetAnimationManifest['hands'] = {};
  for (let frame = 69; frame <= 84; frame += 1) {
    const value = sourceHands[String(frame)];
    if (
      !Array.isArray(value) || value.length !== 3 ||
      !Number.isFinite(value[0]) || !Number.isFinite(value[1]) ||
      Number(value[0]) < 0 || Number(value[0]) > 160 || Number(value[1]) < 0 || Number(value[1]) > 160 ||
      (value[2] !== 1 && value[2] !== -1)
    ) throw new Error(`animations.json needs a valid [x, y, side] hand anchor for frame ${frame}.`);
    hands[String(frame)] = [Number(value[0]), Number(value[1]), value[2]];
  }
  return {
    version: 1,
    image: 'atlas.png',
    width: 1280,
    height: 1920,
    columns: 8,
    cellWidth: 160,
    cellHeight: 160,
    frameCount: 96,
    anchor: [80, 136],
    animations,
    hands
  };
}

function inspectPackage(folder: string, expectedId?: string): InspectedPet {
  const info = fs.lstatSync(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Choose a pet package folder.');
  const metadata = readJson(contained(folder, 'pet.json'));
  const id = metadata['id'];
  const displayName = metadata['displayName'];
  const description = metadata['description'];
  if (
    typeof id !== 'string' || !PET_ID_PATTERN.test(id) || (expectedId && id !== expectedId) ||
    metadata['format'] !== 'cos-pet' || metadata['version'] !== 1 ||
    typeof displayName !== 'string' || !displayName.trim() ||
    typeof description !== 'string'
  ) throw new Error('The folder needs a valid pet.json manifest (format "cos-pet", version 1).');

  const atlas = contained(folder, 'atlas.png');
  const atlasInfo = fs.statSync(atlas);
  if (!atlasInfo.isFile() || atlasInfo.size <= 0 || atlasInfo.size > MAX_ATLAS_BYTES) throw new Error('atlas.png is empty or too large.');
  const bytes = fs.readFileSync(atlas);
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('atlas.png could not be decoded.');
  const size = image.getSize();
  if (size.width !== COS_PET_ATLAS.width || size.height !== COS_PET_ATLAS.height) {
    throw new Error(`atlas.png must be ${COS_PET_ATLAS.width}×${COS_PET_ATLAS.height}px.`);
  }
  const authored = parsePetAnimations(readJson(contained(folder, 'animations.json')));
  // Frame 7 (the last idle frame) is the library preview.
  const preview = image.crop({ x: 7 * COS_PET_ATLAS.cellWidth, y: 0, width: COS_PET_ATLAS.cellWidth, height: COS_PET_ATLAS.cellHeight }).resize({ width: 96, height: 96, quality: 'good' });
  const descriptions = parseDescriptions(metadata['descriptions']);
  return {
    record: {
      id,
      displayName: displayName.trim().slice(0, MAX_NAME_LENGTH),
      description: description.trim().slice(0, MAX_DESCRIPTION_LENGTH),
      ...(descriptions ? { descriptions } : {}),
      previewDataUrl: preview.toDataURL()
    },
    atlas,
    manifest: authored
  };
}

function installedPet(id: string): InspectedPet {
  if (!PET_ID_PATTERN.test(id)) throw new Error('Invalid pet id.');
  if (bundledDirectory && isBundled(id)) {
    const realRoot = fs.realpathSync(bundledDirectory);
    const realFolder = fs.realpathSync(path.join(bundledDirectory, id));
    if (!realFolder.startsWith(realRoot + path.sep)) throw new Error('Pet package escapes the library.');
    const inspected = inspectPackage(realFolder, id);
    return { ...inspected, record: { ...inspected.record, bundled: true } };
  }
  const root = ensureReady();
  const folder = path.join(root, id);
  const info = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Pet is not installed.');
  const realRoot = fs.realpathSync(root);
  const realFolder = fs.realpathSync(folder);
  if (!realFolder.startsWith(realRoot + path.sep)) throw new Error('Pet package escapes the library.');
  return inspectPackage(realFolder, id);
}

function exists(id: string): boolean {
  try { installedPet(id); return true; } catch { return false; }
}

function preference(record: Omit<PetRecord, 'enabled' | 'favorite'>): PetRecord {
  const custom = stored.names[record.id];
  return {
    ...record,
    ...(custom && custom !== record.displayName ? { displayName: custom, originalName: record.displayName } : {}),
    enabled: stored.enabled.includes(record.id),
    favorite: stored.favorites.includes(record.id)
  };
}

export function petLibraryState(): PetLibraryState {
  const root = ensureReady();
  const pets: PetRecord[] = [];
  const bundled = bundledIds();
  for (const id of bundled) {
    try { pets.push(preference(installedPet(id).record)); } catch { /* A damaged bundled package stays unavailable. */ }
  }
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (count >= MAX_PACKAGES || bundled.includes(entry.name) || !entry.isDirectory() || !PET_ID_PATTERN.test(entry.name)) continue;
    count += 1;
    try { pets.push(preference(installedPet(entry.name).record)); } catch { /* Invalid packages remain unavailable. */ }
  }
  pets.sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.displayName.localeCompare(b.displayName));
  return { pets };
}

export function setPetEnabled(id: string, enabled: boolean): PetLibraryState {
  if (!exists(id)) throw new Error('Pet is not installed.');
  const next = new Set(stored.enabled);
  if (enabled) next.add(id); else next.delete(id);
  stored = { ...stored, enabled: [...next] };
  persist();
  return changed();
}

export function setPetFavorite(id: string, favorite: boolean): PetLibraryState {
  if (!exists(id)) throw new Error('Pet is not installed.');
  const next = new Set(stored.favorites);
  if (favorite) next.add(id); else next.delete(id);
  stored = { ...stored, favorites: [...next] };
  persist();
  return changed();
}

/** Give a pet a name of the user's choosing, or pass an empty name to go back to the package's own. */
export function setPetName(id: string, name: string): PetLibraryState {
  if (!exists(id)) throw new Error('Pet is not installed.');
  const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  const names = { ...stored.names };
  if (trimmed) names[id] = trimmed; else delete names[id];
  stored = { ...stored, names };
  persist();
  return changed();
}

export function deletePet(id: string): PetLibraryState {
  if (isBundled(id)) throw new Error('Bundled pets cannot be deleted. Turn them off instead.');
  if (!PET_ID_PATTERN.test(id)) throw new Error('Invalid pet id.');
  const root = ensureReady();
  const folder = path.join(root, id);
  const info = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Pet is not installed.');
  const realRoot = fs.realpathSync(root);
  const realFolder = fs.realpathSync(folder);
  if (!realFolder.startsWith(realRoot + path.sep)) throw new Error('Pet package escapes the library.');
  fs.rmSync(realFolder, { recursive: true, force: false });
  stored = {
    ...stored,
    enabled: stored.enabled.filter(value => value !== id),
    favorites: stored.favorites.filter(value => value !== id),
    names: Object.fromEntries(Object.entries(stored.names).filter(([key]) => key !== id))
  };
  persist();
  return changed();
}

export function importPet(sourceFolder: string): PetLibraryState {
  const source = fs.realpathSync(sourceFolder);
  const inspected = inspectPackage(source);
  if (isBundled(inspected.record.id)) throw new Error('That pet id is reserved for a bundled pet.');
  const root = ensureReady();
  const destination = path.join(root, inspected.record.id);
  if (fs.existsSync(destination)) throw new Error(`${inspected.record.displayName} is already imported.`);
  const temporary = path.join(root, `.import-${randomUUID()}`);
  fs.mkdirSync(temporary);
  try {
    fs.copyFileSync(inspected.atlas, path.join(temporary, 'atlas.png'));
    fs.writeFileSync(path.join(temporary, 'pet.json'), JSON.stringify({
      format: 'cos-pet',
      version: 1,
      id: inspected.record.id,
      displayName: inspected.record.displayName,
      description: inspected.record.description,
      ...(inspected.record.descriptions ? { descriptions: inspected.record.descriptions } : {})
    }, null, 2));
    fs.writeFileSync(path.join(temporary, 'animations.json'), JSON.stringify(inspected.manifest, null, 2));
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return changed();
}

export function loadPetAsset(id: string, preview: boolean): PetRuntimeAsset {
  const inspected = installedPet(id);
  const bytes = fs.readFileSync(inspected.atlas);
  if (!preview) {
    return { id, atlasDataUrl: `data:image/png;base64,${bytes.toString('base64')}`, manifest: inspected.manifest };
  }
  const image = nativeImage.createFromBuffer(bytes).resize({ width: 512, height: 768, quality: 'good' });
  return { id, atlasDataUrl: `data:image/png;base64,${image.toPNG().toString('base64')}`, manifest: inspected.manifest };
}
