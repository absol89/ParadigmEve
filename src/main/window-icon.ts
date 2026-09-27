import path from 'node:path';

/**
 * Linux window managers do not reliably recover the application icon from AppImage metadata
 * when the raw AppImage is launched directly. Windows can likewise keep a stale taskbar icon for
 * a long-lived AppUserModel/shortcut even after the executable resource changes. Give both
 * packaged platforms an explicit branded PNG; macOS keeps its native app-bundle icon semantics.
 */
export function browserWindowIconPath(
  platform: NodeJS.Platform,
  packaged: boolean,
  resourcesPath: string
): string | undefined {
  if (!packaged) return undefined;
  if (platform === 'linux') return path.join(resourcesPath, 'runtime-icon.png');
  if (platform === 'win32') return path.join(resourcesPath, 'connector', 'icon.png');
  return undefined;
}
