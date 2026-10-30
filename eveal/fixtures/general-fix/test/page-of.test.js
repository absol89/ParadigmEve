import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageOf } from '../src/page-of.js';

test('[visible] the first page', () => {
  const items = ["item1","item2","item3","item4","item5","item6","item7","item8","item9","item10"];
  assert.deepEqual(pageOf(items, 1, 4), ["item1","item2","item3","item4"]);
});
