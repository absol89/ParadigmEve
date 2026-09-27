import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mainRoot = fileURLToPath(new URL('../src/main/', import.meta.url));

describe('installed schedules + requests production wiring', () => {
  it('has a production owner that can turn verified scheduled work into Done', () => {
    const runner = readFileSync(path.join(mainRoot, 'evecron-runner.ts'), 'utf8');
    const coreTools = readFileSync(path.join(mainRoot, 'mcp', 'tools-core.ts'), 'utf8');
    const surfaces = readFileSync(path.join(mainRoot, 'mcp', 'surfaces.ts'), 'utf8');
    const inputs = readFileSync(path.join(mainRoot, 'session', 'input.ts'), 'utf8');
    expect(runner).toMatch(/completeEvecronRunFromSessionVerification[\s\S]*return completeEvecronRun\s*\(/u);
    expect(coreTools).toMatch(/reg\.register\('schedule_complete'[\s\S]*completeEvecronRunFromSessionVerification\s*\(/u);
    expect(surfaces).toMatch(/['"]schedule_complete['"]/u);
    expect(inputs).toMatch(/PARADIGMEVE_SCHEDULE_COMPLETION:v1[\s\S]*schedule_complete/u);
  });

  it('has a production owner that accepts an exact user request into Request Trail', () => {
    const planTool = readFileSync(path.join(mainRoot, 'mcp', 'plan-tool.ts'), 'utf8');
    const admission = readFileSync(path.join(mainRoot, 'request-trail-admission.ts'), 'utf8');
    expect(planTool).toMatch(/ensureRequestTrailForAcceptedPlan\s*\(/u);
    expect(admission).toMatch(/ensureRequestTrail\s*\(/u);
    expect(admission).toMatch(/activeTurnId/u);
  });

  it('carries a fresh Thread-context request into Request Trail by exact durable id', () => {
    const admission = readFileSync(path.join(mainRoot, 'request-trail-admission.ts'), 'utf8');
    expect(admission).toMatch(/contextQuiltId/u);
    expect(admission).toContain('...(threadId ? { threadId } : {})');
  });

  it('starts the durable Request Trail check-in owner from the app process', () => {
    const index = readFileSync(path.join(mainRoot, 'index.ts'), 'utf8');
    expect(index).toMatch(/createRequestTrailCheckInSource\s*\(/u);
    expect(index).toMatch(/createRequestCheckInOwner\s*\(/u);
    expect(index).toMatch(/requestCheckIns\.start\s*\(/u);
  });

  it('carries native request notification clicks to the exact recorded source event', () => {
    const index = readFileSync(path.join(mainRoot, 'index.ts'), 'utf8');
    const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
    const chat = readFileSync(new URL('../src/renderer/chat.ts', import.meta.url), 'utf8');
    expect(index).toContain("target.send('session:write', source.sessionId, source.eventSeq)");
    expect(preload).toMatch(/onWriteSession:\s*\(listener:\s*\(id: string, eventSeq\?: number\)/u);
    expect(chat).toContain("selectSession(id, typeof eventSeq === 'number' ? { targetEventSeq: eventSeq } : {})");
  });

  it('refreshes the Companion folder and names its build before any startup browser launch', () => {
    // 2026-09-26: an unclean-restart launch started Chrome a second before the lazy refresh, so
    // Chrome ran the previous build's page code and the installed reply fix never took effect.
    const index = readFileSync(path.join(mainRoot, 'index.ts'), 'utf8');
    const refresh = index.indexOf('setCompanionBuild(companionBuild(extensionDir()));');
    expect(refresh).toBeGreaterThan(0);
    for (const launch of ['void startBridge();', 'startupBrowserRecovery = runCompanionBrowserRecovery();',
      'startupBrowserRecovery = restoreParadigmEveChromeSessionForRecovery(', 'startupBrowserRecovery = restoreForegroundCompanionBrowser()']) {
      expect(index.indexOf(launch)).toBeGreaterThan(refresh);
    }
  });

  it('keeps update_plan projection-only so it cannot manufacture user signoff', () => {
    const planTool = readFileSync(path.join(mainRoot, 'mcp', 'plan-tool.ts'), 'utf8');
    expect(planTool).not.toMatch(/\barchivePlan\s*\(/u);
    expect(planTool).not.toMatch(/archiveCompletedWork/u);
  });
});
