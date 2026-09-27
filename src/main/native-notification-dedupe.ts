const shown = new Set<string>();
const MAX_NATIVE_NOTIFICATION_KEYS = 512;

/**
 * Process-local defense in depth for native toasts.
 *
 * Durable owners still decide whether a notification is owed. This only prevents one already
 * accepted notification callback from producing the same OS toast repeatedly during races or
 * replay in the current app process.
 */
export function claimNativeNotification(key: string): boolean {
  if (shown.has(key)) return false;
  shown.add(key);
  while (shown.size > MAX_NATIVE_NOTIFICATION_KEYS) {
    const oldest = shown.values().next().value as string | undefined;
    if (!oldest) break;
    shown.delete(oldest);
  }
  return true;
}

export function resetNativeNotificationDedupeForTests(): void {
  shown.clear();
}
