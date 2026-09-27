/** Durable presentation preferences for the Concepts overview. */
export const CONCEPT_PREVIEW_TEXT_SIZES = ['small', 'medium', 'large'] as const;
export type ConceptPreviewTextSize = typeof CONCEPT_PREVIEW_TEXT_SIZES[number];
export const CONCEPT_PIN_PREVIEW_DENSITIES = [1, 2, 3, 4] as const;
export type ConceptPinPreviewDensity = typeof CONCEPT_PIN_PREVIEW_DENSITIES[number];

export interface ConceptPreviewSettings {
  quiltRows: number;
  pinPreviewDensity: ConceptPinPreviewDensity;
  descriptionTextSize: ConceptPreviewTextSize;
  descriptionRows: number;
  promptTextSize: ConceptPreviewTextSize;
  promptRows: number;
}

export const CONCEPT_QUILT_ROWS_MIN = 1;
export const CONCEPT_QUILT_ROWS_MAX = 6;
export const CONCEPT_TEXT_ROWS_MIN = 1;
export const CONCEPT_TEXT_ROWS_MAX = 8;

/** Matches the current renderer before these preferences became configurable. */
export const DEFAULT_CONCEPT_PREVIEW_SETTINGS: Readonly<ConceptPreviewSettings> = {
  quiltRows: 2,
  pinPreviewDensity: 2,
  descriptionTextSize: 'medium',
  descriptionRows: 2,
  promptTextSize: 'medium',
  promptRows: 2
};

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function textSize(value: unknown, fallback: ConceptPreviewTextSize): ConceptPreviewTextSize {
  return (CONCEPT_PREVIEW_TEXT_SIZES as readonly unknown[]).includes(value)
    ? value as ConceptPreviewTextSize
    : fallback;
}

function pinPreviewDensity(value: unknown): ConceptPinPreviewDensity {
  return (CONCEPT_PIN_PREVIEW_DENSITIES as readonly unknown[]).includes(value)
    ? value as ConceptPinPreviewDensity
    : DEFAULT_CONCEPT_PREVIEW_SETTINGS.pinPreviewDensity;
}

/** Normalize legacy/partial UI settings without making unrelated config invalid. */
export function conceptPreviewSettings(value: {
  conceptQuiltRows?: unknown;
  conceptPinPreviewDensity?: unknown;
  conceptDescriptionTextSize?: unknown;
  conceptDescriptionRows?: unknown;
  conceptPromptTextSize?: unknown;
  conceptPromptRows?: unknown;
}): ConceptPreviewSettings {
  return {
    quiltRows: boundedInt(value.conceptQuiltRows, DEFAULT_CONCEPT_PREVIEW_SETTINGS.quiltRows, CONCEPT_QUILT_ROWS_MIN, CONCEPT_QUILT_ROWS_MAX),
    pinPreviewDensity: pinPreviewDensity(value.conceptPinPreviewDensity),
    descriptionTextSize: textSize(value.conceptDescriptionTextSize, DEFAULT_CONCEPT_PREVIEW_SETTINGS.descriptionTextSize),
    descriptionRows: boundedInt(value.conceptDescriptionRows, DEFAULT_CONCEPT_PREVIEW_SETTINGS.descriptionRows, CONCEPT_TEXT_ROWS_MIN, CONCEPT_TEXT_ROWS_MAX),
    promptTextSize: textSize(value.conceptPromptTextSize, DEFAULT_CONCEPT_PREVIEW_SETTINGS.promptTextSize),
    promptRows: boundedInt(value.conceptPromptRows, DEFAULT_CONCEPT_PREVIEW_SETTINGS.promptRows, CONCEPT_TEXT_ROWS_MIN, CONCEPT_TEXT_ROWS_MAX)
  };
}
