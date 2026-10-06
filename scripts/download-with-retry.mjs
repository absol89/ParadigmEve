/**
 * Packaging downloads with bounded retries.
 *
 * A GitHub macOS runner lost the tunnel-client download to one transient `fetch failed`
 * (2.3.6, 2026-10-06) and the whole packaging job failed. Each pinned artifact is still
 * checksum-verified by its caller; this only retries the transfer and names the cause.
 */
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

const describe = (error) => {
  const cause = error && error.cause ? ` (${error.cause.code || error.cause.message || error.cause})` : '';
  return `${error && error.message ? error.message : String(error)}${cause}`;
};

export async function downloadWithRetry(url, target, label = url) {
  if (existsSync(target)) return;
  let failure;
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'chat-on-steroids-build' }, signal: AbortSignal.timeout(180_000) });
      if (!response.ok) {
        const error = new Error(`${label} -> HTTP ${response.status}`);
        // A missing asset will not appear on retry; only server-side and rate-limit statuses are retried.
        if (response.status < 500 && response.status !== 429) throw Object.assign(error, { final: true });
        throw error;
      }
      await writeFile(target, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      failure = error;
      await rm(target, { force: true }).catch(() => undefined);
      if (error && error.final) break;
      if (attempt <= RETRY_DELAYS_MS.length) {
        process.stderr.write(`${label}: attempt ${attempt} failed: ${describe(error)}; retrying\n`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
      }
    }
  }
  throw new Error(`${label}: ${describe(failure)}`);
}
