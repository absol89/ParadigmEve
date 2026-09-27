import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, initConfigPath, loadConfig, saveConfig } from '../src/main/config.js';
import {
  configureSelfMaintenanceRuntime,
  resetSelfMaintenanceRuntimeForTests,
  selfMaintenanceRoots,
  selfMaintenanceSettings,
  updateSelfMaintenanceSettings
} from '../src/main/self-maintenance.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paradigmeve-self-settings-'));
  initConfigPath(directory);
  await saveConfig(defaultConfig());
});

afterEach(async () => {
  resetSelfMaintenanceRuntimeForTests();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('keeps AppData and the actual installation directory as runtime-managed roots instead of config roots', async () => {
  const install = path.join(directory, 'custom-install');
  await fs.mkdir(install);
  configureSelfMaintenanceRuntime({
    setLoginStartup: vi.fn(),
    appDataPath: directory,
    installationPath: install
  });

  expect(selfMaintenanceRoots()).toEqual([
    { name: 'appdata', path: path.resolve(directory) },
    { name: 'paradigmeve', path: path.resolve(install) }
  ]);
  expect((await loadConfig()).roots).toEqual([]);
});

it('persists live self-maintenance settings and applies Windows login registration through the runtime hook', async () => {
  const login = vi.fn();
  configureSelfMaintenanceRuntime({ setLoginStartup: login });

  const updated = await updateSelfMaintenanceSettings({
    startAtLogin: true,
    autoConnect: true,
    minimizeToTray: true,
    backgroundChats: false
  });

  expect(updated).toEqual({
    startAtLogin: true,
    autoConnect: true,
    minimizeToTray: true,
    backgroundChats: false
  });
  expect(login).toHaveBeenCalledTimes(1);
  expect(login).toHaveBeenCalledWith(true);

  const persisted = await loadConfig();
  expect(persisted.ui).toMatchObject({
    startAtLogin: true,
    autoConnect: true,
    minimizeToTray: true,
    backgroundChats: false
  });
  expect(selfMaintenanceSettings()).toEqual(updated);
});
