/**
 * The one place a file-capability provider is offered and the one place the user answers.
 *
 * The model can only *ask*: `file_edit install_provider` opens Eve's own native confirmation.
 * Nothing the model writes, and nothing inside a file, can answer it. Release metadata is read
 * before the question so the user sees the real version and size, and an app with no build or no
 * published checksum for this machine is refused without asking. "No thanks" is remembered per
 * app until reset in Plugins; closing the dialog is "not now", which only suppresses another prompt
 * for a short cool-down so a looping model cannot nag.
 */
import { readDurable, writeDurableNow } from './durable.js';
import {
  capabilityProvidersForFormat,
  currentProviderPlatform,
  fileCapabilityProvider,
  maturityOffered,
  providerAssetTemplate,
  type ProviderPlatform
} from './file-capabilities.js';
import { chooseProviderRelease, ProviderUnavailableError, type ProviderReleaseChoice } from './file-provider-install.js';
import { pluginManager } from './plugins/manager.js';

export type ProviderAnswer = 'install' | 'decline' | 'later';
export type ProviderConfirm = (choice: ProviderReleaseChoice) => Promise<ProviderAnswer>;
export interface FeatureLossChoice {
  provider: string;
  source: string;
  output: string;
  losses: readonly string[];
}

interface ConsentState { declined: string[]; preview: boolean }

const STORE = 'file-providers';
const LATER_COOLDOWN_MS = 10 * 60_000;
let state: ConsentState | null = null;
const pending = new Map<string, Promise<ProviderInstallOutcome>>();
const laterUntil = new Map<string, number>();
/** `${audience}|${provider}` pairs already told about an app, so a long read loop is not padded with it. */
const offered = new Set<string>();
let platformOverride: ProviderPlatform | null | undefined;

const platform = (): ProviderPlatform | null => platformOverride === undefined ? currentProviderPlatform() : platformOverride;

async function load(): Promise<ConsentState> {
  if (state) return state;
  const stored = await readDurable<Partial<ConsentState>>(STORE);
  state = {
    declined: Array.isArray(stored?.declined) ? stored.declined.filter((id): id is string => typeof id === 'string' && !!fileCapabilityProvider(id)) : [],
    preview: stored?.preview === true
  };
  return state;
}

async function save(next: ConsentState): Promise<void> {
  state = next;
  await writeDurableNow(STORE, next);
}

export type FileProviderOffer =
  | { id: string; name: string; license: string; maturity: string; available: true }
  | { id: string; name: string; available: false; reason: string };

/**
 * What file_action may tell the model about a format: every matching app that is not installed and
 * not declined, including ones Eve cannot install on this system (so the user hears why). With
 * `onceFor`, an app is mentioned to that conversation only the first time.
 */
export async function fileProviderOffers(format: string, onceFor?: string): Promise<FileProviderOffer[]> {
  const { declined, preview } = await load();
  const offers: FileProviderOffer[] = [];
  for (const provider of capabilityProvidersForFormat(format)) {
    if (declined.includes(provider.id) || pluginManager.fileProvider(provider.id)) continue;
    if (!maturityOffered(provider.maturity, preview)) continue;
    if (onceFor !== undefined) {
      const key = `${onceFor}|${provider.id}`;
      if (offered.has(key)) continue;
      offered.add(key);
    }
    offers.push(providerAssetTemplate(provider, platform())
      ? { id: provider.id, name: provider.displayName, license: provider.license, maturity: provider.maturity, available: true }
      : { id: provider.id, name: provider.displayName, available: false, reason: `${provider.displayName} has no build for this operating system yet.` });
  }
  return offers;
}

export type ProviderInstallOutcome =
  | { status: 'installed'; version: string }
  | { status: 'already-installed'; version: string }
  | { status: 'declined' }
  | { status: 'later' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string };

/** Shared wording: the integration is early, and Eve never edits the user's original file with it. */
export const PROVIDER_CAVEAT = 'This is an in-development integration. Your original file is left alone: Eve edits a copy saved next to it.';

/** Electron's native message box: an answer only the person at this computer can give. */
export function providerInstallDialogOptions(choice: ProviderReleaseChoice) {
  const { provider, version, asset } = choice;
  return {
    type: 'question' as const,
    title: `Install ${provider.displayName}?`,
    message: `Install ${provider.displayName} ${version} so Eve can work with this file?`,
    detail:
      `${provider.displayName} is a free, open-source ${provider.domain} app (${provider.license}) from the ArtCraft suite. ` +
      'It lets Eve open and edit these files for you without a paid subscription.\n\n' +
      `${PROVIDER_CAVEAT}\n\n` +
      `ParadigmEve will download only the official build for this computer (${(asset.size / 1_048_576).toFixed(1)} MB), ` +
      'check it against the SHA-256 its release publishes, and install it for your user account only. You can remove it any time in Plugins.',
    buttons: ['Install', 'No thanks', 'Not now'],
    defaultId: 2,
    cancelId: 2,
    noLink: true
  };
}

export function focusNativeProviderConsentWindow(window: Pick<import('electron').BrowserWindow, 'isMinimized' | 'restore' | 'isVisible' | 'show' | 'focus' | 'moveTop'> | null, platform = process.platform): void {
  if (platform !== 'win32' || !window) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  window.moveTop();
}

async function nativeConfirm(choice: ProviderReleaseChoice): Promise<ProviderAnswer> {
  const { BrowserWindow, dialog } = await import('electron');
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && candidate.isVisible()) ?? BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed()) ?? null;
  // The native consent must be visible in front of Eve, never silently hidden
  // behind Chrome. Raising Eve does not interact with any ChatGPT tab.
  focusNativeProviderConsentWindow(window);
  const options = providerInstallDialogOptions(choice);
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return response === 0 ? 'install' : response === 1 ? 'decline' : 'later';
}

/** Native, app-owned approval for one exact fidelity risk. The safe answer owns Enter/Escape. */
export function featureLossDialogOptions(choice: FeatureLossChoice) {
  return {
    type: 'warning' as const,
    title: `Keep all features in ${choice.source}?`,
    message: `${choice.provider} cannot keep ${choice.losses.join(', ')} in this file.`,
    detail:
      `If you continue, those features will be lost only from the new copy ${choice.output}; the original ${choice.source} stays unchanged.\n\n` +
      'Continue only if you accept losing exactly the features listed above.',
    buttons: ['Continue with feature loss', 'Keep features / cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  };
}

export async function confirmFileFeatureLoss(choice: FeatureLossChoice): Promise<boolean> {
  const { BrowserWindow, dialog } = await import('electron');
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const options = featureLossDialogOptions(choice);
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return response === 0;
}

/**
 * Asks once, then installs on yes. Concurrent requests for the same app share one dialog.
 * The confirm seam exists for tests; production always uses the native dialog.
 */
export function requestFileProviderInstall(providerId: string, confirm: ProviderConfirm = nativeConfirm): Promise<ProviderInstallOutcome> {
  const running = pending.get(providerId);
  if (running) return running;
  const work = (async (): Promise<ProviderInstallOutcome> => {
    const provider = fileCapabilityProvider(providerId);
    if (!provider) return { status: 'unavailable', reason: 'This app is not in ParadigmEve\'s registry.' };
    const installed = pluginManager.fileProvider(providerId);
    if (installed) return { status: 'already-installed', version: installed.version };
    const current = await load();
    if (!maturityOffered(provider.maturity, current.preview)) return { status: 'unavailable', reason: 'This app is not offered yet. Turn on preview apps in Plugins to try it.' };
    if (current.declined.includes(providerId)) return { status: 'declined' };
    if ((laterUntil.get(providerId) ?? 0) > Date.now()) return { status: 'later' };
    let choice: ProviderReleaseChoice;
    try {
      choice = await chooseProviderRelease(providerId, { platform: platform() });
    } catch (error) {
      return error instanceof ProviderUnavailableError
        ? { status: 'unavailable', reason: error.message }
        : { status: 'failed', reason: `Could not read ${provider.displayName}'s official release: ${(error as Error).message.slice(0, 200)}` };
    }
    const answer = await confirm(choice);
    if (answer === 'decline') {
      await save({ ...current, declined: [...new Set([...current.declined, providerId])] });
      return { status: 'declined' };
    }
    if (answer !== 'install') {
      laterUntil.set(providerId, Date.now() + LATER_COOLDOWN_MS);
      return { status: 'later' };
    }
    try {
      await pluginManager.installFileProvider(providerId, choice.version);
    } catch (error) {
      return { status: 'failed', reason: (error as Error).message.slice(0, 400) };
    }
    const row = pluginManager.fileProvider(providerId);
    if (!row || row.status !== 'ready') {
      // An installation that never became healthy is not left behind half-working.
      if (row) await pluginManager.uninstall(row.id).catch(() => undefined);
      return { status: 'failed', reason: `${provider.displayName} was downloaded and verified but did not start correctly, so it was removed.` };
    }
    return { status: 'installed', version: row.version };
  })().finally(() => pending.delete(providerId));
  pending.set(providerId, work);
  return work;
}

export async function fileProviderSettings(): Promise<ConsentState> {
  const current = await load();
  return { declined: [...current.declined], preview: current.preview };
}

/** User-only settings: forgets every "No thanks" and/or switches preview apps. */
export async function updateFileProviderSettings(patch: { resetDeclined?: boolean; preview?: boolean }): Promise<ConsentState> {
  const current = await load();
  const next = {
    declined: patch.resetDeclined ? [] : current.declined,
    preview: patch.preview ?? current.preview
  };
  if (patch.resetDeclined) laterUntil.clear();
  await save(next);
  return { ...next, declined: [...next.declined] };
}

/** Test seam: forget process state and pretend to be another machine. */
export function resetFileProviderConsentForTests(platformKey?: ProviderPlatform | null): void {
  state = null;
  pending.clear();
  laterUntil.clear();
  offered.clear();
  platformOverride = platformKey;
}
