import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { approveGuidedAction, beginAgentGuidedRun, completeAgentGuidedRun, recordAgentStep, recordGuidedVerdict, recordVisualFinding } from '../src/engine.ts';
import { createModule, initializeProject, readTask, saveTask, taskDirectory, taskSourceRunDirectory, taskSourceRunPath, taskSourceRunReportPath } from '../src/project.ts';
import { createTaskSkeleton } from '../src/planning.ts';
import { inspectTaskArchive } from '../src/archive.ts';
import { analyzeProjectImpact } from '../src/impact-analysis.ts';
import { buildModuleRegressionSelection, buildReleaseRegressionSelection, buildTaskRegressionSelection, runRegressionSelection } from '../src/regression.ts';
import { createReleaseCheck, finalizeReleaseCheck } from '../src/release.ts';
import { createPythonRegressionDraft, publishPythonRegression, readPythonRegression, runPythonRegression } from '../src/python-regression.ts';
import { validateProject } from '../src/validation.ts';
import { approvalIsCurrent, testPlanHash } from '../src/approval.ts';
import type { PythonRegressionManifest, TestRun, TestTask } from '../src/types.ts';

const repository = process.cwd();
const cli = join(repository, 'src', 'cli.ts');

function command(cwd: string, ...arguments_: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--experimental-strip-types', cli, ...arguments_], { cwd, encoding: 'utf8' });
}
function run(cwd: string, ...arguments_: string[]): string {
  const result = command(cwd, ...arguments_);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
function json<T = any>(cwd: string, ...arguments_: string[]): T { return JSON.parse(run(cwd, ...arguments_)) as T; }
function importHost(root: string, capabilities = ['browser.interact', 'browser.inspect']): void {
  const path = join(root, 'host.json');
  writeFileSync(path, JSON.stringify({ host: 'test-host', collectedAt: new Date().toISOString(), connections: [{ id: 'test-host', capabilities, permissionStatus: 'verified' }] }));
  run(root, 'host', 'import', '--file', path);
}
function approve(task: TestTask): TestTask {
  task.metadata.status = 'ready';
  const confirmedAt = new Date().toISOString();
  const planHash = testPlanHash(task);
  task.metadata.planReview = { confirmedBy: 'project-owner', confirmedAt, confirmationSource: 'external-review-record', statement: '确认测试方案', planHash };
  task.metadata.approval = { confirmedBy: 'project-owner', confirmedAt, confirmationSource: 'external-review-record', statement: '确认开始测试', planHash };
  return task;
}
function approveThroughCli(root: string, moduleId: string, taskId: string): void {
  run(root, 'plan', 'review', '--module', moduleId, '--task', taskId, '--approve', '--confirmed-by', 'project-owner', '--confirmation-text', '确认测试方案');
  run(root, 'review', '--module', moduleId, '--task', taskId, '--approve', '--confirmed-by', 'project-owner', '--confirmation-text', '确认开始测试');
}
function applyDetailedPlan(root: string, task: TestTask, options: { userQuestions?: string[]; confirmedDecisions?: string[]; platforms?: string[] } = {}): TestTask {
  const approvalWasCurrent = approvalIsCurrent(task);
  const scenario = task.scenarios[0]!;
  const planPath = join(root, `plan-${task.metadata.moduleId}-${task.metadata.id}.json`);
  writeFileSync(planPath, JSON.stringify({
    apiVersion: 'qa-agent/plan-draft/v1',
    moduleId: task.metadata.moduleId,
    taskId: task.metadata.id,
    taskName: task.metadata.name,
    description: task.description,
    objectives: task.objectives,
    scope: { ...task.scope, platforms: options.platforms ?? task.scope.platforms },
    preconditions: task.preconditions,
    userQuestions: options.userQuestions ?? [],
    confirmedDecisions: options.confirmedDecisions ?? [],
    scenarios: [{
      id: scenario.id,
      title: scenario.title,
      intent: scenario.intent,
      input: scenario.input,
      preconditions: scenario.preconditions,
      expected: scenario.expected,
      evidence: scenario.evidence,
      cleanup: scenario.cleanup,
      risk: scenario.risk,
      planningStatus: 'applicable',
      priority: scenario.priority,
      requirementRefs: scenario.requirementRefs,
      sourceRefs: scenario.sourceRefs,
      steps: [
        { id: 'open-target', action: '打开测试目标页面', expected: '页面正常加载并显示目标业务区域。' },
        { id: 'locate-state', action: `定位与“${scenario.intent}”相关的控件和状态`, expected: '目标控件、文案和业务状态可以被稳定识别。' },
        { id: 'execute-flow', action: `执行已规划业务流程：${scenario.intent}`, expected: String(scenario.expected.outcome ?? '业务流程进入预期状态。') },
        { id: 'verify-result', action: '验证最终控件状态、可见文案和业务反馈', expected: '实际结果与所有业务断言一致，或记录明确差异。' },
        { id: 'capture-evidence', action: '截取关键结果页面', expected: '截图保存到对应 Task Run 目录。' },
      ],
      visualAssertions: scenario.visualAssertions,
    }],
  }, null, 2));
  const applied = json(root, 'plan', 'apply', '--file', planPath);
  assert.equal(applied.requirementsConfirmationRequired, !approvalWasCurrent || Boolean(options.userQuestions?.length));
  assert.equal(applied.requiredRequirementsConfirmation, '确认测试方案');
  assert.deepEqual(applied.unresolvedQuestions, options.userQuestions ?? []);
  assert.equal(applied.approvalRequired, !approvalWasCurrent || Boolean(options.userQuestions?.length));
  assert.equal(applied.requiredConfirmation, '确认开始测试');
  return readTask(root, task.metadata.moduleId, task.metadata.id);
}
function prepareQuickTask(root: string, request: string): { prepared: any; task: TestTask } {
  const prepared = json(root, 'check', request);
  assert.equal(prepared.runId, undefined);
  assert.equal(prepared.uiExecutionAllowed, false);
  assert.equal(prepared.mustStop, true);
  assert.equal(prepared.planningRequired, true);
  assert.equal(prepared.requiredRequirementsConfirmationAfterPlanning, '确认测试方案');
  assert.equal(prepared.requiredConfirmationAfterPlanning, '确认开始测试');
  assert.ok(existsSync(prepared.prdPath));
  assert.equal(prepared.userFacingArtifacts[0].kind, 'task-prd');
  assert.match(prepared.userFacingArtifacts[0].markdownLink, /^\[查看测试方案 PRD\]\(.+\/prd\.md\)$/);
  assert.equal(prepared.requiredUserFacingLinks, prepared.userFacingArtifacts[0].markdownLink);
  assert.match(readFileSync(prepared.prdPath, 'utf8'), /等待 Agent 根据项目生成详细步骤/);
  const task = applyDetailedPlan(root, readTask(root, prepared.quickCheck.moduleId, prepared.quickCheck.taskId));
  const prd = readFileSync(prepared.prdPath, 'utf8');
  assert.match(prd, /\| 步骤 \| 操作 \| 预期结果 \|/);
  assert.match(prd, /确认测试方案/);
  assert.match(prd, /确认开始测试/);
  assert.doesNotMatch(prd, /等待 Agent 根据项目生成详细步骤/);
  return { prepared, task };
}
function startQuickTask(root: string, request: string): { prepared: any; task: TestTask; started: any } {
  const { prepared, task } = prepareQuickTask(root, request);
  approveThroughCli(root, task.metadata.moduleId, task.metadata.id);
  const started = json(root, 'test', '--module', task.metadata.moduleId, '--task', task.metadata.id);
  return { prepared, task: readTask(root, task.metadata.moduleId, task.metadata.id), started };
}
function completeRun(root: string, task: TestTask, runId: string, options: { businessStatus?: 'passed' | 'failed'; action?: 'click' | 'fill'; inputRefs?: Record<string,string> } = {}): TestRun {
  const screenshot = join(root, `${runId}.png`);
  writeFileSync(screenshot, 'screenshot');
  const action = options.action ?? 'click';
  recordAgentStep(root, runId, {
    action: action === 'fill' ? 'Fill account field' : 'Click primary action',
    detail: 'Executed the approved business step.',
    screenshotPath: screenshot,
    scenarioId: task.scenarios[0]!.id,
    source: 'ui',
    executionMode: 'host-automated',
    uiAction: action,
    locator: { strategy: 'role', value: action === 'fill' ? 'textbox:Account' : 'button:Continue' },
    actualLocator: { strategy: 'role', value: action === 'fill' ? 'textbox:Account' : 'button:Continue' },
    inputRefs: options.inputRefs,
    expectedState: 'Expected business state is visible.',
    actualState: options.businessStatus === 'failed' ? 'Unexpected state is visible.' : 'Expected business state is visible.',
  });
  for (const assertion of task.scenarios[0]!.visualAssertions ?? []) {
    recordVisualFinding(root, runId, {
      scenarioId: task.scenarios[0]!.id,
      assertionId: assertion.id,
      expected: assertion.expected,
      actual: options.businessStatus === 'failed' ? 'The product showed an unexpected state.' : 'The expected business result was visible.',
      status: options.businessStatus ?? 'passed',
      screenshotPath: screenshot,
    });
  }
  return completeAgentGuidedRun(root, task, runId);
}
function createFormalScript(root: string, task: TestTask, sourceRun: TestRun, scriptId: string, businessStatus: 'passed' | 'failed' = 'passed'): PythonRegressionManifest {
  assert.equal(sourceRun.pythonRegressionEligibility?.eligible, true);
  const flowHash = sourceRun.pythonRegressionEligibility!.flowHash!;
  const stepIds = sourceRun.pythonRegressionEligibility!.sourceStepIds;
  const scriptPath = join(root, `${scriptId}.py`);
  const metadata = JSON.stringify({ scriptId, sourceRunId: sourceRun.id, sourceStepIds: stepIds, sourceFlowHash: flowHash });
  const resultSteps = stepIds.map((id, index) => ({ id, name: `Recorded step ${index + 1}`, status: businessStatus, expected: 'Expected business state is visible.', actual: businessStatus === 'passed' ? 'Expected business state is visible.' : 'Unexpected business state is visible.', screenshot: `screenshots/${id}.png` }));
  const python = `# QA_AGENT_REGRESSION: ${metadata}\nimport json\nimport os\nfrom pathlib import Path\n\nSOURCE_STEP_IDS = ${JSON.stringify(stepIds)}\n\ndef main():\n    screenshot_dir = Path(os.environ["QA_AGENT_SCREENSHOT_DIR"])\n    screenshot_dir.mkdir(parents=True, exist_ok=True)\n    for step_id in SOURCE_STEP_IDS:\n        (screenshot_dir / f"{step_id}.png").write_bytes(b"screenshot")\n    result = ${JSON.stringify({ apiVersion: 'qa-agent/python-regression-result/v1', status: businessStatus, contractStatus: 'completed', conclusion: businessStatus === 'passed' ? 'Regression passed.' : 'Regression found a business failure.', steps: resultSteps, cleanup: [] })}\n    Path(os.environ["QA_AGENT_RESULT_PATH"]).write_text(json.dumps(result), encoding="utf-8")\n\nif __name__ == "__main__":\n    main()\n`;
  writeFileSync(scriptPath, python);
  createPythonRegressionDraft(root, { moduleId: task.metadata.moduleId, taskId: task.metadata.id, runId: sourceRun.id, scriptId, scriptFile: scriptPath });
  const published = publishPythonRegression(root, { moduleId: task.metadata.moduleId, taskId: task.metadata.id, draftId: scriptId, confirmedBy: 'project-owner' });
  const validation = runPythonRegression(root, { moduleId: task.metadata.moduleId, taskId: task.metadata.id, scriptId });
  assert.equal(validation.contractStatus, 'completed');
  return readPythonRegression(root, task.metadata.moduleId, task.metadata.id, scriptId);
}
function strictTaskWithRun(root: string, moduleId: string, taskId: string, risk: 'medium'|'critical' = 'medium'): { task: TestTask; run: TestRun } {
  const module = createModule(root, { id: moduleId, name: moduleId, description: `${moduleId} flow`, riskLevel: risk, platforms: ['web'], sourceHints: [`src/${moduleId}`] });
  let task = createTaskSkeleton(module, taskId, taskId);
  approve(task);
  saveTask(root, task);
  task = readTask(root, moduleId, taskId);
  const started = beginAgentGuidedRun(root, task);
  const completed = completeRun(root, task, started.id);
  return { task: readTask(root, moduleId, taskId), run: completed };
}

test('initializes v0.3.93 with the bundled Runner and exposes simplified help', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-init-'));
  run(root, 'init', '--id', 'fixture');
  assert.equal(run(root, '--version').trim(), '0.3.93');
  const help = run(root, 'help');
  for (const commandName of ['init', 'check', 'continue', 'finish', 'doctor', 'update']) assert.match(help, new RegExp(commandName));
  assert.doesNotMatch(help, /operation plan|operation replay/i);
  const doctor = json(root, 'doctor');
  assert.equal(doctor.recommendedRegressionStack.policy, 'recommended-not-required');
  assert.equal(doctor.recommendedRegressionStack.platforms[0]?.platform, 'web');
  assert.equal(doctor.recommendedRegressionStack.platforms[0]?.mandatory, false);
  assert.ok(doctor.recommendedRegressionStack.unifiedOutput.includes('result.json'));
  const module = createModule(root, { id: 'auth', name: 'Auth', description: 'Auth', platforms: ['web'] });
  const task = createTaskSkeleton(module, 'login'); saveTask(root, task);
  const taskRoot = taskDirectory(root, 'auth', 'login');
  assert.equal(existsSync(join(taskRoot, 'operation-plans')), false);
  assert.equal(existsSync(join(taskRoot, 'regression-suite.json')), false);
  assert.equal(existsSync(join(taskRoot, 'reports')), false);
  assert.equal(existsSync(join(taskRoot, 'runs')), false);
  assert.equal(existsSync(join(taskRoot, 'source-run')), false);
  assert.equal(existsSync(join(root, '.qa-agent', 'schemas', 'operation.schema.json')), false);
  assert.equal(existsSync(join(root, '.qa-agent', 'schemas', 'regression-suite.schema.json')), false);
  assert.equal(existsSync(join(root, '.qa-agent', 'skills', 'built-in', 'operation-replay.json')), false);
  assert.equal(existsSync(join(root, '.qa-agent', 'runner')), false);
  assert.equal(JSON.parse(readFileSync(join(root, '.qa-agent', '.version'), 'utf8')).version, '0.3.93');
  assert.equal(validateProject(root).valid, true);
});

test('reports a missing managed Runner during project validation', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-runner-validation-'));
  initializeProject(root, { id: 'runner-validation' });
  const previous = process.env.QA_AGENT_RUNNER_DIR;
  process.env.QA_AGENT_RUNNER_DIR = join(root, 'missing-runner');
  try {
    const result = validateProject(root);
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /Unified Runner is missing|does not contain qa_agent_runner/i);
  } finally {
    if (previous === undefined) delete process.env.QA_AGENT_RUNNER_DIR;
    else process.env.QA_AGENT_RUNNER_DIR = previous;
  }
});

test('Quick Check completes with report, PRD, and direct Python eligibility', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-quick-'));
  run(root, 'init', '--id', 'quick'); importHost(root);
  const { task, started } = startQuickTask(root, '测试登录流程');
  const completed = completeRun(root, task, started.runId);
  assert.equal(completed.status, 'passed');
  assert.equal(completed.pythonRegressionEligibility?.eligible, true);
  assert.ok(completed.pythonRegressionEligibility?.flowHash);
  const taskRoot = taskDirectory(root, task.metadata.moduleId, task.metadata.id);
  assert.ok(existsSync(taskSourceRunReportPath(root, task.metadata.moduleId, task.metadata.id)));
  const report = readFileSync(taskSourceRunReportPath(root, task.metadata.moduleId, task.metadata.id), 'utf8');
  assert.match(report, /## Embedded Screenshots/);
  for (const screenshot of completed.screenshots) assert.ok(report.includes(`](./${screenshot.path.replace(/^source-run\//, '')})`));
  assert.equal(existsSync(join(taskRoot, 'runs')), false);
  assert.equal(readTask(root, task.metadata.moduleId, task.metadata.id).sourceRunRef, 'source-run/run.json');
  assert.equal(readTask(root, task.metadata.moduleId, task.metadata.id).sourceReportRef, 'source-run/report.md');
  assert.ok(existsSync(join(taskRoot, 'prd.md')));
  assert.equal(readTask(root, task.metadata.moduleId, task.metadata.id).metadata.status, 'completed');
  assert.equal(existsSync(join(taskRoot, 'operation-plans')), false);
  assert.equal(existsSync(join(taskRoot, 'regression-suite.json')), false);
  assert.equal(validateProject(root).valid, true);
});

test('Run eligibility rejects incomplete structured input trace without creating duplicate assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-ineligible-'));
  run(root, 'init', '--id', 'ineligible'); importHost(root);
  const { task, started } = startQuickTask(root, '测试表单输入');
  const completed = completeRun(root, task, started.runId, { action: 'fill' });
  assert.equal(completed.status, 'passed');
  assert.equal(completed.pythonRegressionEligibility?.eligible, false);
  assert.match(JSON.stringify(completed.pythonRegressionEligibility?.issues), /inputRefs/);
  assert.equal(existsSync(join(taskDirectory(root, task.metadata.moduleId, task.metadata.id), 'operation-plans')), false);
});

test('a new initial execution replaces the unpublished Source Run instead of creating runs history', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-source-replace-'));
  run(root, 'init', '--id', 'source-replace'); importHost(root);
  const first = startQuickTask(root, '验证可重复的商品流程');
  const completed = completeRun(root, first.task, first.started.runId);
  const taskRoot = taskDirectory(root, first.task.metadata.moduleId, first.task.metadata.id);
  assert.match(readFileSync(join(taskRoot, 'prd.md'), 'utf8'), /QA-AGENT:RESULTS:START/);
  const second = json(root, 'test', '--module', first.task.metadata.moduleId, '--task', first.task.metadata.id);
  assert.equal(second.status, 'running');
  assert.notEqual(second.runId, completed.id);
  assert.equal(JSON.parse(readFileSync(taskSourceRunPath(root, first.task.metadata.moduleId, first.task.metadata.id), 'utf8')).id, second.runId);
  assert.equal(existsSync(join(taskRoot, 'runs')), false);
  assert.doesNotMatch(readFileSync(join(taskRoot, 'prd.md'), 'utf8'), /QA-AGENT:RESULTS:START/);
  assert.match(readFileSync(join(taskRoot, 'events.jsonl'), 'utf8'), /source_run_restarted/);
});

test('a formal Python script freezes the Source Run and sends later execution to regression-runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-source-frozen-'));
  initializeProject(root, { id: 'source-frozen' }); importHost(root);
  const source = strictTaskWithRun(root, 'catalog', 'frozen-flow');
  createFormalScript(root, source.task, source.run, 'frozen-script');
  const rejected = command(root, 'test', '--module', 'catalog', '--task', 'frozen-flow');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Source Run .* frozen|formal Python regression/i);
  assert.equal(JSON.parse(readFileSync(taskSourceRunPath(root, 'catalog', 'frozen-flow'), 'utf8')).id, source.run.id);
  assert.ok(existsSync(join(taskDirectory(root, 'catalog', 'frozen-flow'), 'regression-runs')));
});

test('PlanDraft requires explicit detailed steps before review', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-prd-steps-'));
  run(root, 'init', '--id', 'plan-steps');
  run(root, 'start', '--request', '验证商品状态', '--module', 'catalog', '--task', 'product-state');
  const task = readTask(root, 'catalog', 'product-state');
  const scenario = task.scenarios[0]!;
  const planPath = join(root, 'plan-without-steps.json');
  writeFileSync(planPath, JSON.stringify({
    apiVersion: 'qa-agent/plan-draft/v1',
    moduleId: 'catalog',
    taskId: 'product-state',
    description: task.description,
    objectives: task.objectives,
    scenarios: [{
      id: scenario.id,
      title: scenario.title,
      intent: scenario.intent,
      expected: scenario.expected,
      planningStatus: 'applicable',
      visualAssertions: scenario.visualAssertions,
    }],
  }));
  const rejected = command(root, 'plan', 'apply', '--file', planPath);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /requires explicit detailed steps/i);
  assert.equal(readTask(root, 'catalog', 'product-state').metadata.status, 'planning');
  assert.equal(readTask(root, 'catalog', 'product-state').sourceRunRef, undefined);
});

test('Task requires QA PRD confirmation and separate start authorization before real execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-approval-'));
  run(root, 'init', '--id', 'approval'); importHost(root);
  const started = json(root, 'start', '--request', '验证登录流程', '--module', 'auth', '--task', 'login-flow');
  assert.equal(started.workflowStatus, 'setup_required');
  assert.equal(started.workflowPhase, 'planning');
  applyDetailedPlan(root, readTask(root, 'auth', 'login-flow'));
  const workflowBeforeReview = json(root, 'workflow', 'status', '--module', 'auth', '--task', 'login-flow');
  assert.equal(workflowBeforeReview.workflowStatus, 'approval_required');
  assert.equal(workflowBeforeReview.reasonCode, 'test_plan_requirements_confirmation_required');
  const blocked = command(root, 'test', '--module', 'auth', '--task', 'login-flow');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /确认测试方案|confirmed by QA/i);
  assert.equal(readTask(root, 'auth', 'login-flow').sourceRunRef, undefined);
  const earlyStart = command(root, 'review', '--module', 'auth', '--task', 'login-flow', '--approve', '--confirmed-by', 'project-owner', '--confirmation-text', '确认开始测试');
  assert.notEqual(earlyStart.status, 0);
  assert.match(earlyStart.stderr, /确认测试方案/);
  const wrongPlanPhrase = command(root, 'plan', 'review', '--module', 'auth', '--task', 'login-flow', '--approve', '--confirmed-by', 'project-owner', '--confirmation-text', '没问题');
  assert.notEqual(wrongPlanPhrase.status, 0);
  run(root, 'plan', 'review', '--module', 'auth', '--task', 'login-flow', '--approve', '--confirmed-by', 'project-owner', '--confirmation-text', '确认测试方案');
  const afterPlanReview = json(root, 'workflow', 'status', '--module', 'auth', '--task', 'login-flow');
  assert.equal(afterPlanReview.reasonCode, 'explicit_start_confirmation_required');
  const missingPhrase = command(root, 'review', '--module', 'auth', '--task', 'login-flow', '--approve', '--confirmed-by', 'project-owner');
  assert.notEqual(missingPhrase.status, 0);
  const wrongPhrase = command(root, 'review', '--module', 'auth', '--task', 'login-flow', '--approve', '--confirmed-by', 'project-owner', '--confirmation-text', '可以测试');
  assert.notEqual(wrongPhrase.status, 0);
  run(root, 'review', '--module', 'auth', '--task', 'login-flow', '--approve', '--confirmed-by', 'project-owner', '--confirmation-text', '确认开始测试');
  const execution = json(root, 'test', '--module', 'auth', '--task', 'login-flow');
  assert.equal(execution.status, 'running');
  assert.equal(execution.uiExecutionAllowed, true);
});

test('unresolved QA questions block PRD confirmation until answers are applied', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-prd-questions-'));
  run(root, 'init', '--id', 'prd-questions');
  run(root, 'start', '--request', '验证首次启动欢迎弹窗', '--module', 'onboarding', '--task', 'welcome-dialog');
  let task = readTask(root, 'onboarding', 'welcome-dialog');
  task = applyDetailedPlan(root, task, { userQuestions: ['本场景是否要求全新安装且没有历史本地状态？'] });
  const workflow = json(root, 'workflow', 'status', '--module', 'onboarding', '--task', 'welcome-dialog');
  assert.equal(workflow.reasonCode, 'qa_requirement_questions_unresolved');
  assert.match(workflow.nextActions[0].description, /全新安装/);
  const prd = readFileSync(join(taskDirectory(root, 'onboarding', 'welcome-dialog'), 'prd.md'), 'utf8');
  assert.match(prd, /本场景是否要求全新安装/);
  const rejected = command(root, 'plan', 'review', '--module', 'onboarding', '--task', 'welcome-dialog', '--approve', '--confirmed-by', 'project-owner', '--confirmation-text', '确认测试方案');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unresolved QA questions|待 QA 回答/i);

  task = applyDetailedPlan(root, task, { confirmedDecisions: ['该场景必须从全新安装且无历史本地状态开始。'] });
  run(root, 'plan', 'review', '--module', 'onboarding', '--task', 'welcome-dialog', '--approve', '--confirmed-by', 'project-owner', '--confirmation-text', '确认测试方案');
  const reviewed = readTask(root, 'onboarding', 'welcome-dialog');
  assert.equal(reviewed.requirements?.userQuestions.length, 0);
  assert.deepEqual(reviewed.requirements?.confirmedDecisions, ['该场景必须从全新安装且无历史本地状态开始。']);
  assert.equal(reviewed.metadata.planReview?.statement, '确认测试方案');
});

test('User-led QA keeps one pending interaction and generates one regression script per Scenario', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-guided-'));
  run(root, 'init', '--id', 'guided'); importHost(root);
  const prepared = json(root, 'check', '--mode', 'guided', '--request', '验证首次安装 Welcome Dialog');
  assert.equal(prepared.check.mode, 'guided');
  let task = readTask(root, prepared.check.moduleId, prepared.check.taskId);
  assert.equal(task.metadata.mode, 'guided');
  task = applyDetailedPlan(root, task);
  approveThroughCli(root, task.metadata.moduleId, task.metadata.id);

  const started = json(root, 'test', '--module', task.metadata.moduleId, '--task', task.metadata.id);
  assert.equal(started.status, 'running');
  assert.equal(started.controlMode, 'user-led');
  const guidedRunId = started.runId as string;
  assert.equal(guidedRunId !== undefined, true);
  assert.equal(started.uiExecutionAllowed, false);
  assert.equal(started.mustStop, true);
  const scenario = task.scenarios[0]!;
  const plannedStep = scenario.plannedSteps[0]!;
  const screenshot = join(root, 'guided-step.png'); writeFileSync(screenshot, 'guided screenshot');

  assert.throws(() => recordAgentStep(root, guidedRunId, {
    action: plannedStep.action, detail: 'Attempted without QA approval.', screenshotPath: screenshot,
    scenarioId: scenario.id, source: 'ui', executionMode: 'host-automated', uiAction: 'click',
    actualLocator: { strategy: 'role', value: 'button:Open' }, expectedState: plannedStep.expected, actualState: plannedStep.expected,
  }), /QA-approved action|guide-approve/i);

  const approvedAction = json(root, 'run', 'guide-approve', guidedRunId,
    '--scenario', scenario.id, '--planned-step', plannedStep.id,
    '--confirmed-by', 'project-owner', '--confirmation-text', '是的，执行这一步');
  assert.equal(approvedAction.uiExecutionAllowed, true);

  const afterStep = recordAgentStep(root, guidedRunId, {
    action: plannedStep.action, detail: 'The approved action was executed.', screenshotPath: screenshot,
    scenarioId: scenario.id, source: 'ui', executionMode: 'host-automated', uiAction: 'click',
    actualLocator: { strategy: 'role', value: 'button:Open' }, expectedState: plannedStep.expected, actualState: plannedStep.expected,
  });
  const step = afterStep.steps.at(-1)!;
  assert.equal(step.status, 'blocked');
  assert.equal(afterStep.guidedPending?.type, 'result_verdict');
  assert.throws(() => approveGuidedAction(root, guidedRunId, {
    scenarioId: scenario.id, plannedStepId: scenario.plannedSteps[1]!.id,
    confirmedBy: 'project-owner', statement: '继续下一步',
  }), /waiting for the QA verdict/i);
  assert.throws(() => completeAgentGuidedRun(root, task, guidedRunId), /waiting for the QA verdict|QA confirms every UI result/i);

  const verdict = json(root, 'run', 'guide-verdict', guidedRunId,
    '--step', step.id, '--status', 'passed', '--confirmed-by', 'project-owner',
    '--confirmation-text', '是的，符合预期');
  assert.equal(verdict.uiExecutionAllowed, false);
  const afterVerdict = JSON.parse(readFileSync(taskSourceRunPath(root, task.metadata.moduleId, task.metadata.id), 'utf8')) as TestRun;
  assert.equal(afterVerdict.steps.at(-1)?.humanVerdict?.status, 'passed');
  assert.equal(afterVerdict.guidedPending, undefined);

  for (const assertion of scenario.visualAssertions ?? []) recordVisualFinding(root, guidedRunId, {
    assertionId: assertion.id, expected: assertion.expected, actual: assertion.expected,
    status: 'passed', screenshotPath: screenshot, scenarioId: scenario.id,
  });
  const completed = completeAgentGuidedRun(root, task, guidedRunId);
  assert.equal(completed.status, 'passed');
  assert.equal(completed.guidedPending, undefined);
  assert.equal(completed.scenarioRegressionDrafts?.length, 1);
  const scenarioDraft = completed.scenarioRegressionDrafts![0]!;
  const scenarioScriptPath = join(taskSourceRunDirectory(root, task.metadata.moduleId, task.metadata.id), scenarioDraft.scriptRef);
  assert.ok(existsSync(scenarioScriptPath));
  assert.ok(scenarioDraft.scriptRef.endsWith('steps.json'));
  const scenarioSteps = JSON.parse(readFileSync(scenarioScriptPath, 'utf8'));
  assert.equal(scenarioSteps.apiVersion, 'qa-agent/regression-steps/v1');
  assert.ok(Array.isArray(scenarioSteps.steps) && scenarioSteps.steps.length > 0);
  assert.ok(scenarioSteps.steps.some((entry: { id: string }) => entry.id === step.id));
  const report = readFileSync(taskSourceRunReportPath(root, task.metadata.moduleId, task.metadata.id), 'utf8');
  assert.match(report, /User-led QA Decisions/);
  assert.match(report, /Scenario Regression Drafts/);
  assert.match(report, /project-owner/);
  assert.equal(validateProject(root).valid, true);
});

test('missing host capability blocks execution without fabricating results', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-capability-'));
  run(root, 'init', '--id', 'capability');
  const { task } = prepareQuickTask(root, '测试首页');
  approveThroughCli(root, task.metadata.moduleId, task.metadata.id);
  const started = json(root, 'test', '--module', task.metadata.moduleId, '--task', task.metadata.id);
  assert.equal(started.status, 'blocked');
  assert.equal(started.uiExecutionAllowed, false);
  assert.match(started.conclusion, /capability|precondition/i);
});

test('safety policy blocks prohibited UI actions', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-safety-'));
  run(root, 'init', '--id', 'safety'); importHost(root);
  const { started } = startQuickTask(root, '验证支付前页面');
  const screenshot = join(root, 'safe.png'); writeFileSync(screenshot, 'shot');
  assert.throws(() => recordAgentStep(root, started.runId, { action: 'Submit payment', safetyAction: 'payment.submit.real', detail: 'Would submit a real payment.', screenshotPath: screenshot, scenarioId: 'exploration', source: 'ui' }), /Safety policy blocks/);
});

test('Task and Module regression run validated Python scripts directly', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-batch-'));
  initializeProject(root, { id: 'batch' }); importHost(root);
  const first = strictTaskWithRun(root, 'auth', 'login'); createFormalScript(root, first.task, first.run, 'login-script');
  const secondModule = createModule(root, { id: 'profile', name: 'profile', description: 'profile', platforms: ['web'] });
  let secondTask = createTaskSkeleton(secondModule, 'profile-save'); approve(secondTask); saveTask(root, secondTask); secondTask = readTask(root, 'profile', 'profile-save');
  const secondRun = completeRun(root, secondTask, beginAgentGuidedRun(root, secondTask).id); createFormalScript(root, secondTask, secondRun, 'profile-script');
  const taskSelection = buildTaskRegressionSelection(root, first.task);
  assert.deepEqual(taskSelection.members.map(item => item.regressionId), ['login-script']);
  assert.equal(runRegressionSelection(root, taskSelection).status, 'passed');
  const moduleSelection = buildModuleRegressionSelection(root, 'auth');
  assert.equal(moduleSelection.members.length, 1);
  const batch = runRegressionSelection(root, moduleSelection);
  assert.equal(batch.kind, 'PythonRegressionBatchRun');
  assert.equal(batch.childRuns[0]?.contractStatus, 'completed');
});

test('Release selection uses validated Python scripts and reports required asset gaps', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-release-'));
  initializeProject(root, { id: 'release' }); importHost(root);
  const ready = strictTaskWithRun(root, 'checkout', 'checkout-gate', 'critical'); createFormalScript(root, ready.task, ready.run, 'checkout-script');
  const missingModule = createModule(root, { id: 'orders', name: 'orders', description: 'orders', riskLevel: 'critical', platforms: ['web'], sourceHints: ['src/orders'] });
  const missingTask = createTaskSkeleton(missingModule, 'orders-gate'); approve(missingTask); saveTask(root, missingTask);
  const impact = analyzeProjectImpact(root, { changedFiles: ['src/checkout/page.ts', 'src/orders/service.ts'] });
  const selection = buildReleaseRegressionSelection(root, impact, 'full');
  assert.ok(selection.members.some(item => item.regressionId === 'checkout-script'));
  assert.ok(selection.requiredAssetGaps?.some(item => item.taskId === 'orders-gate'));
  const check = createReleaseCheck(selection, impact, 'full');
  assert.equal(check.releaseDecision, 'no-go');
  const batch = runRegressionSelection(root, selection);
  finalizeReleaseCheck(check, batch);
  assert.equal(check.releaseDecision, 'no-go');
});

test('a genuine business FAIL keeps a completed Python execution contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-business-fail-'));
  initializeProject(root, { id: 'business-fail' }); importHost(root);
  const source = strictTaskWithRun(root, 'catalog', 'search');
  const manifest = createFormalScript(root, source.task, source.run, 'search-script', 'failed');
  assert.equal(manifest.status, 'validated');
  assert.equal(manifest.lastRunStatus, 'failed');
});

test('Archive requires validated Python coverage and succeeds after script validation', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-archive-'));
  initializeProject(root, { id: 'archive' }); importHost(root);
  const source = strictTaskWithRun(root, 'account', 'profile');
  const before = inspectTaskArchive(root, source.task);
  assert.equal(before.valid, false);
  assert.match(JSON.stringify(before.checks), /Python regression/i);
  createFormalScript(root, source.task, source.run, 'profile-script');
  const current = readTask(root, 'account', 'profile');
  const after = inspectTaskArchive(root, current);
  assert.equal(after.valid, true, JSON.stringify(after, null, 2));
  run(root, 'archive', '--module', 'account', '--task', 'profile');
  assert.equal(readTask(root, 'account', 'profile').metadata.status, 'archived');
});

test('changing a Task plan marks Python stale but preserves approval for a replacement Source Run', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-stale-'));
  initializeProject(root, { id: 'stale' }); importHost(root);
  const source = strictTaskWithRun(root, 'settings', 'preferences'); createFormalScript(root, source.task, source.run, 'preferences-script');
  run(root, 'task', 'update', 'preferences', '--module', 'settings', '--name', 'Changed preferences flow');
  assert.equal(readPythonRegression(root, 'settings', 'preferences', 'preferences-script').status, 'stale');
  const replacement = json(root, 'test', '--module', 'settings', '--task', 'preferences');
  assert.equal(replacement.status, 'running');
  assert.notEqual(replacement.runId, source.run.id);
  assert.equal(JSON.parse(readFileSync(taskSourceRunPath(root, 'settings', 'preferences'), 'utf8')).id, replacement.runId);
});

test('switching a reviewed Task from Web to iOS keeps approval and refreshes platform capabilities', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-platform-switch-'));
  initializeProject(root, { id: 'platform-switch', platforms: ['web'] });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Checkout flow', platforms: ['web'] });
  const initial = createTaskSkeleton(module, 'payment-method');
  saveTask(root, initial);
  applyDetailedPlan(root, readTask(root, 'checkout', 'payment-method'), { platforms: ['web'] });
  approveThroughCli(root, 'checkout', 'payment-method');
  const approved = readTask(root, 'checkout', 'payment-method');

  const switched = applyDetailedPlan(root, readTask(root, 'checkout', 'payment-method'), { platforms: ['ios'] });
  assert.deepEqual(switched.scope.platforms, ['ios']);
  assert.equal(switched.capabilities.required.includes('browser.interact'), false);
  assert.equal(switched.capabilities.required.includes('ios.simulator.interact'), true);
  assert.equal(approvalIsCurrent(switched), true);
  assert.equal(switched.metadata.status, 'ready');
  assert.equal(approved.metadata.approval?.confirmedBy, switched.metadata.approval?.confirmedBy);

  importHost(root, ['ios.simulator.interact', 'ios.screenshot']);
  const started = json(root, 'test', '--module', 'checkout', '--task', 'payment-method', '--platform', 'ios');
  assert.equal(started.status, 'running');
  assert.equal(started.context.platform, 'ios');
});

test('rejects projects created by another Runtime version instead of migrating them', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-fresh-version-'));
  run(root, 'init', '--id', 'fresh-version');
  writeFileSync(join(root, '.qa-agent', '.version'), JSON.stringify({ version: '0.3.6', initializedAt: '2026-01-01T00:00:00.000Z' }));
  for (const args of [['update'], ['doctor'], ['check', '--request', '旧项目不应被读取'], ['init']]) {
    const rejected = command(root, ...args);
    assert.notEqual(rejected.status, 0, args.join(' '));
    assert.match(rejected.stderr, /not supported|fresh project|remove \.qa-agent/i);
  }
  const migrate = command(root, 'migrate');
  assert.notEqual(migrate.status, 0);
  assert.match(migrate.stderr, /Unsupported command/i);
  assert.equal(existsSync(join(repository, 'src', 'migration.ts')), false);
});
