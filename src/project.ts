import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendJsonl, assertSafeId, ensureDir, now, readJson, withFileLock, writeJsonAtomic, writeTextAtomic } from './store.ts';
import type { ProjectConfig, QaModule, TestTask, TestRun } from './types.ts';
import { schemas } from './schemas.ts';
import { prompts } from './prompts.ts';
import { builtInSkills } from './built-in-skills.ts';

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

export function initializeProject(root: string, options: { id?: string; name?: string; description?: string; platforms?: string[] } = {}): ProjectConfig {
  const existing = qaPath(root, 'project.json');
  if (existsSync(existing)) throw new Error('.qa-agent is already initialized in this project.');
  const id = options.id ?? basename(resolve(root)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  assertSafeId(id, 'project id');
  for (const path of ['index', 'modules', 'shared-memory', 'skills/built-in', 'skills/project', 'skills/generated', 'prompts', 'schemas', 'runs', 'reports', 'evidence', 'cache', 'archive', '.locks']) ensureDir(qaPath(root, path));
  const timestamp = now();
  const project: ProjectConfig = {
    $schema: './schemas/project.schema.json', version: 1,
    project: { id, name: options.name ?? basename(resolve(root)), description: options.description ?? '', businessGoals: [], crossModuleFlows: [] },
    platforms: options.platforms?.length ? options.platforms : ['web'], environments: ['local'], roles: ['default'], defaultContext: { environment: 'local', platform: options.platforms?.[0] ?? 'web', role: 'default' },
    source: { mode: 'local-readonly', root: '..' }, storage: { format: 'json', runIndexFormat: 'jsonl' }, createdAt: timestamp, updatedAt: timestamp,
  };
  writeJsonAtomic(existing, project);
  writeJsonAtomic(qaPath(root, 'policies.json'), defaultPolicies());
  writeJsonAtomic(qaPath(root, 'capabilities.json'), { version: 1, capabilities: ['source.readonly'], updatedAt: timestamp });
  writeJsonAtomic(qaPath(root, 'mcp.json'), { version: 1, connections: [] });
  writeJsonAtomic(qaPath(root, 'accounts.example.json'), { version: 1, accounts: [{ id: 'example-staging-user', secretRef: 'env:QA_EXAMPLE_PASSWORD' }] });
  for (const name of ['modules', 'tasks', 'memories', 'skills', 'capabilities']) writeJsonAtomic(qaPath(root, 'index', `${name}.json`), { version: 1, updatedAt: timestamp, [name]: [] });
  writeJsonAtomic(qaPath(root, 'shared-memory', 'project-profile.json'), { version: 1, entries: [] });
  for (const [name, schema] of Object.entries(schemas)) writeJsonAtomic(qaPath(root, 'schemas', name), schema);
  for (const [name, prompt] of Object.entries(prompts)) {
    const path = qaPath(root, 'prompts', name);
    writeTextAtomic(path, `${prompt}\n`);
  }
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
export function taskPath(root: string, moduleId: string, taskId: string): string { assertSafeId(taskId, 'task id'); return join(modulePath(root, moduleId), 'tasks', `${taskId}.json`); }

export function createModule(root: string, input: Pick<QaModule, 'id' | 'name' | 'description'> & Partial<Pick<QaModule, 'riskLevel' | 'platforms' | 'roles' | 'dependencies' | 'businessGoals' | 'sourceHints' | 'entryPoints' | 'coreFlows' | 'businessRules' | 'keyStates' | 'regressionFocus'>>): QaModule {
  return withFileLock(qaPath(root, '.locks', 'modules.lock'), () => {
    const folder = modulePath(root, input.id);
    const path = join(folder, 'module.json');
    if (existsSync(path)) throw new Error(`Module ${input.id} already exists.`);
    ensureDir(join(folder, 'tasks')); ensureDir(join(folder, 'memory'));
    const timestamp = now();
    const module: QaModule = {
      $schema: '../../schemas/module.schema.json', version: 1, id: input.id, name: input.name, description: input.description,
      status: 'active', riskLevel: input.riskLevel ?? 'medium', platforms: input.platforms ?? ['web'], roles: input.roles ?? ['default'],
      dependencies: input.dependencies ?? [], businessGoals: input.businessGoals ?? [], sourceHints: input.sourceHints ?? [], entryPoints: input.entryPoints ?? [], coreFlows: input.coreFlows ?? [], businessRules: input.businessRules ?? [], keyStates: input.keyStates ?? [], regressionFocus: input.regressionFocus ?? [], createdAt: timestamp, updatedAt: timestamp,
    };
    writeJsonAtomic(path, module);
    return module;
  });
}

export function readModule(root: string, id: string): QaModule { return readJson<QaModule>(join(modulePath(root, id), 'module.json')); }
export function readTask(root: string, moduleId: string, taskId: string): TestTask { return readJson<TestTask>(taskPath(root, moduleId, taskId)); }

export function saveTask(root: string, task: TestTask): void { withFileLock(qaPath(root, '.locks', 'tasks.lock'), () => writeJsonAtomic(taskPath(root, task.metadata.moduleId, task.metadata.id), task)); }
export function checkpointRun(root: string, run: TestRun): void {
  withFileLock(qaPath(root, '.locks', 'runs.lock'), () => writeJsonAtomic(qaPath(root, 'runs', `${run.id}.json`), run));
}
export function saveRun(root: string, run: TestRun): void {
  withFileLock(qaPath(root, '.locks', 'runs.lock'), () => {
    writeJsonAtomic(qaPath(root, 'runs', `${run.id}.json`), run);
    appendJsonl(qaPath(root, 'index', 'runs.jsonl'), { runId: run.id, taskId: run.taskId, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, reportPath: run.reportPath });
  });
}

export function gitMetadata(root: string): TestRun['git'] {
  const run = (args: string[]): string | undefined => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; } };
  const status = run(['status', '--porcelain']) ?? '';
  return { branch: run(['branch', '--show-current']), commit: run(['rev-parse', 'HEAD']), dirtyWorkspace: status.length > 0, changedFiles: status.split('\n').filter(Boolean).map(line => line.slice(3)) };
}
