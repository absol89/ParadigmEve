import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const browser = vi.hoisted(() => ({ connected: false, present: false, lastSeenAt: null as number | null }));
const config = vi.hoisted(() => ({ ui: { chatBrowser: 'chrome' } }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => config }));
const open = vi.hoisted(() => vi.fn(async (_url: string): Promise<string | null> => 'chrome'));
const dedicated = vi.hoisted(() => vi.fn(async (_url: string, _browser?: string): Promise<void> => undefined));
const running = vi.hoisted(() => vi.fn(async (): Promise<boolean | null> => null));
const restore = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ id: 77, restoredPages: true })));
const conversationOpen = vi.hoisted(() => vi.fn((_conversationId: string): boolean | null => false));
vi.mock('../src/main/bridge.js', () => ({ bridgeStatus: async () => ({ ...browser }), browserConversationOpen: conversationOpen, browserWakeConnected: () => browser.connected, startBridge: async () => true }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: open, isPreferredBrowserRunning: running }));
vi.mock('../src/main/setup-assistant.js', () => ({
  openParadigmEveChromeProfile: dedicated,
  restoreParadigmEveChromeSessionForRecovery: restore,
}));
vi.mock('../src/main/connection.js', () => ({ connect: vi.fn(), getStatus: vi.fn(), onStatusChange: vi.fn() }));
import { resetBrowserStartupForTests, wakeBrowserUrl } from '../src/main/browser-startup.js';

// Restore-first cold-start recovery is the Windows dedicated-profile path. Pin the platform so macOS/Linux runners exercise the same Windows branch the fixtures describe;
// the modules under test read process.platform at call time, never at import.
const hostPlatform = process.platform;
beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }); });
afterAll(() => { Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true }); });

beforeEach(() => { resetBrowserStartupForTests(); config.ui.chatBrowser = 'chrome'; browser.connected = false; browser.present = false; browser.lastSeenAt = null; conversationOpen.mockReset().mockReturnValue(false); open.mockReset().mockResolvedValue('chrome'); dedicated.mockReset().mockResolvedValue(undefined); running.mockReset().mockResolvedValue(false); restore.mockReset().mockResolvedValue({ id: 77, restoredPages: true }); });

it('starts the newly selected family without reusing the old attempt or overriding a connected companion', async () => {
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=old');
  config.ui.chatBrowser = 'edge';
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=new');
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=repeat');
  expect(dedicated).toHaveBeenCalledTimes(2);
  expect(dedicated).toHaveBeenNthCalledWith(1, 'https://chatgpt.com/?cos-model-catalog=old', 'chrome');
  expect(dedicated).toHaveBeenNthCalledWith(2, 'https://chatgpt.com/?cos-model-catalog=new', 'edge');
  browser.connected = true;
  config.ui.chatBrowser = 'chrome';
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=connected');
  expect(dedicated).toHaveBeenCalledTimes(2);
});

it('discards absence evidence when the selected browser changes during its probe', async () => {
  browser.present = true;
  running.mockImplementationOnce(async () => { config.ui.chatBrowser = 'edge'; return false; });
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=old', true);
  expect(dedicated).not.toHaveBeenCalled();
  running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=new', true);
  expect(dedicated).toHaveBeenCalledTimes(1);
  expect(dedicated).toHaveBeenCalledWith('https://chatgpt.com/?cos-model-catalog=new', 'edge');
});

it('admits a new explicit refresh after the previous browser process exited', async () => {
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=old', true);
  running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=new', true);
  expect(dedicated).toHaveBeenCalledTimes(2);
});
it('keeps warm and cold app-owned work in the selected dedicated profile', async () => {
  browser.present = true; browser.lastSeenAt = Date.now();
  running.mockResolvedValue(true);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=one', true);
  expect(dedicated).toHaveBeenCalledTimes(1);
  expect(dedicated).toHaveBeenLastCalledWith('https://chatgpt.com/?cos-model-catalog=one', 'chrome');
  expect(open).not.toHaveBeenCalled();
  running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=one', true);
  expect(dedicated).toHaveBeenCalledTimes(2);
  expect(open).not.toHaveBeenCalled();
});
it('shares concurrent absence probes and never opens after the wake socket reconnects during a probe', async () => {
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=old', true);
  let release!: (value: boolean) => void;
  const probe = new Promise<boolean>(resolve => { release = resolve; });
  running.mockReturnValue(probe);
  const first = wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=new', true);
  const second = wakeBrowserUrl('https://chatgpt.com/?cos-input=other', true);
  await Promise.resolve(); release(false);
  await Promise.all([first, second]);
  expect(dedicated).toHaveBeenCalledTimes(2);
  running.mockImplementation(async () => { browser.connected = true; return false; });
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=third', true);
  expect(dedicated).toHaveBeenCalledTimes(2);
});
it('also opens for a first authored send when Chrome exited inside the HTTP presence window', async () => {
  browser.present = true; browser.lastSeenAt = Date.now(); running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-input=first');
  expect(dedicated).toHaveBeenCalledTimes(1);
});

it('shares one successful absence episode across input and discovery retries', async () => {
  await Promise.all([wakeBrowserUrl('https://chatgpt.com/?cos-input=one'), wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=two', true)]);
  running.mockResolvedValue(true);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=three', true);
  expect(dedicated).toHaveBeenCalledTimes(2);
  expect(open).not.toHaveBeenCalled();
  browser.connected = true; browser.present = true; browser.lastSeenAt = 100;
  await wakeBrowserUrl('https://chatgpt.com/');
  browser.connected = false; browser.present = false; running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=four', true);
  expect(dedicated).toHaveBeenCalledTimes(3);
  expect(open).not.toHaveBeenCalled();
});
it('retries a rejected launch only after explicit retry and keeps successful retry shared', async () => {
  dedicated.mockRejectedValueOnce(new Error('Microsoft Edge was not found'));
  await expect(wakeBrowserUrl('https://chatgpt.com/')).rejects.toThrow(/not found/);
  await expect(wakeBrowserUrl('https://chatgpt.com/')).rejects.toThrow(/not found/);
  expect(dedicated).toHaveBeenCalledTimes(1);
  await wakeBrowserUrl('https://chatgpt.com/', true);
  running.mockResolvedValue(true);
  await wakeBrowserUrl('https://chatgpt.com/', true);
  expect(dedicated).toHaveBeenCalledTimes(3);
  expect(open).not.toHaveBeenCalled();
});
it('waits for real absence after the wake channel closes with recent HTTP presence', async () => {
  browser.present = true; browser.lastSeenAt = Date.now(); browser.connected = true;
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=discovery');
  expect(open).not.toHaveBeenCalled();
  running.mockResolvedValue(true);
  browser.connected = false; // MV3 suspension or reconnect is not proof of browser absence
  await Promise.all([wakeBrowserUrl('https://chatgpt.com/?cos-input=first'), wakeBrowserUrl('https://chatgpt.com/?cos-input=second')]);
  expect(dedicated).toHaveBeenCalledTimes(1);
  expect(dedicated).toHaveBeenCalledWith('https://chatgpt.com/?cos-input=first', 'chrome');
  expect(open).not.toHaveBeenCalled();
  browser.present = false; running.mockResolvedValue(false);
  await wakeBrowserUrl('https://chatgpt.com/?cos-input=first');
  expect(dedicated).toHaveBeenCalledTimes(2);
  expect(open).not.toHaveBeenCalled();
});
it('starts cold model discovery in the dedicated Eve Browser profile instead of an ordinary OS profile', async () => {
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=one', true, true);
  expect(dedicated).toHaveBeenCalledWith('https://chatgpt.com/?cos-model-catalog=one', 'chrome');
  expect(open).not.toHaveBeenCalled();
});

it('opens an authorized recovery only after proving process absence, including stale HTTP absence', async () => {
  running.mockResolvedValue(null);
  const authority = { current: () => true };
  await wakeBrowserUrl('https://chatgpt.com/c/recovery', true, true, authority);
  expect(open).not.toHaveBeenCalled(); // Unknown process state is not absence.
  running.mockResolvedValue(true);
  await wakeBrowserUrl('https://chatgpt.com/c/recovery', true, true, authority);
  expect(open).not.toHaveBeenCalled(); // No socket/HTTP observation is not a closed browser.
  running.mockResolvedValue(false);
  await Promise.all([
    wakeBrowserUrl('https://chatgpt.com/c/recovery', true, true, authority),
    wakeBrowserUrl('https://chatgpt.com/?cos-input=concurrent')
  ]);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
});

it('gives native Chrome session restore first claim for bridge-owned cold starts', async () => {
  const authority = { current: () => true };
  await wakeBrowserUrl('https://chatgpt.com/c/owed-conversation', true, true, authority);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(restore).toHaveBeenCalledWith(undefined);
  expect(open).not.toHaveBeenCalled();
});

it('reopens an exact proven Prime through dedicated-profile recovery without forwarding it to the OS', async () => {
  const url = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
  await wakeBrowserUrl(url, true, true, { current: () => true, exactPrime: true });
  expect(restore).toHaveBeenCalledWith({
    exactRecoveryUrl: url,
    exactConversationOpen: conversationOpen,
    preferRestoredExact: true,
  });
  expect(open).not.toHaveBeenCalled();
});

it('shares one restore-first cold start across concurrent bridge recovery and durable input wake', async () => {
  let release!: () => void;
  restore.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ id: 77, restoredPages: true }); }));
  const authority = { current: () => true };
  const recovery = wakeBrowserUrl('https://chatgpt.com/c/owed-conversation', true, true, authority);
  const input = wakeBrowserUrl('https://chatgpt.com/?cos-input=concurrent');
  await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
  expect(open).not.toHaveBeenCalled();
  release();
  await Promise.all([recovery, input]);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
});

it('gives selected Edge the same dedicated-profile recovery path as Chrome', async () => {
  config.ui.chatBrowser = 'edge';
  await wakeBrowserUrl('https://chatgpt.com/c/recovery', true, true, { current: () => true });
  expect(restore).toHaveBeenCalledWith(undefined);
  expect(open).not.toHaveBeenCalled();
  expect(dedicated).not.toHaveBeenCalled();
});

it('cold-starts selected Brave in its dedicated profile', async () => {
  config.ui.chatBrowser = 'brave';
  await wakeBrowserUrl('https://chatgpt.com/?cos-input=brave');
  expect(dedicated).toHaveBeenCalledWith('https://chatgpt.com/?cos-input=brave', 'brave');
  expect(open).not.toHaveBeenCalled();
});

it('preserves failed restore retry semantics without falling through to an exact URL launch', async () => {
  const authority = { current: () => true };
  restore.mockRejectedValueOnce(new Error('native restore failed'));
  await expect(wakeBrowserUrl('https://chatgpt.com/c/recovery', false, true, authority)).rejects.toThrow('native restore failed');
  await expect(wakeBrowserUrl('https://chatgpt.com/c/recovery', false, true, authority)).rejects.toThrow('native restore failed');
  expect(restore).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  await expect(wakeBrowserUrl('https://chatgpt.com/c/recovery', true, true, authority)).resolves.toBeUndefined();
  expect(restore).toHaveBeenCalledTimes(2);
  expect(open).not.toHaveBeenCalled();
});

it('cannot open a recovery revoked while its process probe is pending', async () => {
  let current = true;
  let release!: (value: boolean) => void;
  running.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const work = wakeBrowserUrl('https://chatgpt.com/c/recovery', true, true,
    { current: () => current });
  await Promise.resolve();
  current = false; release(false);
  await work;
  expect(open).not.toHaveBeenCalled();
});

it('routes an initial explicit URL to the dedicated profile only with positive process evidence', async () => {
  running.mockResolvedValue(true);
  await wakeBrowserUrl('https://chatgpt.com/?cos-model-catalog=first', true, true);
  expect(dedicated).toHaveBeenCalledWith('https://chatgpt.com/?cos-model-catalog=first', 'chrome');
  expect(open).not.toHaveBeenCalled();
  resetBrowserStartupForTests(); dedicated.mockClear(); running.mockResolvedValue(null);
  await wakeBrowserUrl('https://chatgpt.com/?cos-input=first');
  expect(dedicated).not.toHaveBeenCalled();
});
