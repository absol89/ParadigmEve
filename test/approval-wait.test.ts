import { beforeEach, expect, it, vi } from 'vitest';
import {
  APPROVAL_FRESH_MS, APPROVAL_NOTICE_GRACE_MS,
  APPROVAL_CLEARED_TEXT, APPROVAL_WAITING_TEXT,
  approvalCardWaiting, noteApprovalCard, resetApprovalWaits
} from '../src/main/approval-wait.js';

const record = vi.fn(async (_session: string, _id: string, _text: string, _anchor?: { seq: number; time: number }) => ({ seq: 7, time: 100 }));
const notify = vi.fn();
const log = vi.fn();
const deps = { record, notify, log };
beforeEach(() => { resetApprovalWaits(); vi.clearAllMocks(); });

it('projects one pending episode and one delayed notice, even after repeated hidden activity polls', async () => {
  await noteApprovalCard('prime', true, 'session', deps, 1000);
  expect(approvalCardWaiting('prime', 1000)).toBe(true);
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0]?.[2]).toBe(APPROVAL_WAITING_TEXT);
  expect(notify).not.toHaveBeenCalled();
  await noteApprovalCard('prime', true, 'session', deps, 1000 + APPROVAL_NOTICE_GRACE_MS);
  await noteApprovalCard('prime', true, 'session', deps, 1000 + APPROVAL_NOTICE_GRACE_MS + 500);
  expect(notify).toHaveBeenCalledTimes(1);
  await noteApprovalCard('prime', false, 'session', deps, 32_000);
  expect(approvalCardWaiting('prime', 32_000)).toBe(false);
  expect(record).toHaveBeenCalledTimes(2);
  expect(record.mock.calls[1]?.[2]).toBe(APPROVAL_CLEARED_TEXT);
  expect(record.mock.calls[1]?.[3]).toEqual({ seq: 7, time: 100 });
});

it('expires the hold without falsely claiming a human answered after the page stopped polling', async () => {
  await noteApprovalCard('prime', true, 'session', deps, 1000);
  expect(approvalCardWaiting('prime', 1000 + APPROVAL_FRESH_MS)).toBe(false);
  await noteApprovalCard('prime', true, 'session', deps, 1000 + APPROVAL_FRESH_MS);
  expect(record).toHaveBeenCalledTimes(2);
  expect(record.mock.calls.every(call => call[2] === APPROVAL_WAITING_TEXT)).toBe(true);
});

it('keeps approval observations isolated by exact conversation and never interprets disappearance as human denial', async () => {
  await noteApprovalCard('chat-a', true, 'session-a', deps, 1000);
  await noteApprovalCard('chat-b', true, 'session-b', deps, 2000);
  expect(approvalCardWaiting('chat-a', 2000)).toBe(true);
  expect(approvalCardWaiting('chat-b', 2000)).toBe(true);
  await noteApprovalCard('chat-a', false, 'session-a', deps, 3000);
  expect(approvalCardWaiting('chat-a', 3000)).toBe(false);
  expect(approvalCardWaiting('chat-b', 3000)).toBe(true);
  expect(record.mock.calls.at(-1)?.[2]).toBe(APPROVAL_CLEARED_TEXT);
  expect(record.mock.calls.at(-1)?.[2]).not.toMatch(/denied|approved|rejected/i);
  expect(notify).not.toHaveBeenCalled();
});
