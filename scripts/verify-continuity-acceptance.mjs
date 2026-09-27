import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

function fail(message) {
  console.error(`\n[continuity acceptance] FAIL: ${message}`);
  process.exit(1);
}

if (!existsSync(vitest)) fail('node_modules/vitest/vitest.mjs is missing; install dependencies first');

// ChatGPT may issue this private provider request itself, but ParadigmEve must never depend on it
// for A→B continuation. The 2.1.7 incident included a provider 405 while our own browser command
// was independently stranded before /commands/redeem.
const forbiddenProviderRoute = '/backend-api/f/conversation/resume';
for (const relative of ['extension/background.js', 'extension/content.js', 'src/main/bridge.ts']) {
  const source = readFileSync(path.join(root, relative), 'utf8');
  if (source.includes(forbiddenProviderRoute)) {
    fail(`${relative} references ChatGPT private resume transport ${forbiddenProviderRoute}`);
  }
}

const groups = [
  {
    label: 'debug context ceiling policy',
    file: 'test/config.test.ts'
  },
  {
    label: 'browser successor placement and transport',
    file: 'test/extension.test.ts',
    pattern: [
      'redeems a marked successor through the local bridge with POST',
      'opens the replacement chat in the window of the chat it continues',
      'reloads one exact marked successor when a live Companion never redeems but reports no safety veto',
      'lets the reloaded marked successor redeem the same command without opening another tab',
      'does not reload a live successor recorder that deliberately never redeemed',
      'durably retries a lost command ACK after the service worker restarts'
    ].join('|')
  },
  {
    label: 'page bootstrap, exact incident URLs, and browser races',
    file: 'test/content-script.test.ts',
    pattern: [
      'replays the reported 2.1.7 successor URL pair once while the final ACK is slow',
      'redeems the one command its URL names and crosses the durable destination fence',
      'abandons a redeemed bootstrap if SPA navigation retargets the tab before insertion',
      'retries one fresh Resume redeem when the durable service-worker reply is lost',
      'returns one untouched app-opened fresh command to native New Chat when ChatGPT retargets it before redeem'
    ].join('|')
  },
  {
    label: 'one-shot destination ownership and restart',
    file: 'test/resume.test.ts',
    pattern: [
      'lets exactly one of two live documents arm the same claim',
      'can move documents until a page arms the click, and never after it',
      'leaves the session in chat A when the new chat never revealed its id',
      'commits once, so a repeated ack cannot move the session again',
      'restores the leased resume transport without opening a second replacement chat'
    ].join('|')
  },
  {
    label: 'continuation phase and deadline invariants',
    file: 'test/continuation.test.ts',
    pattern: [
      'serves one claimant and refuses a second',
      'does not move the state backwards while a commit is in flight',
      'expires on its own when the replacement chat never appears'
    ].join('|')
  }
];

for (const group of groups) {
  console.log(`\n[continuity acceptance] ${group.label}`);
  const args = [vitest, 'run', group.file];
  if (group.pattern) args.push('-t', group.pattern);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) fail(`${group.label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${group.label}: test process exited ${result.status ?? 'without a status'}`);
}

console.log('\n[continuity acceptance] PASS: transport, successor, bootstrap, ownership, ACK, timeout, restart, and context-ceiling gates are green.');
