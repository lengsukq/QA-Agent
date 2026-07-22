import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { beginAgentGuidedRun, completeAgentGuidedRun, recordAgentStep, recordVisualFinding } from '../src/engine.ts';
import { createModule, initializeProject, readTask, saveTask, taskDirectory, taskRunReportPath } from '../src/project.ts';
import { createTaskSkeleton } from '../src/planning.ts';
import { inspectTaskArchive } from '../src/archive.ts';
import { analyzeProjectImpact } from '../src/impact-analysis.ts';
import { buildModuleRegressionSelection, buildReleaseRegressionSelection, buildTaskRegressionSelection, runRegressionSelection } from '../src/regression.ts';
import { createReleaseCheck, finalizeReleaseCheck } from '../src/release.ts';
import { createPythonRegressionDraft, publishPythonRegression, readPythonRegression, runPythonRegression } from '../src/python-regression.ts';
import { migrateProjectArtifacts } from '../src/migration.ts';
import { validateProject } from '../src/validation.ts';
import { testPlanHash } from '../src/approval.ts';
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
function importHost(root: string): void {
  const path = join(root, 'host.json');
  writeFileSync(path, JSON.stringify({ host: 'test-host', collectedAt: new Date().toISOString(), connections: [{ id: 'browser', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }] }));
  run(root, 'host', 'import', '--file', path);
}
function approve(task: TestTask): TestTask {
  task.metadata.status = 'ready';
  task.metadata.approval = { confirmedBy: 'project-owner', confirmedAt: new Date().toISOString(), confirmationSource: 'external-review-record', statement: 'Approved.', planHash: testPlanHash(task) };
  return task;
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

test('initializes v0.3.2 without replay directories and exposes simplified help', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-init-'));
  run(root, 'init', '--id', 'fixture');
  assert.equal(run(root, '--version').trim(), '0.3.2');
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
  assert.equal(validateProject(root).valid, true);
});

test('Quick Check completes with report, PRD, and direct Python eligibility', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-quick-'));
  run(root, 'init', '--id', 'quick'); importHost(root);
  const started = json(root, 'check', '测试登录流程');
  const task = readTask(root, started.quickCheck.moduleId, started.quickCheck.taskId);
  const completed = completeRun(root, task, started.runId);
  assert.equal(completed.status, 'passed');
  assert.equal(completed.pythonRegressionEligibility?.eligible, true);
  assert.ok(completed.pythonRegressionEligibility?.flowHash);
  const taskRoot = taskDirectory(root, task.metadata.moduleId, task.metadata.id);
  assert.ok(existsSync(taskRunReportPath(root, task.metadata.moduleId, task.metadata.id, completed.id)));
  assert.ok(existsSync(join(taskRoot, 'prd.md')));
  assert.equal(readTask(root, task.metadata.moduleId, task.metadata.id).metadata.status, 'completed');
  assert.equal(existsSync(join(taskRoot, 'operation-plans')), false);
  assert.equal(existsSync(join(taskRoot, 'regression-suite.json')), false);
  assert.equal(validateProject(root).valid, true);
});

test('Run eligibility rejects incomplete structured input trace without creating duplicate assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-ineligible-'));
  run(root, 'init', '--id', 'ineligible'); importHost(root);
  const started = json(root, 'check', '测试表单输入');
  const task = readTask(root, started.quickCheck.moduleId, started.quickCheck.taskId);
  const completed = completeRun(root, task, started.runId, { action: 'fill' });
  assert.equal(completed.status, 'passed');
  assert.equal(completed.pythonRegressionEligibility?.eligible, false);
  assert.match(JSON.stringify(completed.pythonRegressionEligibility?.issues), /inputRefs/);
  assert.equal(existsSync(join(taskDirectory(root, task.metadata.moduleId, task.metadata.id), 'operation-plans')), false);
});

test('strict Task requires human approval before real execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-approval-'));
  run(root, 'init', '--id', 'approval'); importHost(root);
  const started = json(root, 'start', '--request', '验证登录流程', '--module', 'auth', '--task', 'login-flow');
  assert.equal(started.workflowStatus, 'approval_required');
  const blocked = command(root, 'test', '--module', 'auth', '--task', 'login-flow');
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).status, 'needs_confirmation');
  run(root, 'review', '--module', 'auth', '--task', 'login-flow', '--approve', '--confirmed-by', 'project-owner');
  const execution = json(root, 'test', '--module', 'auth', '--task', 'login-flow');
  assert.equal(execution.status, 'running');
  assert.equal(execution.uiExecutionAllowed, true);
});

test('missing host capability blocks execution without fabricating results', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-capability-'));
  run(root, 'init', '--id', 'capability');
  const started = json(root, 'check', '测试首页');
  assert.equal(started.status, 'blocked');
  assert.equal(started.uiExecutionAllowed, false);
  assert.match(started.conclusion, /capability|precondition/i);
});

test('safety policy blocks prohibited UI actions', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-safety-'));
  run(root, 'init', '--id', 'safety'); importHost(root);
  const started = json(root, 'check', '验证支付前页面');
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

test('changing a Task plan marks a formal Python script stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-stale-'));
  initializeProject(root, { id: 'stale' }); importHost(root);
  const source = strictTaskWithRun(root, 'settings', 'preferences'); createFormalScript(root, source.task, source.run, 'preferences-script');
  run(root, 'task', 'update', 'preferences', '--module', 'settings', '--name', 'Changed preferences flow');
  assert.equal(readPythonRegression(root, 'settings', 'preferences', 'preferences-script').status, 'stale');
});

test('Migration removes legacy replay assets and upgrades Python source metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-migration-'));
  initializeProject(root, { id: 'migration' }); importHost(root);
  const source = strictTaskWithRun(root, 'legacy', 'legacy-task'); createFormalScript(root, source.task, source.run, 'legacy-script');
  const taskRoot = taskDirectory(root, 'legacy', 'legacy-task');
  const manifestPath = join(taskRoot, 'regression', 'legacy-script.json');
  const scriptPath = join(taskRoot, 'regression', 'legacy-script.py');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.apiVersion = 'qa-agent/python-regression/v1'; manifest.sourceOperationPlanIds = ['legacy-operation']; delete manifest.sourceFlowHash; delete manifest.scenarioIds;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const script = readFileSync(scriptPath, 'utf8').replace(/,"sourceFlowHash":"[^"]+"/, ''); writeFileSync(scriptPath, script);
  const taskManifestPath = join(taskRoot, 'task.json'); const taskManifest = JSON.parse(readFileSync(taskManifestPath, 'utf8')); taskManifest.operationPlanRefs = ['operation-plans/happy-path/v1.json']; taskManifest.regressionSuiteRef = 'regression-suite.json'; taskManifest.metadata.status = 'regression_ready'; writeFileSync(taskManifestPath, JSON.stringify(taskManifest, null, 2));
  mkdirSync(join(taskRoot, 'operation-plans', 'happy-path'), { recursive: true }); writeFileSync(join(taskRoot, 'operation-plans', 'happy-path', 'v1.json'), '{}'); writeFileSync(join(taskRoot, 'regression-suite.json'), '{}');
  const result = migrateProjectArtifacts(root);
  assert.equal(result.removedOperationPlanDirectories, 1);
  assert.equal(result.removedRegressionSuites, 1);
  assert.equal(existsSync(join(taskRoot, 'operation-plans')), false);
  assert.equal(existsSync(join(taskRoot, 'regression-suite.json')), false);
  const migrated = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(migrated.apiVersion, 'qa-agent/python-regression/v2');
  assert.ok(migrated.sourceFlowHash);
  assert.ok(migrated.scenarioIds.length);
  assert.equal(migrated.sourceOperationPlanIds, undefined);
  assert.equal(readTask(root, 'legacy', 'legacy-task').metadata.status, 'reviewing_result');
  assert.equal(validateProject(root).valid, true);
});

test('host force-update removes stale replay references and the old mixed regression Skill', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-host-'));
  run(root, 'install-host', 'cursor', '--project', root, '--force');
  const main = join(root, '.cursor', 'skills', 'qa-agent');
  const legacyReference = join(main, 'references', 'operating-model.md');
  writeFileSync(legacyReference, 'legacy replay reference');
  const legacySkill = join(root, '.cursor', 'skills', 'qa-agent-regression'); mkdirSync(legacySkill, { recursive: true }); writeFileSync(join(legacySkill, 'SKILL.md'), '---\nname: qa-agent-regression\ndescription: legacy\n---\n');
  run(root, 'install-host', 'cursor', '--project', root, '--force');
  assert.equal(existsSync(legacyReference), false);
  assert.equal(existsSync(legacySkill), false);
  assert.ok(existsSync(join(main, 'references', 'recommended-regression-stack.md')));
  assert.ok(existsSync(join(root, '.cursor', 'skills', 'qa-agent-regression-test', 'SKILL.md')));
});

test('legacy operation commands are removed from CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-old-cli-'));
  run(root, 'init', '--id', 'old-cli');
  for (const args of [['operation', 'generate'], ['operation', 'replay', 'legacy'], ['task', 'operation', 'list', '--module', 'auth'], ['task', 'regression', 'sync', '--module', 'auth']]) {
    const result = command(root, ...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /removed|Unsupported|task id|required/i);
  }
});
