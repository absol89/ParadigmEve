import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  TRANSCRIPTION_AVENUES,
  cloneTranscriptionSettings,
  transcriptionSettingsIssue,
  type TranscriptionAvenue,
  type TranscriptionSettings
} from '../shared/transcription.js';
import type { AppState } from '../shared/types.js';
import { $, run, toast } from './dom.js';
import { t, ui } from './i18n.js';

/**
 * Settings → Transcription. Three avenues, each a switch plus a whole-number priority; the
 * lowest enabled number runs first. The section saves itself through its own IPC call (it has
 * no second writer), and the main process re-validates exactly what this form checks.
 */

const IDS: Record<TranscriptionAvenue, { enabled: string; priority: string }> = {
  gpu: { enabled: 'transcriptionGpuEnabled', priority: 'transcriptionGpuPriority' },
  local: { enabled: 'transcriptionLocalEnabled', priority: 'transcriptionLocalPriority' },
  cloud: { enabled: 'transcriptionCloudEnabled', priority: 'transcriptionCloudPriority' }
};

let state: AppState | null = null;
let onState: (next: AppState) => void = () => {};

function saved(): TranscriptionSettings {
  return cloneTranscriptionSettings(state?.config.transcription ?? DEFAULT_TRANSCRIPTION_SETTINGS);
}

function formValue(): TranscriptionSettings {
  const settings = saved();
  for (const avenue of TRANSCRIPTION_AVENUES) {
    settings[avenue].enabled = $<HTMLInputElement>(IDS[avenue].enabled).checked;
    // A blank or fractional entry stays as typed (NaN / 2.5) so validation rejects it instead
    // of silently rounding the user's number into a different order.
    const raw = $<HTMLInputElement>(IDS[avenue].priority).value.trim();
    settings[avenue].priority = raw === '' ? Number.NaN : Number(raw);
  }
  return settings;
}

/** The section's one status line: the current order, or why the edit was not saved. */
function showStatus(settings: TranscriptionSettings, issue: string | null): void {
  const node = $('transcriptionOrder');
  node.textContent = issue ?? orderText(settings);
  node.classList.toggle('is-warn', issue !== null);
}

function orderText(settings: TranscriptionSettings): string {
  const names: Record<TranscriptionAvenue, string> = { gpu: t('GPU'), local: t('Local'), cloud: t('Cloud') };
  const order = TRANSCRIPTION_AVENUES.filter((avenue) => settings[avenue].enabled)
    .sort((left, right) => settings[left].priority - settings[right].priority)
    .map((avenue) => names[avenue]);
  return order.length > 0 ? t('Tried in this order: {0}.', [order.join(' → ')]) : '';
}

async function save(): Promise<void> {
  if (!state) return;
  const settings = formValue();
  const issue = transcriptionSettingsIssue(settings, state.hasTranscriptionKey);
  if (issue) {
    showStatus(settings, t(issue));
    return;
  }
  const next = await run(window.api.saveTranscription(settings));
  if (next) onState(next);
}

export function applyTranscriptionSettings(next: AppState): void {
  state = next;
  const settings = saved();
  const pane = $('transcriptionPane');
  const editing = pane.contains(document.activeElement);
  for (const avenue of TRANSCRIPTION_AVENUES) {
    const enabled = $<HTMLInputElement>(IDS[avenue].enabled);
    const priority = $<HTMLInputElement>(IDS[avenue].priority);
    enabled.checked = settings[avenue].enabled;
    // Do not overwrite a number the user is still typing.
    if (!editing || document.activeElement !== priority) priority.value = String(settings[avenue].priority);
  }
  // Cloud can be switched off at any time, but only switched on once its key is stored.
  $<HTMLInputElement>(IDS.cloud.enabled).disabled = !next.hasTranscriptionKey && !settings.cloud.enabled;
  if (!editing) showStatus(settings, null);

  const secureStorageAvailable = next.secureStorage?.available ?? true;
  const key = $<HTMLInputElement>('transcriptionKey');
  ui(key, 'placeholder', () => next.hasTranscriptionKey ? t('•••••••• stored') : '');
  key.disabled = !secureStorageAvailable;
  ui($('transcriptionKeyState'), 'textContent', () => !secureStorageAvailable
    ? (next.secureStorage?.detail ?? t('Secure credential storage is unavailable.'))
    : next.hasTranscriptionKey
      ? t('A key is stored with secure OS credential storage. Type a new one to replace it.')
      : t('Needed only for Cloud. Use a separate Groq key limited to the Whisper models. It is stored with secure OS credential storage and sent only to Groq.'));
  $('transcriptionKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('transcriptionKeyRemove').disabled = !next.hasTranscriptionKey || !secureStorageAvailable;
}

export function initTranscriptionSettings(apply: (next: AppState) => void): void {
  onState = apply;
  for (const avenue of TRANSCRIPTION_AVENUES) {
    $(IDS[avenue].enabled).addEventListener('change', () => { void save(); });
    $(IDS[avenue].priority).addEventListener('change', () => { void save(); });
  }
  $('transcriptionKey').addEventListener('blur', async () => {
    const input = $<HTMLInputElement>('transcriptionKey');
    const submitted = input.value;
    if (!submitted.trim()) return;
    const next = await run(window.api.setTranscriptionKey(submitted.trim()));
    if (next) {
      if (input.value === submitted) input.value = '';
      onState(next);
      toast(t('Transcription key stored. You can now enable Cloud.'));
    }
  });
  $('transcriptionKeyRemove').addEventListener('click', async () => {
    const next = await run(window.api.setTranscriptionKey(''));
    if (next) {
      onState(next);
      toast(t('Transcription key removed. Cloud transcription is off.'));
    }
  });
}
