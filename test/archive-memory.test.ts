import { describe, expect, it } from 'vitest';
import {
  ArchiveMemoryLedger,
  archiveMemoryJsonl,
  parseArchiveMemoryJsonl,
  type ArchiveMemorySourceRef
} from '../src/main/archive/archive-memory.js';

const source = (eventSeq: number): ArchiveMemorySourceRef => ({ sessionId: 'session-archive-0001', eventSeq });

describe('archive provider-neutral memory', () => {
  it('keeps curated memory separate from exact immutable evidence references', () => {
    const refs: ArchiveMemorySourceRef[] = [source(12)];
    const ledger = new ArchiveMemoryLedger();
    const created = ledger.create({
      scope: 'project',
      scopeId: 'project-alpha',
      text: 'Prefer short release checklists.',
      sourceRefs: refs,
      authoredBy: 'user'
    }, { id: 'memory-1', now: 100 });

    refs[0]!.eventSeq = 99;
    refs.push(source(13));
    expect(created.sourceRefs).toEqual([{ sessionId: 'session-archive-0001', eventSeq: 12 }]);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.sourceRefs)).toBe(true);
    expect(Object.isFrozen(created.sourceRefs[0])).toBe(true);
    expect(created).not.toHaveProperty('evidence');
  });

  it('enforces global/project/thread/agent scope identity and exact provenance', () => {
    const ledger = new ArchiveMemoryLedger();
    expect(ledger.create({ scope: 'global', text: 'Use Swedish dates.', sourceRefs: [source(1)], authoredBy: 'user' }, { id: 'g', now: 1 }).scopeId).toBeUndefined();
    expect(ledger.create({ scope: 'thread', scopeId: 'thread-1', text: 'Architecture decisions.', sourceRefs: [source(2)], authoredBy: 'eve' }, { id: 't', now: 2 }).scopeId).toBe('thread-1');
    expect(ledger.create({ scope: 'agent', scopeId: 'eva', text: 'Eva owns gaming-PC checks.', sourceRefs: [source(3)], authoredBy: 'system' }, { id: 'a', now: 3 }).scopeId).toBe('eva');
    expect(() => ledger.create({ scope: 'global', scopeId: 'wrong', text: 'x', sourceRefs: [source(4)], authoredBy: 'user' })).toThrow(/global memory/i);
    expect(() => ledger.create({ scope: 'project', text: 'x', sourceRefs: [source(4)], authoredBy: 'user' })).toThrow(/scope id/i);
    expect(() => ledger.create({ scope: 'project', scopeId: 'p', text: 'x', sourceRefs: [{ sessionId: 'session-archive-0001' }], authoredBy: 'user' })).toThrow(/event or asset/i);
  });

  it('supersedes without erasing old text/provenance and retires only the active replacement', () => {
    const ledger = new ArchiveMemoryLedger();
    const original = ledger.create({
      scope: 'project', scopeId: 'p1', text: 'Old preference', sourceRefs: [source(5)], authoredBy: 'user'
    }, { id: 'old', now: 10 });
    const replacement = ledger.supersede('old', {
      scope: 'project', scopeId: 'p1', text: 'New preference', sourceRefs: [source(6)], authoredBy: 'user'
    }, { id: 'new', now: 20 });

    expect(original.status).toBe('active');
    expect(ledger.get('old')).toMatchObject({ text: 'Old preference', status: 'superseded', supersededById: 'new' });
    expect(ledger.get('old')?.sourceRefs).toEqual([source(5)]);
    expect(replacement).toMatchObject({ text: 'New preference', status: 'active', supersedesId: 'old' });
    expect(() => ledger.retire('old', 21)).toThrow(/only active/i);
    expect(ledger.retire('new', 22)).toMatchObject({ status: 'retired', supersedesId: 'old', updatedAt: 22 });
    expect(ledger.get('old')?.status).toBe('superseded');
  });

  it('round-trips an auditable lifecycle through deterministic JSONL', () => {
    const ledger = new ArchiveMemoryLedger();
    ledger.create({ scope: 'thread', scopeId: 'thread-a', text: 'First', sourceRefs: [source(7)], authoredBy: 'eve' }, { id: 'one', now: 1 });
    ledger.supersede('one', { scope: 'thread', scopeId: 'thread-a', text: 'Second', sourceRefs: [source(8)], authoredBy: 'eve' }, { id: 'two', now: 2 });
    const jsonl = archiveMemoryJsonl(ledger.snapshot());
    const restored = parseArchiveMemoryJsonl(jsonl);
    expect(restored).toEqual(ledger.snapshot());
    expect(restored.map(row => row.status)).toEqual(['superseded', 'active']);
    expect(() => parseArchiveMemoryJsonl('{broken}\n')).toThrow(/line 1/i);
  });
});
