import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  LanPeerNicknameConflictError,
  forgetLanPeerReservations,
  lanPeerGroupId,
  lanPeerNicknameReservation,
  reserveLanPeerNickname,
  resetLanPeerReservationsForTests
} from '../src/main/lan-peer-reservations.js';
import { canonicalLanPeerNickname } from '../src/shared/lan-peer.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir = '';
const groupA = Buffer.alloc(32, 0x11);
const groupB = Buffer.alloc(32, 0x22);
const peerA = Buffer.alloc(32, 0xaa).toString('base64url');
const peerB = Buffer.alloc(32, 0xbb).toString('base64url');

beforeEach(async () => {
  dir = await makeTempDir('eve-lan-reservations-');
  initDurableStore(dir);
  resetLanPeerReservationsForTests();
});

afterEach(async () => {
  resetLanPeerReservationsForTests();
  resetDurableForTests();
  await removeTempDir(dir);
});

describe('LAN nickname reservations', () => {
  it('normalizes case and Unicode composition to one exact reservation name', async () => {
    expect(canonicalLanPeerNickname('  E\u0301VA  ')).toBe('éva');
    await expect(reserveLanPeerNickname(groupA, 'Éva', peerA)).resolves.toBe('claimed');
    await expect(reserveLanPeerNickname(groupA, 'éVA', peerA)).resolves.toBe('owned');
    expect(await lanPeerNicknameReservation(groupA, 'E\u0301va')).toEqual({ peerId: peerA, nickname: 'éVA' });
  });

  it('refuses a different installation fingerprint from taking an already reserved name', async () => {
    await reserveLanPeerNickname(groupA, 'Eva', peerA);
    await expect(reserveLanPeerNickname(groupA, 'eva', peerB)).rejects.toBeInstanceOf(LanPeerNicknameConflictError);
    expect(await lanPeerNicknameReservation(groupA, 'EVA')).toEqual({ peerId: peerA, nickname: 'Eva' });
  });

  it('allows the same installation to rename and releases only its previous alias', async () => {
    await reserveLanPeerNickname(groupA, 'Eva', peerA);
    await reserveLanPeerNickname(groupA, 'Kitchen Eve', peerB);
    await reserveLanPeerNickname(groupA, 'Eva Gaming', peerA);
    expect(await lanPeerNicknameReservation(groupA, 'Eva')).toBeNull();
    expect(await lanPeerNicknameReservation(groupA, 'Eva Gaming')).toEqual({ peerId: peerA, nickname: 'Eva Gaming' });
    expect(await lanPeerNicknameReservation(groupA, 'Kitchen Eve')).toEqual({ peerId: peerB, nickname: 'Kitchen Eve' });
  });

  it('scopes reservations to a one-way group id and forgets one group without touching another', async () => {
    expect(lanPeerGroupId(groupA)).not.toBe(lanPeerGroupId(groupB));
    await reserveLanPeerNickname(groupA, 'Eva', peerA);
    await reserveLanPeerNickname(groupB, 'Eva', peerB);
    const raw = await fs.readFile(path.join(dir, 'state', 'lan-peer-reservations.json'), 'utf8');
    expect(raw).not.toContain(groupA.toString('base64url'));
    expect(raw).not.toContain(groupB.toString('base64url'));
    await forgetLanPeerReservations(groupA);
    expect(await lanPeerNicknameReservation(groupA, 'Eva')).toBeNull();
    expect(await lanPeerNicknameReservation(groupB, 'Eva')).toEqual({ peerId: peerB, nickname: 'Eva' });
  });

  it('fails closed on malformed durable reservation state instead of treating it as empty', async () => {
    await fs.mkdir(path.join(dir, 'state'), { recursive: true });
    await fs.writeFile(path.join(dir, 'state', 'lan-peer-reservations.json'), '{"version":1,"groups":{"bad":{}}}', 'utf8');
    await expect(reserveLanPeerNickname(groupA, 'Eva', peerA)).rejects.toThrow(/malformed/i);
  });

  it.each(['E\u200Bva', 'E\u202Eva'])('rejects invisible/format-control nickname %j at the LAN identity boundary', value => {
    expect(() => canonicalLanPeerNickname(value)).toThrow(/nickname is invalid/i);
  });
});
