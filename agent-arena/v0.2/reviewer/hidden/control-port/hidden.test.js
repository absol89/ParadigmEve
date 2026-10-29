// Reviewer-only hidden tests for fixtures/control-port (the trivial control task).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaults, loadConfig, serverUrl } from '../src/config.js';

test('[target] the default port is 8081 everywhere', () => {
  assert.equal(defaults.port, 8081);
  assert.equal(loadConfig().port, 8081);
  assert.equal(serverUrl(), 'http://127.0.0.1:8081/');
  assert.match(fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /127\.0\.0\.1:8081/);
});

test('[target] the visible test asserts the new default', () => {
  const visible = fs.readFileSync(new URL('../test/config.test.js', import.meta.url), 'utf8');
  assert.match(visible, /8081/);
  assert.doesNotMatch(visible, /8080/);
});

test('[adjacent:overrides] other defaults and overrides are unchanged', () => {
  assert.deepEqual(Object.keys(defaults).sort(), ['host', 'port', 'retries', 'timeoutMs']);
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.retries, 3);
  assert.equal(defaults.timeoutMs, 15_000);
  assert.equal(loadConfig({ APP_PORT: '9000' }).port, 9000);
  assert.equal(loadConfig({ APP_RETRIES: '5' }).retries, 5);
  assert.ok(Object.isFrozen(defaults));
});
