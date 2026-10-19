/**
 * Focused regression for the Companion journal persistence queue.
 *
 * This executes the shipped persistence functions from background.js rather than copying their
 * implementation into the test. The storage fake snapshots input when `set()` starts, matching
 * Chrome's async whole-value write boundary closely enough to prove both coalescing and ACK timing.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { expect, it } from 'vitest';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it('coalesces observations arriving during a journal write without acknowledging before storage', async () => {
  const background = (await fs.readFile(path.join(process.cwd(), 'extension', 'background.js'), 'utf8'))
    .replace(/\r\n/g, '\n');
  const start = background.indexOf('let durabilityGap = false;');
  const end = background.indexOf('// --------------------------------------------------------------------- journal', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  const journal: Array<{ event: { text: string } }> = [];
  const writes: string[][] = [];
  const firstWrite = deferred();
  const secondWrite = deferred();
  let writeCount = 0;
  const chrome = {
    storage: {
      session: {
        async set(values: { journal?: Array<{ event: { text: string } }> }) {
          if (!Array.isArray(values.journal)) return;
          writes.push(structuredClone(values.journal).map((entry) => entry.event.text));
          writeCount += 1;
          if (writeCount === 1) await firstWrite.promise;
          if (writeCount === 2) await secondWrite.promise;
        }
      }
    }
  };
  const context: Record<string, unknown> = {
    chrome,
    journal,
    makeRoom: () => undefined,
    gapEntry: () => ({ event: { text: 'gap' } })
  };
  vm.runInNewContext(
    `${background.slice(start, end)}\nglobalThis.__persistJournal = persistJournal;`,
    context,
    { filename: 'background-journal-slice.js' }
  );
  const persistJournal = context.__persistJournal as () => Promise<boolean>;

  journal.push({ event: { text: 'A' } });
  let firstAck = false;
  const first = persistJournal().then((value) => { firstAck = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(writes).toEqual([['A']]);
  expect(firstAck).toBe(false);

  const laterAcks = ['B', 'C', 'D', 'E'].map((text) => {
    journal.push({ event: { text } });
    let acked = false;
    const promise = persistJournal().then((value) => { acked = true; return value; });
    return { promise, acked: () => acked };
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(writes).toEqual([['A']]);
  expect(laterAcks.every((entry) => !entry.acked())).toBe(true);

  firstWrite.resolve();
  await first;
  expect(firstAck).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(writes).toEqual([['A'], ['A', 'B', 'C', 'D', 'E']]);
  expect(laterAcks.every((entry) => !entry.acked())).toBe(true);

  secondWrite.resolve();
  await Promise.all(laterAcks.map((entry) => entry.promise));
  expect(laterAcks.every((entry) => entry.acked())).toBe(true);
  expect(writes).toHaveLength(2);
});
