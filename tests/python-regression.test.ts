import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { completeAgentGuidedRun, recordAgentStep, recordVisualFinding } from '../src/engine.ts';
import { readTask, taskDirectory } from '../src/project.ts';
import { readPythonRegression } from '../src/python-regression.ts';

const repository = process.cwd();
const cli = join(repository, 'src', 'cli.ts');

function run(cwd: string, ...arguments_: string[]): string {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...arguments_], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function importHostSnapshot(root: string): void {
  const snapshot = join(root, 'host-capabilities.json');
  writeFileSync(snapshot, JSON.stringify({
    host: 'test-host',
    collectedAt: new Date().toISOString(),
    connections: [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }],
  }), 'utf8');
  run(root, 'host', 'import', '--file', snapshot);
}

test('creates a reviewed Python regression draft, publishes it into the Task, and runs it from the command line', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-python-regression-'));
  run(root, 'init', '--id', 'python-regression-fixture');
  importHostSnapshot(root);

  const started = JSON.parse(run(root, 'check', '测试登录回归脚本'));
  const task = readTask(root, started.quickCheck.moduleId, started.quickCheck.taskId);
  const sourceScreenshot = join(root, 'source-login.png');
  writeFileSync(sourceScreenshot, 'source screenshot', 'utf8');
  const updated = recordAgentStep(root, started.runId, {
    action: 'Click login button',
    detail: 'Clicked the login button and reached the expected state.',
    screenshotPath: sourceScreenshot,
    scenarioId: 'exploration',
    visualInspection: 'performed',
    source: 'ui',
    executionMode: 'host-automated',
    uiAction: 'click',
    locator: { strategy: 'role', value: 'button:Login' },
    actualLocator: { strategy: 'role', value: 'button:Login' },
    expectedState: 'Authenticated home is visible.',
    actualState: 'Authenticated home is visible.',
  });
  const sourceStepId = updated.steps.at(-1)!.id;
  const assertion = task.scenarios[0]!.visualAssertions![0]!;
  recordVisualFinding(root, started.runId, {
    scenarioId: 'exploration',
    assertionId: assertion.id,
    expected: assertion.expected,
    actual: 'The authenticated home was visible.',
    status: 'passed',
    screenshotPath: sourceScreenshot,
  });
  const completed = completeAgentGuidedRun(root, task, started.runId);
  assert.equal(completed.status, 'passed');
  assert.equal(completed.pythonRegressionEligibility?.eligible, true);
  assert.ok(completed.pythonRegressionEligibility?.flowHash);
  assert.deepEqual(completed.pythonRegressionEligibility?.sourceStepIds, [sourceStepId]);

  const scriptId = 'login-python-regression';
  const scriptFile = join(root, 'login-regression.py');
  const metadata = JSON.stringify({ scriptId, sourceRunId: completed.id, sourceStepIds: [sourceStepId], sourceFlowHash: completed.pythonRegressionEligibility!.flowHash });
  writeFileSync(scriptFile, `# QA_AGENT_REGRESSION: ${metadata}\nimport json\nimport os\nfrom pathlib import Path\n\nSOURCE_STEP_IDS = [${JSON.stringify(sourceStepId)}]\n\ndef main():\n    run_dir = Path(os.environ["QA_AGENT_REGRESSION_RUN_DIR"])\n    screenshot = Path(os.environ["QA_AGENT_SCREENSHOT_DIR"]) / "login-success.png"\n    screenshot.write_bytes(b"screenshot")\n    result = {\n        "apiVersion": "qa-agent/python-regression-result/v1",\n        "status": "passed",\n        "contractStatus": "completed",\n        "conclusion": "Login regression completed successfully.",\n        "steps": [{\n            "id": ${JSON.stringify(sourceStepId)},\n            "name": "Click login button",\n            "status": "passed",\n            "expected": "Authenticated home is visible.",\n            "actual": "Authenticated home is visible.",\n            "screenshot": "screenshots/login-success.png"\n        }],\n        "cleanup": []\n    }\n    Path(os.environ["QA_AGENT_RESULT_PATH"]).write_text(json.dumps(result), encoding="utf-8")\n\nif __name__ == "__main__":\n    main()\n`, 'utf8');

  const draft = JSON.parse(run(root, 'regression', 'draft', '--module', task.metadata.moduleId, '--task', task.metadata.id, '--run', completed.id, '--file', scriptFile, '--id', scriptId));
  assert.equal(draft.draft.apiVersion, 'qa-agent/python-regression-draft/v2');
  assert.equal(draft.draft.status, 'draft');
  assert.equal(draft.draft.sourceFlowHash, completed.pythonRegressionEligibility!.flowHash);
  assert.deepEqual(draft.draft.scenarioIds, ['exploration']);
  assert.equal(draft.approvalRequired, true);
  const taskRoot = taskDirectory(root, task.metadata.moduleId, task.metadata.id);
  assert.equal(existsSync(join(taskRoot, 'regression', `${scriptId}.py`)), false);

  const rejected = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'regression', 'publish', '--module', task.metadata.moduleId, '--task', task.metadata.id, '--draft', scriptId, '--confirmed-by', 'qa-agent'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /real human/i);

  const published = JSON.parse(run(root, 'regression', 'publish', '--module', task.metadata.moduleId, '--task', task.metadata.id, '--draft', scriptId, '--confirmed-by', 'project-owner'));
  assert.equal(published.manifest.apiVersion, 'qa-agent/python-regression/v2');
  assert.equal(published.manifest.status, 'approved_unverified');
  assert.equal(published.manifest.sourceFlowHash, completed.pythonRegressionEligibility!.flowHash);
  assert.ok(existsSync(join(taskRoot, 'regression', `${scriptId}.py`)));
  assert.ok(existsSync(join(taskRoot, 'regression', `${scriptId}.json`)));
  assert.match(readFileSync(join(taskRoot, 'regression', `${scriptId}.py`), 'utf8'), /QA_AGENT_REGRESSION/);
  assert.equal(existsSync(join(taskRoot, 'operation-plans')), false);
  assert.equal(existsSync(join(taskRoot, 'regression-suite.json')), false);

  const executed = JSON.parse(run(root, 'regression', 'run', scriptId, '--module', task.metadata.moduleId, '--task', task.metadata.id));
  assert.equal(executed.status, 'passed');
  assert.equal(executed.contractStatus, 'completed');
  assert.ok(existsSync(executed.reportPath));
  assert.match(readFileSync(executed.reportPath, 'utf8'), /QA-AGENT:PYTHON-REGRESSION-REPORT/);
  assert.equal(readPythonRegression(root, task.metadata.moduleId, task.metadata.id, scriptId).status, 'validated');
  assert.equal(JSON.parse(run(root, 'validate')).valid, true);
});
