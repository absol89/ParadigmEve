import { expect, it } from 'vitest';
import { chronological, type Chronological } from '../src/shared/chronology.js';

type Entry = Chronological & { id: string };

it('places a consolidated final after the steer question and continued-turn tools', () => {
  const rows: Entry[] = [
    { id: 'q1', seq: 1, origin: 1, time: 1, kind: 'user_message' },
    { id: 'start1', seq: 2, origin: 2, time: 2, kind: 'turn_start', turnId: 't1' },
    { id: 'tool1', seq: 3, origin: 3, time: 3, kind: 'tool_call', turnId: 't1' },
    { id: 'steer', seq: 4, origin: 4, time: 4, kind: 'user_message' },
    { id: 'end1', seq: 5, origin: 5, time: 5, kind: 'turn_end', turnId: 't1', continued: true },
    { id: 'start2', seq: 6, origin: 6, time: 6, kind: 'turn_start', turnId: 't2' },
    { id: 'tool2', seq: 7, origin: 7, time: 7, kind: 'tool_call', turnId: 't2' },
    // ChatGPT kept the original turn id/origin but wrote the final content during t2.
    { id: 'final', seq: 8, origin: 3.5, contentSeq: 8, time: 3.5, kind: 'assistant_message', turnId: 't1', final: true, state: 'final' },
    { id: 'end2', seq: 9, origin: 9, time: 9, kind: 'turn_end', turnId: 't2' }
  ];
  const ids = chronological(rows).map(row => row.id);
  expect(ids.indexOf('steer')).toBeLessThan(ids.indexOf('tool2'));
  expect(ids.indexOf('tool2')).toBeLessThan(ids.indexOf('final'));
  expect(ids.indexOf('final')).toBeLessThan(ids.indexOf('end2'));
});

it('keeps a final written before the steer as the closing message of its original turn', () => {
  const rows: Entry[] = [
    { id: 'start1', seq: 1, origin: 1, time: 1, kind: 'turn_start', turnId: 't1' },
    { id: 'tool1', seq: 2, origin: 2, time: 2, kind: 'tool_call', turnId: 't1' },
    { id: 'final1', seq: 3, origin: 3, contentSeq: 3, time: 3, kind: 'assistant_message', turnId: 't1', final: true },
    { id: 'steer', seq: 4, origin: 4, time: 4, kind: 'user_message' },
    { id: 'end1', seq: 5, origin: 5, time: 5, kind: 'turn_end', turnId: 't1', continued: true },
    { id: 'start2', seq: 6, origin: 6, time: 6, kind: 'turn_start', turnId: 't2' },
    { id: 'tool2', seq: 7, origin: 7, time: 7, kind: 'tool_call', turnId: 't2' },
    { id: 'final2', seq: 8, origin: 8, contentSeq: 8, time: 8, kind: 'assistant_message', turnId: 't2', final: true },
    { id: 'end2', seq: 9, origin: 9, time: 9, kind: 'turn_end', turnId: 't2' }
  ];
  const ids = chronological(rows).map(row => row.id);
  expect(ids.indexOf('tool1')).toBeLessThan(ids.indexOf('final1'));
  expect(ids.indexOf('final1')).toBeLessThan(ids.indexOf('end1'));
  expect(ids.indexOf('tool2')).toBeLessThan(ids.indexOf('final2'));
});
