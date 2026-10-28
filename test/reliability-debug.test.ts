import { afterEach, describe, expect, it } from 'vitest';
import { debugReliabilityEvent } from '../src/main/reliability-debug-events.js';
import { classifyReliabilityLog, summarizeReliabilityDiagnostics } from '../src/main/reliability-debug.js';
import { formatLogAsJson, getLog, logInfo, resetLoggerForTests } from '../src/main/logger.js';

afterEach(() => resetLoggerForTests());

describe('debug reliability evidence, not a second monitoring scheduler', () => {
  it.each([
    ['heartbeat: review paused', 'heartbeat'],
    ['Native subagent host unavailable', 'native-subagent'],
    ['approval: some-chat awaiting human ChatGPT tool decision', 'provider-approval'],
    ['multi-agent: heartbeat FIRST_PROGRESS_MISSING', 'worker-progress'],
    ['request attribution timeout after 20s', 'identity'],
    ['Compact & Resume cancelled without proof', 'compact-resume'],
    ['Companion browser recovery did not restore a profile', 'browser-recovery'],
    ['Send remains unverified; no replay', 'delivery'],
    ['model picker mismatch; refusing model switch', 'model-integrity'],
    ['Voice VAD 404 silero-vad', 'voice'],
    ['provider HTTP 429', 'provider-transport'],
    ['page user image msg=37c39700 recorder=unavailable:ambiguous', 'archive-image'],
    ['bridge: stopped unclaimed assistant-error recovery after 10 offers', 'browser-recovery']
  ])('classifies one known symptom as %s without claiming a root cause', (message, expected) => {
    expect(classifyReliabilityLog(message)?.area).toBe(expected);
  });

  it('adds structured tags to debug Activity JSON while preserving the original message', () => {
    logInfo('Send remains unverified; no replay');
    const json = JSON.parse(formatLogAsJson());
    expect(json).toHaveLength(1);
    expect(json[0].message).toBe('Send remains unverified; no replay');
    expect(json[0].reliability).toEqual({ area: 'delivery', signal: 'send-ack-or-outbox-uncertain' });
  });

  it('logs only hash-truncated correlation IDs and numeric timings for explicit events', () => {
    const privateChat = 'private-chat-id-1234';
    const privateEpoch = 'heartbeat:private-request';
    debugReliabilityEvent('worker-first-progress-missing', {
      owner: privateChat, epoch: privateEpoch, elapsedMs: 80_000, warning: true
    });
    const entry = getLog().at(-1)!;
    expect(entry.message).toContain('area=worker-progress event=worker-first-progress-missing');
    expect(entry.message).toContain('elapsed_ms=80000');
    expect(entry.message).not.toContain(privateChat);
    expect(entry.message).not.toContain(privateEpoch);
    expect(JSON.parse(formatLogAsJson())[0].reliability).toEqual({
      area: 'worker-progress', signal: 'worker-first-progress-missing'
    });
  });

  it('ignores unknown codes, unrelated messages and freeform secrets', () => {
    expect(classifyReliabilityLog('RELIABILITY_DIAG area=identity event=made-up')).toBeNull();
    expect(classifyReliabilityLog('A normal completed turn')).toBeNull();
  });
  it('summarizes recent categories without returning message, chat or provider contents', () => {
    const sensitive = 'private-chat-from-a-customer';
    const view = summarizeReliabilityDiagnostics([
      { time: 100, message: `approval: ${sensitive} awaiting provider approval` },
      { time: 150, message: 'worker FIRST_PROGRESS_MISSING' },
      { time: 175, message: `approval: ${sensitive} explicitly cleared` },
      { time: 190, message: 'ordinary successful turn' }
    ], 200);
    expect(view).toContain('provider-approval ×2');
    expect(view).toContain('worker-progress ×1');
    expect(view).toContain('newest 0s ago');
    expect(view).not.toContain(sensitive);
    expect(summarizeReliabilityDiagnostics([{ time: 200, message: 'normal run' }], 200))
      .toContain('does not prove');
  });
});
