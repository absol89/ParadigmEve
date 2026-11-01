import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlanUpdate } from '../src/plan.js';

test('exact revision updates exactly once', () => {
  const plan = { status: 'ready', revision: 4 };
  assert.equal(applyPlanUpdate(plan, 4, 'done'), true);
  assert.deepEqual(plan, { status: 'done', revision: 5 });
});

test('stale revision cannot change state', () => {
  const plan = { status: 'ready', revision: 4 };
  assert.equal(applyPlanUpdate(plan, 3, 'done'), false);
  assert.deepEqual(plan, { status: 'ready', revision: 4 });
});

test('future revision cannot leapfrog or change state', () => {
  const plan = { status: 'ready', revision: 4 };
  assert.equal(applyPlanUpdate(plan, 7, 'done'), false);
  assert.deepEqual(plan, { status: 'ready', revision: 4 });
});
