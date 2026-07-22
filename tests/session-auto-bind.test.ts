import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repository = process.cwd();
const cli = join(repository, 'src', 'cli.ts');

function run(cwd: string, ...arguments_: string[]): string {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...arguments_], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('continue auto-binds the only unfinished Task when the session has no pointer', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-auto-bind-'));
  run(root, 'init', '--id', 'auto-bind-fixture');
  run(root, 'start', '--request', '建立登录回归', '--module', 'auth', '--task', 'login-flow', '--session', 'temporary-window');
  run(root, 'session', 'clear', '--session', 'temporary-window');

  const continued = JSON.parse(run(root, 'continue', '--session', 'new-window'));
  assert.equal(continued.status, 'human_decision_required');
  assert.equal(continued.task.taskId, 'login-flow');
  assert.equal(continued.session.sessionKey, 'new-window');
  assert.equal(continued.nextAction.id, 'request_test_plan_approval');
});
