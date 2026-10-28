/** Debug-only event envelope; never copy full chat IDs, prompts, paths or provider tokens. */
import { createHash } from 'node:crypto';
import { BUILD_FLAVOR } from '../shared/build-flavor.js';
import { logInfo, logWarn } from './logger.js';
import { AREA_BY_EVENT, type ReliabilityEvent } from './reliability-debug.js';

export function debugReliabilityEvent(
  code: ReliabilityEvent,
  options: { owner?: string | null; epoch?: string | null; elapsedMs?: number; warning?: boolean } = {}
): void {
  if (BUILD_FLAVOR !== 'debug') return;
  const hashed = (value: string | null | undefined): string | undefined =>
    value ? createHash('sha256').update(value).digest('hex').slice(0, 12) : undefined;
  const owner = hashed(options.owner);
  const epoch = hashed(options.epoch);
  const fields = [
    `area=${AREA_BY_EVENT[code]}`, `event=${code}`,
    ...(owner ? [`owner=${owner}`] : []), ...(epoch ? [`epoch=${epoch}`] : []),
    ...(Number.isFinite(options.elapsedMs) && options.elapsedMs! >= 0
      ? [`elapsed_ms=${Math.min(Math.floor(options.elapsedMs!), 86_400_000)}`] : [])
  ];
  (options.warning ? logWarn : logInfo)(`RELIABILITY_DIAG ${fields.join(' ')}`);
}
