import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { recordAgentStep, recordVisualFinding } from '../src/engine.ts';
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

function installStubRunner(root: string): void {
  const runnerDir = join(root, 'runner', 'qa_agent_runner');
  mkdirSync(runnerDir, { recursive: true });
  writeFileSync(join(runnerDir, '__init__.py'), '', 'utf8');
  writeFileSync(join(runnerDir, '__main__.py'), `import json, os, sys
from pathlib import Path

args = sys.argv[1:]
assert args and args[0] == "replay", args
steps_file = args[1]
screenshot_dir = Path(os.environ["QA_AGENT_SCREENSHOT_DIR"])
result_path = Path(os.environ["QA_AGENT_RESULT_PATH"])
run_dir = os.environ.get("QA_AGENT_REGRESSION_RUN_DIR")
screenshot_dir.mkdir(parents=True, exist_ok=True)
doc = json.load(open(steps_file))
results = []
for step in doc.get("steps", []):
    sid = step["id"]
    fname = f"{sid}.png"
    (screenshot_dir / fname).write_bytes(b"screenshot")
    rel = os.path.relpath(str(screenshot_dir / fname), run_dir) if run_dir else f"screenshots/{fname}"
    results.append({"id": sid, "name": f"Step {sid}", "status": "passed", "expected": "", "actual": "", "screenshot": rel})
result = {"apiVersion": "qa-agent/python-regression-result/v1", "status": "passed", "contractStatus": "completed", "conclusion": "Stub replay passed.", "steps": results, "cleanup": []}
result_path.parent.mkdir(parents=True, exist_ok=True)
result_path.write_text(json.dumps(result))
sys.exit(0)
`, 'utf8');
}

test('exports a reviewed regression steps draft, publishes it into the Task, and replays it from the command line', () => {
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
  assert.match(completed.requiredUserQuestion, /是否基于本次已验证流程导出可一键重放的回归步骤脚本/);
  assert.equal(completed.nextUserDecision.id, 'offer_regression_steps');
  assert.deepEqual(completed.nextUserDecision.choices, ['导出回归步骤', '暂不导出']);
  assert.deepEqual(completed.userFacingArtifacts.map((item: { kind: string }) => item.kind), ['task-prd', 'source-run-report']);
  assert.match(completed.requiredUserFacingLinks, /\[查看测试方案 PRD\]\(.+prd\.md\).*\[查看测试报告\]\(.+report\.md\)/);

  installStubRunner(root);

  const scriptId = 'login-regression-steps';
  const taskRoot = taskDirectory(root, task.metadata.moduleId, task.metadata.id);
  const draft = JSON.parse(run(root, 'regression', 'export', '--module', task.metadata.moduleId, '--task', task.metadata.id, '--run', completed.id, '--id', scriptId));
  assert.equal(draft.draft.apiVersion, 'qa-agent/python-regression-draft/v2');
  assert.equal(draft.draft.status, 'draft');
  assert.equal(draft.draft.sourceFlowHash, completed.pythonRegressionEligibility!.flowHash);
  assert.deepEqual(draft.draft.scenarioIds, ['exploration']);
  assert.ok(draft.draft.scriptRef.endsWith('.steps.json'));
  assert.deepEqual(draft.stepsFile.steps.map((step: { id: string }) => step.id), [sourceStepId]);
  assert.equal(draft.approvalRequired, true);
  assert.equal(existsSync(join(taskRoot, 'regression', `${scriptId}.steps.json`)), false);

  const rejected = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'regression', 'publish', '--module', task.metadata.moduleId, '--task', task.metadata.id, '--draft', scriptId, '--confirmed-by', 'qa-agent'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /real human/i);

  const published = JSON.parse(run(root, 'regression', 'publish', '--module', task.metadata.moduleId, '--task', task.metadata.id, '--draft', scriptId, '--confirmed-by', 'project-owner'));
  assert.equal(published.manifest.apiVersion, 'qa-agent/python-regression/v2');
  assert.equal(published.manifest.status, 'approved_unverified');
  assert.equal(published.manifest.sourceFlowHash, completed.pythonRegressionEligibility!.flowHash);
  assert.ok(existsSync(join(taskRoot, 'regression', `${scriptId}.steps.json`)));
  assert.ok(existsSync(join(taskRoot, 'regression', `${scriptId}.json`)));
  const publishedSteps = JSON.parse(readFileSync(join(taskRoot, 'regression', `${scriptId}.steps.json`), 'utf8'));
  assert.deepEqual(publishedSteps.steps.map((step: { id: string }) => step.id), [sourceStepId]);
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
  assert.ok(report.includes(`screenshots/${sourceStepId}.png`));
  assert.equal(readPythonRegression(root, task.metadata.moduleId, task.metadata.id, scriptId).status, 'validated');
  assert.equal(JSON.parse(run(root, 'validate')).valid, true);
});
