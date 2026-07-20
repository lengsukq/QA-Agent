import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { beginAgentGuidedRun, beginRegressionRun, buildExecutionSnapshot, completeAgentGuidedRun, completeRegressionRun, recordAgentStep, recordCleanupFinding, recordRecoveryAttempt, recordVisualFinding } from '../src/engine.ts';
import { listOperations, reviewOperation } from '../src/operations.ts';
import { createModule, initializeProject, readRunById, readTask, saveTask, taskDirectory, taskRunDirectory, taskRunReportPath } from '../src/project.ts';
import { createTaskSkeleton } from '../src/planning.ts';
import { reviewMemory } from '../src/memory.ts';
import { testPlanHash } from '../src/approval.ts';
import type { TestTask } from '../src/types.ts';
import { buildModuleRegressionSuite, syncTaskRegressionSuite } from '../src/regression.ts';

const repository = process.cwd();
const cli = join(repository, 'src', 'cli.ts');
const installedCli = join(repository, 'bin', 'qa-agent.mjs');

function run(cwd: string, ...arguments_: string[]): string {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...arguments_], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function approveTask(task: TestTask): void {
  task.metadata.status = 'ready';
  task.metadata.approval = { confirmedBy: 'test-user', confirmedAt: new Date().toISOString(), confirmationSource: 'external-review-record', statement: 'Confirmed.', planHash: testPlanHash(task) };
}

function importHostSnapshot(root: string, connections: Array<{ id: string; capabilities: string[]; status?: 'available' | 'unavailable'; permissionStatus?: 'verified' | 'missing' | 'unknown' }>): void {
  const snapshot = join(root, 'host-capabilities.json');
  writeFileSync(snapshot, JSON.stringify({ host: 'test-host', collectedAt: new Date().toISOString(), connections }), 'utf8');
  run(root, 'host', 'import', '--file', snapshot);
}

test('initializes, plans, persists, validates, and requires host-driven execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-'));
  run(root, 'init', '--id', 'shop', '--name', 'Shop');
  assert.ok(existsSync(join(root, '.qa-agent', 'project.json')));
  assert.equal(existsSync(join(root, '.qa-agent', 'prompts', 'qa-main.md')), false);
  for (const mode of ['start.md', 'test.md', 'review.md', 'archive.md', 'report.md']) assert.ok(existsSync(join(root, '.qa-agent', 'prompts', mode)));
  assert.match(readFileSync(join(root, '.qa-agent', 'prompts', 'test.md'), 'utf8'), /uiExecutionAllowed=true/);
  assert.doesNotMatch(readFileSync(join(root, '.qa-agent', 'prompts', 'test.md'), 'utf8'), /[\u3400-\u9fff]/);
  assert.ok(existsSync(join(root, '.qa-agent', 'skills', 'built-in', 'execution-contract.json')));
  assert.equal(JSON.parse(run(root, 'skill', 'list')).length, 5);
  run(root, 'module', 'create', 'checkout', '--name', 'Checkout', '--description', 'Checkout flow', '--risk', 'high');
  const plan = JSON.parse(run(root, 'module', 'plan', 'checkout'));
  assert.equal(plan.suggestions.length, 8);
  const coverage = JSON.parse(run(root, 'module', 'coverage', 'checkout'));
  assert.equal(coverage.summary.total, 8);
  run(root, 'task', 'create', 'checkout-basic-flow', '--module', 'checkout');
  run(root, 'task', 'review', 'checkout-basic-flow', '--module', 'checkout', '--approve', '--confirmed-by', 'test-user');
  const taskRoot = taskDirectory(root, 'checkout', 'checkout-basic-flow');
  for (const file of ['task.json', 'module-snapshot.json', 'requirements.json', 'test-plan.json', 'scenarios/happy-path.json']) assert.ok(existsSync(join(taskRoot, file)), `missing task asset ${file}`);
  run(root, 'memory', 'add', 'checkout-rule', '--module', 'checkout', '--title', 'Checkout rule', '--content', 'Buyer can review the order total.');
  run(root, 'memory', 'review', 'checkout-rule', '--module', 'checkout', '--approve');
  const context = JSON.parse(run(root, 'context', 'module', 'checkout'));
  assert.equal(context.module.id, 'checkout');
  assert.equal(context.memories[0].id, 'checkout-rule');
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  assert.equal(JSON.parse(run(root, 'host', 'doctor')).healthy, true);
  const taskRun = JSON.parse(run(root, 'task', 'explore', 'checkout-basic-flow', '--module', 'checkout'));
  assert.equal(taskRun.status, 'running');
  assert.equal(taskRun.executionMode, 'explore');
  assert.equal(taskRun.mode, 'explore');
  assert.equal(taskRun.planningAllowed, true);
  assert.equal(taskRun.uiExecutionAllowed, true);
  assert.ok(taskRun.runId);
  for (const oldCommand of [['capability', 'list'], ['mcp', 'list'], ['mobile', 'doctor', '--platform', 'android'], ['task', 'runbook', 'checkout-basic-flow', '--module', 'checkout'], ['run', 'start', 'checkout-basic-flow', '--module', 'checkout'], ['run', 'replay', 'checkout-basic-flow', '--module', 'checkout', '--operation', 'op']]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...oldCommand], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${oldCommand.join(' ')} must be removed`);
    assert.match(result.stderr, /Unsupported command/);
  }
  const validation = JSON.parse(run(root, 'validate'));
  assert.equal(validation.valid, true);
  const incompleteArchive = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'task', 'archive', 'checkout-basic-flow', '--module', 'checkout'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(incompleteArchive.status, 0);
  assert.match(incompleteArchive.stdout, /Active OperationPlan|successful Runtime Run|RegressionSuite/);
  assert.equal(readTask(root, 'checkout', 'checkout-basic-flow').metadata.status, 'ready');
});

test('syncs current closure prompts into an initialized project', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-prompts-'));
  initializeProject(root, { id: 'prompt-fixture' });
  const executionPrompt = join(root, '.qa-agent', 'prompts', 'test.md');
  writeFileSync(executionPrompt, 'old prompt', 'utf8');
  const result = JSON.parse(run(root, 'prompts', 'sync'));
  assert.ok(result.prompts.map((prompt: string) => realpathSync(prompt)).includes(realpathSync(executionPrompt)));
  const text = readFileSync(executionPrompt, 'utf8');
  assert.match(text, /selects explore.*replay/i);
  assert.match(text, /manual report/i);
  assert.equal(existsSync(join(root, '.qa-agent', 'prompts', 'execution.md')), false);
});

test('start creates the Task package before approval and review does not start a Run', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-start-'));
  run(root, 'init', '--id', 'start-fixture');
  const started = JSON.parse(run(root, 'start', '--request', '验证登录流程', '--module', 'auth', '--task', 'login-flow'));
  assert.equal(started.workflowStatus, 'approval_required');
  assert.ok(started.bootstrap.taskDirectory);
  assert.ok(existsSync(join(root, started.bootstrap.taskDirectory, 'task.json')));
  assert.ok(existsSync(join(root, started.bootstrap.taskDirectory, 'test-plan.json')));
  assert.equal(readTask(root, 'auth', 'login-flow').metadata.status, 'draft');
  const reviewed = JSON.parse(run(root, 'task', 'review', 'login-flow', '--module', 'auth', '--approve', '--confirmed-by', 'human-reviewer'));
  assert.equal(reviewed.metadata.status, 'ready');
  assert.equal(existsSync(join(root, reviewed.metadata.moduleId, 'run.json')), false);
  assert.equal(existsSync(join(root, '.qa-agent', 'modules', 'auth', 'tasks', 'login-flow', 'runs')), true);
});

test('validates the installable skill', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-skill-'));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'skill', 'validate'], { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).valid, true);
  assert.ok(root);
  const installed = spawnSync(process.execPath, [installedCli, 'help'], { cwd: repository, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /qa-agent/);
  const target = mkdtempSync(join(tmpdir(), 'qa-agent-install-'));
  const install = spawnSync(process.execPath, [installedCli, 'install-skill', '--path', target], { cwd: repository, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.ok(existsSync(join(target, 'qa-agent', 'SKILL.md')));
});

test('exposes CLI help and version flags', () => {
  const version = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version as string;
  for (const flag of ['--version', '-v', 'version']) {
    const result = spawnSync(process.execPath, [installedCli, flag], { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), version);
  }
  const help = spawnSync(process.execPath, [installedCli, '--help'], { cwd: repository, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /workflow bootstrap/);
});

test('installs native host integrations without changing the host-neutral runtime', () => {
  const target = mkdtempSync(join(tmpdir(), 'qa-agent-hosts-'));
  for (const host of ['claude', 'cursor', 'opencode', 'copilot', 'gemini', 'agents']) {
    const result = spawnSync(process.execPath, [installedCli, 'install-host', host, '--project', target], { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  assert.ok(existsSync(join(target, '.claude', 'skills', 'qa-agent', 'SKILL.md')));
  assert.ok(existsSync(join(target, '.cursor', 'rules', 'qa-agent.mdc')));
  assert.ok(existsSync(join(target, '.cursor', 'commands', 'qa-agent.md')));
  assert.ok(existsSync(join(target, '.opencode', 'skills', 'qa-agent', 'SKILL.md')));
  assert.ok(existsSync(join(target, '.github', 'skills', 'qa-agent', 'SKILL.md')));
  assert.ok(existsSync(join(target, '.github', 'agents', 'qa-agent.agent.md')));
  assert.ok(existsSync(join(target, '.gemini', 'commands', 'qa-agent.toml')));
  assert.ok(existsSync(join(target, '.agents', 'skills', 'qa-agent', 'SKILL.md')));
});

test('validates explicit installation scopes and host limitations', () => {
  const target = mkdtempSync(join(tmpdir(), 'qa-agent-scopes-'));
  const projectInstall = spawnSync(process.execPath, [installedCli, 'install-host', 'opencode', '--scope', 'project', '--project', target], { cwd: repository, encoding: 'utf8' });
  assert.equal(projectInstall.status, 0, projectInstall.stderr || projectInstall.stdout);
  const cursorUser = spawnSync(process.execPath, [installedCli, 'install-host', 'cursor', '--scope', 'user'], { cwd: repository, encoding: 'utf8' });
  assert.notEqual(cursorUser.status, 0);
  assert.match(cursorUser.stderr, /Cursor user Rules/);
  const invalidScope = spawnSync(process.execPath, [installedCli, 'install-host', 'opencode', '--scope', 'workspace', '--project', target], { cwd: repository, encoding: 'utf8' });
  assert.notEqual(invalidScope.status, 0);
  assert.match(invalidScope.stderr, /scope must be project or user/);
});

test('configures a project and injects the selected host integration in one CLI command', () => {
  const target = mkdtempSync(join(tmpdir(), 'qa-agent-configure-'));
  const result = spawnSync(process.execPath, [installedCli, 'configure', '--project', target, '--host', 'cursor', '--scope', 'project', '--id', 'configured-app', '--name', 'Configured App'], { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const configured = JSON.parse(result.stdout);
  assert.equal(configured.projectInitialized, true);
  assert.equal(configured.project.id, 'configured-app');
  assert.ok(existsSync(join(target, '.qa-agent', 'project.json')));
  assert.ok(existsSync(join(target, '.cursor', 'rules', 'qa-agent.mdc')));
  assert.ok(existsSync(join(target, '.cursor', 'commands', 'qa-agent.md')));
});

test('requires confirmation when the reviewed business contract changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-approval-'));
  run(root, 'init', '--id', 'approval-fixture');
  run(root, 'module', 'create', 'checkout', '--name', 'Checkout');
  run(root, 'task', 'create', 'checkout-flow', '--module', 'checkout');
  run(root, 'task', 'review', 'checkout-flow', '--module', 'checkout', '--approve', '--confirmed-by', 'test-user');
  const changed = readTask(root, 'checkout', 'checkout-flow');
  changed.scenarios[0]!.expected = { outcome: 'The revised business outcome is displayed.' };
  saveTask(root, changed);
  const plan = JSON.parse(run(root, 'task', 'plan', 'checkout-flow', '--module', 'checkout'));
  assert.equal(plan.approvalRequired, true);
  const taskRun = JSON.parse(run(root, 'task', 'run', 'checkout-flow', '--module', 'checkout'));
  assert.equal(taskRun.status, 'needs_confirmation');
});

test('records agent-guided visual business verification with screenshot evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-visual-'));
  initializeProject(root, { id: 'visual-fixture' });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Fixture' });
  const task = createTaskSkeleton(module, 'checkout-visual-flow'); approveTask(task); saveTask(root, task);
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'fixture.png');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const agentRun = beginAgentGuidedRun(root, task);
  recordAgentStep(root, agentRun.id, { action: '打开结算页', detail: 'Agent opened the real checkout page.', screenshotPath: screenshot });
  assert.throws(() => completeAgentGuidedRun(root, task, agentRun.id), /cannot complete.*run observe/i);
  assert.equal(readRunById(root, agentRun.id).status, 'running');
  assert.throws(() => recordVisualFinding(root, agentRun.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout summary is visible.', actual: 'Checkout summary is visible.', status: 'passed' }), /requires a screenshot/);
  recordVisualFinding(root, agentRun.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout summary is visible.', actual: 'Checkout summary is visible and the amount is displayed.', status: 'passed', screenshotPath: screenshot });
  const completed = completeAgentGuidedRun(root, task, agentRun.id);
  assert.equal(completed.status, 'passed');
  assert.equal(completed.visualFindings.length, 1);
  assert.equal(completed.memoryCandidates?.length, 1);
  assert.match(completed.memoryCandidates?.[0] ?? '', /^observed-/);
  assert.equal(completed.operationCandidates, undefined);
  assert.ok(completed.operationCandidateIssues?.[0]?.reasons.some(reason => /operationAction is missing/.test(reason)));
  assert.ok(existsSync(join(taskRunDirectory(root, 'checkout', 'checkout-visual-flow', agentRun.id), completed.visualFindings[0]!.screenshotPath!)));
  const report = readFileSync(taskRunReportPath(root, 'checkout', 'checkout-visual-flow', agentRun.id), 'utf8');
  assert.match(report, /测试用例与业务逻辑/);
  assert.match(report, /视觉业务验证/);
  assert.match(report, /!\[happy-path business-outcome\]/);
  assert.match(report, /OperationPlan 未生成原因/);
});

test('persists replay-ready locator, input refs, and states from CLI run steps', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-structured-step-'));
  initializeProject(root, { id: 'structured-step' });
  const module = createModule(root, { id: 'listing', name: 'Listing', description: 'Structured replay fixture' });
  const task = createTaskSkeleton(module, 'listing-flow'); approveTask(task); saveTask(root, task);
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'listing.png');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const started = JSON.parse(run(root, 'task', 'run', 'listing-flow', '--module', 'listing'));
  run(root, 'run', 'step', started.id,
    '--action', 'Fill listing form', '--detail', 'Entered reviewed listing fixtures', '--screenshot', screenshot,
    '--operation-action', 'fill', '--locator-strategy', 'accessibility', '--locator-value', 'Listing form',
    '--input-refs', 'brand=fixture:brand,price=fixture:price',
    '--expected-state', 'Required listing fields are populated', '--actual-state', 'Required listing fields are populated');
  run(root, 'run', 'observe', started.id, '--scenario', 'happy-path', '--assertion', 'business-outcome',
    '--expected', 'The listing result is visible.', '--actual', 'The listing result is visible.', '--status', 'passed', '--screenshot', screenshot);
  const completed = JSON.parse(run(root, 'run', 'complete', started.id));
  assert.equal(completed.status, 'passed');
  assert.equal(completed.operationCandidateIssues, undefined);
  assert.equal(completed.operationCandidates.length, 1);
  const operation = listOperations(root, readTask(root, 'listing', 'listing-flow'))[0]!;
  assert.deepEqual(operation.steps[0]!.inputRefs, { brand: 'fixture:brand', price: 'fixture:price' });
  assert.equal(operation.steps[0]!.locator?.value, 'Listing form');
  assert.equal(operation.steps[0]!.expectedState, 'Required listing fields are populated');
});

test('creates, approves, and replays a project-local Operation JSON with adaptive evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-replay-'));
  initializeProject(root, { id: 'replay-fixture' });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Replay fixture' });
  const task = createTaskSkeleton(module, 'checkout-replay-flow'); approveTask(task); saveTask(root, task);
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'replay.png');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const first = beginAgentGuidedRun(root, task);
  recordAgentStep(root, first.id, { action: 'Open checkout', operationAction: 'click', detail: 'Opened checkout', screenshotPath: screenshot, operationStepId: 'open-checkout', locator: { strategy: 'accessibility', value: 'Go to checkout', fallbacks: [{ strategy: 'text', value: 'Checkout' }] } });
  recordRecoveryAttempt(root, first.id, { reason: 'Async content was not ready', action: 'wait', detail: 'Content appeared after a safe wait.', outcome: 'continued' });
  recordVisualFinding(root, first.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout result is visible.', actual: 'Checkout result is visible.', status: 'passed', screenshotPath: screenshot });
  const completed = completeAgentGuidedRun(root, task, first.id);
  assert.equal(completed.status, 'passed');
  const candidates = listOperations(root, task);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.status, 'candidate');
  assert.equal(candidates[0]!.apiVersion, 'qa-agent/v2');
  assert.equal(candidates[0]!.steps[0]!.action, 'click');
  assert.equal(candidates[0]!.steps[0]!.locator?.strategy, 'accessibility');
  assert.ok(candidates[0]!.steps[0]!.assertionRefs?.includes('business-outcome'));
  reviewOperation(root, task, candidates[0]!.id, 'approve');
  const replayViaOperationCommand = JSON.parse(run(root, 'operation', 'replay', candidates[0]!.id, '--module', 'checkout', '--task', 'checkout-replay-flow'));
  assert.equal(replayViaOperationCommand.status, 'running');
  assert.equal(replayViaOperationCommand.executionMode, 'replay');
  assert.equal(replayViaOperationCommand.mode, 'replay');
  assert.equal(replayViaOperationCommand.replayStatus, 'replayed');
  assert.equal(replayViaOperationCommand.operationPlanId, candidates[0]!.id);
  assert.equal(replayViaOperationCommand.planningAllowed, false);
  assert.equal(replayViaOperationCommand.sourceReviewAllowed, false);
  assert.equal(replayViaOperationCommand.strictStepOrder, true);
  assert.equal(replayViaOperationCommand.operationPlan.id, candidates[0]!.id);
  assert.equal(replayViaOperationCommand.nextOperationStep.id, 'open-checkout');
  assert.equal(replayViaOperationCommand.remainingOperationSteps, 1);
  assert.equal(replayViaOperationCommand.checkpoints[0].id, 'business-outcome');

  const replayProgress = JSON.parse(run(root, 'run', 'step', replayViaOperationCommand.runId,
    '--action', 'Open checkout', '--detail', 'Executed the JSON step without replanning.', '--screenshot', screenshot,
    '--operation-step', 'open-checkout'));
  assert.equal(replayProgress.remainingOperationSteps, 0);
  assert.equal(replayProgress.nextOperationStep, undefined);
  const persistedReplay = readRunById(root, replayViaOperationCommand.runId);
  const persistedReplayStep = persistedReplay.steps.find(item => item.operationStepId === 'open-checkout')!;
  assert.equal(persistedReplayStep.operationAction, 'click');
  assert.equal(persistedReplayStep.locator?.value, 'Go to checkout');

  run(root, 'run', 'observe', replayViaOperationCommand.runId, '--scenario', 'happy-path', '--assertion', 'business-outcome',
    '--expected', 'Checkout result is visible.', '--actual', 'Checkout result is visible.', '--status', 'passed', '--screenshot', screenshot);
  const replayViaCliCompleted = JSON.parse(run(root, 'run', 'complete', replayViaOperationCommand.runId));
  assert.equal(replayViaCliCompleted.status, 'passed');
  assert.equal(replayViaCliCompleted.executionMode, 'replay');
  const replayCliReport = readFileSync(taskRunReportPath(root, 'checkout', 'checkout-replay-flow', replayViaOperationCommand.runId), 'utf8');
  assert.match(replayCliReport, /Execution mode: replay/);
  assert.match(replayCliReport, /## Critical Checkpoints/);
  assert.match(replayCliReport, /### business-outcome/);
  assert.match(replayCliReport, /Checkpoint business-outcome/);

  const replayViaTaskCommand = JSON.parse(run(root, 'task', 'run', 'checkout-replay-flow', '--module', 'checkout', '--operation', candidates[0]!.id));
  assert.equal(replayViaTaskCommand.status, 'running');
  assert.match(replayViaTaskCommand.compatibilityNote, /compatibility/);
  const taskSuite = syncTaskRegressionSuite(root, task);
  const moduleSuite = buildModuleRegressionSuite(root, 'checkout');
  assert.equal(taskSuite.scope, 'task');
  assert.equal(taskSuite.members.length, 1);
  assert.equal(moduleSuite.scope, 'module');
  assert.equal(moduleSuite.members[0]!.taskId, 'checkout-replay-flow');
  assert.equal(existsSync(join(root, '.qa-agent', 'modules', 'checkout', 'regression-suite.json')), false);
  const moduleSuiteFromCli = JSON.parse(run(root, 'module', 'regression', 'show', 'checkout'));
  assert.equal(moduleSuiteFromCli.scope, 'module');
  assert.equal(moduleSuiteFromCli.members.length, 1);
  const removedSync = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'module', 'regression', 'sync', 'checkout'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(removedSync.status, 0);
  assert.match(removedSync.stderr, /Unsupported command/);
  const moduleRegression = JSON.parse(run(root, 'module', 'regression', 'run', 'checkout'));
  assert.equal(moduleRegression.status, 'running');
  assert.equal(moduleRegression.childRuns.length, 1);
  const regression = beginRegressionRun(root, taskSuite, buildExecutionSnapshot(root, task));
  assert.equal(regression.status, 'running');
  assert.equal(regression.childRuns.length, 1);
  const regressionChild = regression.childRuns[0]!;
  recordAgentStep(root, regressionChild.runId, { action: 'Open checkout', operationAction: 'click', detail: 'Module regression replay', screenshotPath: screenshot, operationStepId: 'open-checkout', locator: { strategy: 'accessibility', value: 'Go to checkout' } });
  recordVisualFinding(root, regressionChild.runId, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout result is visible.', actual: 'Checkout result is visible.', status: 'passed', screenshotPath: screenshot });
  completeAgentGuidedRun(root, task, regressionChild.runId);
  const completedRegression = completeRegressionRun(root, regression);
  assert.equal(completedRegression.status, 'passed');
  assert.ok(existsSync(join(root, '.qa-agent', 'modules', 'checkout', 'reports', `${regression.id}.md`)));
  const replay = beginAgentGuidedRun(root, task, { operationId: candidates[0]!.id });
  assert.equal(replay.status, 'running');
  assert.equal(replay.replayStatus, 'replayed');
  assert.equal(replay.operationPlanId, candidates[0]!.id);
  assert.throws(() => recordAgentStep(root, replay.id, { action: 'Wrong step', detail: 'Must not skip the approved step', screenshotPath: screenshot, operationStepId: 'wrong-step' }), /step order violation/);
  recordAgentStep(root, replay.id, { action: 'Open checkout', operationAction: 'click', detail: 'Replayed approved operation', screenshotPath: screenshot, operationStepId: 'open-checkout', locator: { strategy: 'accessibility', value: 'Go to checkout' } });
  recordRecoveryAttempt(root, replay.id, { reason: 'Replay locator needed a safe wait', action: 'wait', detail: 'The approved flow resumed without changing its meaning.', outcome: 'continued' });
  recordVisualFinding(root, replay.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout result is visible.', actual: 'Checkout result is visible.', status: 'passed', screenshotPath: screenshot });
  const replayed = completeAgentGuidedRun(root, task, replay.id);
  assert.equal(replayed.status, 'passed');
  assert.equal(replayed.replayStatus, 'replayed');
  assert.ok(replayed.screenshots.some(item => item.visualInspection === 'not-required'));
  const report = readFileSync(taskRunReportPath(root, 'checkout', 'checkout-replay-flow', replay.id), 'utf8');
  assert.match(report, /Screenshot captured/);
  assert.match(report, /Visual inspection: performed/);
  assert.match(report, /Recovery/);
  const adaptedRun = beginAgentGuidedRun(root, task, { operationId: candidates[0]!.id });
  recordAgentStep(root, adaptedRun.id, { action: 'Open checkout', operationAction: 'click', detail: 'Adapted semantic locator', screenshotPath: screenshot, operationStepId: 'open-checkout', status: 'adapted', adaptation: 'Used visible text after the accessibility locator changed.' });
  recordVisualFinding(root, adaptedRun.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout result is visible.', actual: 'Checkout result is visible.', status: 'adapted', screenshotPath: screenshot });
  const adapted = completeAgentGuidedRun(root, task, adaptedRun.id);
  assert.equal(adapted.status, 'adapted');
  const adaptedPlan = listOperations(root, task).find(item => item.version === 2);
  assert.equal(adaptedPlan?.status, 'candidate');
  assert.equal(adaptedPlan?.supersedes, candidates[0]!.id);
});

test('creates one OperationPlan per Scenario and enforces replay context and recovery policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-v2-scenarios-'));
  initializeProject(root, { id: 'v2-scenarios' });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Scenario fixture' });
  const task = createTaskSkeleton(module, 'checkout-scenarios');
  task.scenarios.push({ ...task.scenarios[0]!, id: 'permission-denied', title: 'Permission denied', intent: 'A restricted role cannot submit', expected: { outcome: 'blocked' }, visualAssertions: [{ id: 'permission-state', expected: 'Submit is unavailable', importance: 'high' }] });
  approveTask(task); saveTask(root, task);
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'scenario.png'); writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const first = beginAgentGuidedRun(root, task, { scenarioId: 'happy-path', device: 'pixel-8', appVersion: '2.4.1' });
  recordAgentStep(root, first.id, { action: 'Tap checkout', operationAction: 'click', detail: 'Checkout opened', screenshotPath: screenshot, operationStepId: 'happy-open', scenarioId: 'happy-path', locator: { strategy: 'text', value: 'Checkout' } });
  recordVisualFinding(root, first.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout succeeds', actual: 'Checkout succeeds', status: 'passed', screenshotPath: screenshot });
  completeAgentGuidedRun(root, task, first.id);
  const second = beginAgentGuidedRun(root, task, { scenarioId: 'permission-denied', device: 'pixel-8', appVersion: '2.4.1' });
  recordAgentStep(root, second.id, { action: 'Tap checkout', operationAction: 'click', detail: 'Submit is disabled', screenshotPath: screenshot, operationStepId: 'permission-open', scenarioId: 'permission-denied', locator: { strategy: 'accessibility', value: 'Checkout' } });
  recordVisualFinding(root, second.id, { scenarioId: 'permission-denied', assertionId: 'permission-state', expected: 'Submit is unavailable', actual: 'Submit is unavailable', status: 'passed', screenshotPath: screenshot });
  completeAgentGuidedRun(root, task, second.id);
  const operations = listOperations(root, task);
  assert.deepEqual(operations.map(item => item.scenarioId).sort(), ['happy-path', 'permission-denied']);
  assert.equal(operations[0]!.executionSnapshot.device, 'pixel-8');
  assert.equal(operations[0]!.executionSnapshot.appVersion, '2.4.1');
  const approved = reviewOperation(root, task, operations[0]!.id, 'approve');
  const mismatch = beginAgentGuidedRun(root, task, { operationId: approved.id, scenarioId: approved.scenarioId, device: 'pixel-8', appVersion: '2.5.0' });
  assert.equal(mismatch.status, 'blocked');
  assert.match(mismatch.steps[0]!.detail, /app version/);
  const recovery = beginAgentGuidedRun(root, task, { scenarioId: 'happy-path' });
  assert.throws(() => recordRecoveryAttempt(root, recovery.id, { action: 'delete-production-data', reason: 'unsafe', detail: 'must reject', outcome: 'continued' }), /not allowed/);
  for (let index = 0; index < task.recoveryPolicy.maxRecoveryAttempts; index += 1) recordRecoveryAttempt(root, recovery.id, { action: 'wait', reason: `retry-${index}`, detail: 'safe wait', outcome: 'continued' });
  const exhausted = recordRecoveryAttempt(root, recovery.id, { action: 'wait', reason: 'retry-limit', detail: 'must stop', outcome: 'continued' });
  assert.equal(exhausted.status, 'blocked');
  assert.match(exhausted.steps.at(-1)!.detail, /limit/);
});

test('blocks APP execution until the approved simulator MCP can interact and capture screenshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-android-'));
  initializeProject(root, { id: 'android-fixture', platforms: ['android'] });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Android fixture', platforms: ['android'] });
  const task = createTaskSkeleton(module, 'android-checkout'); approveTask(task); saveTask(root, task);
  const blocked = beginAgentGuidedRun(root, task, { platform: 'android' });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.steps[0]!.detail, /Android emulator\/device capability snapshot/);
  importHostSnapshot(root, [{ id: 'android-emulator', capabilities: ['android.adb', 'android.screenshot'], permissionStatus: 'unknown' }]);
  const unknownPermissions = JSON.parse(run(root, 'host', 'doctor', '--platform', 'android'));
  assert.equal(unknownPermissions.ready, false);
  assert.equal(unknownPermissions.permissionStatus, 'unknown');
  importHostSnapshot(root, [{ id: 'android-emulator', capabilities: ['android.adb', 'android.screenshot'], permissionStatus: 'verified' }]);
  assert.equal(JSON.parse(run(root, 'host', 'doctor', '--platform', 'android')).ready, true);
  const started = beginAgentGuidedRun(root, task, { platform: 'android' });
  assert.equal(started.status, 'running');
  assert.match(started.steps[0]!.detail, /Required capabilities are available/);
});

test('imports host artifacts, records evidence, and curates failed business outcomes', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-host-artifacts-'));
  initializeProject(root, { id: 'host-artifacts' });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Fixture' });
  const task = createTaskSkeleton(module, 'checkout-host-flow'); approveTask(task); saveTask(root, task);
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect', 'logs.read'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'host.png'); const log = join(root, 'console.log');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  writeFileSync(log, 'host browser console output', 'utf8');
  const agentRun = beginAgentGuidedRun(root, task);
  run(root, 'run', 'evidence', agentRun.id, '--type', 'console', '--summary', 'Host browser console output.', '--file', log);
  recordAgentStep(root, agentRun.id, { action: 'Submit order', operationAction: 'click', detail: 'Host tool submitted the test order.', screenshotPath: screenshot, locator: { strategy: 'role', value: 'button:Submit' } });
  recordVisualFinding(root, agentRun.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Order creation succeeds.', actual: 'The host observed an error state.', status: 'failed', screenshotPath: screenshot });
  const completed = completeAgentGuidedRun(root, task, agentRun.id);
  assert.equal(completed.status, 'failed');
  assert.ok(completed.evidence.some(item => item.type === 'console' && item.path?.includes('artifacts')));
  const candidateId = completed.memoryCandidates?.find(item => item.startsWith('issue-'));
  assert.ok(candidateId);
  const approved = reviewMemory(root, 'checkout', candidateId!, 'approve', 'confirmed', 'checkout-host-flow');
  assert.equal(approved.status, 'active');
});

test('plans and completes an impact-aware fast release check with Golden Path gating', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-release-'));
  initializeProject(root, { id: 'release-fixture' });
  const paymentModule = createModule(root, { id: 'payment', name: 'Payment', description: 'Critical payment flow', riskLevel: 'critical', sourceHints: ['lib/payment'] });
  const settingsModule = createModule(root, { id: 'settings', name: 'Settings', description: 'Low-risk settings flow', riskLevel: 'low', sourceHints: ['lib/settings'] });

  const paymentTask = createTaskSkeleton(paymentModule, 'buyer-payment');
  paymentTask.metadata.priority = 'p0';
  paymentTask.metadata.releaseGate = true;
  paymentTask.metadata.frequency = 'every-release';
  paymentTask.metadata.tags = ['payment', 'regression', 'golden-path'];
  approveTask(paymentTask); saveTask(root, paymentTask);

  const settingsTask = createTaskSkeleton(settingsModule, 'profile-settings');
  settingsTask.metadata.priority = 'p2';
  settingsTask.metadata.releaseGate = false;
  settingsTask.metadata.frequency = 'manual';
  settingsTask.metadata.tags = ['settings', 'regression'];
  approveTask(settingsTask); saveTask(root, settingsTask);

  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'release.png');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

  for (const [task, stepId] of [[paymentTask, 'payment-open'], [settingsTask, 'settings-open']] as const) {
    const firstRun = beginAgentGuidedRun(root, task);
    recordAgentStep(root, firstRun.id, { action: `Open ${task.metadata.name}`, operationAction: 'click', detail: 'Open the reviewed business flow.', screenshotPath: screenshot, operationStepId: stepId, locator: { strategy: 'text', value: task.metadata.name } });
    recordVisualFinding(root, firstRun.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'The business result is visible.', actual: 'The business result is visible.', status: 'passed', screenshotPath: screenshot });
    completeAgentGuidedRun(root, task, firstRun.id);
    const candidate = listOperations(root, task).find(operation => operation.status === 'candidate');
    assert.ok(candidate);
    reviewOperation(root, task, candidate!.id, 'approve');
  }

  const impact = JSON.parse(run(root, 'impact', 'analyze', '--changed-files', 'lib/payment/payment_service.dart'));
  assert.deepEqual(impact.impactedModules.map((item: { moduleId: string }) => item.moduleId), ['payment']);
  assert.equal(impact.selectedTasks[0].taskId, 'buyer-payment');
  assert.ok(existsSync(join(root, '.qa-agent', 'impact-analysis', `${impact.id}.json`)));

  const planned = JSON.parse(run(root, 'release', 'check', '--profile', 'fast', '--changed-files', 'lib/payment/payment_service.dart', '--plan-only'));
  assert.equal(planned.profile, 'fast');
  assert.equal(planned.status, 'planned');
  assert.deepEqual([...new Set(planned.suite.members.map((member: { taskId: string }) => member.taskId))], ['buyer-payment']);
  assert.ok(planned.suite.members.every((member: { releaseGate: boolean }) => member.releaseGate));
  assert.ok(existsSync(join(root, '.qa-agent', 'release-checks', `${planned.id}.json`)));

  const started = JSON.parse(run(root, 'release', 'check', '--profile', 'fast', '--changed-files', 'lib/payment/payment_service.dart'));
  assert.equal(started.releaseCheck.status, 'running');
  assert.equal(started.regressionRun.status, 'running');
  assert.equal(started.regressionRun.childRuns.length, 1);

  const child = started.regressionRun.childRuns[0];
  run(root, 'run', 'step', child.runId, '--action', 'Open payment', '--detail', 'Replayed payment Golden Path.', '--screenshot', screenshot, '--operation-action', 'click', '--operation-step', 'payment-open', '--scenario', 'happy-path');
  run(root, 'run', 'observe', child.runId, '--scenario', 'happy-path', '--assertion', 'business-outcome', '--expected', 'The business result is visible.', '--actual', 'The business result is visible.', '--status', 'passed', '--screenshot', screenshot);
  run(root, 'run', 'complete', child.runId);

  const completed = JSON.parse(run(root, 'release', 'complete', started.releaseCheck.id));
  assert.equal(completed.releaseCheck.status, 'passed');
  assert.equal(completed.releaseCheck.releaseDecision, 'go');
  const releaseReport = readFileSync(join(root, '.qa-agent', 'reports', `${completed.releaseCheck.id}.md`), 'utf8');
  assert.match(releaseReport, /Decision: GO/);
  assert.match(releaseReport, /GOLDEN PATH/);
  assert.match(releaseReport, /buyer-payment/);

  const full = JSON.parse(run(root, 'release', 'check', '--profile', 'full', '--changed-files', 'lib/payment/payment_service.dart', '--plan-only'));
  assert.deepEqual([...new Set(full.suite.members.map((member: { taskId: string }) => member.taskId))].sort(), ['buyer-payment', 'profile-settings']);
  assert.equal(JSON.parse(run(root, 'validate')).valid, true);
});


test('loads the canonical project Prompt Bundle and blocks stale prompts', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-canonical-prompts-'));
  initializeProject(root, { id: 'canonical-prompts' });
  const module = createModule(root, { id: 'catalog', name: 'Catalog', description: 'Catalog flow' });
  const task = createTaskSkeleton(module, 'catalog-flow'); approveTask(task); saveTask(root, task);
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);

  const context = JSON.parse(run(root, 'context', 'module', 'catalog'));
  assert.equal(context.canonicalPrompts.current, true);
  assert.match(context.canonicalPrompts.prompts['test.md'], /screenshots/);

  writeFileSync(join(root, '.qa-agent', 'prompts', 'test.md'), 'stale prompt', 'utf8');
  const blocked = JSON.parse(run(root, 'task', 'run', 'catalog-flow', '--module', 'catalog'));
  assert.equal(blocked.status, 'needs_confirmation');
  assert.equal(blocked.canonicalPrompts.current, false);
  assert.ok(blocked.canonicalPrompts.stale.includes('test.md'));

  run(root, 'prompts', 'sync');
  const started = JSON.parse(run(root, 'task', 'run', 'catalog-flow', '--module', 'catalog'));
  assert.equal(started.status, 'running');
  assert.equal(started.canonicalPrompts.current, true);
});

test('rejects automated identities as Test Plan approvers', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-human-approval-'));
  run(root, 'init', '--id', 'approval-fixture');
  run(root, 'module', 'create', 'checkout', '--name', 'Checkout');
  run(root, 'task', 'create', 'checkout-flow', '--module', 'checkout');

  const rejected = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'task', 'review', 'checkout-flow', '--module', 'checkout', '--approve', '--confirmed-by', 'qa-agent'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /real human reviewer/i);

  const approved = JSON.parse(run(root, 'task', 'review', 'checkout-flow', '--module', 'checkout', '--approve', '--confirmed-by', 'project-owner', '--confirmation-source', 'current-chat-explicit-approval'));
  assert.equal(approved.metadata.approval.confirmedBy, 'project-owner');
  assert.equal(approved.metadata.approval.confirmationSource, 'current-chat-explicit-approval');
});

test('marks a required release gate without an active OperationPlan as NO-GO', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-release-gap-'));
  initializeProject(root, { id: 'release-gap' });
  const module = createModule(root, { id: 'payment', name: 'Payment', description: 'Payment release gate', riskLevel: 'critical', sourceHints: ['src/payment'] });
  const task = createTaskSkeleton(module, 'payment-gate');
  task.metadata.priority = 'p0'; task.metadata.releaseGate = true; task.metadata.frequency = 'every-release'; task.metadata.tags = ['payment', 'golden-path'];
  approveTask(task); saveTask(root, task);

  const check = JSON.parse(run(root, 'release', 'check', '--profile', 'fast', '--changed-files', 'src/payment/service.ts', '--plan-only'));
  assert.equal(check.releaseDecision, 'no-go');
  assert.equal(check.status, 'blocked');
  assert.equal(check.requiredAssetGaps.length, 1);
  assert.equal(check.requiredAssetGaps[0].taskId, 'payment-gate');
  assert.equal(check.suite.members.length, 0);
  const report = readFileSync(join(root, '.qa-agent', 'reports', `${check.id}.md`), 'utf8');
  assert.match(report, /Required QA Asset Gaps/);
  assert.match(report, /payment-gate/);
});

test('requires declared Scenario cleanup before Run completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-cleanup-'));
  initializeProject(root, { id: 'cleanup-fixture' });
  const module = createModule(root, { id: 'catalog', name: 'Catalog', description: 'Catalog mutation' });
  const task = createTaskSkeleton(module, 'publish-item');
  task.scenarios[0]!.cleanup = ['Delete the created test item'];
  approveTask(task); saveTask(root, task);
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'cleanup.png');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

  const runState = beginAgentGuidedRun(root, task);
  recordAgentStep(root, runState.id, { action: 'Publish item', operationAction: 'click', detail: 'Published fixture item.', screenshotPath: screenshot, locator: { strategy: 'text', value: 'Publish' } });
  recordVisualFinding(root, runState.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Item is published.', actual: 'Item is published.', status: 'passed', screenshotPath: screenshot });
  assert.throws(() => completeAgentGuidedRun(root, task, runState.id), /missing cleanup result/i);

  recordCleanupFinding(root, runState.id, { scenarioId: 'happy-path', cleanup: 'Delete the created test item', actual: 'The fixture item was removed and the list returned to baseline.', status: 'passed', screenshotPath: screenshot });
  const completed = completeAgentGuidedRun(root, task, runState.id);
  assert.equal(completed.status, 'passed');
  assert.equal(completed.cleanupFindings.length, 1);
  const report = readFileSync(taskRunReportPath(root, 'catalog', 'publish-item', runState.id), 'utf8');
  assert.match(report, /Scenario Cleanup/);
});

test('keeps user-assisted evidence but does not create a fully automated OperationPlan', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-assisted-'));
  initializeProject(root, { id: 'assisted-fixture' });
  const module = createModule(root, { id: 'catalog', name: 'Catalog', description: 'System picker flow' });
  const task = createTaskSkeleton(module, 'upload-item'); approveTask(task); saveTask(root, task);
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'assisted.png');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

  const runState = beginAgentGuidedRun(root, task);
  recordAgentStep(root, runState.id, { action: 'Choose fixture image', operationAction: 'click', detail: 'A human selected an image in the system picker.', screenshotPath: screenshot, locator: { strategy: 'text', value: 'Choose image' }, executionMode: 'user-assisted' });
  recordVisualFinding(root, runState.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Image is attached.', actual: 'Image is attached.', status: 'passed', screenshotPath: screenshot });
  const completed = completeAgentGuidedRun(root, task, runState.id);
  assert.equal(completed.status, 'passed');
  assert.equal(completed.operationCandidates, undefined);
  assert.ok(completed.operationCandidateIssues?.[0]?.reasons.some(reason => /user-assisted/.test(reason)));

  const blockedRun = beginAgentGuidedRun(root, task);
  assert.throws(() => recordAgentStep(root, blockedRun.id, { action: 'Open system picker', detail: 'System picker could not be controlled.', screenshotPath: screenshot, executionMode: 'system-component-blocked', status: 'passed' }), /cannot be recorded as passed/i);
});

test('bootstraps a Task before UI execution and stores one self-contained Run package', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-workflow-'));
  run(root, 'init', '--id', 'workflow-fixture');
  const bootstrapped = JSON.parse(run(root, 'workflow', 'bootstrap', '--request', 'Edit all supported profile fields', '--module', 'profile', '--task', 'edit-profile-all-fields', '--module-name', 'Profile', '--task-name', 'Edit profile fields', '--platforms', 'web'));
  assert.equal(bootstrapped.workflowStatus, 'approval_required');
  assert.equal(bootstrapped.uiExecutionAllowed, false);
  assert.equal(bootstrapped.mustStop, true);
  assert.equal(bootstrapped.manualReportAllowed, false);
  assert.equal(bootstrapped.taskAssetsReady, true);
  assert.equal(bootstrapped.bootstrap.taskCreated, true);
  assert.equal(bootstrapped.bootstrap.taskDirectory, '.qa-agent/modules/profile/tasks/edit-profile-all-fields');
  assert.ok(bootstrapped.bootstrap.taskAssets.some((item: string) => item.endsWith('/task.json')));
  assert.equal(bootstrapped.plan.approvalRequired, true);
  assert.ok(bootstrapped.todoList.some((item: { id: string; status: string }) => item.id === 'approval' && item.status === 'blocked'));
  const taskRoot = taskDirectory(root, 'profile', 'edit-profile-all-fields');
  for (const file of ['task.json', 'requirements.json', 'test-plan.json', 'module-snapshot.json', 'scenarios/happy-path.json']) assert.ok(existsSync(join(taskRoot, file)), file);

  run(root, 'task', 'review', 'edit-profile-all-fields', '--module', 'profile', '--approve', '--confirmed-by', 'profile-owner');
  const capabilityBlocked = JSON.parse(run(root, 'workflow', 'status', '--module', 'profile', '--task', 'edit-profile-all-fields'));
  assert.equal(capabilityBlocked.workflowStatus, 'blocked');
  assert.equal(capabilityBlocked.uiExecutionAllowed, false);
  assert.ok(capabilityBlocked.todoList.some((item: { id: string; status: string }) => item.id === 'capabilities' && item.status === 'blocked'));
  const attested = JSON.parse(run(root, 'host', 'attest', '--id', 'browser-mcp', '--capabilities', 'browser.interact,browser.inspect', '--permission-status', 'verified', '--host', 'test-host'));
  assert.equal(attested.connection.permissionStatus, 'verified');
  assert.equal(JSON.parse(run(root, 'host', 'doctor')).healthy, true);
  const started = JSON.parse(run(root, 'task', 'run', 'edit-profile-all-fields', '--module', 'profile'));
  assert.equal(started.uiExecutionAllowed, true);
  assert.equal(started.mustStop, false);
  assert.equal(started.manualReportAllowed, false);
  assert.equal(started.assetContract.taskDirectory, '.qa-agent/modules/profile/tasks/edit-profile-all-fields');
  assert.equal(started.workflow.workflowStatus, 'running');
  assert.ok(started.runId);

  const screenshot = join(root, 'profile.png');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  run(root, 'run', 'step', started.runId, '--scenario', 'happy-path', '--action', 'Open edit profile', '--detail', 'The host opened the approved profile form.', '--operation-action', 'click', '--locator-strategy', 'text', '--locator-value', 'Edit Profile', '--expected-state', 'The edit profile form is visible.', '--actual-state', 'The edit profile form is visible.', '--screenshot', screenshot);
  run(root, 'run', 'observe', started.runId, '--scenario', 'happy-path', '--assertion', 'business-outcome', '--expected', 'The visible result matches the approved request: Edit all supported profile fields', '--actual', 'The approved profile form and editable fields are visible.', '--status', 'passed', '--screenshot', screenshot);
  const completed = JSON.parse(run(root, 'run', 'complete', started.runId));
  assert.equal(completed.reportPath, `runs/${started.runId}/report.md`);
  assert.equal(completed.reportGeneratedBy, 'qa-agent-runtime');
  assert.equal(completed.runtimeReportGenerated, true);
  assert.equal(completed.mustStop, true);

  const packageRoot = taskRunDirectory(root, 'profile', 'edit-profile-all-fields', started.runId);
  assert.ok(existsSync(join(packageRoot, 'run.json')));
  assert.ok(existsSync(join(packageRoot, 'report.md')));
  const runtimeReport = readFileSync(join(packageRoot, 'report.md'), 'utf8');
  assert.match(runtimeReport, new RegExp(`qa-agent-runtime-report:${started.runId}`));
  assert.match(runtimeReport, /Runtime generator: qa-agent-runtime/);
  assert.match(runtimeReport, /Checkpoint business-outcome/);
  assert.match(runtimeReport, /!\[Checkpoint business-outcome\]/);
  assert.ok(existsSync(join(packageRoot, completed.screenshots[0].path)));
  assert.ok(existsSync(join(taskRoot, 'runs', 'index.json')));
  assert.ok(existsSync(join(taskRoot, 'runs', 'latest.json')));
  assert.equal(realpathSync(run(root, 'run', 'report', started.runId).trim()), realpathSync(join(packageRoot, 'report.md')));

  const status = JSON.parse(run(root, 'workflow', 'status', '--module', 'profile', '--task', 'edit-profile-all-fields'));
  assert.equal(status.workflowStatus, 'completed');
  assert.equal(status.uiExecutionAllowed, false);
  assert.ok(status.todoList.some((item: { id: string; status: string }) => item.id === 'finish' && item.status === 'completed'));
});


test('stops blocked execution, rejects manual reports, and migrates legacy Task reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-report-contract-'));
  run(root, 'init', '--id', 'report-contract');
  const bootstrap = JSON.parse(run(root, 'workflow', 'bootstrap', '--request', 'Verify profile preferences', '--module', 'profile', '--task', 'preferences', '--platforms', 'web'));
  assert.equal(bootstrap.bootstrap.taskCreated, true);
  run(root, 'task', 'review', 'preferences', '--module', 'profile', '--approve', '--confirmed-by', 'project-owner');

  const blocked = JSON.parse(run(root, 'task', 'explore', 'preferences', '--module', 'profile'));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.uiExecutionAllowed, false);
  assert.equal(blocked.mustStop, true);
  assert.equal(blocked.manualReportAllowed, false);
  assert.ok(blocked.forbiddenActions.includes('ui.execute'));
  assert.ok(blocked.forbiddenActions.includes('manual-report.write'));
  assert.equal(blocked.reportGeneratedBy, 'qa-agent-runtime');
  assert.equal(blocked.reportPath, `runs/${blocked.id}/report.md`);

  const taskRoot = taskDirectory(root, 'profile', 'preferences');
  const runRoot = taskRunDirectory(root, 'profile', 'preferences', blocked.id);
  const legacyReports = join(taskRoot, 'reports');
  mkdirSync(legacyReports, { recursive: true });
  renameSync(join(runRoot, 'report.md'), join(legacyReports, `${blocked.id}.md`));
  const legacyRunPath = join(runRoot, 'run.json');
  const legacyRun = JSON.parse(readFileSync(legacyRunPath, 'utf8'));
  legacyRun.reportPath = `reports/${blocked.id}.md`;
  delete legacyRun.reportGeneratedBy;
  delete legacyRun.reportGeneratedAt;
  writeFileSync(legacyRunPath, `${JSON.stringify(legacyRun, null, 2)}\n`, 'utf8');

  const manualReport = join(root, '.qa-agent', 'reports', 'preferences', 'qa-test-report.md');
  mkdirSync(join(manualReport, '..'), { recursive: true });
  writeFileSync(manualReport, '# Hand-written PASS\n', 'utf8');

  const invalid = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'validate'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout, /legacy Task report/);
  assert.match(invalid.stdout, /orphan or manually written QA report/);

  const migrated = JSON.parse(run(root, 'migrate'));
  assert.equal(migrated.migratedTaskReports, 1);
  assert.equal(migrated.quarantinedOrphanReports, 1);
  assert.equal(migrated.validation.valid, true);
  assert.ok(existsSync(join(runRoot, 'report.md')));
  assert.ok(existsSync(join(root, '.qa-agent', 'orphans', 'reports', 'preferences', 'qa-test-report.md')));
  const migratedRun = JSON.parse(readFileSync(legacyRunPath, 'utf8'));
  assert.equal(migratedRun.reportPath, `runs/${blocked.id}/report.md`);
  assert.equal(migratedRun.reportGeneratedBy, 'qa-agent-runtime');
  assert.match(readFileSync(join(runRoot, 'report.md'), 'utf8'), new RegExp(`qa-agent-runtime-report:${blocked.id}`));
});
