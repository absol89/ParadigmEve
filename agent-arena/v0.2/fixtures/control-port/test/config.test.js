import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, loadConfig, serverUrl } from '../src/config.js';

test('defaults', () => {
  assert.equal(defaults.port, 8080);
  assert.equal(serverUrl(), 'http://127.0.0.1:8080/');
});

test('environment overrides', () => {
  assert.equal(loadConfig({ APP_PORT: '9000' }).port, 9000);
  assert.equal(loadConfig({ APP_HOST: '0.0.0.0' }).host, '0.0.0.0');
});
