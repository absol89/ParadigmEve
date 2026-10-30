// Delay before the next attempt after an explicit rejection, in milliseconds.
export const BASE_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 60_000;

export function nextAttemptDelay(attempts) {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
}
