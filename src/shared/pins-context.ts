import type { Pin, PinsLibrarySnapshot, Quilt, QuiltCollection } from './pins.js';

/**
 * Human-facing Pins references.
 *
 * User-facing vocabulary: `#quilt` names one broader Quilt and expands to its live Threads;
 * `%topic` names one bounded Thread. Storage keeps the legacy collection/quilt field names.
 */
const THREAD_SIGIL = '%';
const REFERENCE_CHAR = /[\p{L}\p{N}_.-]/u;
const REFERENCE_BOUNDARY = /[\s([{]/u;

const normalized = (value: string): string => value.normalize('NFKC').toLocaleLowerCase();
const referencedName = (value: string): string => normalized(value.slice(1));
const storedName = (value: string, sigil: string): string =>
  normalized(value.startsWith(sigil) ? value.slice(1) : value);
const storedThreadName = (value: string): string =>
  normalized(value.startsWith(THREAD_SIGIL) ? value.slice(1) : value);

export interface PinsContextReferenceSpan {
  reference: string;
  start: number;
  end: number;
}

export type PinsReferenceResolution =
  | { kind: 'quilt'; id: string }
  | { kind: 'thread'; id: string }
  | { kind: 'concept-thread'; id: string }
  | { kind: 'data-thread'; id: string };

export interface PinsContextSelection {
  references: string[];
  /** Syntactically valid authored references that had no unique exact durable match. */
  unresolvedReferences: string[];
  /** Exact wider Quilts selected by authored #quilt references. */
  quiltGroups: QuiltCollection[];
  quilts: Quilt[];
  /** Threads whose standing prompt/special opening context was explicitly activated. */
  activatedThreads: Quilt[];
  /** Concept aliases activate the Thread contents but deliberately suppress prompt semantics. */
  promptSuppressedThreads: Quilt[];
  /** Threads reached through a # reference stay data-only. */
  dataOnlyThreads: Quilt[];
  pins: Pin[];
}

export interface PinsContextOptions {
  /** Exact durable Thread identity chosen outside authored sigil syntax. */
  quiltId?: string;
  /**
   * Narrow app-owned convenience aliases. Normal durable references always win first, so a real
   * user-created Quilt can shadow an alias without changing generic #Quilt trust semantics.
   */
  activationAliases?: readonly { reference: string; threadId: string }[];
  /**
   * Narrow app-owned aliases that expose one Thread as # data only. They never activate its
   * standing prompt and never become project/action authority. Exact real Quilts still win first.
   */
  dataOnlyAliases?: readonly { reference: string; threadId: string }[];
}

/**
 * Finds only syntactically plausible authored `#quilt` / `%Thread` references.
 *
 * This deliberately does not consult the Pins library. Admission of an authored message must
 * never depend on personal Pins state being readable, and ordinary text with no product sigil
 * must not touch that durable store at all. Resolution remains a separate step below.
 */
export function pinsContextReferenceSpans(text: string): PinsContextReferenceSpan[] {
  const chars = Array.from(text);
  const offsets = new Array<number>(chars.length + 1);
  let units = 0;
  for (let index = 0; index < chars.length; index += 1) {
    offsets[index] = units;
    units += chars[index]!.length;
  }
  offsets[chars.length] = units;
  const found: Array<{ index: number; end: number; reference: string }> = [];
  const collect = (sigil: string): void => {
    for (let index = 0; index < chars.length; index += 1) {
      if (chars[index] !== sigil) continue;
      const before = index === 0 ? '' : chars[index - 1]!;
      if (before && !REFERENCE_BOUNDARY.test(before)) continue;
      let end = index + 1;
      if (end >= chars.length || !REFERENCE_CHAR.test(chars[end]!)) continue;
      while (end < chars.length && REFERENCE_CHAR.test(chars[end]!)) end += 1;
      // `%appdata%` intentionally mirrors the Windows environment-variable spelling. A closing
      // `%` is admitted only after a normal Thread token and the ordinary opening-boundary rule
      // still applies, so inline percentages and URL encoding remain non-references.
      if (sigil === THREAD_SIGIL && end < chars.length && chars[end] === THREAD_SIGIL) end += 1;
      while (end > index + 1 && chars[end - 1] === '.') end -= 1;
      found.push({ index, end, reference: chars.slice(index, end).join('') });
    }
  };
  collect('#');
  collect(THREAD_SIGIL);
  found.sort((left, right) => left.index - right.index);
  return found.map(({ index, end, reference }) => ({
    reference,
    start: offsets[index]!,
    end: offsets[end]!
  }));
}

export function pinsContextReferences(text: string): string[] {
  const mentioned: string[] = [];
  const seenRefs = new Set<string>();
  for (const { reference } of pinsContextReferenceSpans(text)) {
    const key = normalized(reference);
    if (seenRefs.has(key)) continue;
    seenRefs.add(key);
    mentioned.push(reference);
  }
  return mentioned;
}

/** Resolve one product reference to one durable id. Duplicate legacy names deliberately abstain. */
export function resolvePinsReference(
  snapshot: PinsLibrarySnapshot,
  reference: string
): PinsReferenceResolution | null {
  const spans = pinsContextReferenceSpans(reference);
  if (spans.length !== 1 || spans[0]!.start !== 0 || spans[0]!.end !== reference.length) return null;
  const key = referencedName(reference);
  if (reference.startsWith('#')) {
    const matches = snapshot.collections.filter(row => storedName(row.name, '#') === key);
    if (matches.length === 1) return { kind: 'quilt', id: matches[0]!.id };
    if (matches.length > 1) return null;
    const sameNameThreads = snapshot.quilts.filter(row => storedThreadName(row.title) === key);
    if (sameNameThreads.length !== 1) return null;
    const concept = sameNameThreads[0]!;
    const hasPins = snapshot.pins.some(pin => pin.quiltId === concept.id);
    return !hasPins && !concept.prompt
      ? { kind: 'concept-thread', id: concept.id }
      : null;
  }
  if (!reference.startsWith(THREAD_SIGIL)) return null;
  const matches = snapshot.quilts.filter(row => storedThreadName(row.title) === key);
  return matches.length === 1 ? { kind: 'thread', id: matches[0]!.id } : null;
}

/** Pure selection only. Loading the recorded source text remains a main-process responsibility. */
export function selectPinsContext(
  text: string,
  snapshot: PinsLibrarySnapshot,
  options: PinsContextOptions = {},
  mentionedReferences?: readonly string[]
): PinsContextSelection {
  // Some callers already proved which authored bytes are eligible for product interpretation
  // (for example the Companion fresh-send boundary filters transport frames, URLs, quotes/code and
  // pasted diagnostics). Accept that exact inert syntax list rather than reparsing less-trusted text.
  // Other local callers keep the standalone parser as their existing deterministic default.
  const mentioned = mentionedReferences ? [...mentionedReferences] : pinsContextReferences(text);

  const quiltIds: string[] = [];
  const quiltGroupIds: string[] = [];
  const quiltGroupIdSet = new Set<string>();
  const selectedIds = new Set<string>();
  const activatedThreadIds: string[] = [];
  const activatedIds = new Set<string>();
  const promptSuppressedThreadIds: string[] = [];
  const promptSuppressedIds = new Set<string>();
  const dataOnlyThreadIds: string[] = [];
  const dataOnlyIds = new Set<string>();
  const references: string[] = [];
  const unresolvedReferences: string[] = [];
  const select = (quilt: Quilt, activate = false, suppressPrompt = false, dataOnly = false): void => {
    if (!selectedIds.has(quilt.id)) {
      selectedIds.add(quilt.id);
      quiltIds.push(quilt.id);
    }
    if (activate && !activatedIds.has(quilt.id)) {
      activatedIds.add(quilt.id);
      activatedThreadIds.push(quilt.id);
    }
    if (suppressPrompt && !promptSuppressedIds.has(quilt.id)) {
      promptSuppressedIds.add(quilt.id);
      promptSuppressedThreadIds.push(quilt.id);
    }
    if (dataOnly && !dataOnlyIds.has(quilt.id)) {
      dataOnlyIds.add(quilt.id);
      dataOnlyThreadIds.push(quilt.id);
    }
  };

  if (options.quiltId) {
    const quilt = snapshot.quilts.find(row => row.id === options.quiltId);
    // Durable id is authoritative. Never reinterpret a missing id through the current title.
    if (!quilt) throw new Error('Selected Thread is no longer available');
    references.push(`Thread "${quilt.title}"`);
    select(quilt, true);
  }

  for (const reference of mentioned) {
    const resolved = resolvePinsReference(snapshot, reference) ?? (() => {
      const alias = options.activationAliases?.find(row => normalized(row.reference) === normalized(reference));
      if (alias && snapshot.quilts.some(row => row.id === alias.threadId)) {
        return { kind: 'thread' as const, id: alias.threadId };
      }
      const dataAlias = options.dataOnlyAliases?.find(row => normalized(row.reference) === normalized(reference));
      return dataAlias && snapshot.quilts.some(row => row.id === dataAlias.threadId)
        ? { kind: 'data-thread' as const, id: dataAlias.threadId }
        : null;
    })();
    if (!resolved) {
      unresolvedReferences.push(reference);
      continue;
    }
    if (resolved.kind === 'quilt') {
      const collection = snapshot.collections.find(row => row.id === resolved.id)!;
      references.push(reference);
      if (!quiltGroupIdSet.has(collection.id)) {
        quiltGroupIdSet.add(collection.id);
        quiltGroupIds.push(collection.id);
      }
      for (const quilt of snapshot.quilts) {
        if (quilt.state === 'pinned' && quilt.collectionIds.includes(collection.id)) {
          select(quilt, false, false, true);
        }
      }
      continue;
    }

    const thread = snapshot.quilts.find(quilt => quilt.id === resolved.id)!;
    references.push(reference);
    if (resolved.kind === 'data-thread') select(thread, false, true, true);
    else select(thread, true, resolved.kind === 'concept-thread', resolved.kind === 'concept-thread');
  }

  const quiltSet = new Set(quiltIds);
  const quilts = quiltIds.flatMap(id => {
    const quilt = snapshot.quilts.find(row => row.id === id);
    return quilt ? [quilt] : [];
  });
  const quiltGroups = quiltGroupIds.flatMap(id => {
    const quilt = snapshot.collections.find(row => row.id === id);
    return quilt ? [quilt] : [];
  });
  const activatedThreads = activatedThreadIds.flatMap(id => {
    const quilt = snapshot.quilts.find(row => row.id === id);
    return quilt ? [quilt] : [];
  });
  const promptSuppressedThreads = promptSuppressedThreadIds.flatMap(id => {
    const quilt = snapshot.quilts.find(row => row.id === id);
    return quilt ? [quilt] : [];
  });
  const dataOnlyThreads = dataOnlyThreadIds.flatMap(id => {
    const quilt = snapshot.quilts.find(row => row.id === id);
    return quilt ? [quilt] : [];
  });
  const pins = snapshot.pins
    .filter(pin => quiltSet.has(pin.quiltId))
    .sort((left, right) => {
      const leftTime = left.sourceCreatedAt ?? left.createdAt;
      const rightTime = right.sourceCreatedAt ?? right.createdAt;
      return leftTime - rightTime || left.createdAt - right.createdAt;
    });

  return { references, unresolvedReferences, quiltGroups, quilts, activatedThreads, promptSuppressedThreads, dataOnlyThreads, pins };
}
