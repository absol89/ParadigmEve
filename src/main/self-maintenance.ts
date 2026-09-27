import { getConfig, updateConfig } from './config.js';
import path from 'node:path';
import type { Root } from '../shared/types.js';

export interface SelfMaintenanceUpdate {
  startAtLogin?: boolean;
  autoConnect?: boolean;
  minimizeToTray?: boolean;
  backgroundChats?: boolean;
}

let setLoginStartup: ((enabled: boolean) => void) | null = null;
let managedRoots: Root[] = [];

/** Main-process wiring for the OS-specific startup side effect. */
export function configureSelfMaintenanceRuntime(runtime: {
  setLoginStartup(enabled: boolean): void;
  appDataPath?: string;
  installationPath?: string;
}): void {
  setLoginStartup = runtime.setLoginStartup;
  managedRoots = [
    ...(runtime.appDataPath ? [{ name: 'appdata', path: path.resolve(runtime.appDataPath) }] : []),
    ...(runtime.installationPath ? [{ name: 'paradigmeve', path: path.resolve(runtime.installationPath) }] : [])
  ];
}

/** App-owned roots are runtime truth, not ordinary user-approved folders persisted in config. */
export function selfMaintenanceRoots(): Root[] {
  return managedRoots.map((root) => ({ ...root }));
}

/** Test seam only. Production runtime is configured once during Electron bootstrap. */
export function resetSelfMaintenanceRuntimeForTests(): void {
  setLoginStartup = null;
  managedRoots = [];
}

export function selfMaintenanceSettings(): SelfMaintenanceUpdate {
  const config = getConfig();
  return {
    startAtLogin: config.ui.startAtLogin,
    autoConnect: config.ui.autoConnect,
    minimizeToTray: config.ui.minimizeToTray,
    backgroundChats: config.ui.backgroundChats
  };
}

/**
 * Change the small set of self-maintenance settings whose runtime effects ParadigmEve can apply
 * safely itself. Authority/identity checks live at the MCP boundary; this module only performs
 * the validated config + OS mutation.
 */
export async function updateSelfMaintenanceSettings(update: SelfMaintenanceUpdate): Promise<SelfMaintenanceUpdate> {
  const before = getConfig();
  const nextStartAtLogin = update.startAtLogin ?? before.ui.startAtLogin;
  const startupChanged = nextStartAtLogin !== before.ui.startAtLogin;
  if (startupChanged && !setLoginStartup) throw new Error('ParadigmEve startup registration is not available yet');

  const next = await updateConfig((latest) => ({
    ...latest,
    ui: {
      ...latest.ui,
      ...(update.startAtLogin !== undefined ? { startAtLogin: update.startAtLogin } : {}),
      ...(update.autoConnect !== undefined ? { autoConnect: update.autoConnect } : {}),
      ...(update.minimizeToTray !== undefined ? { minimizeToTray: update.minimizeToTray } : {}),
      ...(update.backgroundChats !== undefined ? { backgroundChats: update.backgroundChats } : {})
    }
  }));

  if (startupChanged) setLoginStartup!(next.ui.startAtLogin === true);
  return selfMaintenanceSettings();
}
