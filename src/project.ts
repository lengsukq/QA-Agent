import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendJsonl, assertSafeId, ensureDir, listFiles, now, readJson, withFileLock, writeJsonAtomic, writeTextAtomic } from './store.ts';
import type { ModuleSnapshot, ProjectConfig, QaModule, TestPlan, TestRequirements, TestRun, TestTask } from './types.ts';
import { schemas } from './schemas.ts';
import { prompts } from './prompts.ts';
import { builtInSkills } from './built-in-skills.ts';
import { approvalIsCurrent } from './approval.ts';

export const QA_DIRECTORY = '.qa-agent';

export function findProjectRoot(start = process.cwd()): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, QA_DIRECTORY, 'project.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function requireProjectRoot(start = process.cwd()): string {
  const root = findProjectRoot(start);
  if (!root) throw new Error('No .qa-agent/project.json found. Run qa-agent init first.');
  return root;
}

export function qaPath(root: string, ...parts: string[]): string { return join(root, QA_DIRECTORY, ...parts); }

export function syncProjectPrompts(root: string): string[] {
  const written: string[] = [];
  ensureDir(qaPath(root, 'prompts'));
  const obsolete = ['qa-main.md', 'module-planner.md', 'task-planner.md', 'execution.md', 'assertion.md', 'impact-analysis.md', 'source-verification.md', 'memory-curator.md'];
  for (const name of obsolete) {
    const path = qaPath(root, 'prompts', name);
    if (existsSync(path)) unlinkSync(path);
  }
  for (const [name, prompt] of Object.entries(prompts)) {
    const path = qaPath(root, 'prompts', name);
    writeTextAtomic(path, `${prompt}\n`);
    written.push(path);
  }
  return written;
}


export function readProjectPromptBundle(root: string): {
  apiVersion: 'qa-agent/v2'; kind: 'PromptBundle'; bundleHash: string; current: boolean; missing: string[]; stale: string[]; prompts: Record<string, string>;
} {
  const entries = Object.keys(prompts).sort().map(name => {
    const path = qaPath(root, 'prompts', name);
    const content = existsSync(path) ? readFileSync(path, 'utf8').trimEnd() : '';
    return { name, content, expected: prompts[name] ?? '' };
  });
  const missing = entries.filter(entry => !entry.content).map(entry => entry.name);
  const stale = entries.filter(entry => entry.content && entry.content !== entry.expected).map(entry => entry.name);
  const promptMap = Object.fromEntries(entries.map(entry => [entry.name, entry.content]));
  return {
    apiVersion: 'qa-agent/v2', kind: 'PromptBundle',
    bundleHash: createHash('sha256').update(JSON.stringify(promptMap)).digest('hex'),
    current: !missing.length && !stale.length, missing, stale, prompts: promptMap,
  };
}

export function initializeProject(root: string, options: { id?: string; name?: string; description?: string; platforms?: string[] } = {}): ProjectConfig {
  const existing = qaPath(root, 'project.json');
  if (existsSync(existing)) throw new Error('.qa-agent is already initialized in this project.');
  const id = options.id ?? basename(resolve(root)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  assertSafeId(id, 'project id');
  for (const path of ['index', 'modules', 'shared-memory', 'skills/built-in', 'skills/project', 'skills/generated', 'prompts', 'schemas', 'runs', 'reports', 'evidence', 'regression-runs', 'impact-analysis', 'release-checks', 'cache', 'archive', '.locks']) ensureDir(qaPath(root, path));
  const timestamp = now();
  const project: ProjectConfig = {
    $schema: './schemas/project.schema.json', version: 1,
    project: { id, name: options.name ?? basename(resolve(root)), description: options.description ?? '', businessGoals: [], crossModuleFlows: [] },
    platforms: options.platforms?.length ? options.platforms : ['web'], environments: ['local'], roles: ['default'], defaultContext: { environment: 'local', platform: options.platforms?.[0] ?? 'web', role: 'default' },
    source: { mode: 'host-provided', root: '' }, storage: { format: 'json', runIndexFormat: 'jsonl' }, createdAt: timestamp, updatedAt: timestamp,
  };
  writeJsonAtomic(existing, project);
  writeJsonAtomic(qaPath(root, '.version'), { version: '0.2.6', initializedAt: timestamp });
  writeJsonAtomic(qaPath(root, '.template-hashes.json'), { version: 1, hashes: {} });
  writeJsonAtomic(qaPath(root, '.configured-hosts.json'), {});
  writeJsonAtomic(qaPath(root, 'policies.json'), defaultPolicies());
  writeJsonAtomic(qaPath(root, 'mcp.json'), { version: 1, connections: [] });
  writeJsonAtomic(qaPath(root, 'accounts.example.json'), { version: 1, accounts: [{ id: 'example-staging-user', secretRef: 'env:QA_EXAMPLE_PASSWORD' }] });
  for (const name of ['modules', 'tasks', 'memories', 'skills']) writeJsonAtomic(qaPath(root, 'index', `${name}.json`), { version: 1, updatedAt: timestamp, [name]: [] });
  writeJsonAtomic(qaPath(root, 'shared-memory', 'project-profile.json'), { version: 1, entries: [] });
  for (const [name, schema] of Object.entries(schemas)) writeJsonAtomic(qaPath(root, 'schemas', name), schema);
  syncProjectPrompts(root);
  for (const skill of builtInSkills) writeJsonAtomic(qaPath(root, 'skills', 'built-in', `${skill.metadata.name.replace(/\./g, '-')}.json`), skill);
  writeJsonAtomic(qaPath(root, 'index', 'skills.json'), {
    version: 1,
    updatedAt: timestamp,
    skills: builtInSkills.map(skill => ({ name: skill.metadata.name, version: skill.metadata.version, description: skill.metadata.description, lifecycle: skill.metadata.lifecycle, path: `skills/built-in/${skill.metadata.name.replace(/\./g, '-')}.json`, capabilities: skill.requirements.capabilities })),
  });
  return project;
}

export function defaultPolicies(): object {
  return {
    version: 1, safeMode: true, allowTestDataCreation: true,
    prohibitedActions: ['payment.submit.real', 'refund.submit.real', 'production.delete', 'production.database.write', 'notification.send.real', 'permission.change.production'],
    stopBefore: ['payment.submit', 'refund.submit', 'data.delete', 'notification.send'],
    requireApprovalFor: ['order.submit', 'account.permission.change'], production: { writeAccess: false },
  };
}

export function readProject(root: string): ProjectConfig { return readJson<ProjectConfig>(qaPath(root, 'project.json')); }

export function modulePath(root: string, id: string): string { assertSafeId(id, 'module id'); return qaPath(root, 'modules', id); }
export function taskDirectory(root: string, moduleId: string, taskId: string): string { assertSafeId(taskId, 'task id'); return join(modulePath(root, moduleId), 'tasks', taskId); }
export function taskPath(root: string, moduleId: string, taskId: string): string { return join(taskDirectory(root, moduleId, taskId), 'task.json'); }
export function taskRequirementsPath(root: string, moduleId: string, taskId: string): string { return join(taskDirectory(root, moduleId, taskId), 'requirements.json'); }
export function taskPlanPath(root: string, moduleId: string, taskId: string): string { return join(taskDirectory(root, moduleId, taskId), 'test-plan.json'); }
export function taskModuleSnapshotPath(root: string, moduleId: string, taskId: string): string { return join(taskDirectory(root, moduleId, taskId), 'module-snapshot.json'); }
export function taskScenarioPath(root: string, moduleId: string, taskId: string, scenarioId: string): string { assertSafeId(scenarioId, 'scenario id'); return join(taskDirectory(root, moduleId, taskId), 'scenarios', `${scenarioId}.json`); }
export function taskOperationDirectory(root: string, moduleId: string, taskId: string, scenarioId?: string): string { return join(taskDirectory(root, moduleId, taskId), 'operation-plans', ...(scenarioId ? [scenarioId] : [])); }
export function taskRegressionSuitePath(root: string, moduleId: string, taskId: string): string { return join(taskDirectory(root, moduleId, taskId), 'regression-suite.json'); }
export function taskRunDirectory(root: string, moduleId: string, taskId: string, runId: string): string { assertSafeId(runId, 'run id'); return join(taskDirectory(root, moduleId, taskId), 'runs', runId); }
export function taskRunPath(root: string, moduleId: string, taskId: string, runId: string): string { return join(taskRunDirectory(root, moduleId, taskId, runId), 'run.json'); }
/** Compatibility paths for the self-contained Runtime Run package contract. */
export function taskRunReportPath(root: string, moduleId: string, taskId: string, runId: string): string { return join(taskRunDirectory(root, moduleId, taskId, runId), 'report.md'); }
export function taskRunIndexPath(root: string, moduleId: string, taskId: string): string { return join(taskDirectory(root, moduleId, taskId), 'runs', 'index.json'); }
export function taskRunLatestPath(root: string, moduleId: string, taskId: string): string { return join(taskDirectory(root, moduleId, taskId), 'runs', 'latest.json'); }
export function taskReportDirectory(root: string, moduleId: string, taskId: string): string { return join(taskDirectory(root, moduleId, taskId), 'reports'); }
export function moduleReportDirectory(root: string, moduleId: string): string { return join(modulePath(root, moduleId), 'reports'); }
export function taskEvidenceDirectory(root: string, moduleId: string, taskId: string, runId: string): string { return join(taskRunDirectory(root, moduleId, taskId, runId), 'evidence'); }

export function createModule(root: string, input: Pick<QaModule, 'id' | 'name' | 'description'> & Partial<Pick<QaModule, 'riskLevel' | 'platforms' | 'roles' | 'dependencies' | 'businessGoals' | 'sourceHints' | 'entryPoints' | 'coreFlows' | 'businessRules' | 'keyStates' | 'regressionFocus'>>): QaModule {
  return withFileLock(qaPath(root, '.locks', 'modules.lock'), () => {
    const folder = modulePath(root, input.id);
    const path = join(folder, 'module.json');
    if (existsSync(path)) throw new Error(`Module ${input.id} already exists.`);
    ensureDir(join(folder, 'tasks')); ensureDir(join(folder, 'memory')); ensureDir(join(folder, 'reports'));
    const timestamp = now();
    const module: QaModule = {
      $schema: '../../schemas/module.schema.json', version: 1, revision: 1, id: input.id, name: input.name, description: input.description,
      status: 'active', riskLevel: input.riskLevel ?? 'medium', platforms: input.platforms ?? ['web'], roles: input.roles ?? ['default'],
      dependencies: input.dependencies ?? [], businessGoals: input.businessGoals ?? [], sourceHints: input.sourceHints ?? [], entryPoints: input.entryPoints ?? [], coreFlows: input.coreFlows ?? [], businessRules: input.businessRules ?? [], keyStates: input.keyStates ?? [], regressionFocus: input.regressionFocus ?? [], createdAt: timestamp, updatedAt: timestamp,
    };
    writeJsonAtomic(path, module);
    return module;
  });
}

export function readModule(root: string, id: string): QaModule { return readJson<QaModule>(join(modulePath(root, id), 'module.json')); }
function buildModuleSnapshot(module: QaModule): ModuleSnapshot {
  const snapshot = { moduleId: module.id, moduleName: module.name, moduleRevision: module.revision ?? 1, platforms: module.platforms, roles: module.roles, businessGoals: module.businessGoals, coreFlows: module.coreFlows ?? [], businessRules: module.businessRules ?? [], keyStates: module.keyStates ?? [], regressionFocus: module.regressionFocus ?? [] };
  return { $schema: '../../../../schemas/module-snapshot.schema.json', apiVersion: 'qa-agent/v2', kind: 'ModuleSnapshot', ...snapshot, snapshotHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), capturedAt: now() };
}

function buildRequirements(task: TestTask, module: QaModule): TestRequirements {
  const timestamp = now();
  return { $schema: '../../../../schemas/requirements.schema.json', apiVersion: 'qa-agent/v2', kind: 'TestRequirements', taskId: task.metadata.id, moduleId: module.id, businessGoals: task.objectives, actors: task.scope.roles, flows: module.coreFlows ?? [], rules: (module.businessRules ?? []).map((statement, index) => ({ id: `rule-${index + 1}`, statement, knowledgeLevel: 'inferred' as const, source: 'module definition' })), scope: { included: task.objectives, excluded: [] }, preconditions: task.preconditions, testDataRefs: [], environments: task.scope.environments, sourceRefs: module.sourceHints ?? [], risks: task.safety.stopBefore, userQuestions: [], confirmedDecisions: [], createdAt: timestamp, updatedAt: timestamp };
}

function resolveTaskAssetRef(root: string, moduleId: string, taskId: string, ref: string): string {
  const base = resolve(taskDirectory(root, moduleId, taskId));
  const path = resolve(base, ref);
  if (path !== base && !path.startsWith(`${base}${sep}`)) throw new Error(`Task asset reference escapes Task directory: ${ref}.`);
  return path;
}

export function readTask(root: string, moduleId: string, taskId: string): TestTask {
  const task = readJson<TestTask>(taskPath(root, moduleId, taskId));
  task.scenarios = (task.scenarioRefs ?? []).map(ref => readJson<TestTask['scenarios'][number]>(resolveTaskAssetRef(root, moduleId, taskId, ref)));
  task.moduleSnapshot = existsSync(taskModuleSnapshotPath(root, moduleId, taskId)) ? readJson<ModuleSnapshot>(taskModuleSnapshotPath(root, moduleId, taskId)) : undefined;
  task.requirements = existsSync(taskRequirementsPath(root, moduleId, taskId)) ? readJson<TestRequirements>(taskRequirementsPath(root, moduleId, taskId)) : undefined;
  task.testPlan = existsSync(taskPlanPath(root, moduleId, taskId)) ? readJson<TestPlan>(taskPlanPath(root, moduleId, taskId)) : undefined;
  return task;
}

export function saveTask(root: string, task: TestTask): void {
  withFileLock(qaPath(root, '.locks', 'tasks.lock'), () => {
    const module = readModule(root, task.metadata.moduleId);
    const directory = taskDirectory(root, task.metadata.moduleId, task.metadata.id);
    for (const child of ['scenarios', 'operation-plans', 'runs', 'reports', 'memory']) ensureDir(join(directory, child));
    task.moduleSnapshot ??= buildModuleSnapshot(module); task.requirements ??= buildRequirements(task, module);
    task.scenarioRefs = task.scenarios.map(scenario => `scenarios/${scenario.id}.json`);
    const approvalCurrent = approvalIsCurrent(task);
    task.testPlan ??= { $schema: '../../../../schemas/test-plan.schema.json', apiVersion: 'qa-agent/v2', kind: 'TestPlan', taskId: task.metadata.id, moduleId: task.metadata.moduleId, version: task.metadata.version, planHash: approvalCurrent ? task.metadata.approval!.planHash : '', scenarioRefs: task.scenarioRefs, requiredSkills: task.requiredSkills, capabilities: task.capabilities, safety: task.safety, evidencePolicy: task.evidencePolicy, recoveryPolicy: task.recoveryPolicy, status: approvalCurrent ? 'approved' : 'draft', approvedBy: approvalCurrent ? task.metadata.approval!.confirmedBy : undefined, approvedAt: approvalCurrent ? task.metadata.approval!.confirmedAt : undefined, createdAt: task.createdAt, updatedAt: task.updatedAt };
    writeJsonAtomic(taskModuleSnapshotPath(root, task.metadata.moduleId, task.metadata.id), task.moduleSnapshot);
    writeJsonAtomic(taskRequirementsPath(root, task.metadata.moduleId, task.metadata.id), task.requirements);
    task.testPlan.planHash = approvalCurrent ? task.metadata.approval!.planHash : task.testPlan.planHash;
    task.testPlan.status = approvalCurrent ? 'approved' : task.testPlan.status === 'approved' ? 'awaiting_confirmation' : task.testPlan.status;
    task.testPlan.approvedBy = approvalCurrent ? task.metadata.approval!.confirmedBy : undefined;
    task.testPlan.approvedAt = approvalCurrent ? task.metadata.approval!.confirmedAt : undefined;
    task.testPlan.updatedAt = task.updatedAt;
    writeJsonAtomic(taskPlanPath(root, task.metadata.moduleId, task.metadata.id), task.testPlan);
    for (const scenario of task.scenarios) writeJsonAtomic(taskScenarioPath(root, task.metadata.moduleId, task.metadata.id, scenario.id), scenario);
    const { scenarios: _scenarios, moduleSnapshot: _snapshot, requirements: _requirements, testPlan: _testPlan, ...manifest } = task;
    writeJsonAtomic(taskPath(root, task.metadata.moduleId, task.metadata.id), manifest);
  });
}
export function checkpointRun(root: string, run: TestRun): void {
  withFileLock(qaPath(root, '.locks', 'runs.lock'), () => writeJsonAtomic(taskRunPath(root, run.moduleId, run.taskId, run.id), run));
}
export function saveRun(root: string, run: TestRun): void {
  withFileLock(qaPath(root, '.locks', 'runs.lock'), () => {
    writeJsonAtomic(taskRunPath(root, run.moduleId, run.taskId, run.id), run);
    appendJsonl(qaPath(root, 'index', 'runs.jsonl'), { runId: run.id, taskId: run.taskId, moduleId: run.moduleId, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, reportPath: run.reportPath });
  });
}
function normalizeRun(run: TestRun): TestRun { run.cleanupFindings ??= []; return run; }
export function readRun(root: string, moduleId: string, taskId: string, runId: string): TestRun { return normalizeRun(readJson<TestRun>(taskRunPath(root, moduleId, taskId, runId))); }
export function readRunById(root: string, runId: string): TestRun {
  const path = listFiles(qaPath(root, 'modules'), candidate => candidate.endsWith(`/runs/${runId}/run.json`))[0];
  if (!path) throw new Error(`Run ${runId} was not found in a Task folder.`);
  return normalizeRun(readJson<TestRun>(path));
}

export function gitMetadata(root: string): TestRun['git'] {
  const run = (args: string[]): string | undefined => { try { return execFileSync('git', ['-c', `safe.directory=${root}`, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; } };
  const status = run(['status', '--porcelain']) ?? '';
  return { branch: run(['branch', '--show-current']), commit: run(['rev-parse', 'HEAD']), dirtyWorkspace: status.length > 0, changedFiles: status.split('\n').filter(Boolean).map(line => line.slice(3)) };
}
