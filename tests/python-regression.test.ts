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

  const prepared = JSON.parse(run(root, 'check', '测试登录回归脚本'));
  assert.equal(prepared.runId, undefined);
  assert.equal(prepared.planningRequired, true);
  assert.equal(prepared.requiredRequirementsConfirmationAfterPlanning, '确认测试方案');
  assert.equal(prepared.requiredConfirmationAfterPlanning, '确认开始测试');
  assert.ok(existsSync(prepared.prdPath));
  assert.match(readFileSync(prepared.prdPath, 'utf8'), /等待 Agent 根据项目生成详细步骤/);
  const initialTask = readTask(root, prepared.quickCheck.moduleId, prepared.quickCheck.taskId);
  const scenario = initialTask.scenarios[0]!;
  const planFile = join(root, 'login-plan.json');
  writeFileSync(planFile, JSON.stringify({
    apiVersion: 'qa-agent/plan-draft/v1',
    moduleId: initialTask.metadata.moduleId,
    taskId: initialTask.metadata.id,
    description: initialTask.description,
    objectives: initialTask.objectives,
    scenarios: [{
      id: scenario.id,
      title: scenario.title,
      intent: scenario.intent,
      expected: scenario.expected,
      planningStatus: 'applicable',
      steps: [
        { id: 'open-login', action: '打开登录页面', expected: '登录表单正常显示。' },
        { id: 'submit-login', action: '点击登录按钮', expected: '进入认证后的首页。' },
        { id: 'verify-home', action: '验证认证后的首页状态', expected: '首页和用户状态可见。' },
        { id: 'capture-result', action: '截取登录成功页面', expected: '截图保存到对应 Task Run。' }
      ],
      visualAssertions: scenario.visualAssertions,
    }],
  }, null, 2));
  const applied = JSON.parse(run(root, 'plan', 'apply', '--file', planFile));
  assert.equal(applied.requiredRequirementsConfirmation, '确认测试方案');
  assert.equal(applied.requiredConfirmation, '确认开始测试');
  assert.equal(applied.userFacingArtifacts[0].kind, 'task-prd');
  assert.match(applied.userFacingArtifacts[0].markdownLink, /^\[查看测试方案 PRD\]\(.+\/prd\.md\)$/);
  assert.match(readFileSync(prepared.prdPath, 'utf8'), /\| 步骤 \| 操作 \| 预期结果 \|/);
  run(root, 'plan', 'review', '--module', prepared.quickCheck.moduleId, '--task', prepared.quickCheck.taskId, '--approve', '--confirmed-by', 'project-owner', '--confirmation-text', '确认测试方案');
  run(root, 'review', '--module', prepared.quickCheck.moduleId, '--task', prepared.quickCheck.taskId, '--approve', '--confirmed-by', 'project-owner', '--confirmation-text', '确认开始测试');
  const started = JSON.parse(run(root, 'test', '--module', prepared.quickCheck.moduleId, '--task', prepared.quickCheck.taskId));
  const task = readTask(root, prepared.quickCheck.moduleId, prepared.quickCheck.taskId);
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
  const completed = JSON.parse(run(root, 'run', 'complete', started.runId));
  assert.equal(completed.status, 'passed');
  assert.equal(completed.pythonRegressionEligibility?.eligible, true);
  assert.ok(completed.pythonRegressionEligibility?.flowHash);
  assert.deepEqual(completed.pythonRegressionEligibility?.sourceStepIds, [sourceStepId]);
  assert.equal(completed.mustAskUserQuestion, true);
  assert.match(completed.requiredUserQuestion, /是否基于本次已验证流程生成 Python 回归脚本草稿/);
  assert.equal(completed.nextUserDecision.id, 'offer_python_regression');
  assert.deepEqual(completed.nextUserDecision.choices, ['生成回归脚本', '暂不生成']);
  assert.deepEqual(completed.userFacingArtifacts.map((item: { kind: string }) => item.kind), ['task-prd', 'source-run-report']);
  assert.match(completed.requiredUserFacingLinks, /\[查看测试方案 PRD\]\(.+prd\.md\).*\[查看测试报告\]\(.+report\.md\)/);

  const missingScreenshotScriptId = 'missing-screenshot-contract';
  const missingScreenshotScript = join(root, 'missing-screenshot-contract.py');
  const missingScreenshotMetadata = JSON.stringify({ scriptId: missingScreenshotScriptId, sourceRunId: completed.id, sourceStepIds: [sourceStepId], sourceFlowHash: completed.pythonRegressionEligibility!.flowHash });
  writeFileSync(missingScreenshotScript, `# QA_AGENT_REGRESSION: ${missingScreenshotMetadata}\nimport json\nimport os\nfrom pathlib import Path\n\nSOURCE_STEP_IDS = [${JSON.stringify(sourceStepId)}]\nresult = {"apiVersion": "qa-agent/python-regression-result/v1", "status": "passed", "contractStatus": "completed", "conclusion": "No screenshot contract.", "steps": []}\nPath(os.environ["QA_AGENT_RESULT_PATH"]).write_text(json.dumps(result), encoding="utf-8")\n`, 'utf8');
  const missingScreenshotDraft = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'regression', 'draft', '--module', task.metadata.moduleId, '--task', task.metadata.id, '--run', completed.id, '--file', missingScreenshotScript, '--id', missingScreenshotScriptId], { cwd: root, encoding: 'utf8' });
  assert.notEqual(missingScreenshotDraft.status, 0);
  assert.match(missingScreenshotDraft.stderr, /QA_AGENT_SCREENSHOT_DIR/);

  const invalidRuntimeScriptId = 'invalid-runtime-screenshot';
  const invalidRuntimeScript = join(root, 'invalid-runtime-screenshot.py');
  const invalidRuntimeMetadata = JSON.stringify({ scriptId: invalidRuntimeScriptId, sourceRunId: completed.id, sourceStepIds: [sourceStepId], sourceFlowHash: completed.pythonRegressionEligibility!.flowHash });
  writeFileSync(invalidRuntimeScript, `# QA_AGENT_REGRESSION: ${invalidRuntimeMetadata}\nimport json\nimport os\nfrom pathlib import Path\n\nSOURCE_STEP_IDS = [${JSON.stringify(sourceStepId)}]\nSCREENSHOT_FIELD = "screenshot"\n\ndef main():\n    Path(os.environ["QA_AGENT_SCREENSHOT_DIR"]).mkdir(parents=True, exist_ok=True)\n    result = {"apiVersion": "qa-agent/python-regression-result/v1", "status": "passed", "contractStatus": "completed", "conclusion": "Missing runtime screenshot.", "steps": [{"id": ${JSON.stringify(sourceStepId)}, "name": "Click login button", "status": "passed"}], "cleanup": []}\n    Path(os.environ["QA_AGENT_RESULT_PATH"]).write_text(json.dumps(result), encoding="utf-8")\n\nif __name__ == "__main__":\n    main()\n`, 'utf8');
  run(root, 'regression', 'draft', '--module', task.metadata.moduleId, '--task', task.metadata.id, '--run', completed.id, '--file', invalidRuntimeScript, '--id', invalidRuntimeScriptId);
  run(root, 'regression', 'publish', '--module', task.metadata.moduleId, '--task', task.metadata.id, '--draft', invalidRuntimeScriptId, '--confirmed-by', 'project-owner');
  const invalidRuntimeExecution = JSON.parse(run(root, 'regression', 'run', invalidRuntimeScriptId, '--module', task.metadata.moduleId, '--task', task.metadata.id));
  assert.equal(invalidRuntimeExecution.contractStatus, 'invalid_result');
  assert.equal(invalidRuntimeExecution.status, 'inconclusive');
  assert.match(readFileSync(invalidRuntimeExecution.reportPath, 'utf8'), /QA-AGENT:PYTHON-REGRESSION-DIAGNOSTIC/);
  assert.equal(readPythonRegression(root, task.metadata.moduleId, task.metadata.id, invalidRuntimeScriptId).status, 'approved_unverified');

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
  assert.equal(executed.userFacingArtifacts[0].kind, 'python-regression-report');
  assert.match(executed.userFacingArtifacts[0].markdownLink, /^\[查看回归报告\]\(.+\/report\.md\)$/);
  const report = readFileSync(executed.reportPath, 'utf8');
  assert.match(report, /QA-AGENT:PYTHON-REGRESSION-REPORT/);
  assert.match(report, /## Screenshot-backed Checkpoints/);
  assert.match(report, /!\[login-success\.png\]\(screenshots\/login-success\.png\)/);
  assert.equal(readPythonRegression(root, task.metadata.moduleId, task.metadata.id, scriptId).status, 'validated');
  assert.equal(JSON.parse(run(root, 'validate')).valid, true);
});
