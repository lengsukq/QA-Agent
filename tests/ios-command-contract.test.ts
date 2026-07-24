import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stepToRegressionEntry } from '../src/regression-steps.ts';
import type { TestRun } from '../src/types.ts';

function step(input: Partial<TestRun['steps'][number]>): TestRun['steps'][number] {
  return {
    id: 'agent-1',
    action: 'native action',
    detail: 'native action',
    at: '2026-07-24T00:00:00.000Z',
    status: 'passed',
    source: 'ui',
    executionMode: 'host-automated',
    ...input,
  } as TestRun['steps'][number];
}

test('iOS source steps preserve the native driver command for replay', () => {
  const entry = stepToRegressionEntry(step({
    uiAction: 'input',
    driverCommand: 'type-text',
    driverParams: { inputRef: 'env:QA_EMAIL' },
    inputRefs: { value: 'env:QA_EMAIL' },
  }));
  assert.equal(entry.cmd, 'type-text');
  assert.deepEqual(entry.params, { inputRef: 'env:QA_EMAIL' });
});

test('coordinate taps remain explicit fallback locators', () => {
  const entry = stepToRegressionEntry(step({
    uiAction: 'click',
    driverCommand: 'tap',
    driverParams: { x: 170, y: 124 },
    actualLocator: { strategy: 'coordinate', value: '170,124' },
  }));
  assert.equal(entry.cmd, 'tap');
  assert.deepEqual(entry.params, { x: 170, y: 124 });
});

test('the checked-in iOS example preserves the search-to-detail native command flow', () => {
  const example = JSON.parse(readFileSync(join(process.cwd(), 'ios-search-bvl.steps.json'), 'utf8')) as {
    platform: string;
    steps: Array<{ cmd: string; params?: Record<string, unknown> }>;
  };
  assert.equal(example.platform, 'ios');
  assert.deepEqual(example.steps.map(step => step.cmd), [
    'terminate', 'launch', 'back', 'wait', 'tap', 'clear', 'fill', 'assert-value', 'key',
    'wait', 'assert-text', 'tap', 'wait', 'describe', 'assert-text',
    'assert-text', 'scroll', 'wait', 'assert-text',
  ]);
  assert.deepEqual(example.steps[11]?.params?.locator, { strategy: 'text', value: 'Bvlgari' });
  assert.equal(example.steps[16]?.params?.direction, 'up');
});
