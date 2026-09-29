import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';

/**
 * Reboot recovery, end to end through the real session store, input queue, bridge and IPC wiring.
 *
 * The unit tests in recovery-memory.test.ts mock the store and the queue, so they prove that a
 * wake is *queued*. What the user sees is whether it is *delivered*: after the 2026-09-29 reboot
 * the wake and the user's next message sat queued for Eve with a clock icon and never reached
 * ChatGPT. That happens at the boundary these tests exercise — the Companion's `/status` census,
 * which is the only way a queued browser input ever gets handed to a page.
 */
type Handler = (event: unknown, payload: unknown) => Promise<any>;
const handlers = new Map<string, Handler>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {}, nativeTheme: { themeSource: 'system' },
  app: { getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async (data: Buffer) => ({ result: data.toString(), shouldReEncrypt: false })
  }
}));
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd() }));
vi.mock('../src/main/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/connection.js')>();
  return { ...actual, connect: async () => {}, getStatus: () => ({ ...actual.getStatus(), state: 'connected' }) };
});
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: async () => 'chrome.exe', isPreferredBrowserRunning: async () => null }));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, writeDurableNow } = await import('../src/main/durable.js');
const { getSession, rebindSession, initSessionStore } = await import('../src/main/session/store.js');
const { registerIpc } = await import('../src/main/ipc.js');
const { bridgePort, startBridge, stopBridge } = await import('../src/main/bridge.js');
const input = await import('../src/main/session/input.js');
const { queuePrimeRestartRecovery } = await import('../src/main/session/recovery-memory.js');
const { restoreAgentIdentity, resetAgentIdentityForTests } = await import('../src/main/agent-identity.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let chatSeq = 0;
/** A fresh pair of ChatGPT-shaped ids per test, so one test's durable rebind never meets another's. */
function chats(): { a: string; b: string } {
  chatSeq += 1;
  const n = String(chatSeq).padStart(4, '0');
  return { a: `6ab994e4-93a0-83eb-ba8c-9900b7f2${n}`, b: `6abbf45a-c3fc-83eb-9bdd-5a59ce97${n}` };
}

let directory: string;
let bearer = '';
const rendererWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } };

async function call(method: 'GET' | 'POST', route: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, {
    method,
    headers: {
      'content-type': 'application/json', 'x-extension-version': APP_VERSION,
      'x-extension-protocol': String(BRIDGE_PROTOCOL), ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() as any };
}

/**
 * What survives a reboot is what is on disk. Drop the recorder's live page state (which chat is
 * generating) and the queue's memory, exactly as a new process starts; durable sessions, events,
 * inputs and the Eve identity stay.
 */
async function reboot(): Promise<void> {
  resetRecorderForTests();
  input.resetInputForTests();
}

/** What the Companion's maintenance pass is told to deliver right now. */
async function handedToBrowser(): Promise<Array<{ id: string; conversationId: string | null }>> {
  const status = await call('GET', '/status');
  expect(status.status).toBe(200);
  return status.body.inputs ?? [];
}

/**
 * Eve worked in chat A, a Compact & Resume moved her durable session to chat B, and then the
 * app rebooted. The last lifecycle row in the session is still chat A's turn_start: B's page has
 * not reported a turn of its own yet. That is exactly the durable state of session
 * 2026-09-27-100d21a7 on 2026-09-29.
 */
async function eveMovedToChatB(CHAT_A: string, CHAT_B: string): Promise<string> {
  const recorded = await call('POST', '/events', {
    conversationId: CHAT_A,
    events: [
      { kind: 'user_message', time: Date.now() - 120_000, text: 'keep working', messageId: 'm-a-1' },
      { kind: 'turn_start', time: Date.now() - 110_000, turnId: 'turn-in-a' }
    ]
  });
  expect(recorded.status).toBe(200);
  const sessionId = recorded.body.sessionId as string;
  expect(sessionId).toBeTruthy();
  expect(await rebindSession(sessionId, CHAT_A, CHAT_B)).toBe(true);
  const moved = await getSession(sessionId);
  expect(moved).toMatchObject({ conversationId: CHAT_B, activeTurnId: null });
  resetAgentIdentityForTests();
  restoreAgentIdentity({ version: 1, conversationId: CHAT_B });
  return sessionId;
}

beforeAll(async () => {
  directory = await makeTempDir('clf-restart-recovery-');
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
  registerIpc(() => rendererWindow as never, () => undefined);
  await startBridge();
  const paired = await call('POST', '/pair', {});
  expect(paired.status).toBe(200);
  bearer = paired.body.token;
});

afterAll(async () => {
  await stopBridge();
  await removeTempDir(directory);
});

beforeEach(async () => {
  await writeDurableNow('session-input', []);
  input.resetInputForTests();
});

describe('reboot recovery of the exact Eve conversation', () => {
  it('hands the restart wake to the browser for the chat Eve now lives in', async () => {
    const { a: CHAT_A, b: CHAT_B } = chats();
    const sessionId = await eveMovedToChatB(CHAT_A, CHAT_B);

    await reboot();
    const plan = await queuePrimeRestartRecovery(CHAT_B);
    expect(plan, 'restart recovery found no exact Eve session to wake').not.toBeNull();
    expect(plan).toMatchObject({ sessionId, conversationId: CHAT_B, exactPrime: true, url: `https://chatgpt.com/c/${CHAT_B}` });
    expect(plan!.entry, 'the wake was not durably queued').toMatchObject({ state: 'queued' });

    // The proof that recovery works: the Companion is told to deliver the wake to chat B.
    expect(await handedToBrowser()).toContainEqual(expect.objectContaining({ id: plan!.inputId, conversationId: CHAT_B }));
  });

  it('delivers the user message typed after the reboot once the wake has gone', async () => {
    const { a: CHAT_A, b: CHAT_B } = chats();
    const sessionId = await eveMovedToChatB(CHAT_A, CHAT_B);
    await reboot();
    const plan = await queuePrimeRestartRecovery(CHAT_B);
    const claimed = await call('POST', '/input/claim', { id: plan!.inputId, owner: 'chat-b-page', conversationId: CHAT_B });
    expect(claimed.status, 'the browser could not claim the restart wake').toBe(200);
    const acked = await call('POST', '/input/ack', { id: plan!.inputId, owner: 'chat-b-page', conversationId: CHAT_B, messageId: 'wake-in-b' });
    expect(acked.status, JSON.stringify(acked.body)).toBe(200);
    // ChatGPT answers the wake and the page reports that turn's lifecycle.
    await call('POST', '/events', {
      conversationId: CHAT_B,
      events: [
        { kind: 'turn_start', time: Date.now() - 2_000, turnId: 'wake-turn' },
        { kind: 'turn_end', time: Date.now() - 1_000, turnId: 'wake-turn', outcome: 'completed' }
      ]
    });

    const typed = await input.enqueueInput({
      id: randomUUID(), sessionId, text: 'is this eve chat prime?', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null
    });
    // The user's message must not be parked on a tool result that no turn will produce.
    expect(typed.transportIntent).not.toBe('tool');
    expect(await handedToBrowser()).toContainEqual(expect.objectContaining({ id: typed.id, conversationId: CHAT_B }));
  });

  /**
   * The state in the 2026-09-29 screenshot: after the reboot chat B's page reported a turn start
   * and later its final answer, but never the turn end. The app kept drawing Eve as generating,
   * held the restart wake as "maybe busy" and parked the user's message on a tool result.
   */
  it('still delivers the wake when chat B published its final answer but never reported the turn end', async () => {
    const { a: CHAT_A, b: CHAT_B } = chats();
    const sessionId = await eveMovedToChatB(CHAT_A, CHAT_B);
    const reported = await call('POST', '/events', {
      conversationId: CHAT_B,
      events: [
        { kind: 'turn_start', time: Date.now() - 100_000, turnId: 'turn-in-b' },
        { kind: 'assistant_message', time: Date.now() - 90_000, turnId: 'turn-in-b', messageId: 'final-in-b',
          text: 'Done. Everything is committed.', state: 'final', final: true }
      ]
    });
    expect(reported.status).toBe(200);
    expect(reported.body.sessionId).toBe(sessionId);

    await reboot();
    const plan = await queuePrimeRestartRecovery(CHAT_B);
    expect(plan?.entry, 'the wake was not durably queued').toMatchObject({ state: 'queued' });
    expect(await handedToBrowser(), 'the restart wake never reaches the browser').toContainEqual(
      expect.objectContaining({ id: plan!.inputId, conversationId: CHAT_B })
    );
  });

  /**
   * The durable state that broke every reboot on 2026-09-29 (replayed from session
   * 2026-09-27-100d21a7): the Compact & Resume bootstrap was typed into chat B and recorded as a
   * user message, but B's page never reported the turn that message started. The newest lifecycle
   * row was therefore a user message with no turn_start after it, and the "the provider turn has
   * not started yet" fence treated Eve as busy forever. The wake could never be delivered, each
   * later restart wake was refused as a second queued message, and the user's own text sat
   * behind them.
   */
  it('delivers the wake after a reboot even when the last recorded message never got its turn_start', async () => {
    const { a: CHAT_A, b: CHAT_B } = chats();
    const sessionId = await eveMovedToChatB(CHAT_A, CHAT_B);
    const bootstrap = await call('POST', '/events', {
      conversationId: CHAT_B,
      events: [{ kind: 'user_message', time: Date.now() - 10 * 60_000, text: 'Continue from this brief.', messageId: 'bootstrap-in-b' }]
    });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.sessionId).toBe(sessionId);

    // The reboot came an hour later (only the clock moves; timers keep running for the bridge).
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await reboot();
      const plan = await queuePrimeRestartRecovery(CHAT_B);
      expect(plan?.entry, 'the wake was not durably queued').toMatchObject({ state: 'queued' });
      expect(await handedToBrowser(), 'the restart wake never reaches the browser').toContainEqual(
        expect.objectContaining({ id: plan!.inputId, conversationId: CHAT_B })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
