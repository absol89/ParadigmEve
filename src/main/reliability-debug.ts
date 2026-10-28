/**
 * Debug-build interpretation of existing Activity evidence. No background loop,
 * browser access, new telemetry endpoint, or duplicate transport authority.
 * Codes describe symptoms, not proof of a specific GPT/provider root cause.
 */

export type ReliabilityArea =
  | 'heartbeat' | 'native-subagent' | 'provider-approval' | 'worker-progress'
  | 'identity' | 'compact-resume' | 'browser-recovery' | 'delivery'
  | 'model-integrity' | 'voice' | 'provider-transport' | 'archive-image';

export type ReliabilityEvent =
  | 'heartbeat-mode-off' | 'heartbeat-native-host-unavailable'
  | 'heartbeat-native-idle-wait' | 'heartbeat-mode-change-held'
  | 'native-delegation-prepared' | 'native-report-by-prime' | 'native-delegation-unresolved'
  | 'approval-pending' | 'approval-cleared' | 'approval-observation-expired'
  | 'worker-first-progress-missing' | 'worker-review-budget-exceeded'
  | 'native-caller-unproven' | 'delivery-uncertain';

export const AREA_BY_EVENT: Readonly<Record<ReliabilityEvent, ReliabilityArea>> = {
  'heartbeat-mode-off': 'heartbeat',
  'heartbeat-native-host-unavailable': 'native-subagent',
  'heartbeat-native-idle-wait': 'heartbeat',
  'heartbeat-mode-change-held': 'heartbeat',
  'native-delegation-prepared': 'native-subagent',
  'native-report-by-prime': 'native-subagent',
  'native-delegation-unresolved': 'native-subagent',
  'approval-pending': 'provider-approval',
  'approval-cleared': 'provider-approval',
  'approval-observation-expired': 'provider-approval',
  'worker-first-progress-missing': 'worker-progress',
  'worker-review-budget-exceeded': 'worker-progress',
  'native-caller-unproven': 'identity',
  'delivery-uncertain': 'delivery'
};

const RULES: Array<{ area: ReliabilityArea; signal: string; pattern: RegExp }> = [
  { area: 'archive-image', signal: 'page-upload-preview-unavailable', pattern: /page user image msg=[0-9a-f]{8} recorder=(?:unavailable|invalid-preview|limit)/i },
  { area: 'heartbeat', signal: 'review-paused-or-backoff', pattern: /heartbeat.*(paused|backoff|deferred|no-coordinator)/i },
  { area: 'native-subagent', signal: 'host-unavailable-or-unproven', pattern: /native.*(subagent|delegation).*(unavailable|unverified|unknown|unsupported|locked|require)/i },
  { area: 'provider-approval', signal: 'approval-wait-or-refusal', pattern: /approval.*(wait|pending|refus|denied|expired|cleared)/i },
  { area: 'worker-progress', signal: 'worker-stall-or-missing-progress', pattern: /(FIRST_PROGRESS_MISSING|REVIEW_BUDGET_EXCEEDED|worker.*(stall|timeout|silent))/i },
  { area: 'identity', signal: 'attribution-or-caller-proof', pattern: /(unattributed|request attribution|identity.*(missing|timeout|ambiguous)|CALLER_IDENTITY_REQUIRED)/i },
  { area: 'compact-resume', signal: 'handoff-or-resume-problem', pattern: /(compact.*(cancel|stuck|failed)|resume.*(unverified|failed|cancel|stalled|interrupted)|handoff.*(failed|unverified|timeout))/i },
  { area: 'browser-recovery', signal: 'browser-ownership-or-reload', pattern: /(browser.*(reload|repair|recovery|profile)|companion.*(reload|repair|recovery|proof)|assistant-error recovery.*(?:unclaimed|offers))/i },
  { area: 'delivery', signal: 'send-ack-or-outbox-uncertain', pattern: /(delivery.*(failed|undelivered|uncertain)|send.*(ack|unverified|uncertain)|outbox.*(failed|replay))/i },
  { area: 'model-integrity', signal: 'model-selection-or-provider-fallback', pattern: /(model.*(switch|fallback|mismatch|unavailable|picker)|reasoning.*(change|mismatch))/i },
  { area: 'voice', signal: 'voice-session-or-vad-failure', pattern: /(voice.*(exit|error|failed|stall|404)|silero.vad|VAD.*404)/i },
  { area: 'provider-transport', signal: 'provider-http-or-stream-failure', pattern: /(transport.*(failed|interrupted|error)|provider.*(401|403|404|429)|HTTP (401|403|404|429))/i }
];

/** Adds searchable tags to an existing Activity JSON export; creates no new records. */
export function classifyReliabilityLog(message: string): { area: ReliabilityArea; signal: string } | null {
  if (message.startsWith('RELIABILITY_DIAG ')) {
    const area = /\barea=([a-z-]+)/.exec(message)?.[1];
    const event = /\bevent=([a-z-]+)/.exec(message)?.[1];
    if (event && Object.hasOwn(AREA_BY_EVENT, event)) {
      return { area: AREA_BY_EVENT[event as ReliabilityEvent], signal: event };
    }
    if (area) return null;
  }
  const match = RULES.find(rule => rule.pattern.test(message));
  return match ? { area: match.area, signal: match.signal } : null;
}

/** Content-free counts from the existing bounded Activity ring, newest evidence first. */
export function summarizeReliabilityDiagnostics(
  entries: readonly { time: number; message: string }[], now = Date.now()
): string {
  const totals = new Map<ReliabilityArea, number>();
  let newestAt: number | null = null;
  for (const entry of entries) {
    const label = classifyReliabilityLog(entry.message);
    if (!label) continue;
    totals.set(label.area, (totals.get(label.area) ?? 0) + 1);
    if (newestAt === null || entry.time > newestAt) newestAt = entry.time;
  }
  if (totals.size === 0) return 'No classified reliability symptoms in the current Activity ring. This does not prove the host or provider is healthy.';
  const recentSeconds = Math.max(0, Math.floor((now - newestAt!) / 1000));
  return [...totals].sort((a, b) => b[1] - a[1]).map(([area, count]) => `${area} ×${count}`).join(' · ') +
    `; newest ${recentSeconds}s ago. Symptoms only, not verified causes; see the Activity JSON export for event timestamps.`;
}
