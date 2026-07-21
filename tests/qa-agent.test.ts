import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { beginAgentGuidedRun, beginRegressionRun, buildExecutionSnapshot, completeAgentGuidedRun, completeRegressionRun, recordAgentStep, recordCleanupFinding, recordRecoveryAttempt, recordVisualFinding } from '../src/engine.ts';
import { listOperations, readOperation, reviewOperation } from '../src/operations.ts';
import { createModule, initializeProject, readRunById, readTask, saveTask, taskDirectory, taskRunDirectory, taskRunReportPath } from '../src/project.ts';
import { createTaskSkeleton } from '../src/planning.ts';
import { reviewMemory } from '../src/memory.ts';
import { testPlanHash } from '../src/approval.ts';
import type { TestTask } from '../src/types.ts';
import { buildModuleRegressionSuite, syncTaskRegressionSuite } from '../src/regression.ts';
import { HOST_CONFIGURATORS, HOST_PLATFORMS } from '../src/host-adapters.ts';
import { inspectTaskArchive } from '../src/archive.ts';
import { appendTaskEvent } from '../src/events.ts';

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
  assert.match(incompleteArchive.stdout, /Validated OperationPlan|successful Runtime Run|RegressionSuite/);
  assert.equal(readTask(root, 'checkout', 'checkout-basic-flow').metadata.status, 'running');
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
  assert.equal(readTask(root, 'auth', 'login-flow').metadata.status, 'awaiting_approval');
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
  assert.match(help.stdout, /Common commands/);
  assert.doesNotMatch(help.stdout, /workflow bootstrap/);
  const advancedHelp = spawnSync(process.execPath, [installedCli, 'help', '--advanced'], { cwd: repository, encoding: 'utf8' });
  assert.equal(advancedHelp.status, 0, advancedHelp.stderr || advancedHelp.stdout);
  assert.match(advancedHelp.stdout, /workflow bootstrap/);
});

test('installs native host integrations without changing the host-neutral runtime', () => {
  const target = mkdtempSync(join(tmpdir(), 'qa-agent-hosts-'));
  for (const host of ['claude', 'cursor', 'opencode', 'copilot', 'gemini', 'agents']) {
    const result = spawnSync(process.execPath, [installedCli, 'install-host', host, '--project', target], { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  assert.ok(existsSync(join(target, '.claude', 'skills', 'qa-agent', 'SKILL.md')));
  assert.ok(existsSync(join(target, '.cursor', 'rules', 'qa-agent.mdc')));
  assert.ok(existsSync(join(target, '.cursor', 'commands', 'qa-agent-cli.md')));
  assert.ok(existsSync(join(target, '.cursor', 'skills', 'qa-agent', 'SKILL.md')));
  const installedMainSkill = readFileSync(join(target, '.cursor', 'skills', 'qa-agent', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(installedMainSkill, /skills\/start\/SKILL\.md/);
  for (const phase of ['start', 'review', 'test', 'result', 'regression', 'recovery', 'archive']) {
    assert.match(installedMainSkill, new RegExp(`qa-agent-${phase}`));
    assert.ok(existsSync(join(target, '.cursor', 'skills', `qa-agent-${phase}`, 'SKILL.md')), `missing routed Skill qa-agent-${phase}`);
  }
  assert.ok(existsSync(join(target, '.cursor', 'skills', 'qa-agent-test', 'SKILL.md')));
  assert.ok(existsSync(join(target, '.cursor', 'skills', 'qa-agent-operation', 'SKILL.md')));
  assert.equal(existsSync(join(target, '.cursor', 'skills', 'qa-agent', 'skills')), false);
  assert.ok(existsSync(join(target, '.opencode', 'skills', 'qa-agent', 'SKILL.md')));
  assert.ok(existsSync(join(target, '.github', 'skills', 'qa-agent', 'SKILL.md')));
  assert.ok(existsSync(join(target, '.github', 'agents', 'qa-agent.agent.md')));
  assert.ok(existsSync(join(target, '.github', 'prompts', 'qa-agent.prompt.md')));
  assert.ok(existsSync(join(target, '.gemini', 'commands', 'qa-agent.toml')));
  assert.ok(existsSync(join(target, '.agents', 'skills', 'qa-agent', 'SKILL.md')));
});

test('initializes multiple registered hosts, shared skills, metadata, and idempotent updates', () => {
  const target = mkdtempSync(join(tmpdir(), 'qa-agent-platforms-'));
  const initialized = JSON.parse(run(target, 'init', '--id', 'platform-fixture', '--codex', '--cursor', '--claude'));
  assert.deepEqual(initialized.hosts, ['codex', 'cursor', 'claude']);
  assert.ok(existsSync(join(target, '.qa-agent', '.version')));
  assert.ok(existsSync(join(target, '.qa-agent', '.template-hashes.json')));
  const records = JSON.parse(readFileSync(join(target, '.qa-agent', '.configured-hosts.json'), 'utf8'));
  assert.deepEqual(Object.keys(records).sort(), ['claude', 'codex', 'cursor']);
  assert.ok(existsSync(join(target, '.codex', 'skills', 'qa-agent', 'SKILL.md')));
  assert.ok(existsSync(join(target, '.agents', 'skills', 'qa-agent-test', 'SKILL.md')));
  assert.equal(existsSync(join(target, '.agents', 'skills', 'qa-agent', 'skills')), false);
  assert.ok(existsSync(join(target, '.cursor', 'rules', 'qa-agent.mdc')));
  assert.ok(existsSync(join(target, '.cursor', 'skills', 'qa-agent', 'SKILL.md')));
  assert.equal(existsSync(join(target, '.cursor', 'skills', 'qa-agent', 'skills')), false);
  assert.ok(existsSync(join(target, '.claude', 'commands', 'qa-agent.md')));
  assert.ok(existsSync(join(target, '.claude', 'skills', 'qa-agent-archive', 'SKILL.md')));
  assert.ok(existsSync(join(target, '.claude', 'skills', 'qa-agent-operation', 'SKILL.md')));

  const repeated = JSON.parse(run(target, 'init', '--cursor'));
  assert.deepEqual(repeated.hosts, []);
  const added = JSON.parse(run(target, 'init', '--gemini'));
  assert.deepEqual(added.hosts, ['gemini']);
  assert.ok(existsSync(join(target, '.gemini', 'commands', 'qa-agent.toml')));
});

test('keeps the platform registry and configurator contracts complete', () => {
  const hosts = ['codex', 'cursor', 'claude', 'opencode', 'copilot', 'gemini', 'agents'] as const;
  assert.deepEqual(Object.keys(HOST_PLATFORMS).sort(), [...hosts].sort());
  for (const host of hosts) {
    assert.equal(HOST_PLATFORMS[host].cliFlag, host);
    assert.ok(HOST_PLATFORMS[host].managedPaths.length > 0);
    assert.equal(typeof HOST_CONFIGURATORS[host].configure, 'function');
    assert.ok(HOST_CONFIGURATORS[host].collectManagedTemplates().size > 0);
    assert.equal(typeof HOST_CONFIGURATORS[host].detect, 'function');
  }
});

test('update protects user-modified host templates and force refreshes only managed files', () => {
  const target = mkdtempSync(join(tmpdir(), 'qa-agent-update-'));
  run(target, 'init', '--id', 'update-fixture', '--cursor');
  const projectFile = join(target, '.qa-agent', 'project.json');
  const project = JSON.parse(readFileSync(projectFile, 'utf8'));
  project.project.description = 'user data must survive update';
  writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  const rule = join(target, '.cursor', 'rules', 'qa-agent.mdc');
  writeFileSync(rule, `${readFileSync(rule, 'utf8')}\n# user customization\n`, 'utf8');
  const update = JSON.parse(run(target, 'update'));
  assert.deepEqual(update.hostUpdate.updated, []);
  assert.equal(update.hostUpdate.conflicts[0].host, 'cursor');
  assert.match(readFileSync(rule, 'utf8'), /user customization/);
  assert.equal(JSON.parse(readFileSync(projectFile, 'utf8')).project.description, 'user data must survive update');
  const forced = JSON.parse(run(target, 'update', '--force'));
  assert.deepEqual(forced.hostUpdate.updated, ['cursor']);
  assert.doesNotMatch(readFileSync(rule, 'utf8'), /user customization/);
  const legacyCommand = join(target, '.cursor', 'commands', 'qa-agent.md');
  writeFileSync(legacyCommand, readFileSync(join(target, '.cursor', 'commands', 'qa-agent-cli.md'), 'utf8'), 'utf8');
  JSON.parse(run(target, 'update', '--force'));
  assert.equal(existsSync(legacyCommand), false);
  const hashes = JSON.parse(readFileSync(join(target, '.qa-agent', '.template-hashes.json'), 'utf8'));
  assert.ok(Object.keys(hashes.hashes).length > 0);
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
  assert.ok(existsSync(join(target, '.cursor', 'commands', 'qa-agent-cli.md')));
});

test('applies a structured multi-Scenario PlanDraft through the Runtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-plan-draft-'));
  run(root, 'init', '--id', 'plan-draft');
  run(root, 'start', '--request', '验证用户登录', '--module', 'auth', '--task', 'login-flow');
  const draftPath = join(root, 'login-plan.json');
  const draft = {
    apiVersion: 'qa-agent/plan-draft/v1',
    moduleId: 'auth',
    taskId: 'login-flow',
    taskName: '用户登录',
    description: '验证登录成功、密码错误和账号锁定。',
    objectives: ['验证合法用户可以登录', '验证非法登录被明确拒绝'],
    scope: { platforms: ['web'], environments: ['local'], roles: ['buyer'], excluded: ['第三方登录'] },
    sourceRefs: ['src/auth'],
    testDataRefs: ['fixture:buyer-account'],
    scenarios: [
      { title: '登录成功', intent: '正确账号进入首页', expected: '进入首页并显示当前用户', risk: 'high', requirementRefs: ['login-success'], visualAssertions: [{ expected: '首页显示当前用户', importance: 'high' }] },
      { title: '密码错误', intent: '错误密码不能登录', expected: '页面显示密码错误提示', risk: 'medium', requirementRefs: ['invalid-password'], visualAssertions: [{ expected: '错误提示清晰可见', importance: 'medium' }] },
      { title: '账号锁定', intent: '锁定账号不能登录', expected: '页面显示账号已锁定', cleanup: ['恢复测试账号状态'], risk: 'critical', requirementRefs: ['locked-account'], visualAssertions: [{ expected: '账号锁定提示清晰可见', importance: 'critical' }] },
    ],
  };
  writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  const applied = JSON.parse(run(root, 'plan', 'apply', '--file', draftPath));
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.scenarioIds, ['scenario-1', 'scenario-2', 'scenario-3']);
  const task = readTask(root, 'auth', 'login-flow');
  assert.equal(task.metadata.status, 'awaiting_approval');
  assert.equal(task.metadata.approval, undefined);
  assert.equal(task.scenarios.length, 3);
  assert.equal(task.requirements?.requirementTrace?.length, 3);
  assert.deepEqual(task.testPlan?.scenarioRefs, ['scenarios/scenario-1.json', 'scenarios/scenario-2.json', 'scenarios/scenario-3.json']);
  assert.equal(task.testPlan?.planHash, testPlanHash(task));
  assert.equal(task.testPlan?.status, 'awaiting_confirmation');
  assert.equal(existsSync(join(taskDirectory(root, 'auth', 'login-flow'), 'scenarios', 'happy-path.json')), false);
  assert.equal(JSON.parse(run(root, 'validate')).valid, true);

  const repeated = JSON.parse(run(root, 'plan', 'apply', '--file', draftPath));
  assert.equal(repeated.changed, false);
  run(root, 'review', '--module', 'auth', '--task', 'login-flow', '--approve', '--confirmed-by', 'auth-owner');
  draft.scenarios[1].expected = '页面显示明确的凭证错误提示';
  writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  const changed = JSON.parse(run(root, 'plan', 'apply', '--file', draftPath));
  assert.equal(changed.changed, true);
  assert.equal(readTask(root, 'auth', 'login-flow').metadata.approval, undefined);
  assert.equal(readTask(root, 'auth', 'login-flow').metadata.status, 'awaiting_approval');
  const unsafeDraftPath = join(root, 'unsafe-login-plan.json');
  const unsafeDraft = structuredClone(draft);
  unsafeDraft.scenarios[0].input = { password: 'plain-text-secret' };
  writeFileSync(unsafeDraftPath, `${JSON.stringify(unsafeDraft, null, 2)}\n`, 'utf8');
  const unsafe = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'plan', 'apply', '--file', unsafeDraftPath], { cwd: root, encoding: 'utf8' });
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /potential secret/i);
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
  assert.equal(candidates[0]!.validationStatus, 'unverified');
  const generated = JSON.parse(run(root, 'operation', 'generate', '--module', 'checkout', '--task', 'checkout-replay-flow', '--run', first.id));
  assert.equal(generated.generated, false);
  assert.equal(generated.approvalRequired, true);
  assert.deepEqual(generated.operationCandidates, [candidates[0]!.id]);
  assert.throws(() => reviewOperation(root, task, candidates[0]!.id, 'approve', 'qa-agent'), /real human reviewer/i);
  reviewOperation(root, task, candidates[0]!.id, 'approve', 'test-user');
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
  const validatedOperation = listOperations(root, readTask(root, 'checkout', 'checkout-replay-flow')).find(item => item.id === candidates[0]!.id)!;
  assert.equal(validatedOperation.validationStatus, 'passed');
  assert.equal(validatedOperation.validatedByRunId, replayViaOperationCommand.runId);
  const replayCliReport = readFileSync(taskRunReportPath(root, 'checkout', 'checkout-replay-flow', replayViaOperationCommand.runId), 'utf8');
  assert.match(replayCliReport, /Execution mode: replay/);
  assert.match(replayCliReport, /## Critical Checkpoints/);
  assert.match(replayCliReport, /### business-outcome/);
  assert.match(replayCliReport, /Checkpoint business-outcome/);

  const replayViaTaskCommand = JSON.parse(run(root, 'task', 'run', 'checkout-replay-flow', '--module', 'checkout', '--operation', candidates[0]!.id));
  assert.equal(replayViaTaskCommand.status, 'running');
  assert.match(replayViaTaskCommand.compatibilityNote, /compatibility/);
  run(root, 'run', 'step', replayViaTaskCommand.runId, '--action', 'Open checkout', '--detail', 'Completed compatibility replay.', '--screenshot', screenshot, '--operation-step', 'open-checkout');
  run(root, 'run', 'observe', replayViaTaskCommand.runId, '--scenario', 'happy-path', '--assertion', 'business-outcome', '--expected', 'Checkout result is visible.', '--actual', 'Checkout result is visible.', '--status', 'passed', '--screenshot', screenshot);
  run(root, 'run', 'complete', replayViaTaskCommand.runId);
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
  const moduleChild = moduleRegression.childRuns[0];
  run(root, 'run', 'step', moduleChild.runId, '--action', 'Open checkout', '--detail', 'Completed module regression replay.', '--screenshot', screenshot, '--operation-step', 'open-checkout');
  run(root, 'run', 'observe', moduleChild.runId, '--scenario', 'happy-path', '--assertion', 'business-outcome', '--expected', 'Checkout result is visible.', '--actual', 'Checkout result is visible.', '--status', 'passed', '--screenshot', screenshot);
  run(root, 'run', 'complete', moduleChild.runId);
  completeRegressionRun(root, moduleRegression);
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
  const adaptedPlan = listOperations(root, task).find(item => item.version === 2)!;
  assert.equal(adaptedPlan.status, 'candidate');
  assert.equal(adaptedPlan.supersedes, candidates[0]!.id);
  reviewOperation(root, task, adaptedPlan.id, 'approve', 'test-user');
  const adaptedValidationRun = beginAgentGuidedRun(root, task, { operationId: adaptedPlan.id });
  recordAgentStep(root, adaptedValidationRun.id, { action: 'Open checkout', detail: 'Validated the adapted OperationPlan version.', screenshotPath: screenshot, operationStepId: adaptedPlan.steps[0]!.id });
  recordVisualFinding(root, adaptedValidationRun.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout result is visible.', actual: 'Checkout result is visible.', status: 'passed', screenshotPath: screenshot });
  completeAgentGuidedRun(root, task, adaptedValidationRun.id);
  const versionedOperations = listOperations(root, readTask(root, 'checkout', 'checkout-replay-flow'));
  assert.equal(versionedOperations.find(item => item.id === candidates[0]!.id)?.status, 'superseded');
  assert.equal(versionedOperations.find(item => item.id === adaptedPlan.id)?.status, 'validated');
  const latestSuite = syncTaskRegressionSuite(root, readTask(root, 'checkout', 'checkout-replay-flow'));
  assert.equal(latestSuite.members.length, 1);
  assert.equal(latestSuite.members[0]!.operationPlanId, adaptedPlan.id);
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
  const approved = reviewOperation(root, task, operations[0]!.id, 'approve', 'test-user');
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
    reviewOperation(root, task, candidate!.id, 'approve', 'test-user');
    const replay = beginAgentGuidedRun(root, task, { operationId: candidate!.id, scenarioId: 'happy-path' });
    recordAgentStep(root, replay.id, { action: `Replay ${task.metadata.name}`, detail: 'Executed the approved OperationPlan.', screenshotPath: screenshot, operationStepId: stepId });
    recordVisualFinding(root, replay.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'The business result is visible.', actual: 'The business result is visible.', status: 'passed', screenshotPath: screenshot });
    completeAgentGuidedRun(root, task, replay.id);
    assert.equal(listOperations(root, task).find(operation => operation.id === candidate!.id)?.status, 'validated');
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
  assert.ok(migratedRun.planHash);
  assert.match(readFileSync(join(runRoot, 'report.md'), 'utf8'), new RegExp(`qa-agent-runtime-report:${blocked.id}`));
});


test('emits a v3 workflow breadcrumb and idempotent Task event history', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-workflow-v3-'));
  run(root, 'init', '--id', 'workflow-v3');
  const first = JSON.parse(run(root, 'start', '--request', 'Verify account profile editing', '--module', 'profile', '--task', 'profile-edit'));
  assert.equal(first.apiVersion, 'qa-agent/v3');
  assert.equal(first.taskState, 'awaiting_approval');
  assert.equal(first.workflowPhase, 'approval');
  assert.equal(first.reasonCode, 'test_plan_approval_required');
  assert.ok(first.gates.some((gate: { id: string; status: string }) => gate.id === 'test_plan_approved' && gate.status === 'blocking'));
  assert.equal(first.nextActions[0].id, 'request_test_plan_approval');
  assert.equal(first.nextActions[0].requiresHuman, true);
  assert.match(first.breadcrumb, /<qa-workflow-state>/);
  assert.match(first.breadcrumb, /TaskState: awaiting_approval/);
  assert.match(first.resumeToken, /^task:profile\/profile-edit:seq:1$/);
  const eventsPath = join(root, '.qa-agent', 'modules', 'profile', 'tasks', 'profile-edit', 'events.jsonl');
  assert.ok(existsSync(eventsPath));
  assert.equal(readFileSync(eventsPath, 'utf8').trim().split('\n').length, 1);

  const second = JSON.parse(run(root, 'start', '--request', 'Verify account profile editing', '--module', 'profile', '--task', 'profile-edit'));
  assert.equal(second.resumeToken, first.resumeToken);
  assert.equal(readFileSync(eventsPath, 'utf8').trim().split('\n').length, 1);

  const reviewed = JSON.parse(run(root, 'review', '--module', 'profile', '--task', 'profile-edit', '--approve', '--confirmed-by', 'profile-owner'));
  assert.equal(reviewed.task.metadata.status, 'ready');
  assert.equal(reviewed.workflow.taskState, 'ready');
  assert.equal(reviewed.workflow.workflowPhase, 'preflight');
  const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.seq), [1, 2]);
  assert.equal(events[1].type, 'test_plan_approved');
  assert.equal(new Set(events.map(event => event.idempotencyKey)).size, events.length);
});

test('validation rejects a visual assertion without importance', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-schema-v3-'));
  run(root, 'init', '--id', 'schema-v3');
  run(root, 'start', '--request', 'Verify search results', '--module', 'search', '--task', 'search-results');
  const scenarioPath = join(root, '.qa-agent', 'modules', 'search', 'tasks', 'search-results', 'scenarios', 'happy-path.json');
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  delete scenario.visualAssertions[0].importance;
  writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  const validation = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'validate'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(validation.status, 0);
  const result = JSON.parse(validation.stdout);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: string) => /visual assertion.*importance/i.test(error)));
});

test('migrate persists legacy Task and OperationPlan lifecycle states and creates an event baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-migrate-v3-'));
  initializeProject(root, { id: 'migrate-v3' });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Legacy lifecycle fixture' });
  const task = createTaskSkeleton(module, 'legacy-checkout'); approveTask(task); saveTask(root, task);
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'legacy.png');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const exploratory = beginAgentGuidedRun(root, task);
  recordAgentStep(root, exploratory.id, { action: 'Open checkout', operationAction: 'click', detail: 'Legacy fixture action.', screenshotPath: screenshot, locator: { strategy: 'text', value: 'Checkout' } });
  recordVisualFinding(root, exploratory.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout is visible.', actual: 'Checkout is visible.', status: 'passed', screenshotPath: screenshot });
  completeAgentGuidedRun(root, task, exploratory.id);

  const taskRoot = taskDirectory(root, 'checkout', 'legacy-checkout');
  const operationPath = join(taskRoot, 'operation-plans', 'happy-path', 'v1.json');
  const candidate = listOperations(root, readTask(root, 'checkout', 'legacy-checkout'))[0]!;
  reviewOperation(root, readTask(root, 'checkout', 'legacy-checkout'), candidate.id, 'approve', 'test-user');
  const replay = beginAgentGuidedRun(root, readTask(root, 'checkout', 'legacy-checkout'), { operationId: candidate.id });
  recordAgentStep(root, replay.id, { action: 'Open checkout', operationAction: 'click', detail: 'Legacy replay action.', screenshotPath: screenshot, operationStepId: candidate.steps[0]!.id, locator: { strategy: 'text', value: 'Checkout' } });
  recordVisualFinding(root, replay.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout is visible.', actual: 'Checkout is visible.', status: 'passed', screenshotPath: screenshot });
  completeAgentGuidedRun(root, readTask(root, 'checkout', 'legacy-checkout'), replay.id);
  const legacyOperation = JSON.parse(readFileSync(operationPath, 'utf8'));
  legacyOperation.status = 'active';
  legacyOperation.validationStatus = 'unverified';
  delete legacyOperation.approvedBy;
  delete legacyOperation.approvedAt;
  delete legacyOperation.validatedByRunId;
  delete legacyOperation.validatedAt;
  writeFileSync(operationPath, `${JSON.stringify(legacyOperation, null, 2)}\n`, 'utf8');
  const taskManifestPath = join(taskRoot, 'task.json');
  const legacyTask = JSON.parse(readFileSync(taskManifestPath, 'utf8'));
  legacyTask.metadata.status = 'active';
  writeFileSync(taskManifestPath, `${JSON.stringify(legacyTask, null, 2)}\n`, 'utf8');
  const eventsPath = join(taskRoot, 'events.jsonl');
  writeFileSync(eventsPath, '', 'utf8');
  for (const runId of [exploratory.id, replay.id]) {
    const legacyRunPath = join(taskRunDirectory(root, 'checkout', 'legacy-checkout', runId), 'run.json');
    const legacyRun = JSON.parse(readFileSync(legacyRunPath, 'utf8'));
    delete legacyRun.planHash;
    writeFileSync(legacyRunPath, `${JSON.stringify(legacyRun, null, 2)}\n`, 'utf8');
  }

  const migrated = JSON.parse(run(root, 'migrate'));
  assert.equal(migrated.migratedOperationPlans, 1);
  assert.equal(migrated.normalizedTaskStates, 1);
  assert.equal(migrated.createdTaskEventLogs, 1);
  assert.ok(migrated.backfilledRunPlanHashes >= 1);
  const migratedOperation = JSON.parse(readFileSync(operationPath, 'utf8'));
  assert.equal(migratedOperation.status, 'validated');
  assert.equal(migratedOperation.approvedBy, 'test-user');
  assert.ok(migratedOperation.approvedAt);
  assert.equal(JSON.parse(readFileSync(taskManifestPath, 'utf8')).metadata.status, 'ready');
  const event = JSON.parse(readFileSync(eventsPath, 'utf8').trim());
  assert.equal(event.type, 'migration_baseline_created');
  assert.equal(event.toState, 'ready');
  assert.equal(migrated.validation.valid, true);
});


test('repeated test resumes the active Run and workflow tokens track Run progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-active-run-'));
  run(root, 'init', '--id', 'active-run');
  run(root, 'start', '--request', 'Verify the active run', '--module', 'profile', '--task', 'active-run');
  run(root, 'review', '--module', 'profile', '--task', 'active-run', '--approve', '--confirmed-by', 'profile-owner');
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'active.png');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

  const started = JSON.parse(run(root, 'test', '--module', 'profile', '--task', 'active-run'));
  const repeated = JSON.parse(run(root, 'test', '--module', 'profile', '--task', 'active-run'));
  assert.equal(repeated.runId, started.runId);
  const mismatched = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'test', '--module', 'profile', '--task', 'active-run', '--environment', 'staging'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /active Run.*environment/i);
  assert.equal(readdirSync(join(taskDirectory(root, 'profile', 'active-run'), 'runs')).filter(name => name.startsWith('run-')).length, 1);
  const before = JSON.parse(run(root, 'workflow', 'status', '--module', 'profile', '--task', 'active-run'));
  run(root, 'run', 'step', started.runId, '--scenario', 'happy-path', '--action', 'Open profile', '--detail', 'Opened profile.', '--screenshot', screenshot, '--operation-action', 'click', '--locator-strategy', 'text', '--locator-value', 'Profile');
  const after = JSON.parse(run(root, 'workflow', 'status', '--module', 'profile', '--task', 'active-run'));
  assert.notEqual(after.resumeToken, before.resumeToken);
  assert.notEqual(after.contextHash, before.contextHash);
  assert.equal(after.nextActions[0].id, 'record_business_assertion');
  assert.equal(readTask(root, 'profile', 'active-run').metadata.status, 'running');
  const changed = readTask(root, 'profile', 'active-run');
  changed.scenarios[0]!.expected = { outcome: 'A changed outcome requiring approval.' };
  saveTask(root, changed);
  assert.throws(() => recordAgentStep(root, started.runId, { action: 'Continue profile', detail: 'Must stop after plan drift.', screenshotPath: screenshot, scenarioId: 'happy-path' }), /plan changed.*new TestPlan approval/i);
  const stopped = JSON.parse(run(root, 'test', '--module', 'profile', '--task', 'active-run'));
  assert.equal(stopped.status, 'needs_confirmation');
  assert.equal(readTask(root, 'profile', 'active-run').metadata.status, 'blocked');
  const reapproved = JSON.parse(run(root, 'review', '--module', 'profile', '--task', 'active-run', '--approve', '--confirmed-by', 'profile-owner'));
  assert.equal(reapproved.task.metadata.status, 'ready');
});

test('a failed business assertion keeps an executable replay contract validated', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-business-failure-'));
  initializeProject(root, { id: 'business-failure' });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Business failure fixture' });
  const task = createTaskSkeleton(module, 'checkout-regression'); approveTask(task); saveTask(root, task);
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'failure.png');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

  const explore = beginAgentGuidedRun(root, task);
  recordAgentStep(root, explore.id, { action: 'Open checkout', operationAction: 'click', detail: 'Opened checkout.', screenshotPath: screenshot, operationStepId: 'open-checkout', locator: { strategy: 'text', value: 'Checkout' } });
  recordVisualFinding(root, explore.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout succeeds.', actual: 'Checkout succeeds.', status: 'passed', screenshotPath: screenshot });
  completeAgentGuidedRun(root, task, explore.id);
  const candidate = listOperations(root, readTask(root, 'checkout', 'checkout-regression'))[0]!;
  reviewOperation(root, readTask(root, 'checkout', 'checkout-regression'), candidate.id, 'approve', 'qa-owner');

  const replay = beginAgentGuidedRun(root, readTask(root, 'checkout', 'checkout-regression'), { operationId: candidate.id });
  recordAgentStep(root, replay.id, { action: 'Open checkout', detail: 'Replay contract executed.', screenshotPath: screenshot, operationStepId: candidate.steps[0]!.id });
  recordVisualFinding(root, replay.id, { scenarioId: 'happy-path', assertionId: 'business-outcome', expected: 'Checkout succeeds.', actual: 'Checkout displays an application error.', status: 'failed', screenshotPath: screenshot });
  const failed = completeAgentGuidedRun(root, readTask(root, 'checkout', 'checkout-regression'), replay.id);
  assert.equal(failed.status, 'failed');
  const operation = listOperations(root, readTask(root, 'checkout', 'checkout-regression')).find(item => item.id === candidate.id)!;
  assert.equal(operation.status, 'validated');
  assert.equal(operation.validationStatus, 'passed');
  assert.equal(operation.validatedByRunId, replay.id);
  assert.equal(readTask(root, 'checkout', 'checkout-regression').metadata.status, 'reviewing_result');
  assert.ok(syncTaskRegressionSuite(root, readTask(root, 'checkout', 'checkout-regression')).members.some(member => member.operationPlanId === candidate.id));
  const workflow = JSON.parse(run(root, 'workflow', 'status', '--module', 'checkout', '--task', 'checkout-regression'));
  assert.equal(workflow.nextActions[0].id, 'review_failed_result');
  assert.notEqual(workflow.nextActions[0].id, 'archive_or_continue');
  const archive = inspectTaskArchive(root, readTask(root, 'checkout', 'checkout-regression'));
  assert.equal(archive.valid, false);
  assert.equal(archive.checks.find(check => check.id === 'latest-run')?.status, 'failed');
  assert.equal(archive.checks.find(check => check.id === 'known-issues')?.status, 'failed');

  const changed = readTask(root, 'checkout', 'checkout-regression');
  changed.scenarios[0]!.expected = { outcome: 'A revised approved checkout result.' };
  saveTask(root, changed);
  const reapproved = JSON.parse(run(root, 'review', '--module', 'checkout', '--task', 'checkout-regression', '--approve', '--confirmed-by', 'qa-owner'));
  assert.equal(reapproved.task.metadata.status, 'ready');
  const stale = listOperations(root, readTask(root, 'checkout', 'checkout-regression')).find(item => item.id === candidate.id)!;
  assert.equal(stale.status, 'stale');
  assert.equal(existsSync(join(taskDirectory(root, 'checkout', 'checkout-regression'), 'operation-plans', 'happy-path', 'current.json')), false);
  assert.equal(reapproved.workflow.nextActions[0].id, 'start_test');
});

test('multi-Scenario regression starts one child Run at a time', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-serial-regression-'));
  initializeProject(root, { id: 'serial-regression' });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Serial regression fixture' });
  const task = createTaskSkeleton(module, 'checkout-scenarios');
  task.scenarios.push({ ...task.scenarios[0]!, id: 'permission-denied', title: 'Permission denied', intent: 'Restricted users cannot submit.', expected: { outcome: 'Submit is unavailable.' }, requirementRefs: ['requirement-2'], visualAssertions: [{ id: 'permission-state', expected: 'Submit is unavailable.', importance: 'high' }] });
  task.requirements!.requirementTrace!.push({ requirementId: 'requirement-2', scenarioIds: ['permission-denied'], assertionIds: ['permission-state'], sourceRefs: [], status: 'covered' });
  approveTask(task); saveTask(root, task);
  importHostSnapshot(root, [{ id: 'browser-mcp', capabilities: ['browser.interact', 'browser.inspect'], permissionStatus: 'verified' }]);
  const screenshot = join(root, 'serial.png');
  writeFileSync(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

  for (const scenario of task.scenarios) {
    const assertion = scenario.visualAssertions![0]!;
    const explore = beginAgentGuidedRun(root, readTask(root, 'checkout', 'checkout-scenarios'), { scenarioId: scenario.id });
    recordAgentStep(root, explore.id, { action: `Open ${scenario.id}`, operationAction: 'click', detail: `Executed ${scenario.id}.`, screenshotPath: screenshot, operationStepId: `open-${scenario.id}`, scenarioId: scenario.id, locator: { strategy: 'text', value: scenario.title } });
    recordVisualFinding(root, explore.id, { scenarioId: scenario.id, assertionId: assertion.id, expected: assertion.expected, actual: assertion.expected, status: 'passed', screenshotPath: screenshot });
    completeAgentGuidedRun(root, readTask(root, 'checkout', 'checkout-scenarios'), explore.id);
  }
  for (const candidate of listOperations(root, readTask(root, 'checkout', 'checkout-scenarios'))) {
    reviewOperation(root, readTask(root, 'checkout', 'checkout-scenarios'), candidate.id, 'approve', 'qa-owner');
    const replay = beginAgentGuidedRun(root, readTask(root, 'checkout', 'checkout-scenarios'), { operationId: candidate.id, scenarioId: candidate.scenarioId });
    const scenario = readTask(root, 'checkout', 'checkout-scenarios').scenarios.find(item => item.id === candidate.scenarioId)!;
    const assertion = scenario.visualAssertions![0]!;
    recordAgentStep(root, replay.id, { action: `Replay ${scenario.id}`, detail: `Replayed ${scenario.id}.`, screenshotPath: screenshot, operationStepId: candidate.steps[0]!.id, scenarioId: scenario.id });
    recordVisualFinding(root, replay.id, { scenarioId: scenario.id, assertionId: assertion.id, expected: assertion.expected, actual: assertion.expected, status: 'passed', screenshotPath: screenshot });
    completeAgentGuidedRun(root, readTask(root, 'checkout', 'checkout-scenarios'), replay.id);
  }

  const currentTask = readTask(root, 'checkout', 'checkout-scenarios');
  const suite = syncTaskRegressionSuite(root, currentTask);
  assert.equal(suite.members.length, 2);
  const regression = beginRegressionRun(root, suite, buildExecutionSnapshot(root, currentTask));
  assert.equal(regression.childRuns.filter(child => child.status === 'running').length, 1);
  assert.equal(regression.childRuns.filter(child => child.status === 'pending').length, 1);

  const completeChild = (child: typeof regression.childRuns[number]): void => {
    const operation = listOperations(root, readTask(root, child.moduleId, child.taskId)).find(item => item.id === child.operationPlanId)!;
    const scenario = readTask(root, child.moduleId, child.taskId).scenarios.find(item => item.id === child.scenarioId)!;
    const assertion = scenario.visualAssertions![0]!;
    recordAgentStep(root, child.runId, { action: `Regression ${scenario.id}`, detail: `Replayed ${scenario.id}.`, screenshotPath: screenshot, operationStepId: operation.steps[0]!.id, scenarioId: scenario.id });
    recordVisualFinding(root, child.runId, { scenarioId: scenario.id, assertionId: assertion.id, expected: assertion.expected, actual: assertion.expected, status: 'passed', screenshotPath: screenshot });
    completeAgentGuidedRun(root, readTask(root, child.moduleId, child.taskId), child.runId);
  };

  completeChild(regression.childRuns.find(child => child.status === 'running')!);
  const progressed = completeRegressionRun(root, regression);
  assert.equal(progressed.childRuns.filter(child => child.status === 'running').length, 1);
  assert.equal(progressed.childRuns.filter(child => child.status === 'pending').length, 0);
  completeChild(progressed.childRuns.find(child => child.status === 'running')!);
  const completed = completeRegressionRun(root, progressed);
  assert.equal(completed.status, 'passed');
  assert.ok(completed.childRuns.every(child => child.status === 'passed'));
});

test('archived Tasks expose no next action and cannot start a new Run', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-archived-state-'));
  initializeProject(root, { id: 'archived-state' });
  const module = createModule(root, { id: 'profile', name: 'Profile', description: 'Archived state fixture' });
  const task = createTaskSkeleton(module, 'archived-profile'); approveTask(task); task.metadata.status = 'archived'; saveTask(root, task);
  const state = JSON.parse(run(root, 'workflow', 'status', '--module', 'profile', '--task', 'archived-profile'));
  assert.equal(state.workflowPhase, 'archive');
  assert.equal(state.reasonCode, 'task_archived');
  assert.deepEqual(state.nextActions, []);
  assert.throws(() => beginAgentGuidedRun(root, readTask(root, 'profile', 'archived-profile')), /archived.*cannot start/i);
});


test('Task and Operation asset references cannot escape the Task directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-safe-refs-'));
  initializeProject(root, { id: 'safe-refs' });
  const module = createModule(root, { id: 'checkout', name: 'Checkout', description: 'Safe reference fixture' });
  const task = createTaskSkeleton(module, 'safe-task'); saveTask(root, task);
  assert.throws(() => readOperation(root, task, '../outside.json'), /escapes Task directory/i);

  const taskRoot = taskDirectory(root, 'checkout', 'safe-task');
  const manifestPath = join(taskRoot, 'task.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.scenarioRefs = ['../outside.json'];
  writeFileSync(join(taskRoot, '..', 'outside.json'), JSON.stringify(task.scenarios[0]), 'utf8');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  assert.throws(() => readTask(root, 'checkout', 'safe-task'), /escapes Task directory/i);
});


test('compatibility task create writes an event baseline and plan-changing update requires reapproval', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-task-update-events-'));
  run(root, 'init', '--id', 'task-update-events');
  run(root, 'module', 'create', 'profile', '--name', 'Profile');
  run(root, 'task', 'create', 'edit-profile', '--module', 'profile', '--name', 'Edit profile');
  const eventsPath = join(taskDirectory(root, 'profile', 'edit-profile'), 'events.jsonl');
  let events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'task_created');
  assert.equal(events[0].toState, 'draft');
  assert.throws(() => appendTaskEvent(root, { type: 'task_created', actor: { type: 'agent', id: 'qa-agent' }, moduleId: 'profile', taskId: 'edit-profile', toState: 'draft', reasonCode: 'conflicting_reason', artifactHash: events[0].artifactHash, idempotencyKey: events[0].idempotencyKey }), /idempotency conflict/i);

  run(root, 'review', '--module', 'profile', '--task', 'edit-profile', '--approve', '--confirmed-by', 'profile-owner');
  const updated = JSON.parse(run(root, 'task', 'update', 'edit-profile', '--module', 'profile', '--name', 'Edit all profile fields'));
  assert.equal(updated.metadata.status, 'awaiting_approval');
  assert.equal(updated.metadata.approval, undefined);
  events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'test_plan_changed');
  assert.equal(events.at(-1).toState, 'awaiting_approval');
  const workflow = JSON.parse(run(root, 'workflow', 'status', '--module', 'profile', '--task', 'edit-profile'));
  assert.equal(workflow.workflowStatus, 'approval_required');
  assert.equal(workflow.nextActions[0].id, 'request_test_plan_approval');
});
