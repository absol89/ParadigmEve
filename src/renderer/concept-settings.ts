import {
  CONCEPT_PIN_PREVIEW_DENSITIES,
  CONCEPT_PREVIEW_TEXT_SIZES,
  CONCEPT_QUILT_ROWS_MAX,
  CONCEPT_QUILT_ROWS_MIN,
  CONCEPT_TEXT_ROWS_MAX,
  CONCEPT_TEXT_ROWS_MIN,
  conceptPreviewSettings,
  type ConceptPinPreviewDensity,
  type ConceptPreviewTextSize
} from '../shared/concept-settings.js';
import type { UiPrefs } from '../shared/types.js';
import { el } from './dom.js';
import { t, ui } from './i18n.js';
import { setConceptPreviewSettings } from './workspace-library.js';

const IDS = {
  quiltRows: 'conceptQuiltRows',
  pinPreviewDensity: 'conceptPinPreviewDensity',
  descriptionTextSize: 'conceptDescriptionTextSize',
  descriptionRows: 'conceptDescriptionRows',
  promptTextSize: 'conceptPromptTextSize',
  promptRows: 'conceptPromptRows'
} as const;

type ConceptUiPatch = Pick<UiPrefs,
  | 'conceptQuiltRows'
  | 'conceptPinPreviewDensity'
  | 'conceptDescriptionTextSize'
  | 'conceptDescriptionRows'
  | 'conceptPromptTextSize'
  | 'conceptPromptRows'
>;

function numberValue(id: string, fallback: number, min: number, max: number): number {
  const control = document.getElementById(id) as HTMLInputElement | null;
  if (!control) return fallback;
  const value = Number(control.value);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function sizeValue(id: string, fallback: ConceptPreviewTextSize): ConceptPreviewTextSize {
  const control = document.getElementById(id) as HTMLSelectElement | null;
  const value = control?.value;
  return value && (CONCEPT_PREVIEW_TEXT_SIZES as readonly string[]).includes(value)
    ? value as ConceptPreviewTextSize
    : fallback;
}

function densityValue(id: string, fallback: ConceptPinPreviewDensity): ConceptPinPreviewDensity {
  const control = document.getElementById(id) as HTMLSelectElement | null;
  const value = Number(control?.value);
  return (CONCEPT_PIN_PREVIEW_DENSITIES as readonly number[]).includes(value)
    ? value as ConceptPinPreviewDensity
    : fallback;
}

/** Snapshot the content controls without making their host part of the settings-save contract. */
export function conceptSettingsPatch(previous: UiPrefs): ConceptUiPatch {
  const fallback = conceptPreviewSettings(previous);
  return {
    conceptQuiltRows: numberValue(IDS.quiltRows, fallback.quiltRows, CONCEPT_QUILT_ROWS_MIN, CONCEPT_QUILT_ROWS_MAX),
    conceptPinPreviewDensity: densityValue(IDS.pinPreviewDensity, fallback.pinPreviewDensity),
    conceptDescriptionTextSize: sizeValue(IDS.descriptionTextSize, fallback.descriptionTextSize),
    conceptDescriptionRows: numberValue(IDS.descriptionRows, fallback.descriptionRows, CONCEPT_TEXT_ROWS_MIN, CONCEPT_TEXT_ROWS_MAX),
    conceptPromptTextSize: sizeValue(IDS.promptTextSize, fallback.promptTextSize),
    conceptPromptRows: numberValue(IDS.promptRows, fallback.promptRows, CONCEPT_TEXT_ROWS_MIN, CONCEPT_TEXT_ROWS_MAX)
  };
}

function copy(title: string, detail: string): HTMLElement {
  const content = el('span', 'setting-text');
  const strong = el('b');
  const hint = el('em');
  ui(strong, 'textContent', () => t(title));
  ui(hint, 'textContent', () => t(detail));
  content.append(strong, hint);
  return content;
}

function numberSetting(id: string, title: string, detail: string, min: number, max: number): HTMLLabelElement {
  const row = el('label', 'setting') as HTMLLabelElement;
  row.htmlFor = id;
  const input = document.createElement('input');
  input.id = id;
  input.type = 'number';
  input.className = 'num concept-number';
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  row.append(copy(title, detail), input);
  return row;
}

function sizeSetting(id: string, title: string, detail: string): HTMLLabelElement {
  const row = el('label', 'setting') as HTMLLabelElement;
  row.htmlFor = id;
  const select = document.createElement('select');
  select.id = id;
  for (const [value, label] of [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] as const) {
    const option = document.createElement('option');
    option.value = value;
    ui(option, 'textContent', () => t(label));
    select.append(option);
  }
  row.append(copy(title, detail), select);
  return row;
}

function densitySetting(): HTMLLabelElement {
  const row = el('label', 'setting') as HTMLLabelElement;
  row.htmlFor = IDS.pinPreviewDensity;
  const select = document.createElement('select');
  select.id = IDS.pinPreviewDensity;
  for (const [value, label] of [
    [1, '1 large square'],
    [2, '2 × 2'],
    [3, '3 × 3'],
    [4, '4 × 4']
  ] as const) {
    const option = document.createElement('option');
    option.value = String(value);
    ui(option, 'textContent', () => t(label));
    select.append(option);
  }
  row.append(copy('Pinned preview layout', 'Sticky heart-selected Pins fill these preview squares first.'), select);
  return row;
}

/** Fill the Concepts route's content host. The route/navigation itself is owned by the shell. */
export function initConceptSettings(save: () => void): void {
  const host = document.getElementById('conceptsSettingsHost');
  if (!host || host.childElementCount > 0) return;

  const intro = el('p', 'muted');
  ui(intro, 'textContent', () => t('Choose how much of each preview is visible. These settings change presentation only; they do not edit your Threads or Quilts.'));
  const pane = el('div', 'pane');
  pane.append(
    densitySetting(),
    numberSetting(
      IDS.quiltRows,
      '#Quilt pill rows',
      'Rows of #Quilt filters visible before the filter area scrolls.',
      CONCEPT_QUILT_ROWS_MIN,
      CONCEPT_QUILT_ROWS_MAX
    ),
    sizeSetting(IDS.descriptionTextSize, 'Description text size', 'Text size for description previews.'),
    numberSetting(
      IDS.descriptionRows,
      'Description preview rows',
      'Lines shown before a description preview is truncated.',
      CONCEPT_TEXT_ROWS_MIN,
      CONCEPT_TEXT_ROWS_MAX
    ),
    sizeSetting(IDS.promptTextSize, 'Prompt text size', 'Text size for prompt previews.'),
    numberSetting(
      IDS.promptRows,
      'Prompt preview rows',
      'Lines shown before a prompt preview is truncated.',
      CONCEPT_TEXT_ROWS_MIN,
      CONCEPT_TEXT_ROWS_MAX
    )
  );
  host.replaceChildren(intro, pane);
  for (const id of Object.values(IDS)) document.getElementById(id)?.addEventListener('change', save);
}

function setValue(id: string, value: string): void {
  const control = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (!control || document.activeElement === control) return;
  control.value = value;
}

/** Paint controls and the live Concepts surface from the same durable config. */
export function applyConceptSettings(uiPrefs: UiPrefs): void {
  const settings = conceptPreviewSettings(uiPrefs);
  setValue(IDS.quiltRows, String(settings.quiltRows));
  setValue(IDS.pinPreviewDensity, String(settings.pinPreviewDensity));
  setValue(IDS.descriptionTextSize, settings.descriptionTextSize);
  setValue(IDS.descriptionRows, String(settings.descriptionRows));
  setValue(IDS.promptTextSize, settings.promptTextSize);
  setValue(IDS.promptRows, String(settings.promptRows));
  setConceptPreviewSettings(settings);
}
