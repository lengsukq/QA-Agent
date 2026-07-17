import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { beginAgentGuidedRun, beginRegressionRun, buildExecutionSnapshot, completeAgentGuidedRun, completeRegressionRun, recordAgentStep, recordRecoveryAttempt, recordVisualFinding } from '../src/engine.ts';
import { listOperations, reviewOperation } from '../src/operations.ts';
import { createModule, initializeProject, readTask, saveTask, taskDirectory, taskReportDirectory } from '../src/project.ts';
import { createTaskSkeleton } from '../src/planning.ts';
import { reviewMemory } from '../src/memory.ts';
import { testPlanHash } from '../src/approval.ts';
import type { TestTask } from '../src/types.ts';
import { syncModuleRegressionSuite, syncTaskRegressionSuite } from '../src/regression.ts';

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
  task.metadata.approval = { confirmedBy: 'test-user', confirmedAt: new Date().toISOString(), statement: 'Confirmed.', planHash: testPlanHash(task) };
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
  assert.ok(existsSync(join(root, '.qa-agent', 'prompts', 'qa-main.md')));
  assert.match(readFileSync(join(root, '.qa-agent', 'prompts', 'execution.md'), 'utf8'), /Before execution/);
  assert.doesNotMatch(readFileSync(join(root, '.qa-agent', 'prompts', 'execution.md'), 'utf8'), /[\u3400-\u9fff]/);
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
  const taskRun = JSON.parse(run(root, 'task', 'run', 'checkout-basic-flow', '--module', 'checkout'));
  assert.equal(taskRun.status, 'running');
  assert.match(taskRun.next, /Host Agent/);
  for (const oldCommand of [['capability', 'list'], ['mcp', 'list'], ['mobile', 'doctor', '--platform', 'android'], ['task', 'runbook', 'checkout-basic-flow', '--module', 'checkout'], ['run', 'start', 'checkout-basic-flow', '--module', 'checkout'], ['run', 'replay', 'checkout-basic-flow', '--module', 'checkout', '--operation', 'op']]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...oldCommand], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${oldCommand.join(' ')} must be removed`);
    assert.match(result.stderr, /Unsupported command/);
  }
  const validation = JSON.parse(run(root, 'validate'));
  assert.equal(validation.valid, true);
  const archived = JSON.parse(run(root, 'task', 'archive', 'checkout-basic-flow', '--module', 'checkout'));
  assert.equal(archived.metadata.status, 'archived');
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
  assert.throws(() => recordVisualFinding(root, agentRun.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout summary is visible.', actual: 'Checkout summary is visible.', status: 'passed' }), /requires a screenshot/);
  recordVisualFinding(root, agentRun.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout summary is visible.', actual: 'Checkout summary is visible and the amount is displayed.', status: 'passed', screenshotPath: screenshot });
  const completed = completeAgentGuidedRun(root, task, agentRun.id);
  assert.equal(completed.status, 'passed');
  assert.equal(completed.visualFindings.length, 1);
  assert.equal(completed.memoryCandidates?.length, 1);
  assert.match(completed.memoryCandidates?.[0] ?? '', /^observed-/);
  assert.ok(existsSync(join(taskDirectory(root, 'checkout', 'checkout-visual-flow'), completed.visualFindings[0]!.screenshotPath!)));
  const report = readFileSync(join(taskReportDirectory(root, 'checkout', 'checkout-visual-flow'), `${agentRun.id}.md`), 'utf8');
  assert.match(report, /测试用例与业务逻辑/);
  assert.match(report, /视觉业务验证/);
  assert.match(report, /!\[happy-path business-outcome\]/);
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
  const replayViaTaskCommand = JSON.parse(run(root, 'task', 'run', 'checkout-replay-flow', '--module', 'checkout', '--operation', candidates[0]!.id));
  assert.equal(replayViaTaskCommand.status, 'running');
  assert.equal(replayViaTaskCommand.replayStatus, 'replayed');
  assert.equal(replayViaTaskCommand.operationPlanId, candidates[0]!.id);
  const taskSuite = syncTaskRegressionSuite(root, task);
  const moduleSuite = syncModuleRegressionSuite(root, 'checkout');
  assert.equal(taskSuite.scope, 'task');
  assert.equal(taskSuite.members.length, 1);
  assert.equal(moduleSuite.scope, 'module');
  assert.ok(moduleSuite.taskSuiteRefs?.some(ref => ref.includes('checkout-replay-flow')));
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
  const report = readFileSync(join(taskReportDirectory(root, 'checkout', 'checkout-replay-flow'), `${replay.id}.md`), 'utf8');
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
