#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { availableCapabilities, capabilityAdvice } from './capabilities.ts';
import { beginAgentGuidedRun, beginRegressionRun, buildExecutionSnapshot, completeAgentGuidedRun, completeRegressionRun, recordAgentStep, recordCleanupFinding, recordHostEvidence, recordRecoveryAttempt, recordVisualFinding } from './engine.ts';
import { readIndex, rebuildIndexes } from './indexer.ts';
import { createTaskSkeleton, planModule, taskPlan } from './planning.ts';
import { createModule, findProjectRoot, initializeProject, modulePath, qaPath, readModule, readProjectPromptBundle, readRunById, readTask, requireProjectRoot, saveRun, saveTask, syncProjectPrompts, taskDirectory, taskRunReportPath } from './project.ts';
import { readProject } from './project.ts';
import { assertSafeId, listFiles, now, readJson, writeJsonAtomic } from './store.ts';
import type { ExecutionSnapshot, Locator, PermissionStatus, ProjectMemory, RegressionProfile, RegressionRun, ReleaseCheck, RunStatus, StepExecutionMode, TestPriority, TestRun, TestTask } from './types.ts';
import { validateProject, validateSkill } from './validation.ts';
import { createMemoryCandidate, reviewMemory } from './memory.ts';
import { configuredHostRecords, installHostIntegration, recordHostInstall, supportedHosts, updateHostIntegrations } from './host-adapters.ts';
import { detectConfiguredHosts, hostsFromFlags, HOST_PLATFORMS } from './host-configurators/registry.ts';
import { assertHumanApprover, testPlanHash } from './approval.ts';
import { hostCapabilityDiagnosis } from './capabilities.ts';
import { createOperationCandidates, listOperations, operationSummary, readOperation, reviewOperation } from './operations.ts';
import { buildModuleRegressionSuite, buildReleaseRegressionSuite, readTaskRegressionSuite, syncTaskRegressionSuite } from './regression.ts';
import { analyzeProjectImpact } from './impact-analysis.ts';
import { attachRegressionRun, createReleaseCheck, finalizeReleaseCheck, readReleaseCheck, saveReleaseCheck, writeReleaseReport } from './release.ts';
import { bootstrapWorkflow, workflowStatus } from './workflow.ts';
import { migrateProjectArtifacts } from './migration.ts';
import { inspectTaskArchive } from './archive.ts';

const args = process.argv.slice(2);
const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const hostFlags = supportedHosts.map(host => `--${HOST_PLATFORMS[host].cliFlag}`).join(' ');
const hostNames = supportedHosts.join('|');
const usage = `qa-agent — local-first QA Agent MVP

Commands:
  --help, -h, help | --version, -v, version
  init [--id ID] [--name NAME] [--description TEXT] [--platforms web,android,ios] [${hostFlags}] [--force]
  configure --project PROJECT_DIRECTORY --host <${hostNames}> [--scope project|user] [init options] [--force]
  install-skill [--path SKILLS_DIRECTORY] [--force]   (Codex compatibility alias)
  install-host <${hostNames}> [--scope project|user] [--project PROJECT_DIRECTORY] [--path SKILLS_DIRECTORY] [--force]
  doctor | validate | migrate | index rebuild | prompts sync
  update [--force] [--migrate]
  start --request TEXT --module ID --task ID [--module-name NAME] [--task-name NAME] [--platforms web,android,ios] [--risk low|medium|high|critical]
  test --module MODULE --task TASK [--scenario SCENARIO] [execution context flags]
  archive --module MODULE --task TASK
  workflow bootstrap --request TEXT --module ID --task ID [--module-name NAME] [--task-name NAME] [--platforms web,android,ios] [--risk low|medium|high|critical]
  workflow status --module ID --task ID
  operation generate --module MODULE --task TASK [--run RUN_ID] [--scenario SCENARIO]
  operation replay OPERATION_ID --module MODULE --task TASK [execution context flags]
  impact analyze [--base REF] [--head REF] [--changed-files FILE1,FILE2]
  release check [--profile fast|normal|full] [--base REF] [--head REF] [--changed-files FILE1,FILE2] [--plan-only] [execution context flags]
  release list | release show|complete|report CHECK_ID
  host list | host attest --id ID --capabilities CAP1,CAP2 --permission-status verified|missing|unknown [--host HOST] [--version VERSION] | host import --file HOST_CAPABILITIES.json | host doctor [--platform android|ios]
  context module MODULE
  module list | module create ID --name NAME [--description TEXT] [--platforms web,android,ios] [--source-hints PATHS] [--entry-points PATHS] [--dependencies MODULES] | module update ID [--name NAME] [--description TEXT] [--risk LEVEL] [same mapping flags] | module archive ID | module plan ID | module coverage ID
  task list | task create ID --module MODULE [--name NAME] [--priority p0|p1|p2|p3] [--frequency every-change|every-release|scheduled|manual] [--release-gate true|false] [--estimated-minutes N] [--tags TAGS] [--triggers PATHS] [--golden-path] | task update ID --module MODULE [same metadata flags] | task plan ID --module MODULE | task explore ID --module MODULE [execution context flags] | task run ID --module MODULE [--operation OPERATION_ID] [--scenario SCENARIO] [--environment ENV] [--platform PLATFORM] [--role ROLE] [--device DEVICE] [--device-model MODEL] [--os-version VERSION] [--app-version VERSION] [--web-build BUILD] [--test-data-fingerprint FINGERPRINT] | task operation generate|list|show|review ID --module MODULE [--run RUN_ID] [--approve|--reject] | task regression sync|show|run|complete ID --module MODULE | task review ID --module MODULE --approve --confirmed-by USER [--confirmation-source current-chat-explicit-approval] | task archive ID --module MODULE
  module regression show|run|complete MODULE [--priority p0|p1|p2|p3]
  memory list | memory search TEXT | memory add ID --module MODULE [--task TASK] --title TEXT --content TEXT | memory review ID --module MODULE [--task TASK] --approve|--reject
  run step RUN --action TEXT --detail TEXT --screenshot PATH [--operation-action launch|navigate|click|input|fill|swipe|back|wait|assert|screenshot|reset|restart-app] [--safety-action ACTION] [--scenario SCENARIO] [--status passed|failed|paused|blocked|adapted] [--visual-inspection performed|not-required|skipped] [--execution-mode host-automated|user-assisted|system-component-blocked|preseeded-test-data] [--operation-step STEP] [--locator-strategy STRATEGY] [--locator-value VALUE] [--actual-locator-strategy STRATEGY] [--actual-locator-value VALUE] [--input-refs key=ref,key=ref] [--expected-state TEXT] [--actual-state TEXT] [--adaptation TEXT]
  run evidence RUN --type TYPE --summary TEXT [--file PATH]
  run cleanup RUN --scenario ID --cleanup TEXT --actual TEXT --status passed|failed|blocked|paused|inconclusive [--screenshot PATH]
  run recover RUN --action wait|refresh|back|restart-app|reset-sandbox-data|reconnect-mcp|fallback-locator|resume-checkpoint --reason TEXT --detail TEXT --outcome continued|blocked|paused|failed [--failed-step STEP]
  run observe RUN --scenario ID --assertion ID --expected TEXT --actual TEXT --status passed|failed|paused|blocked [--screenshot PATH]
  run complete RUN | run show RUN | run report RUN
  skill list | skill validate
`;

function flag(name: string): string | undefined { const position = args.indexOf(name); return position === -1 ? undefined : args[position + 1]; }
function requiredFlag(name: string): string { const value = flag(name); if (!value || value.startsWith('--')) throw new Error(`${name} is required.`); return value; }
function listFlag(name: string): string[] | undefined { const value = flag(name); return value ? [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))] : undefined; }
function recordFlag(name: string): Record<string, string> | undefined {
  const entries = listFlag(name); if (!entries) return undefined;
  const output: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0 || separator === entry.length - 1) throw new Error(`${name} entries must use key=value.`);
    output[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }
  return output;
}
function output(value: unknown): void { console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }

function regressionProfile(): RegressionProfile {
  const value = flag('--profile') ?? 'fast';
  if (!['fast', 'normal', 'full'].includes(value)) throw new Error('--profile must be fast, normal, or full.');
  return value as RegressionProfile;
}

function priorityValue(value = flag('--priority')): TestPriority | undefined {
  if (!value) return undefined;
  if (!['p0', 'p1', 'p2', 'p3'].includes(value)) throw new Error('--priority must be p0, p1, p2, or p3.');
  return value as TestPriority;
}

function booleanFlag(name: string): boolean | undefined {
  const value = flag(name);
  if (value === undefined) return undefined;
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false.`);
  return value === 'true';
}

function applyTaskRegressionMetadata(task: TestTask): TestTask {
  const priority = priorityValue(); if (priority) task.metadata.priority = priority;
  const frequency = flag('--frequency');
  if (frequency) {
    if (!['every-change', 'every-release', 'scheduled', 'manual'].includes(frequency)) throw new Error('--frequency must be every-change, every-release, scheduled, or manual.');
    task.metadata.frequency = frequency as NonNullable<TestTask['metadata']['frequency']>;
  }
  const releaseGate = booleanFlag('--release-gate'); if (releaseGate !== undefined) task.metadata.releaseGate = releaseGate;
  const estimated = flag('--estimated-minutes');
  if (estimated !== undefined) {
    const value = Number(estimated); if (!Number.isFinite(value) || value <= 0) throw new Error('--estimated-minutes must be a positive number.');
    task.metadata.estimatedDurationMinutes = value;
  }
  const tags = listFlag('--tags'); if (tags) task.metadata.tags = tags;
  const triggers = listFlag('--triggers'); if (triggers) task.regression.triggers = triggers;
  if (args.includes('--golden-path')) {
    task.metadata.tags = [...new Set([...(task.metadata.tags ?? []), 'golden-path'])];
    task.metadata.releaseGate = true;
    task.metadata.frequency = 'every-release';
    task.metadata.priority = 'p0';
  }
  task.updatedAt = now();
  return task;
}
function locatorFromFlags(prefix = ''): Locator | undefined {
  const strategy = flag(`--${prefix}locator-strategy`); const value = flag(`--${prefix}locator-value`);
  if (!strategy && !value) return undefined;
  if (!strategy) throw new Error(`--${prefix}locator-strategy is required when a locator value is supplied.`);
  return { strategy: strategy as Locator['strategy'], value };
}

function runContextFromFlags(): Partial<ExecutionSnapshot> & { operationId?: string } {
  return { environment: flag('--environment'), platform: flag('--platform'), role: flag('--role'), scenarioId: flag('--scenario'), operationId: flag('--operation'), device: flag('--device'), deviceModel: flag('--device-model'), osVersion: flag('--os-version'), appVersion: flag('--app-version'), webBuild: flag('--web-build'), testDataFingerprint: flag('--test-data-fingerprint') };
}

function executionEnvelope(projectRoot: string, run: TestRun): Record<string, unknown> {
  const mode = run.mode ?? (run.replayStatus === 'not_replay' ? 'explore' : 'replay');
  const running = run.status === 'running';
  const taskDirectory = `.qa-agent/modules/${run.moduleId}/tasks/${run.taskId}`;
  const runDirectory = `${taskDirectory}/runs/${run.id}`;
  const assetContract = {
    taskDirectory,
    runDirectory,
    runJson: `${runDirectory}/run.json`,
    report: `${runDirectory}/report.md`,
    screenshotsDirectory: `${runDirectory}/screenshots/`,
    evidenceDirectory: `${runDirectory}/evidence/`,
  };
  const common = {
    ...run,
    executionMode: mode,
    uiExecutionAllowed: running,
    runId: running ? run.id : undefined,
    mustStop: !running,
    manualReportAllowed: false,
    runtimeReportGenerated: run.reportGeneratedBy === 'qa-agent-runtime',
    assetContract,
    forbiddenActions: running
      ? ['manual-report.write', 'pass.claim-before-run-complete']
      : ['ui.execute', 'manual-report.write', 'pass.claim', 'operation-candidate.fabricate'],
  };
  if (mode === 'replay' && run.operationPlanId) {
    const task = readTask(projectRoot, run.moduleId, run.taskId);
    const operationPlan = readOperation(projectRoot, task, run.operationPlanId);
    const cursor = run.replayCursor ?? 0;
    return {
      ...common,
      planningAllowed: false,
      sourceReviewAllowed: false,
      strictStepOrder: true,
      operationPlan,
      nextOperationStep: operationPlan.steps[cursor],
      remainingOperationSteps: Math.max(0, operationPlan.steps.length - cursor),
      checkpoints: operationPlan.checkpoints ?? [],
      next: running
        ? (operationPlan.steps[cursor] ? `Execute OperationPlan step ${operationPlan.steps[cursor]!.id}.` : 'Record declared assertions and cleanup, then run complete.')
        : run.reportGeneratedBy === 'qa-agent-runtime'
          ? `Stop UI execution. Inspect the Runtime report at ${run.reportPath}.`
          : run.conclusion,
    };
  }
  return {
    ...common,
    planningAllowed: true,
    sourceReviewAllowed: true,
    next: running
      ? 'Execute the approved exploratory flow and persist every UI action, screenshot, assertion, and cleanup.'
      : run.reportGeneratedBy === 'qa-agent-runtime'
        ? `Stop UI execution. Inspect the Runtime report at ${run.reportPath}. Do not write a separate report.`
        : run.conclusion,
  };
}

function addMemory(root: string, id: string, moduleId: string, title: string, content: string): ProjectMemory {
  assertSafeId(id, 'memory id');
  readModule(root, moduleId);
  const taskId = flag('--task'); if (taskId) readTask(root, moduleId, taskId);
  const result = createMemoryCandidate(root, {
    id, moduleId, taskId, type: flag('--type') ?? 'business_rule', title, content,
    scope: { environments: ['local'], platforms: ['web'], roles: ['default'] }, knowledgeLevel: 'observed', confidence: 0.7,
    importance: 'medium', source: { type: 'user_input', reference: 'qa-agent memory add' },
  });
  if (result.conflicts.length) console.error(`qa-agent: candidate conflicts with active memory: ${result.conflicts.join(', ')}`);
  return result.memory;
}

function root(): string { return requireProjectRoot(); }

function bootstrapFromFlags(projectRoot: string): void {
  const risk = flag('--risk');
  if (risk && !['low', 'medium', 'high', 'critical'].includes(risk)) throw new Error('--risk must be low, medium, high, or critical.');
  output(bootstrapWorkflow(projectRoot, {
    request: requiredFlag('--request'), moduleId: requiredFlag('--module'), taskId: requiredFlag('--task'),
    moduleName: flag('--module-name'), taskName: flag('--task-name'), platforms: listFlag('--platforms'),
    riskLevel: risk as 'low' | 'medium' | 'high' | 'critical' | undefined,
  }));
}

function archiveTask(projectRoot: string, moduleId: string, taskId: string): void {
  const task = readTask(projectRoot, moduleId, taskId);
  const completeness = inspectTaskArchive(projectRoot, task);
  if (!completeness.valid) {
    output({ archived: false, taskDirectory: completeness.taskDirectory, completeness, task });
    process.exitCode = 1;
    return;
  }
  task.metadata.status = 'archived'; task.metadata.version += 1; task.updatedAt = now(); saveTask(projectRoot, task); rebuildIndexes(projectRoot);
  output({ ...task, archive: completeness });
}

function generateOperationPlan(projectRoot: string, moduleId: string, taskId: string): void {
  const task = readTask(projectRoot, moduleId, taskId);
  const requestedRunId = flag('--run');
  const requestedScenario = flag('--scenario');
  let run: TestRun;
  if (requestedRunId) {
    run = readRunById(projectRoot, requestedRunId);
  } else {
    const runPaths = listFiles(join(taskDirectory(projectRoot, moduleId, taskId), 'runs'), path => path.endsWith('/run.json'));
    const runs = runPaths.map(path => readJson<TestRun>(path)).filter(item => item.moduleId === moduleId && item.taskId === taskId);
    run = runs.sort((left, right) => (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt))[0]!;
  }
  if (!run) throw new Error('No Run was found for this Task. Complete a successful exploratory Run before generating an OperationPlan.');
  if (run.moduleId !== moduleId || run.taskId !== taskId) throw new Error(`Run ${run.id} does not belong to ${moduleId}/${taskId}.`);
  if (!['passed', 'adapted'].includes(run.status) || !run.completedAt) throw new Error(`Run ${run.id} is not a completed successful Run; OperationPlan generation requires status passed or adapted.`);
  if (run.replayStatus === 'replayed') throw new Error(`Run ${run.id} is already a replay Run; generate the OperationPlan from the original successful exploratory Run.`);
  if (requestedScenario && !task.scenarios.some(scenario => scenario.id === requestedScenario)) throw new Error(`Scenario ${requestedScenario} was not found in Task ${taskId}.`);

  const existing = listOperations(projectRoot, task).filter(plan => plan.sourceRunId === run.id && (!requestedScenario || plan.scenarioId === requestedScenario));
  if (existing.length) {
    output({ command: 'operation generate', generated: false, approvalRequired: true, runId: run.id, operationCandidates: existing.map(plan => plan.id), operationCandidateIssues: run.operationCandidateIssues ?? [], next: 'Present these OperationPlan candidates to the user. After approval, run qa-agent test for a real regression check, then qa-agent archive.' });
    return;
  }

  const result = createOperationCandidates(projectRoot, task, run, { scenarioId: requestedScenario });
  run.operationCandidates = [...new Set([...(run.operationCandidates ?? []), ...result.candidates])];
  run.operationCandidateIssues = result.issues.length ? result.issues : undefined;
  saveRun(projectRoot, run); task.updatedAt = now(); saveTask(projectRoot, task); rebuildIndexes(projectRoot);
  output({ command: 'operation generate', generated: result.candidates.length > 0, approvalRequired: result.candidates.length > 0, runId: run.id, operationCandidates: result.candidates, operationCandidateIssues: result.issues, next: result.candidates.length ? 'Present the candidates and request explicit approval. After approval, run qa-agent test for a real regression check, then qa-agent archive.' : 'Fix the listed replay contract issues, complete a valid successful Run, and run operation generate again.' });
}

async function main(): Promise<void> {
  const [group, action, subject] = args;
  if (!group || group === '--help' || group === '-h' || group === 'help') return output(usage);
  if (group === '--version' || group === '-v' || group === 'version') return output(packageMetadata.version);
  if (group === 'init') {
    const projectRoot = process.cwd(); const projectFile = join(projectRoot, '.qa-agent', 'project.json');
    const initialized = existsSync(projectFile);
    const project = initialized ? readProject(projectRoot) : initializeProject(projectRoot, { id: flag('--id'), name: flag('--name'), description: flag('--description'), platforms: listFlag('--platforms') });
    const requestedHosts = hostsFromFlags(args); const selectedHosts = requestedHosts.length ? requestedHosts : (process.stdin.isTTY && process.stdout.isTTY ? detectConfiguredHosts(projectRoot) : []);
    const managedHosts = Object.keys(configuredHostRecords(projectRoot));
    const hosts = args.includes('--force') ? selectedHosts : selectedHosts.filter(host => !managedHosts.includes(host));
    const integrations = hosts.map(host => { const result = installHostIntegration({ host, projectPath: projectRoot, scope: 'project', force: args.includes('--force') }); recordHostInstall(projectRoot, result); return result; });
    output({ message: initialized ? 'QA project already initialized' : 'Initialized .qa-agent', project: project.project, path: qaPath(projectRoot), hosts, integrations }); return;
  }
  if (group === 'configure') {
    const projectPath = resolve(requiredFlag('--project'));
    const host = requiredFlag('--host');
    if (!supportedHosts.includes(host as typeof supportedHosts[number])) throw new Error(`Host is required and must be one of: ${supportedHosts.join(', ')}.`);
    const projectFile = join(projectPath, '.qa-agent', 'project.json');
    const initialized = !existsSync(projectFile);
    const project = initialized ? initializeProject(projectPath, { id: flag('--id'), name: flag('--name'), description: flag('--description'), platforms: listFlag('--platforms') }) : undefined;
    const hostScope = flag('--scope') as 'project' | 'user' | undefined;
    const hostIntegration = installHostIntegration({ host: host as typeof supportedHosts[number], projectPath, path: flag('--path'), scope: hostScope, force: args.includes('--force') });
    const effectiveScope = hostScope ?? (host === 'codex' ? 'user' : 'project');
    if (effectiveScope === 'project') recordHostInstall(projectPath, hostIntegration);
    output({ projectPath, projectInitialized: initialized, project: project?.project, projectDataPath: join(projectPath, '.qa-agent'), hostIntegration }); return;
  }
  if (group === 'install-skill') {
    const result = installHostIntegration({ host: 'codex', path: flag('--path'), force: args.includes('--force') });
    output({ message: result.message, path: result.paths[0] }); return;
  }
  if (group === 'install-host') {
    if (!action || !supportedHosts.includes(action as typeof supportedHosts[number])) throw new Error(`Host is required and must be one of: ${supportedHosts.join(', ')}.`);
    const scope = flag('--scope');
    if (scope && scope !== 'project' && scope !== 'user') throw new Error('--scope must be project or user.');
    const projectPath = flag('--project'); const result = installHostIntegration({ host: action as typeof supportedHosts[number], projectPath, path: flag('--path'), scope: scope as 'project' | 'user' | undefined, force: args.includes('--force') });
    const effectiveScope = scope ?? (action === 'codex' ? 'user' : 'project');
    if (effectiveScope === 'project' && projectPath) recordHostInstall(resolve(projectPath), result);
    output(result); return;
  }
  if (group === 'doctor') {
    const projectRoot = findProjectRoot();
    if (!projectRoot) return output({ ok: false, message: 'No QA project found. Run qa-agent init.' });
    const available = availableCapabilities(projectRoot);
    output({ ok: true, projectRoot, availableCapabilities: available, notes: available.includes('browser.interact') ? [] : capabilityAdvice(['browser.interact']) }); return;
  }
  if (group === 'update') {
    const projectRoot = root();
    const promptPaths = syncProjectPrompts(projectRoot);
    const migration = args.includes('--migrate') ? migrateProjectArtifacts(projectRoot) : undefined;
    const hostUpdate = updateHostIntegrations(projectRoot, { force: args.includes('--force'), migrate: args.includes('--migrate') });
    writeJsonAtomic(qaPath(projectRoot, '.version'), { version: packageMetadata.version, updatedAt: now() });
    output({ projectRoot, prompts: promptPaths, migration, hostUpdate, migrated: args.includes('--migrate'), next: hostUpdate.conflicts.length ? 'Review conflicts or rerun qa-agent update --force.' : 'Project templates are current.' }); return;
  }
  if (group === 'start') { bootstrapFromFlags(root()); return; }
  if (group === 'test') {
    const projectRoot = root(); const moduleId = requiredFlag('--module'); const taskId = requiredFlag('--task'); const task = readTask(projectRoot, moduleId, taskId);
    const requestedScenario = flag('--scenario');
    const active = listFiles(join(qaPath(projectRoot, 'modules'), moduleId, 'tasks', taskId, 'operation-plans'), path => /\/v\d+\.json$/.test(path))
      .map(path => readJson<{ id: string; status: string; scenarioId: string; planHash: string; version: number }>(path))
      .filter(plan => plan.status === 'active' && plan.planHash === testPlanHash(task) && (!requestedScenario || plan.scenarioId === requestedScenario));
    if (!requestedScenario && active.length > 1) throw new Error('Multiple active OperationPlans exist; specify --scenario to select one.');
    const operation = active[0];
    const started = beginAgentGuidedRun(projectRoot, task, { ...runContextFromFlags(), operationId: operation?.id, scenarioId: operation?.scenarioId ?? requestedScenario });
    rebuildIndexes(projectRoot);
    output({ ...executionEnvelope(projectRoot, started), mode: operation ? 'replay' : 'explore', workflow: workflowStatus(projectRoot, moduleId, taskId), canonicalPrompts: readProjectPromptBundle(projectRoot) });
    return;
  }
  if (group === 'archive') { archiveTask(root(), requiredFlag('--module'), requiredFlag('--task')); return; }
  if (group === 'workflow') {
    const projectRoot = root();
    const moduleId = requiredFlag('--module');
    const taskId = requiredFlag('--task');
    if (action === 'bootstrap') {
      bootstrapFromFlags(projectRoot); return;
    }
    if (action === 'status') { output(workflowStatus(projectRoot, moduleId, taskId)); return; }
    throw new Error(`Unsupported command.

${usage}`);
  }
  if (group === 'host') {
    const projectRoot = root(); const path = qaPath(projectRoot, 'mcp.json');
    const config = readJson<{ version: number; connections: Array<{ id: string; capabilities: string[]; status: 'available' | 'unavailable'; permissionStatus?: PermissionStatus; version?: string; host?: string; attestedAt?: string }> }>(path);
    if (action === 'list') { output(config.connections); return; }
    if (action === 'doctor') {
      if (flag('--platform')) { output(hostCapabilityDiagnosis(projectRoot, requiredFlag('--platform'))); return; }
      const checks = config.connections.map(connection => ({ id: connection.id, status: connection.status, permissionStatus: connection.permissionStatus ?? 'unknown', attestedAt: connection.attestedAt, healthy: connection.status === 'available' && connection.capabilities.length > 0 && connection.permissionStatus === 'verified', issue: connection.status !== 'available' ? 'host did not attest this tool as available' : !connection.capabilities.length ? 'no capabilities declared by host' : connection.permissionStatus !== 'verified' ? 'host did not attest required permissions as verified' : undefined }));
      output({ healthy: checks.length > 0 && checks.every(check => check.healthy), connections: checks }); return;
    }
    if (action === 'attest') {
      const id = requiredFlag('--id'); assertSafeId(id, 'host connection id');
      const capabilities = listFlag('--capabilities');
      if (!capabilities?.length) throw new Error('--capabilities requires at least one verified host capability.');
      const permissionStatus = requiredFlag('--permission-status') as PermissionStatus;
      if (!['verified', 'missing', 'unknown'].includes(permissionStatus)) throw new Error('--permission-status must be verified, missing, or unknown.');
      const connection = {
        id,
        capabilities,
        status: 'available' as const,
        permissionStatus,
        version: flag('--version'),
        host: flag('--host') ?? 'host-agent',
        attestedAt: now(),
      };
      config.connections = [...config.connections.filter(item => item.id !== id), connection];
      writeJsonAtomic(path, config);
      output({
        connection,
        warning: 'Attestation is a host claim. Use verified only after the host has confirmed the tool exists and required OS permissions are granted.',
        next: permissionStatus === 'verified' ? 'Run host doctor for the target platform, then retry task explore or operation replay.' : 'Resolve missing or unknown permissions before UI execution.',
      });
      return;
    }
    if (action !== 'import') throw new Error('Host command must be list, attest, import, or doctor.');
    const snapshot = readJson<{ host?: string; collectedAt?: string; connections?: Array<{ id: string; capabilities: string[]; status?: 'available' | 'unavailable'; permissionStatus?: PermissionStatus; version?: string }> }>(requiredFlag('--file'));
    if (!Array.isArray(snapshot.connections) || snapshot.connections.some(connection => !connection.id || !Array.isArray(connection.capabilities))) throw new Error('Host capability snapshot requires a connections array with id and capabilities.');
    config.connections = snapshot.connections.map(connection => ({ id: connection.id, capabilities: [...new Set(connection.capabilities)], status: connection.status ?? 'available', permissionStatus: connection.permissionStatus ?? 'unknown', version: connection.version, host: snapshot.host, attestedAt: snapshot.collectedAt ?? now() }));
    writeJsonAtomic(path, config); output(config); return;
  }
  if (group === 'operation') {
    if (action === 'generate') {
      generateOperationPlan(root(), requiredFlag('--module'), requiredFlag('--task')); return;
    }
    if (action !== 'replay') throw new Error(`Unsupported command.\n\n${usage}`);
    const projectRoot = root();
    if (!subject || subject.startsWith('--')) throw new Error('OperationPlan id or Task-relative JSON ref is required.');
    const moduleId = requiredFlag('--module');
    const taskId = requiredFlag('--task');
    const task = readTask(projectRoot, moduleId, taskId);
    const operationPlan = readOperation(projectRoot, task, subject);
    const started = beginAgentGuidedRun(projectRoot, task, { ...runContextFromFlags(), operationId: operationPlan.id, scenarioId: operationPlan.scenarioId });
    rebuildIndexes(projectRoot);
    output({ ...executionEnvelope(projectRoot, started), canonicalPrompts: readProjectPromptBundle(projectRoot) });
    return;
  }
  if (group === 'impact') {
    if (action !== 'analyze') throw new Error(`Unsupported command.

${usage}`);
    const analysis = analyzeProjectImpact(root(), { base: flag('--base'), head: flag('--head'), changedFiles: listFlag('--changed-files') });
    output(analysis); return;
  }
  if (group === 'release') {
    const projectRoot = root();
    if (action === 'list') {
      const checks = listFiles(qaPath(projectRoot, 'release-checks'), path => path.endsWith('.json')).map(path => readJson<ReleaseCheck>(path)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      output(checks); return;
    }
    if (action === 'check') {
      const profile = regressionProfile();
      const impact = analyzeProjectImpact(projectRoot, { base: flag('--base'), head: flag('--head'), changedFiles: listFlag('--changed-files') });
      const suite = buildReleaseRegressionSuite(projectRoot, impact, profile);
      const check = createReleaseCheck(suite, impact, profile);
      saveReleaseCheck(projectRoot, check);
      writeReleaseReport(projectRoot, check);
      if (args.includes('--plan-only')) { output(check); return; }
      const first = suite.members[0];
      if (!first) {
        if (check.releaseDecision === 'pending') { check.status = 'blocked'; check.releaseDecision = 'review'; }
        check.updatedAt = now();
        saveReleaseCheck(projectRoot, check); writeReleaseReport(projectRoot, check); output(check); return;
      }
      const task = readTask(projectRoot, first.moduleId, first.taskId);
      const context = buildExecutionSnapshot(projectRoot, task, { environment: flag('--environment'), platform: flag('--platform'), role: flag('--role'), device: flag('--device'), deviceModel: flag('--device-model'), osVersion: flag('--os-version'), appVersion: flag('--app-version'), webBuild: flag('--web-build'), testDataFingerprint: flag('--test-data-fingerprint') });
      const regressionRun = beginRegressionRun(projectRoot, suite, context);
      attachRegressionRun(check, regressionRun);
      if (!['running', 'pending'].includes(regressionRun.status)) finalizeReleaseCheck(check, regressionRun);
      saveReleaseCheck(projectRoot, check); writeReleaseReport(projectRoot, check, regressionRun); rebuildIndexes(projectRoot);
      output({ releaseCheck: check, regressionRun }); return;
    }
    if (!subject) throw new Error('release check id is required.');
    const check = readReleaseCheck(projectRoot, subject);
    if (action === 'show') { output(check); return; }
    if (action === 'report') { output(qaPath(projectRoot, 'reports', `${check.id}.md`)); return; }
    if (action === 'complete') {
      if (!check.regressionRunId) throw new Error(`Release check ${check.id} has no regression run.`);
      const regressionRun = readJson<RegressionRun>(qaPath(projectRoot, 'regression-runs', `${check.regressionRunId}.json`));
      const completed = completeRegressionRun(projectRoot, regressionRun);
      attachRegressionRun(check, completed);
      if (!['running', 'pending'].includes(completed.status)) finalizeReleaseCheck(check, completed);
      saveReleaseCheck(projectRoot, check); writeReleaseReport(projectRoot, check, completed); rebuildIndexes(projectRoot);
      output({ releaseCheck: check, regressionRun: completed }); return;
    }
    throw new Error(`Unsupported command.

${usage}`);
  }
  if (group === 'validate') {
    const result = validateProject(root()); output(result); if (!result.valid) process.exitCode = 1; return;
  }
  if (group === 'migrate') {
    const projectRoot = root();
    const result = migrateProjectArtifacts(projectRoot);
    rebuildIndexes(projectRoot);
    output({ ...result, validation: validateProject(projectRoot) });
    return;
  }
  if (group === 'context' && action === 'module') {
    if (!subject) throw new Error('module id is required.');
    const projectRoot = root();
    const module = readModule(projectRoot, subject);
    const memories = readIndex<ProjectMemory>(projectRoot, 'memories').filter(memory => !memory.moduleId || memory.moduleId === subject).filter(memory => memory.status === 'active');
    const tasks = readIndex<{ moduleId: string }>(projectRoot, 'tasks').filter(task => task.moduleId === subject);
    output({ project: readProject(projectRoot), module, canonicalPrompts: readProjectPromptBundle(projectRoot), memories, tasks, skills: readIndex(projectRoot, 'skills'), capabilities: availableCapabilities(projectRoot), policy: readJson(qaPath(projectRoot, 'policies.json')) }); return;
  }
  if (group === 'index' && action === 'rebuild') { output(rebuildIndexes(root())); return; }
  if (group === 'prompts' && action === 'sync') { output({ prompts: syncProjectPrompts(root()) }); return; }
  if (group === 'module') {
    const projectRoot = root();
    if (action === 'list') return output(readIndex(projectRoot, 'modules'));
    if (action === 'create') {
      if (!subject) throw new Error('module id is required.');
      const module = createModule(projectRoot, { id: subject, name: requiredFlag('--name'), description: flag('--description') ?? '', platforms: listFlag('--platforms'), riskLevel: (flag('--risk') as 'low' | 'medium' | 'high' | 'critical' | undefined), sourceHints: listFlag('--source-hints'), entryPoints: listFlag('--entry-points'), dependencies: listFlag('--dependencies') });
      rebuildIndexes(projectRoot); output(module); return;
    }
    if (action === 'plan') {
      if (!subject) throw new Error('module id is required.');
      const planned = planModule(readModule(projectRoot, subject), readIndex<{ id: string; moduleId: string }>(projectRoot, 'tasks').filter(task => task.moduleId === subject).map(task => task.id), readIndex<ProjectMemory>(projectRoot, 'memories').filter(memory => memory.moduleId === subject));
      output({ moduleId: subject, suggestions: planned, note: 'Planning is non-mutating. Create reviewed tasks explicitly.' }); return;
    }
    if (action === 'coverage') {
      if (!subject) throw new Error('module id is required.');
      const tasks = readIndex<{ id: string; moduleId: string }>(projectRoot, 'tasks').filter(task => task.moduleId === subject);
      const memories = readIndex<ProjectMemory>(projectRoot, 'memories').filter(memory => memory.moduleId === subject);
      const dimensions = planModule(readModule(projectRoot, subject), tasks.map(task => task.id), memories).map(item => ({ dimension: item.dimension, taskId: item.id, status: item.exists ? 'covered' : 'not_covered', reason: item.reason }));
      output({ moduleId: subject, coverage: dimensions, summary: { covered: dimensions.filter(item => item.status === 'covered').length, total: dimensions.length } }); return;
    }
    if (action === 'update' || action === 'archive') {
      if (!subject) throw new Error('module id is required.');
      const module = readModule(projectRoot, subject);
      if (action === 'update') {
        module.name = flag('--name') ?? module.name; module.description = flag('--description') ?? module.description;
        const risk = flag('--risk'); if (risk) { if (!['low', 'medium', 'high', 'critical'].includes(risk)) throw new Error('--risk must be low, medium, high, or critical.'); module.riskLevel = risk as typeof module.riskLevel; }
        const sourceHints = listFlag('--source-hints'); if (sourceHints) module.sourceHints = sourceHints;
        const entryPoints = listFlag('--entry-points'); if (entryPoints) module.entryPoints = entryPoints;
        const dependencies = listFlag('--dependencies'); if (dependencies) module.dependencies = dependencies;
      } else module.status = 'archived';
      module.revision = (module.revision ?? 1) + 1; module.updatedAt = now(); writeJsonAtomic(join(modulePath(projectRoot, subject), 'module.json'), module); rebuildIndexes(projectRoot); output(module); return;
    }
  }
  if (group === 'task') {
    const projectRoot = root();
    if (action === 'list') return output(readIndex(projectRoot, 'tasks'));
    const moduleId = requiredFlag('--module');
    if (!subject) throw new Error('task id is required.');
    if (action === 'create') {
      const task = applyTaskRegressionMetadata(createTaskSkeleton(readModule(projectRoot, moduleId), subject, flag('--name')));
      saveTask(projectRoot, task); rebuildIndexes(projectRoot); output(task); return;
    }
    if (action === 'update') {
      const task = applyTaskRegressionMetadata(readTask(projectRoot, moduleId, subject));
      const name = flag('--name'); if (name) task.metadata.name = name;
      saveTask(projectRoot, task); rebuildIndexes(projectRoot); output(task); return;
    }
    const nestedAction = action === 'operation' || action === 'regression' ? subject : undefined;
    const taskId = nestedAction ? (flag('--task') ?? args[3]) : subject;
    if (!taskId || taskId.startsWith('--')) throw new Error('task id is required for operation/regression commands.');
    const task = readTask(projectRoot, moduleId, taskId);
    if (action === 'plan') return output(taskPlan(task));
    if (action === 'operation') {
      const operationAction = ['generate', 'list', 'show', 'review'].includes(subject ?? '') ? subject : args[3];
      if (operationAction === 'generate') { generateOperationPlan(projectRoot, moduleId, taskId); return; }
      if (operationAction === 'list') return output(operationSummary(projectRoot, task));
      if (operationAction === 'show') return output(readOperation(projectRoot, task, requiredFlag('--operation')));
      if (operationAction === 'review') {
        const approve = args.includes('--approve'); const reject = args.includes('--reject');
        if (approve === reject) throw new Error('Specify exactly one of --approve or --reject.');
        const reviewed = reviewOperation(projectRoot, task, requiredFlag('--operation'), approve ? 'approve' : 'reject'); if (approve) syncTaskRegressionSuite(projectRoot, task); rebuildIndexes(projectRoot); return output(reviewed);
      }
      throw new Error('Operation action must be list, show, or review.');
    }
    if (action === 'regression') {
      const regressionAction = ['sync', 'show', 'run', 'complete'].includes(subject ?? '') ? subject : args[3];
      if (regressionAction === 'sync') return output(syncTaskRegressionSuite(projectRoot, task));
      if (regressionAction === 'show') return output(readTaskRegressionSuite(projectRoot, task));
      if (regressionAction === 'run') {
        const suite = readTaskRegressionSuite(projectRoot, task); const context = buildExecutionSnapshot(projectRoot, task, { environment: flag('--environment'), platform: flag('--platform'), role: flag('--role'), scenarioId: flag('--scenario'), device: flag('--device'), deviceModel: flag('--device-model'), osVersion: flag('--os-version'), appVersion: flag('--app-version'), webBuild: flag('--web-build'), testDataFingerprint: flag('--test-data-fingerprint') });
        const started = beginRegressionRun(projectRoot, suite, context); rebuildIndexes(projectRoot); return output(started);
      }
      if (regressionAction === 'complete') { const regressionRun = readJson<RegressionRun>(qaPath(projectRoot, 'regression-runs', `${requiredFlag('--run')}.json`)); const completed = completeRegressionRun(projectRoot, regressionRun); rebuildIndexes(projectRoot); return output(completed); }
      throw new Error('Regression action must be sync, show, or run.');
    }
    if (action === 'review') {
      if (!args.includes('--approve')) throw new Error('Task review requires --approve after verifying scope, business logic, scenarios, evidence, and safety stops.');
      const confirmedBy = requiredFlag('--confirmed-by'); assertHumanApprover(confirmedBy);
      const confirmationSource = flag('--confirmation-source') ?? 'current-chat-explicit-approval';
      if (!['current-chat-explicit-approval', 'external-review-record'].includes(confirmationSource)) throw new Error('--confirmation-source must be current-chat-explicit-approval or external-review-record.');
      if (!task.scenarios.length) throw new Error('A task needs at least one scenario before approval.');
      if (task.scenarios.some(scenario => !scenario.intent || !Object.keys(scenario.expected ?? {}).length || !(scenario.visualAssertions?.length))) throw new Error('Task review requires every Scenario to declare business intent, expected result, and visual assertions.');
      task.metadata.status = 'ready'; task.metadata.approval = { confirmedBy, confirmedAt: now(), confirmationSource: confirmationSource as 'current-chat-explicit-approval' | 'external-review-record', statement: 'User confirmed the generated test cases and business logic before execution.', planHash: testPlanHash(task) }; task.metadata.version += 1; task.updatedAt = now(); saveTask(projectRoot, task); rebuildIndexes(projectRoot); output(task); return;
    }
    if (action === 'archive') {
      archiveTask(projectRoot, moduleId, taskId); return;
    }
    if (action === 'explore') {
      if (flag('--operation')) throw new Error('task explore does not accept --operation. Use operation replay for an active OperationPlan.');
      const started = beginAgentGuidedRun(projectRoot, task, { ...runContextFromFlags(), operationId: undefined });
      rebuildIndexes(projectRoot);
      const workflow = workflowStatus(projectRoot, moduleId, taskId);
      output({ ...executionEnvelope(projectRoot, started), workflow, canonicalPrompts: readProjectPromptBundle(projectRoot) });
      return;
    }
    if (action === 'run') {
      const started = beginAgentGuidedRun(projectRoot, task, runContextFromFlags());
      rebuildIndexes(projectRoot);
      const workflow = workflowStatus(projectRoot, moduleId, taskId);
      output({ ...executionEnvelope(projectRoot, started), workflow, canonicalPrompts: readProjectPromptBundle(projectRoot), compatibilityNote: 'task run is retained for compatibility. Use task explore for first execution and operation replay for fast regression.' });
      return;
    }
  }
  if (group === 'memory') {
    const projectRoot = root();
    if (action === 'list') return output(readIndex(projectRoot, 'memories'));
    if (action === 'search') {
      if (!subject) throw new Error('search text is required.');
      const query = subject.toLowerCase(); return output(readIndex<Record<string, unknown>>(projectRoot, 'memories').filter(item => JSON.stringify(item).toLowerCase().includes(query)));
    }
    if (action === 'add') {
      if (!subject) throw new Error('memory id is required.');
      const memory = addMemory(projectRoot, subject, requiredFlag('--module'), requiredFlag('--title'), requiredFlag('--content'));
      rebuildIndexes(projectRoot); output(memory); return;
    }
    if (action === 'review') {
      if (!subject) throw new Error('memory id is required.');
      const approve = args.includes('--approve'); const reject = args.includes('--reject');
      if (approve === reject) throw new Error('Specify exactly one of --approve or --reject.');
      const memory = reviewMemory(projectRoot, requiredFlag('--module'), subject, approve ? 'approve' : 'reject', (flag('--knowledge-level') as ProjectMemory['knowledgeLevel'] | undefined) ?? 'confirmed', flag('--task'));
      rebuildIndexes(projectRoot); output(memory); return;
    }
  }
  if (group === 'run') {
    if (!['show', 'report', 'step', 'evidence', 'cleanup', 'recover', 'observe', 'complete'].includes(action ?? '')) throw new Error(`Unsupported command.\n\n${usage}`);
    const projectRoot = root();
    if (!subject) throw new Error('run id is required. Start a Task with task run TASK --module MODULE.');
    const run = readRunById(projectRoot, subject);
    if (action === 'show') return output(run);
    if (action === 'report') { const current = taskRunReportPath(projectRoot, run.moduleId, run.taskId, subject); const legacy = join(modulePath(projectRoot, run.moduleId), 'tasks', run.taskId, 'reports', `${subject}.md`); return output(existsSync(current) || !existsSync(legacy) ? current : legacy); }
    if (action === 'step') {
      const executionMode = (flag('--execution-mode') ?? 'host-automated') as StepExecutionMode;
      if (!['host-automated', 'user-assisted', 'system-component-blocked', 'preseeded-test-data'].includes(executionMode)) throw new Error('--execution-mode is invalid.');
      const updated = recordAgentStep(projectRoot, subject, { action: requiredFlag('--action'), operationAction: flag('--operation-action') as 'launch' | 'navigate' | 'click' | 'input' | 'fill' | 'swipe' | 'back' | 'wait' | 'assert' | 'screenshot' | 'reset' | 'restart-app' | undefined, safetyAction: flag('--safety-action'), detail: requiredFlag('--detail'), screenshotPath: requiredFlag('--screenshot'), status: (flag('--status') as RunStatus | undefined) ?? 'passed', visualInspection: (flag('--visual-inspection') as 'performed' | 'not-required' | 'not-applicable' | 'skipped' | undefined) ?? 'not-required', executionMode, operationStepId: flag('--operation-step'), scenarioId: flag('--scenario'), locator: locatorFromFlags(), actualLocator: locatorFromFlags('actual-'), inputRefs: recordFlag('--input-refs'), expectedState: flag('--expected-state'), actualState: flag('--actual-state'), adaptation: flag('--adaptation') });
      output(executionEnvelope(projectRoot, updated)); return;
    }
    if (action === 'evidence') {
      const updated = recordHostEvidence(projectRoot, subject, { type: requiredFlag('--type'), summary: requiredFlag('--summary'), artifactPath: flag('--file') });
      output(executionEnvelope(projectRoot, updated)); return;
    }
    if (action === 'cleanup') {
      const updated = recordCleanupFinding(projectRoot, subject, { scenarioId: requiredFlag('--scenario'), cleanup: requiredFlag('--cleanup'), actual: requiredFlag('--actual'), status: requiredFlag('--status') as RunStatus, screenshotPath: flag('--screenshot') });
      output(executionEnvelope(projectRoot, updated)); return;
    }
    if (action === 'recover') {
      const updated = recordRecoveryAttempt(projectRoot, subject, { action: requiredFlag('--action'), reason: requiredFlag('--reason'), detail: requiredFlag('--detail'), outcome: requiredFlag('--outcome') as 'continued' | 'blocked' | 'paused' | 'failed', failedStepId: flag('--failed-step') });
      output(executionEnvelope(projectRoot, updated)); return;
    }
    if (action === 'observe') {
      const updated = recordVisualFinding(projectRoot, subject, { scenarioId: requiredFlag('--scenario'), assertionId: requiredFlag('--assertion'), expected: requiredFlag('--expected'), actual: requiredFlag('--actual'), status: requiredFlag('--status') as RunStatus, screenshotPath: flag('--screenshot'), inspectionProvider: flag('--inspection-provider') });
      output(executionEnvelope(projectRoot, updated)); return;
    }
    if (action === 'complete') {
      const updated = completeAgentGuidedRun(projectRoot, readTask(projectRoot, (run as { moduleId: string }).moduleId, (run as { taskId: string }).taskId), subject);
      rebuildIndexes(projectRoot); output(executionEnvelope(projectRoot, updated)); return;
    }
  }
  if (group === 'module' && action === 'regression') {
    const projectRoot = root();
    const regressionAction = subject;
    const moduleId = args[3];
    if (!['show', 'run', 'complete'].includes(regressionAction ?? '')) throw new Error(`Unsupported command.\n\n${usage}`);
    if (!moduleId || moduleId.startsWith('--')) throw new Error('module id is required.');
    if (regressionAction === 'show') return output(buildModuleRegressionSuite(projectRoot, moduleId, priorityValue() ?? 'p3'));
    if (regressionAction === 'run') {
      const suite = buildModuleRegressionSuite(projectRoot, moduleId, priorityValue() ?? 'p3'); const first = suite.members[0]; if (!first) throw new Error(`Module ${moduleId} has no active OperationPlan.`);
      const task = readTask(projectRoot, moduleId, first.taskId); const context = buildExecutionSnapshot(projectRoot, task, { environment: flag('--environment'), platform: flag('--platform'), role: flag('--role'), device: flag('--device'), deviceModel: flag('--device-model'), osVersion: flag('--os-version'), appVersion: flag('--app-version'), webBuild: flag('--web-build'), testDataFingerprint: flag('--test-data-fingerprint') });
      const started = beginRegressionRun(projectRoot, suite, context); rebuildIndexes(projectRoot); return output(started);
    }
    if (regressionAction === 'complete') { const regressionRun = readJson<RegressionRun>(qaPath(projectRoot, 'regression-runs', `${requiredFlag('--run')}.json`)); const completed = completeRegressionRun(projectRoot, regressionRun); rebuildIndexes(projectRoot); return output(completed); }
    throw new Error('Module regression action must be show, run, or complete.');
  }
  if (group === 'skill') {
    const skillRoot = join(process.cwd(), 'skill', 'qa-agent');
    const projectRoot = findProjectRoot();
    if (action === 'list') return output(projectRoot ? readIndex(projectRoot, 'skills') : [{ name: 'qa-agent', path: skillRoot }]);
    if (action === 'validate') { const result = validateSkill(skillRoot); output(result); if (!result.valid) process.exitCode = 1; return; }
  }
  throw new Error(`Unsupported command.\n\n${usage}`);
}

main().catch(error => { console.error(`qa-agent: ${(error as Error).message}`); process.exitCode = 1; });
