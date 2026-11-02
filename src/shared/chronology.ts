/**
 * The order a recorded turn is *read* in, which is not the order it was written in.
 *
 * A tool call is only handed to the recorder once its tool has finished and its attribution
 * has resolved, so it is appended late — but it is stamped with `startedAt`, because that is
 * when it happened. Everything the page observed in the meantime already has a lower `seq`.
 * Reading the log by `seq` therefore shows a call after the commentary it ran underneath, and
 * a slow call after the `turn_end` of the turn that made it: `2026-01-01-00000017` seq 390,
 * `time` 1786982781914, sits after a `turn_start` stamped 1786982783350 — a second and a half
 * in the future of the row above it.
 *
 * The fix is not to sort the log by time. `seq` is the append order and the cursor domain,
 * and it has to stay immutable and gap-free or incremental delivery breaks. And a global
 * sort by time would be actively wrong: a reloaded page re-reports the transcript it can see,
 * and those events carry the time they were *observed*, not the time they were said, so
 * sorting the whole log by time drags days-old history into the middle of the live turn.
 *
 * So ordering is turn-local. A turn this log opened is a durable, bounded group — everything
 * in it carries the same generation id, which the extension mints per turn — and inside that
 * group the recorded times are all live observations of one run, directly comparable. Outside
 * it nothing moves: user messages, turn boundaries, and any event whose turn this window does
 * not contain keep the position `seq` gave them.
 *
 * Both consumers use this. The desktop transcript and the stream the extension injects back
 * into ChatGPT are the same record, and they must not be able to disagree about its order.
 */

/** The minimum an entry needs to be placed. Both consumers' shapes satisfy it structurally. */
export interface Chronological {
  seq: number;
  /** First position of a mutable canonical item; seq may be its newer revision cursor. */
  origin?: number;
  /** When the item logically happened: `startedAt` for a call, first appearance for prose. */
  time: number;
  kind: string;
  turnId?: string | null;
  /** ChatGPT's own terminal flag for the one message that ended a turn. See `closing()`. */
  final?: boolean;
  /** Sequence where the latest canonical assistant content was written. */
  contentSeq?: number;
  /** A turn ended because a user message continued the same running response. */
  continued?: boolean;
  state?: string;
}

/** Where an entry sits in the log: its first appearance if it has revisions, else its seq. */
export function positionOf(entry: Chronological): number {
  return typeof entry.origin === 'number' && Number.isFinite(entry.origin) ? entry.origin : entry.seq;
}

/** A final assistant message can be opened early but receive its final text much later. */
export function residenceOf(entry: Chronological): number {
  const position = positionOf(entry);
  return entry.kind === 'assistant_message' && entry.final === true &&
    typeof entry.contentSeq === 'number' && Number.isFinite(entry.contentSeq)
    ? Math.max(position, entry.contentSeq) : position;
}

/**
 * The assistant message that ended a turn, if this group holds one.
 *
 * A message carries the `create_time` ChatGPT stamped when it *opened* that message, and
 * ChatGPT can open the final answer and still run another connector call before the prose is
 * written. Session `2026-01-01-00000019` is the live case: the answer of turn `…-1-9` is
 * stamped 08:40:34, with `write_stdin` at 08:40:37 and `git show` at 08:40:42 after it. Order
 * that group by time alone and two tool rows are drawn *underneath* the finished answer —
 * which is neither what ChatGPT itself shows nor a thing that can have happened.
 *
 * The message that ended a turn is the last thing in that turn by definition: nothing else in
 * the turn can follow the message that closed it. So it is placed there, rather than trusted
 * to a timestamp that describes when it was opened.
 *
 * Only one message per group moves, the one furthest along the log. A turn re-observed after a
 * reload can have every message marked final, and interim prose must keep interleaving with
 * the tool calls it ran between — the terminal message is the only one whose position is a
 * matter of definition rather than observation.
 */
function closing<T extends Chronological>(group: readonly T[], isContinued = false): T | null {
  const continuedEnd = group.find(entry => entry.kind === 'turn_end' && entry.continued === true);
  const endPosition = continuedEnd ? positionOf(continuedEnd) : undefined;
  let found: T | null = null;
  for (const entry of group) {
    if (entry.kind !== 'assistant_message') continue;
    if (entry.final !== true && entry.state !== 'final') continue;
    if (endPosition !== undefined && residenceOf(entry) > endPosition) continue;
    if (!found) { found = entry; continue; }
    const later = isContinued
      ? residenceOf(entry) > residenceOf(found)
      : positionOf(entry) > positionOf(found);
    if (later) found = entry;
  }
  return found;
}

/**
 * Reorders one window of recorded events for reading.
 *
 * Stable, total and deterministic: equal times fall back to `seq`, so nothing depends on the
 * order the window happened to arrive in and re-running it on a rebuilt window gives the same
 * answer. Never mutates the input.
 */
export function chronological<T extends Chronological>(entries: readonly T[]): T[] {
  const position = (entry: T): number => positionOf(entry);
  const bySeq = [...entries].sort((a, b) => position(a) - position(b) || a.seq - b.seq);
  // Only turns this window actually opened. A tail delivered from a cursor can hold events of
  // a turn whose `turn_start` is far behind it, and a group with no anchor has no bounded
  // extent — its members could be reordered past events that are not part of it at all. Those
  // keep their seq position, which is the honest answer for a window that cannot see the turn.
  const anchors = new Map<string, number>();
  // Where each opened turn stops, so an event that names no turn can be told whether it
  // happened inside one. A turn still running has no end and holds everything after it.
  const ends = new Map<number, number>();
  const turnEnds = new Map<string, { origin: number; continued: boolean }>();
  const starts: Array<{ turnId: string; origin: number }> = [];
  for (const entry of bySeq) {
    if (entry.kind === 'turn_start' && entry.turnId && !anchors.has(entry.turnId)) {
      anchors.set(entry.turnId, position(entry));
      starts.push({ turnId: entry.turnId, origin: position(entry) });
    }
    if (entry.kind === 'turn_end' && entry.turnId) {
      const anchor = anchors.get(entry.turnId);
      if (anchor !== undefined) ends.set(anchor, Math.max(ends.get(anchor) ?? 0, entry.time));
      turnEnds.set(entry.turnId, { origin: position(entry), continued: entry.continued === true });
    }
  }

  const continuedTo = new Map<string, string>();
  for (const [turnId, end] of turnEnds) {
    if (!end.continued) continue;
    const sourceAnchor = anchors.get(turnId);
    const next = starts.find(start => start.origin >= end.origin && (sourceAnchor === undefined || start.origin > sourceAnchor));
    if (next) continuedTo.set(turnId, next.turnId);
  }
  const terminalContinuation = (turnId: string): string => {
    let current = turnId;
    const seen = new Set<string>();
    while (continuedTo.has(current) && !seen.has(current)) {
      seen.add(current);
      current = continuedTo.get(current)!;
    }
    return current;
  };

  // Position within a turn. The boundaries are the boundaries whatever their timestamps say:
  // a turn cannot begin after its own first observation or end before its last, and the times
  // on those two events are the moment the page noticed, not the moment the turn moved. The
  // message that ended the turn sits between the two for the same reason — see `closing()`.
  const rank = (entry: T, ends: T | null): number =>
    entry.kind === 'turn_start' ? -1 : entry.kind === 'turn_end' ? 1 : entry === ends ? 0.5 : 0;

  // An entry with no usable time is ordered by its stable position (`origin` for a mutable
  // canonical item, otherwise `seq`) rather than being flung to one end of its turn: a
  // missing timestamp is not evidence about when the thing happened.
  const byTime = (a: T, b: T): number => {
    const apart = a.time - b.time;
    return Number.isFinite(apart) && apart !== 0
      ? apart
      : position(a) - position(b) || a.seq - b.seq;
  };

  const groups = new Map<number, T[]>();
  // The previous implementation found the open turn for every untagged event by rescanning
  // `bySeq` from the beginning. A long session with many app-authored/untagged rows therefore
  // became O(n²) and could freeze Electron's main process for tens of seconds. `bySeq` is
  // already ordered, so carry the latest start from strictly earlier positions forward once.
  // Starts sharing the same canonical position are intentionally activated only when the
  // position advances, matching the old `position(candidate) >= position(entry)` boundary.
  let activeAnchor: number | undefined;
  let pendingAnchor: number | undefined;
  let currentPosition: number | undefined;
  for (const entry of bySeq) {
    const entryPosition = position(entry);
    if (currentPosition === undefined || entryPosition !== currentPosition) {
      if (pendingAnchor !== undefined) activeAnchor = pendingAnchor;
      pendingAnchor = undefined;
      currentPosition = entryPosition;
    }
    let inferredAnchor: number | undefined;
    if (!entry.turnId && activeAnchor !== undefined) {
      const end = ends.get(activeAnchor);
      if (end === undefined || entry.time <= end) inferredAnchor = activeAnchor;
    }
    let explicitAnchor = entry.turnId ? anchors.get(entry.turnId) : undefined;
    if (entry.kind === 'assistant_message' && entry.turnId && (entry.final === true || entry.state === 'final')) {
      const end = turnEnds.get(entry.turnId);
      if (end?.continued && residenceOf(entry) > end.origin) {
        explicitAnchor = anchors.get(terminalContinuation(entry.turnId)) ?? explicitAnchor;
      }
    }
    const anchor = explicitAnchor ?? inferredAnchor ?? entryPosition;
    const held = groups.get(anchor);
    if (held) held.push(entry);
    else groups.set(anchor, [entry]);
    if (entry.kind === 'turn_start' && entry.turnId) pendingAnchor = anchors.get(entry.turnId);
  }

  const out: T[] = [];
  const continuedAnchors = new Set<number>();
  for (const [from, to] of continuedTo) {
    const fromAnchor = anchors.get(from), toAnchor = anchors.get(to);
    if (fromAnchor !== undefined) continuedAnchors.add(fromAnchor);
    if (toAnchor !== undefined) continuedAnchors.add(toAnchor);
  }
  for (const anchor of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(anchor)!;
    const ends = closing(group, continuedAnchors.has(anchor));
    group.sort((a, b) => rank(a, ends) - rank(b, ends) || byTime(a, b));
    out.push(...group);
  }
  return out;
}
