/** Stable local assets used while creating the ParadigmEve ChatGPT connector. */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const MAX_CONNECTOR_ICON_BYTES = 10 * 1024;

function validIcon(file: string): boolean {
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_CONNECTOR_ICON_BYTES;
  } catch {
    return false;
  }
}

/**
 * Returns the exact icon users should upload to ChatGPT while creating the connector.
 * Packaged builds carry it outside the asar so a browser file picker can select it directly.
 */
export function connectorIconPath(): string | null {
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'connector', 'icon.png');
    return validIcon(packaged) ? packaged : null;
  }

  const candidates = [
    path.join(app.getAppPath(), 'artwork', 'icon.png'),
    path.join(process.cwd(), 'artwork', 'icon.png')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && validIcon(candidate)) return candidate;
  }
  return null;
}
