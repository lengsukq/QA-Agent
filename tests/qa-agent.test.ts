import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { beginAgentGuidedRun, completeAgentGuidedRun, configurePlaywrightAdapter, executeTask, recordAgentStep, recordRecoveryAttempt, recordVisualFinding } from '../src/engine.ts';
import { listOperations, reviewOperation } from '../src/operations.ts';
import { createModule, initializeProject, saveTask } from '../src/project.ts';
import { createTaskSkeleton } from '../src/planning.ts';
import { reviewMemory } from '../src/memory.ts';
import { diagnoseSource, searchSource } from '../src/source-verifier.ts';
import { testPlanHash } from '../src/approval.ts';
import type { TestTask } from '../src/types.ts';

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

test('initializes, plans, persists, validates, and safely blocks an unconfigured browser run', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-'));
  run(root, 'init', '--id', 'shop', '--name', 'Shop');
  assert.ok(existsSync(join(root, '.qa-agent', 'project.json')));
  assert.ok(existsSync(join(root, '.qa-agent', 'prompts', 'qa-main.md')));
  assert.match(readFileSync(join(root, '.qa-agent', 'prompts', 'execution.md'), 'utf8'), /Before execution/);
  assert.doesNotMatch(readFileSync(join(root, '.qa-agent', 'prompts', 'execution.md'), 'utf8'), /[\u3400-\u9fff]/);
  assert.ok(existsSync(join(root, '.qa-agent', 'skills', 'built-in', 'visual-verify.json')));
  assert.equal(JSON.parse(run(root, 'skill', 'list')).length, 7);
  run(root, 'module', 'create', 'checkout', '--name', 'Checkout', '--description', 'Checkout flow', '--risk', 'high');
  const plan = JSON.parse(run(root, 'module', 'plan', 'checkout'));
  assert.equal(plan.suggestions.length, 8);
  const coverage = JSON.parse(run(root, 'module', 'coverage', 'checkout'));
  assert.equal(coverage.summary.total, 8);
  run(root, 'task', 'create', 'checkout-basic-flow', '--module', 'checkout');
  const runbookPath = join(root, 'checkout-runbook.json');
  writeFileSync(runbookPath, JSON.stringify([{ id: 'check-page', action: 'assert-visible', locator: 'main' }]), 'utf8');
  run(root, 'task', 'runbook', 'checkout-basic-flow', '--module', 'checkout', '--file', runbookPath);
  run(root, 'task', 'review', 'checkout-basic-flow', '--module', 'checkout', '--approve', '--confirmed-by', 'test-user');
  run(root, 'memory', 'add', 'checkout-rule', '--module', 'checkout', '--title', 'Checkout rule', '--content', 'Buyer can review the order total.');
  run(root, 'memory', 'review', 'checkout-rule', '--module', 'checkout', '--approve');
  const context = JSON.parse(run(root, 'context', 'module', 'checkout'));
  assert.equal(context.module.id, 'checkout');
  assert.equal(context.memories[0].id, 'checkout-rule');
  run(root, 'mcp', 'add', 'browser-mcp', '--capabilities', 'browser.interact,browser.inspect', '--readonly');
  run(root, 'mcp', 'activate', 'browser-mcp', '--permissions', 'verified');
  assert.equal(JSON.parse(run(root, 'mcp', 'doctor')).healthy, true);
  const result = JSON.parse(run(root, 'task', 'run', 'checkout-basic-flow', '--module', 'checkout'));
  assert.equal(result.status, 'blocked');
  assert.ok(existsSync(join(root, '.qa-agent', result.reportPath)));
  assert.match(readFileSync(join(root, '.qa-agent', result.reportPath), 'utf8'), /BLOCKED/);
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

test('invalidates approval when the user-reviewed execution plan changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-approval-'));
  run(root, 'init', '--id', 'approval-fixture');
  run(root, 'module', 'create', 'checkout', '--name', 'Checkout');
  run(root, 'task', 'create', 'checkout-flow', '--module', 'checkout');
  const first = join(root, 'first.json');
  const second = join(root, 'second.json');
  writeFileSync(first, JSON.stringify([{ id: 'first', action: 'screenshot' }]), 'utf8');
  writeFileSync(second, JSON.stringify([{ id: 'second', action: 'screenshot' }]), 'utf8');
  run(root, 'task', 'runbook', 'checkout-flow', '--module', 'checkout', '--file', first);
  run(root, 'task', 'review', 'checkout-flow', '--module', 'checkout', '--approve', '--confirmed-by', 'test-user');
  const changed = JSON.parse(run(root, 'task', 'runbook', 'checkout-flow', '--module', 'checkout', '--file', second));
  assert.equal(changed.approvalInvalidated, true);
  const plan = JSON.parse(run(root, 'task', 'plan', 'checkout-flow', '--module', 'checkout'));
  assert.equal(plan.approvalRequired, true);
  const blocked = JSON.parse(run(root, 'task', 'run', 'checkout-flow', '--module', 'checkout'));
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.steps[0]!.detail, /review and mark it ready/);
});

test('performs only read-only source-assisted diagnosis', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-source-'));
  initializeProject(root, { id: 'source-fixture' });
  writeFileSync(join(root, 'checkout.ts'), 'export const paymentSelector = "visible";\n', 'utf8');
  const findings = searchSource(root, 'paymentSelector');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.path, 'checkout.ts');
  const diagnosis = diagnoseSource(root, 'checkout', 'paymentSelector') as { level: string; disclaimer: string };
  assert.equal(diagnosis.level, 'investigation_hint');
  assert.match(diagnosis.disclaimer, /辅助诊断/);
});

test('records agent-guided visual business verification with screenshot evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-visual-'));
  initializeProject(root, { id: 'visual-fixture' });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Fixture' });
  const task = createTaskSkeleton(module, 'checkout-visual-flow'); approveTask(task); saveTask(root, task);
  run(root, 'mcp', 'add', 'browser-mcp', '--capabilities', 'browser.interact,browser.inspect', '--readonly');
  run(root, 'mcp', 'activate', 'browser-mcp', '--permissions', 'verified');
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
  assert.ok(existsSync(join(root, '.qa-agent', completed.visualFindings[0]!.screenshotPath!)));
  const report = readFileSync(join(root, '.qa-agent', 'reports', `${agentRun.id}.md`), 'utf8');
  assert.match(report, /测试用例与业务逻辑/);
  assert.match(report, /视觉业务验证/);
  assert.match(report, /!\[happy-path business-outcome\]/);
});

test('creates, approves, and replays a project-local Operation JSON with adaptive evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-replay-'));
  initializeProject(root, { id: 'replay-fixture' });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Replay fixture' });
  const task = createTaskSkeleton(module, 'checkout-replay-flow'); approveTask(task); saveTask(root, task);
  run(root, 'mcp', 'add', 'browser-mcp', '--capabilities', 'browser.interact,browser.inspect', '--readonly');
  run(root, 'mcp', 'activate', 'browser-mcp', '--permissions', 'verified');
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
  const report = readFileSync(join(root, '.qa-agent', 'reports', `${replay.id}.md`), 'utf8');
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
  run(root, 'mcp', 'add', 'browser-mcp', '--capabilities', 'browser.interact,browser.inspect', '--readonly');
  run(root, 'mcp', 'activate', 'browser-mcp', '--permissions', 'verified');
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
  assert.match(blocked.steps[0]!.detail, /Android emulator\/device MCP/);
  run(root, 'mcp', 'add', 'android-emulator', '--capabilities', 'android.adb,android.screenshot', '--readonly');
  run(root, 'mcp', 'activate', 'android-emulator');
  const unknownPermissions = JSON.parse(run(root, 'mobile', 'doctor', '--platform', 'android'));
  assert.equal(unknownPermissions.ready, false);
  assert.equal(unknownPermissions.permissionStatus, 'unknown');
  run(root, 'mcp', 'activate', 'android-emulator', '--permissions', 'verified');
  assert.equal(JSON.parse(run(root, 'mobile', 'doctor', '--platform', 'android')).ready, true);
  const started = beginAgentGuidedRun(root, task, { platform: 'android' });
  assert.equal(started.status, 'running');
  assert.match(started.steps[0]!.detail, /Required capabilities are available/);
});

test('executes a browser runbook, verifies assertions, and records real evidence', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>QA fixture</title><main><p id="message">Ready for QA</p></main>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-browser-'));
  try {
    initializeProject(root, { id: 'browser-fixture' });
    const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Fixture' });
    const task = createTaskSkeleton(module, 'checkout-visible-message');
    task.scenarios[0]!.execution = {
      startPath: '/',
      steps: [
        { id: 'assert-message', action: 'assert-text', locator: '#message', expected: 'Ready for QA' },
        { id: 'capture', action: 'screenshot', description: 'Validated fixture.' },
      ],
    };
    approveTask(task); saveTask(root, task);
    configurePlaywrightAdapter(root, `http://127.0.0.1:${address.port}`);
    const run = await executeTask(root, task);
    assert.equal(run.status, 'passed');
    assert.ok(run.evidence.some(item => item.type === 'screenshot'));
    assert.ok(run.evidence.some(item => item.type === 'trace'));
    assert.ok(existsSync(join(root, '.qa-agent', 'reports', `${run.id}.md`)));

    task.scenarios[0]!.execution!.steps = [{ id: 'pay', action: 'click', locator: '#message', safetyAction: 'payment.submit' }];
    approveTask(task);
    const paused = await executeTask(root, task);
    assert.equal(paused.status, 'paused');
    assert.match(paused.scenarioResults[0]!.detail ?? '', /Approval required/);

    task.scenarios[0]!.execution!.steps = [{ id: 'wrong-expectation', action: 'assert-text', locator: '#message', expected: 'Incorrect value' }];
    approveTask(task);
    const failed = await executeTask(root, task);
    assert.equal(failed.status, 'failed');
    const candidateId = failed.memoryCandidates?.[0];
    assert.ok(candidateId);
    const approved = reviewMemory(root, 'checkout', candidateId!, 'approve');
    assert.equal(approved.status, 'active');
    assert.equal(approved.knowledgeLevel, 'confirmed');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
