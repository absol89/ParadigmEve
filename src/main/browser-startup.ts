/** One browser startup owner for explicit work and durable recovery. */
import { bridgeStatus, browserConversationOpen, browserWakeConnected } from './bridge.js';
import { isPreferredBrowserRunning } from './browser.js';
import { getConfig } from './config.js';
import { openParadigmEveChromeProfile, restoreParadigmEveChromeSessionForRecovery } from './setup-assistant.js';

let waking: { lastSeenAt: number | null; selected: string; kind: 'forward' | 'cold' | 'recovery'; work: Promise<void>; failed: boolean; finished: boolean } | null = null;
/** One browser startup per absence episode, shared by authored sends, discovery and owed recovery. */
export async function wakeBrowserUrl(url: string, retry = false, _backgroundStartup = false,
  authority?: { current(): boolean; exactPrime?: boolean }): Promise<void> {
  if (authority && !authority.current()) return;
  const browser = await bridgeStatus();
  if (browserWakeConnected()) { waking = null; return; }
  const selected = getConfig().ui.chatBrowser ?? 'chrome';
  // The companion can be missing because its protocol is incompatible or MV3 is
  // suspended. Explicit authored/discovery work may hand its URL to a confirmed
  // running selected browser; durable recovery remains stricter and requires process
  // absence because forwarding can activate an unrelated/restoring Chrome window.
  const prior = waking;
  const processState = await isPreferredBrowserRunning();
  const absent = processState === false;
  const mayForwardToRunning = !authority && processState === true;
  // A settings change while the probe yielded revokes that browser's absence evidence.
  if (selected !== (getConfig().ui.chatBrowser ?? 'chrome')) return;
  // The process query yields. Off, a collected reply or a new navigation can revoke
  // the exact recovery meanwhile; a missing socket alone never proves Chrome exited.
  if (authority && !authority.current()) return;
  if (browserWakeConnected()) { waking = null; return; }
  if (!absent && !mayForwardToRunning) return;
  const kind: 'forward' | 'cold' | 'recovery' = authority ? 'recovery' : absent ? 'cold' : 'forward';
  if (retry && waking === prior && (waking?.failed || waking?.finished)) waking = null;
  // A restore-first Chrome recovery owns the cold-start episode. An authored send that
  // races it must wait for that same restored browser instead of starting a second Chrome
  // process/window just because its own intent would otherwise be an ordinary cold open.
  if (!authority && absent && waking?.lastSeenAt === browser.lastSeenAt && waking.selected === selected && waking.kind === 'recovery') {
    return waking.work;
  }
  // Until the extension registers, another explicit send belongs to the same startup.
  // A changed browser choice starts a distinct attempt without adopting the old family.
  if (waking?.lastSeenAt === browser.lastSeenAt && waking.selected === selected && waking.kind === kind) return waking.work;
  const work = (async () => {
    // Bridge-owned recovery work already has durable exact-chat authority. When Chrome itself is
    // absent, give its dedicated ParadigmEve profile the first chance to restore the previous
    // session (including human tabs) and invoke the native Restore-pages affordance. The Companion
    // service worker's normal maintenance pass then scans those restored tabs before opening an
    // exact missing conversation for stop/compaction/Goal/identity repair. Do not preempt that
    // arbitration by handing the owed URL to the OS. Explicit authored/discovery opens have no
    // recovery authority object and retain their existing selected-browser behavior.
    if (authority && process.platform === 'win32') {
      await restoreParadigmEveChromeSessionForRecovery(authority.exactPrime ? {
        exactRecoveryUrl: url,
        exactConversationOpen: browserConversationOpen,
        preferRestoredExact: true,
      } : undefined);
      return;
    }
    // Every app-owned launch belongs to ParadigmEve's selected dedicated profile, whether that
    // family is already running or cold. A normal Chrome/Edge/Brave profile must never receive Eve
    // work just because it was the browser's most recent window. Page-driven Compact & Resume does
    // not come through this fallback; bridge.ts keeps placement with the source page that owns A.
    await openParadigmEveChromeProfile(url, selected);
  })();
  const attempt = { lastSeenAt: browser.lastSeenAt, selected, kind, work, failed: false, finished: false };
  waking = attempt;
  try { await work; } catch (error) { attempt.failed = true; throw error; } finally { attempt.finished = true; }
}
export function resetBrowserStartupForTests(): void { waking = null; }
