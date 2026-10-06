/**
 * What a handoff brief has to contain, in one place.
 *
 * One caller, now. These rules used to be shared with an external writer — a second model
 * that was handed a packed recording of the session and asked for the same document — and
 * keeping the two prompts from drifting was the reason this file exists. That path is gone:
 * the brief is written by the ChatGPT conversation that *is* the recording, and the answer it
 * writes is the brief. What survives is the specification of the document itself, which is
 * worth having in one named place whatever ends up reading it.
 */

/** The rules and headings. */
export const HANDOFF_BRIEF_RULES = `Rules:
- Treat the user's messages as the highest-authority source in the entire handoff. They are the specification. Preserve the original task, every requirement, every later correction, every constraint, every explicit preference, and every request about what should happen next. If a later message changed an earlier requirement, state the final position and say that it changed. Never let an assistant plan, guess, TODO, or tool-side interpretation override what the user actually said.
- Weight recency explicitly. The newest user correction or instruction overrides older user instructions on the same subject, and the newest verified tool/repository/install evidence overrides older operational state. Start from the latest relevant turns and work backward only as far as needed to explain the current task.
- Do not carry superseded release/build/version state forward as active work. Older candidates, plans, hypotheses, installer states, and next steps belong only in a compact historical note when they still explain the current state. Never put stale versioned work in CURRENT STATE, IN PROGRESS, NEXT, or DO NOT.
- When recent user messages say that an install, reload, build, test step, provider switch, or other action already happened, treat that as the new continuation boundary and do not make the successor redo the earlier prerequisite unless newer evidence contradicts it.
- Preserve the substance of every user message that could matter to continuing the work, even when it is conversational, repetitive, frustrated, shorthand, or speech-to-text. Collapse duplicates only when their meaning is genuinely identical; preserve differences, changed decisions, priorities, and corrections.
- Never drop a requirement because it looks minor or because it was not worked on. Unfinished requirements matter most.
- Use the tool evidence to decide what is actually done. An assistant message saying it will do something is not evidence that it happened; a recorded tool call that succeeded is. Say plainly which is which.
- Keep exact identifiers: file paths, function names, versions, ports, hashes, ids, command lines, error text. Do not paraphrase them.
- Make the current state the centre of the brief: what is complete and verified · what is currently in progress and exactly where it stopped · what is planned/decided but not implemented yet · what was attempted and failed · what was only discussed · what is still to do. Write enough state that the next agent can choose its very next tool call without rediscovering the session.
- Include failures and unresolved bugs with the actual error, and say what was already tried so it is not repeated.
- AGENT MESSAGE lines are traffic with other agents in a multi-agent run. One delivered to this agent is a report about work done outside this recording — treat it as the only evidence of that work and keep its substance. One sent by this agent is work already delegated; say who is doing it so it is not delegated again.
- State the current state of the repository, install and running processes as far as the recording shows it.
- Preserve causal links, not just facts. When a bug, design decision or patch exists because of a specific observed failure, keep the failure → root cause → change → verification chain together. Keep known-good and known-bad behaviours distinct.
- Treat the brief as an operational continuation snapshot, not an archive of the whole conversation. Preserve requirements and evidence that still affect the next decision, but aggressively compress superseded chronology. Prefer a concise current-state handoff over pages of obsolete build history; a long brief is justified only by many still-live requirements or unresolved branches. Never exceed 30,000 tokens.
- Spend extra space on concrete continuation value: exact changed files and symbols, dirty-tree caveats, test/build commands and outcomes, live-session evidence, current hypotheses with confidence, rejected approaches and why, pending worker ownership, release/install state, and the precise next actions. Spend very little space on superseded versions or already-consumed prerequisite steps.
- Be dense and operational. No preamble, no praise, no restating these instructions, no "in this session we". Put the latest state and newest user direction first inside each section so a successor does not have to read through stale chronology before finding what is current.
- If the recording is incomplete or ambiguous, say so in one line rather than inventing detail.

Structure the brief with these headings, omitting any that would be empty:

TASK — the original goal, in the user's terms.
USER SPECIFICATION — every material user request, constraint, preference, correction and changed decision, with the final position explicit. This is the authoritative section.
CURRENT STATE — what is true right now: repository/app/session state, active implementation, versions, processes, and latest relevant observed behaviour.
DONE — completed and verified, with the evidence.
IN PROGRESS — started, not finished, and exactly where it stopped.
PLANNED / DECIDED — concrete work the user or agent decided should happen next but that tool evidence does not show as completed yet.
FAILED / UNRESOLVED — what broke, the error, what was already tried.
FILES — paths touched or inspected that matter to continuation, what changed in each, and important symbols/line regions when known.
VERIFICATION — tests, builds, smoke checks and live evidence already run, with exact commands/results and what remains unverified.
ENVIRONMENT — commands, versions, running processes, repo/dirty-tree state, installation/release state, and anything the next agent must preserve.
NEXT — the concrete next actions, in order.
DO NOT — what the next agent should not redo or undo.`;

/**
 * The instruction typed into the ChatGPT conversation being compacted.
 *
 * The model is already the participant rather than a reader of a transcript, so there is no
 * recording to hand it and "the tool evidence" is its own call history.
 *
 * The brief leaves as the answer, deliberately. A tool call is a thing the model can retry,
 * skip, or make three different versions of, and every one of those was a way for a
 * compaction to end with the wrong brief or none. An answer cannot be retried: the page
 * watches this exact generation, and whatever it finally wrote is what gets carried across.
 * So there is nothing here to call, and nothing to get right except the writing.
 */
const marker = (kind: 'HANDOFF' | 'RESUME', token: string): string =>
  token ? `[[CLF-${kind}:${token}]]` : '';

export const sourceContinuationMarker = (token: string): string => marker('HANDOFF', token);
export const destinationContinuationMarker = (token: string): string => marker('RESUME', token);

export function nativeHandoffPrompt(token = '', includeToolCalls = true): string {
  const identity = sourceContinuationMarker(token);
  return (
    (identity ? `${identity}\n\n` : '') +
    'ParadigmEve is compacting this conversation so a fresh chat can continue the work. ' +
    'Stop whatever you were doing and do only this.\n\n' +
    'Write a handoff brief so a different coding agent can continue this unfinished task in a brand-new ' +
    "conversation, with no memory of anything here. Everything you know about this session — the user's " +
    (includeToolCalls ? 'messages, your own replies, and every tool call you made against this machine with its result — is the ' :
      'messages and your own replies, including interim updates — is the ') +
    'material. Write it so an agent who reads only your brief can carry on correctly.\n\n' +
    `${HANDOFF_BRIEF_RULES}\n\n` +
    (includeToolCalls ? '' : 'Tool-detail setting: preserve verified outcomes and distinguish them from claims, but omit raw tool-call arguments and result bodies from the brief. Do not copy tool transcripts. This setting controls the brief, not the history you already saw.\n\n') +
    'Your reply to this message must be the brief itself and nothing else: no preamble, no closing remark, no ' +
    'question back, and no tool calls. The app reads this reply, stores it, and opens the fresh chat with it.'
  );
}
