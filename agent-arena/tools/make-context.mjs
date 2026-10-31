import { randomBytes, randomInt } from 'node:crypto';

const kind = process.argv[2];
if (!['fresh-chat-recall', 'durable-hotlink'].includes(kind)) {
  console.error('Usage: node agent-arena/tools/make-context.mjs fresh-chat-recall|durable-hotlink');
  process.exit(2);
}
const id = randomBytes(6).toString('hex');
const take = list => list[randomInt(list.length)];
const facts = {
  project: take(['Saffron Atlas', 'Moss Meridian', 'Hollow Lantern', 'Glacier Kite']),
  milestone: take(['Alpha-13', 'Tango-28', 'Quartz-07', 'Pine-42']),
  owner: take(['Nora', 'Vega', 'Pax', 'Sami']),
  checkpoint: take(['October 9', 'November 18', 'January 24', 'May 6']),
  rule: take(['never overwrite a disputed send', 'retain the first approved revision', 'verify hashes before reporting', 'defer changes until evidence is complete'])
};
const handle = '%arena-' + id;
const factsText = Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join('; ');
const stage1 = kind === 'durable-hotlink'
  ? `Create a durable reference named ${handle} containing these five synthetic facts: ${factsText}. Confirm what actually persisted and where, without making a global rule.`
  : `Please remember these five synthetic facts for a later conversation under challenge id ${id}: ${factsText}. Use only whatever genuine durable memory facilities are already available; report if that is impossible.`;
const stage2 = kind === 'durable-hotlink'
  ? `In this fresh chat, resolve the previously stored reference ${handle}. Return project, milestone, owner, checkpoint and rule. If you cannot access the reference, say so without guessing.`
  : `In this fresh chat, retrieve the five facts I previously asked you to remember for challenge id ${id}. Return project, milestone, owner, checkpoint and rule; if unavailable, say so without guessing.`;
console.log(JSON.stringify({ kind, id, handle, stage1, stage2, PRIVATE_RUNNER_ANSWER: facts, warning: 'Do not send this JSON or answer key to the contestant; copy only stage1 into Chat A and stage2 into Chat B.' }, null, 2));
