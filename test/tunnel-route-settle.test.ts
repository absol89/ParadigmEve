import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initDurableStore, writeDurableNow } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  ROUTE_SETTLE_MS, noteTunnelClientConnected, noteRouteExistingChatSend,
  noteRouteRequestArrived, noteRouteRequestSighted, routeHoldMs, tunnelRouteSettling,
  tunnelRouteSettlingUntil, restoreRouteHold, resetRouteSettleForTests
} from '../src/main/tunnel/route-settle.js';

const CHAT = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const START = 1_790_000_000_000;
let durableDir: string;

beforeAll(async () => {
  durableDir = await makeTempDir('clf-route-hold-');
  initDurableStore(durableDir);
});
afterAll(async () => removeTempDir(durableDir));
afterEach(() => resetRouteSettleForTests());

describe('bounded OpenAI tunnel route settling', () => {
  it('holds only the existing-chat browser claim window and is never lengthened by reconnect reports', () => {
    noteTunnelClientConnected(START);
    expect(tunnelRouteSettling(START + ROUTE_SETTLE_MS - 1)).toBe(true);
    expect(tunnelRouteSettlingUntil(START)).toBe(START + ROUTE_SETTLE_MS);
    expect(tunnelRouteSettling(START + ROUTE_SETTLE_MS)).toBe(false);
    expect(tunnelRouteSettlingUntil(START + ROUTE_SETTLE_MS)).toBeNull();
  });

  it('grows the hold only for a late exact request from the first existing chat after takeover', () => {
    noteTunnelClientConnected(START);
    noteRouteExistingChatSend(CHAT, START + 35_500);
    noteRouteRequestSighted('wfr_wrong', OTHER, START + 36_000);
    noteRouteRequestArrived('wfr_wrong', START + 160_000);
    expect(routeHoldMs()).toBe(ROUTE_SETTLE_MS);
    noteRouteRequestSighted('wfr_own', CHAT, START + 37_000, START + 36_500);
    noteRouteRequestArrived('wfr_other', START + 190_000);
    expect(routeHoldMs()).toBe(ROUTE_SETTLE_MS);
    noteRouteRequestArrived('wfr_own', START + 162_000);
    expect(routeHoldMs()).toBe(52_500);
    noteRouteRequestArrived('wfr_own', START + 200_000);
    expect(routeHoldMs()).toBe(52_500);
  });

  it('rejects stale pre-send evidence, supports ingress-before-page, and shrinks only after three fast takeovers', () => {
    for (let i = 0; i < 3; i++) {
      const now = START + i * 400_000;
      noteTunnelClientConnected(now);
      noteRouteExistingChatSend(CHAT, now + 35_500);
      noteRouteRequestSighted('old', CHAT, now + 36_000, now - 20_000);
      noteRouteRequestArrived('old', now + 36_050);
      expect(routeHoldMs()).toBe(ROUTE_SETTLE_MS);
      const id = `fast_${i}`;
      noteRouteRequestArrived(id, now + 36_200);
      noteRouteRequestSighted(id, CHAT, now + 36_500, now + 36_000);
      if (i < 2) expect(routeHoldMs()).toBe(ROUTE_SETTLE_MS);
    }
    expect(routeHoldMs()).toBe(30_000);
  });

  it('never learns from a new chat, a too-late first send or an unrelated request', () => {
    noteTunnelClientConnected(START);
    noteRouteExistingChatSend('', START + 40_000);
    noteRouteExistingChatSend(CHAT, START + 6 * 60_000);
    noteRouteRequestSighted('late', CHAT, START + 361_000);
    noteRouteRequestArrived('late', START + 500_000);
    expect(routeHoldMs()).toBe(ROUTE_SETTLE_MS);
  });

  it('restores only bounded versioned values and resets malformed streaks without opening a hold', async () => {
    for (const invalid of [
      { version: 2, holdMs: 50_000, fastStreak: 1 },
      { version: 1, holdMs: 100_000, fastStreak: 1 },
      { version: 1, holdMs: -1, fastStreak: 1 },
      { version: 1, holdMs: '50000', fastStreak: 1 },
      { version: 1, holdMs: 12_000.5, fastStreak: 1 }
    ]) {
      await writeDurableNow('route-hold', invalid);
      await restoreRouteHold();
      expect(routeHoldMs()).toBe(ROUTE_SETTLE_MS);
      expect(tunnelRouteSettling(START)).toBe(false);
    }
    await writeDurableNow('route-hold', { version: 1, holdMs: 45_000, fastStreak: 99 });
    await restoreRouteHold();
    expect(routeHoldMs()).toBe(45_000);
    for (let i = 0; i < 2; i++) {
      const now = START + i * 400_000;
      noteTunnelClientConnected(now);
      noteRouteExistingChatSend(CHAT, now + 45_500);
      noteRouteRequestSighted(`restored_${i}`, CHAT, now + 46_000, now + 45_500);
      noteRouteRequestArrived(`restored_${i}`, now + 46_100);
    }
    // Invalid persisted streak was ignored; two fast routes do not shorten the hold.
    expect(routeHoldMs()).toBe(45_000);
    resetRouteSettleForTests();
    await writeDurableNow('route-hold', { version: 1, holdMs: 55_000, fastStreak: 2 });
    await restoreRouteHold();
    const now = START + 1_000_000;
    noteTunnelClientConnected(now);
    noteRouteExistingChatSend(CHAT, now + 55_500);
    noteRouteRequestSighted('fast_restored', CHAT, now + 56_000, now + 55_500);
    noteRouteRequestArrived('fast_restored', now + 56_100);
    expect(routeHoldMs()).toBe(50_000);
  });

  it('starts one new bounded settle episode for a second newly connected process', () => {
    noteTunnelClientConnected(START);
    noteTunnelClientConnected(START + 5_000);
    expect(tunnelRouteSettlingUntil(START + 6_000)).toBe(START + 5_000 + ROUTE_SETTLE_MS);
    expect(tunnelRouteSettling(START + ROUTE_SETTLE_MS + 5_000)).toBe(false);
  });
});
