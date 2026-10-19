/**
 * Worker placement/revival eligibility at the Companion boundary.
 *
 * ParadigmEve 2.4.2 still has one authenticated Companion browser rather than upstream's
 * multi-browser host/build election. Its equivalent safety boundary is earlier: once the
 * current Companion generation is the configured floor, an older Companion is rejected before
 * `/status` can inspect (and placement can consume) worker work. Keep that ordering explicit so
 * a stale poll cannot steal a tab or wake from the current dedicated browser.
 */
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const recoveryBrowserWake = vi.hoisted(() => vi.fn(async (_url: string) => {}));
vi.mock('../src/main/browser-startup.js', () => ({ wakeBrowserUrl: recoveryBrowserWake }));

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'unknown'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  clipboard: {},
  shell: {}
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const {
  pendingCommands,
  resetBridgeForTests,
  setBrowserOpener,
  shutdownBridge,
  startBridge
} = await import('../src/main/bridge.js');
const { flushDurable, initDurableStore, writeDurableNow, writeDurableSoon } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { resetInboundRequestsForTests } = await import('../src/main/mcp/inbound.js');
const { resetAgentIdentityForTests } = await import('../src/main/agent-identity.js');
const {
  finishAgent,
  onSwarmPersistNow,
  pendingWorkerRevivals,
  requestWorkerRevivals,
  resetSwarm,
  spawn,
  stageMessages
} = await import('../src/main/agents.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const PRIME_CHAT = 'c-prime-bridge-eligibility';
const WORKER_CHAT = 'abababab-7654-4210-8edc-ba9876543210';
const STALE_VERSION = '0.0.1';

let dir: string;
let base: string;
let token: string | null = null;
let suiteConfig: ReturnType<typeof defaultConfig>;
const opened: string[] = [];

interface Reply {
  status: number;
  body: any;
}

function request(
  method: string,
  path: string,
  options: { body?: unknown; auth?: string | null; extensionVersion?: string } = {}
): Promise<Reply> {
  const url = new URL(path, base);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    origin: EXTENSION_ORIGIN,
    'x-extension-version': options.extensionVersion ?? APP_VERSION,
    'x-extension-protocol': String(BRIDGE_PROTOCOL)
  };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  const auth = options.auth === undefined ? token : options.auth;
  if (auth) headers.authorization = `Bearer ${auth}`;

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function pairCurrentCompanion(): Promise<void> {
  const reply = await request('POST', '/pair', { auth: null });
  expect(reply.status).toBe(200);
  token = reply.body.token as string;
}

beforeAll(async () => {
  dir = await makeTempDir('eve-bridge-worker-eligibility-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
  const baseConfig = defaultConfig();
  suiteConfig = {
    ...baseConfig,
    bridge: { ...baseConfig.bridge, companionFloor: APP_VERSION },
    sessions: { ...baseConfig.sessions, record: true },
    multiAgent: { ...baseConfig.multiAgent, enabled: true, recoverAgentTabs: true }
  };
  await saveConfig(suiteConfig);
  const port = await startBridge();
  expect(port).not.toBeNull();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await shutdownBridge();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  await saveConfig(suiteConfig);
  resetSwarm();
  resetAgentIdentityForTests();
  resetBridgeForTests();
  resetRecorderForTests();
  resetInboundRequestsForTests();
  writeDurableSoon('bridge-commands', null);
  await flushDurable();
  await setSecret('bridgeToken', '');
  token = null;
  opened.length = 0;
  setBrowserOpener(async (url) => { opened.push(url); });
});

describe('worker browser eligibility', () => {
  it('lets stale/current status polling share no placement or revival work, and leases each command only once', async () => {
    await pairCurrentCompanion();

    const socket = new WebSocket(base.replace('http:', 'ws:') + '/wake', { origin: EXTENSION_ORIGIN });
    await once(socket, 'open');
    const authenticated = once(socket, 'message');
    socket.send(token!);
    await authenticated;

    try {
      const run = spawn({ workers: [{ task: 'prove worker browser eligibility' }], caller: { conversationId: PRIME_CHAT } });
      await vi.waitFor(() => {
        expect(pendingCommands()).toContainEqual(expect.objectContaining({ what: `worker:${run.runId}:worker-1` }));
      });

      // The old Companion polls first. Because compatibility is checked before `/status`, it
      // cannot spend pendingBrowserPlacement()'s one-shot handout.
      const stalePlacementPoll = await request('GET', '/status', { extensionVersion: STALE_VERSION });
      expect(stalePlacementPoll.status).toBe(426);
      expect(stalePlacementPoll.body).toMatchObject({
        error: 'superseded_extension',
        minimumExtensionVersion: APP_VERSION
      });

      let placement: any = null;
      await vi.waitFor(async () => {
        placement ||= (await request('GET', '/status')).body.placement;
        expect(placement).toMatchObject({ id: expect.any(String), active: false });
      });
      // Placement is a handout, not a poll-visible queue: the eligible browser gets exactly one.
      expect((await request('GET', '/status')).body.placement).toBeNull();
      expect(opened).toEqual([]);

      const bootstrap = await request('POST', '/commands/redeem', {
        body: { id: placement.id, client: 'eligible-bootstrap-tab' }
      });
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.body.command).toMatchObject({ type: 'worker', agent: 'worker-1' });
      const bootAck = await request('POST', '/commands/ack', {
        body: {
          id: placement.id,
          status: 'sent',
          conversationId: WORKER_CHAT,
          client: 'eligible-bootstrap-tab',
          agent: 'worker-1'
        }
      });
      expect(bootAck.status).toBe(200);

      finishAgent({ conversationId: WORKER_CHAT }, 'finished first pass');
      const staged = stageMessages({ conversationId: PRIME_CHAT }, [{ to: 'worker-1', text: 'one more check' }]);
      expect(staged.waking).toEqual(['worker-1']);
      expect(requestWorkerRevivals(staged.waking, run.runId)).toBe(1);
      await vi.waitFor(() => expect(pendingWorkerRevivals()).toHaveLength(1));

      // Reverse the order for the existing-chat wake: current sees the exact offer, stale still
      // cannot touch it, and the current browser continues to own the same command until redeem.
      const currentWakePoll = await request('GET', '/status');
      expect(currentWakePoll.body.revival).toMatchObject({
        id: expect.any(String),
        conversationId: WORKER_CHAT
      });
      const revivalId = currentWakePoll.body.revival.id as string;

      const staleWakePoll = await request('GET', '/status', { extensionVersion: STALE_VERSION });
      expect(staleWakePoll.status).toBe(426);
      expect((await request('GET', '/status')).body.revival).toMatchObject({ id: revivalId, conversationId: WORKER_CHAT });

      const redeemed = await request('POST', '/commands/redeem', {
        body: { id: revivalId, client: 'eligible-revival-tab', conversationId: WORKER_CHAT }
      });
      expect(redeemed.status).toBe(200);
      expect(redeemed.body.command).toMatchObject({ type: 'revive', conversationId: WORKER_CHAT });
      expect((await request('GET', '/status')).body.revival).toBeNull();

      // A second document cannot turn the same status offer into duplicate work.
      const duplicate = await request('POST', '/commands/redeem', {
        body: { id: revivalId, client: 'different-revival-tab', conversationId: WORKER_CHAT }
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error).toBe('command_taken');
    } finally {
      const closed = once(socket, 'close');
      socket.close();
      await closed;
    }
  });
});
