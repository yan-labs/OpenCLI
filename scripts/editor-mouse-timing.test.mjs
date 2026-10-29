import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTimings } from './editor-mouse-timing.mjs';

const entry = (stage, state, ms = '0.001', ts = 2) => ({ level: 'info', ts, msg: `[opencli-mouse-timing] ${stage} ${state} ${ms}` });
const before = [{ level: 'info', ts: 1, msg: 'old sensitive value' }];
const complete = ['window', 'target', 'attach', 'cdp', 'identity'].flatMap(stage => [entry(stage, 'start', '0.000'), entry(stage, 'end')]);
test('extracts fixed safe stages, including nested guard, with no raw log data', () => {
  const after = [...before, ...complete.slice(0, 3), entry('guard', 'end'), ...complete.slice(3), { level: 'info', ts: 4, msg: 'secret ignored' }];
  const groups = extractTimings(before, after, 1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 11);
  assert(!JSON.stringify(groups).includes('secret'));
  assert.deepEqual(Object.keys(groups[0][0]), ['stage', 'state', 'elapsedMs']);
});
test('rejects incomplete, interleaved, rotated and missing measurements', () => {
  assert.equal(extractTimings(before, [...before, ...complete.slice(0, -1)], 1), null);
  assert.equal(extractTimings(before, [...before, ...complete, ...complete], 1), null);
  assert.equal(extractTimings(before, complete, 1), null);
  assert.equal(extractTimings(before, before, 1), null);
});
test('keeps an unfinished phase observable without claiming completion', () => {
  const events = [...before, ...complete.slice(0, 7)];
  assert.equal(extractTimings(before, events, 1), null);
  const partial = extractTimings(before, events, 1, false);
  assert.equal(partial[0].at(-1).stage, 'cdp');
  assert.equal(partial[0].at(-1).state, 'start');
});
