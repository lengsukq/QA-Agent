#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { availableCapabilities, capabilityAdvice, platformCapabilities } from './capabilities.ts';
import { approveGuidedAction, beginAgentGuidedRun, completeAgentGuidedRun, recordAgentStep, recordCleanupFinding, recordGuidedVerdict, recordHostEvidence, recordRecoveryAttempt, recordVisualFinding } from './engine.ts';
import { readIndex, rebuildIndexes } from './indexer.ts';
import { createTaskSkeleton, planModule, taskPlan } from './planning.ts';
import { createModule, findProjectRoot, initializeProject, modulePath, qaPath, readModule, readRunById, readTask, requireProjectRoot, saveRun, saveTask, taskDirectory, taskPrdPath, taskSourceRunReportPath } from './project.ts';
import { readProject } from './project.ts';
import { assertSafeId, listFiles, now, readJson, writeJsonAtomic } from './store.ts';
import type { ExecutionSnapshot, Locator, PermissionStatus, ProjectMemory, RegressionProfile, RegressionRun, ReleaseCheck, RunStatus, StepExecutionMode, TestPriority, TestRun, TestTask } from './types.ts';
import { validateProject, validateSkill } from './validation.ts';
import { createMemoryCandidate, reviewMemory } from './memory.ts';
import { configuredHostRecords, installHostIntegration, recordHostInstall, supportedHosts, updateHostIntegrations } from './host-adapters.ts';
import { detectConfiguredHosts, hostsFromFlags, HOST_PLATFORMS } from './host-configurators/registry.ts';
import { approvalIsCurrent, assertHumanApprover, invalidateApproval, isExplicitPlanRequirementsConfirmation, isExplicitStartConfirmation, PLAN_REQUIREMENTS_CONFIRMATION_ZH, planReviewIsCurrent, START_TEST_CONFIRMATION_ZH, testPlanHash } from './approval.ts';
import { hostCapabilityDiagnosis } from './capabilities.ts';
import { buildModuleRegressionSelection, buildReleaseRegressionSelection, buildTaskRegressionSelection, runRegressionSelection } from './regression.ts';
import { analyzeProjectImpact } from './impact-analysis.ts';
import { attachRegressionRun, createReleaseCheck, finalizeReleaseCheck, readReleaseCheck, saveReleaseCheck, writeReleaseReport } from './release.ts';
import { bootstrapWorkflow, workflowStatus } from './workflow.ts';
import { migrateProjectArtifacts } from './migration.ts';
import { inspectTaskArchive } from './archive.ts';
import { appendTaskEvent } from './events.ts';
import { normalizeTaskState, transitionTaskState } from './workflow-model.ts';
import { applyPlanDraft } from './plan-draft.ts';
import type { PlanDraft } from './types.ts';
import { prepareQuickCheck } from './quick.ts';
import { continueCurrentTask } from './continue.ts';
import { bindTaskSession, clearTaskSession, clearTaskSessionIfMatches, listTaskSessions, readTaskSession } from './session.ts';
import { finalizeTask } from './task-finalizer.ts';
import { finishCurrentTask } from './finish.ts';
import {
  createPythonRegressionDraft,
  listPythonRegressionDrafts,
  listPythonRegressions,
  publishPythonRegression,
  readPythonRegression,
  readPythonRegressionDraft,
  runPythonRegression,
  markPythonRegressionsStaleForPlanHash,
} from './python-regression.ts';
import { recommendedRegressionStackDiagnosis } from './recommended-stack.ts';
import { syncManagedRuntimeAssets } from './managed-assets.ts';
import { QA_AGENT_VERSION } from './version.ts';
import { planningPrdIsCurrent } from './task-prd.ts';

const args = process.argv.slice(2);
const hostFlags = supportedHosts.map(host => `--${HOST_PLATFORMS[host].cliFlag}`).join(' ');
const hostNames = supportedHosts.join('|');
const advancedUsage = `qa-agent — local-first QA Agent MVP

Commands:
  --help, -h, help | --version, -v, version
  init [--id ID] [--name NAME] [--description TEXT] [--platforms web,android,ios] [${hostFlags}] [--force]
  configure --project PROJECT_DIRECTORY --host <${hostNames}> [--scope project|user] [init options] [--force]
  install-skill [--path SKILLS_DIRECTORY] [--force]   (Codex compatibility alias)
  install-host <${hostNames}> [--scope project|user] [--project PROJECT_DIRECTORY] [--path SKILLS_DIRECTORY] [--force]
  doctor [--platforms web,ios] | validate | migrate | index rebuild
  update [--force] [--migrate]
  check --request TEXT [--mode quick|guided] [--module ID] [--task ID] [--session SESSION_KEY] [--platforms web,android,ios] [--risk low|medium|high|critical]
  continue [--session SESSION_KEY]
  finish [--session SESSION_KEY]
  plan apply --file PLAN_DRAFT.json | --stdin
  plan review --module MODULE --task TASK --approve --confirmed-by USER --confirmation-text "确认测试方案" [--session SESSION_KEY]
  start --request TEXT --module ID --task ID [--session SESSION_KEY] [--module-name NAME] [--task-name NAME] [--platforms web,android,ios] [--risk low|medium|high|critical]
  review --module MODULE --task TASK --approve --confirmed-by USER --confirmation-text "确认开始测试" [--session SESSION_KEY] [--confirmation-source current-chat-explicit-approval]
  test --module MODULE --task TASK [--session SESSION_KEY] [--scenario SCENARIO] [execution context flags]
  archive --module MODULE --task TASK
  Compatibility and administration:
  workflow bootstrap --request TEXT --module ID --task ID [--module-name NAME] [--task-name NAME] [--platforms web,android,ios] [--risk low|medium|high|critical]
  workflow status --module ID --task ID
  session bind --module MODULE --task TASK [--run RUN] [--session SESSION_KEY] [--session-host HOST] | session current|clear|list [--session SESSION_KEY]
  regression draft --module MODULE --task TASK --run RUN_ID --file SCRIPT.py [--id SCRIPT_ID] [--session SESSION_KEY] [--python PYTHON]
  regression drafts [--session SESSION_KEY] | regression draft-show DRAFT_ID [--session SESSION_KEY]
  regression publish --module MODULE --task TASK --draft DRAFT_ID --confirmed-by HUMAN [--confirmation-source current-chat-explicit-approval] [--replace] [--session SESSION_KEY]
  regression list --module MODULE --task TASK | regression show SCRIPT_ID --module MODULE --task TASK
  regression run SCRIPT_ID --module MODULE --task TASK [--python PYTHON] [--bridge HOST_BRIDGE] [--timeout-seconds N]
  impact analyze [--base REF] [--head REF] [--changed-files FILE1,FILE2]
  release check [--profile fast|normal|full] [--base REF] [--head REF] [--changed-files FILE1,FILE2] [--plan-only] [execution context flags]
  release list | release show|report CHECK_ID
  host list | host attest --id ID --capabilities CAP1,CAP2 --permission-status verified|missing|unknown [--host HOST] [--version VERSION] | host import --file HOST_CAPABILITIES.json | host doctor [--platform android|ios]
  context module MODULE
  module list | module create ID --name NAME [--description TEXT] [--platforms web,android,ios] [--source-hints PATHS] [--entry-points PATHS] [--dependencies MODULES] | module update ID [--name NAME] [--description TEXT] [--risk LEVEL] [same mapping flags] | module archive ID | module plan ID | module coverage ID
  task list | task create ID --module MODULE [metadata flags] | task update ID --module MODULE [metadata flags] | task plan|finalize|explore|run|review|archive ID --module MODULE | task regression show|run ID --module MODULE
  module regression show|run MODULE [--priority p0|p1|p2|p3]
  memory list | memory search TEXT | memory add ID --module MODULE [--task TASK] --title TEXT --content TEXT | memory review ID --module MODULE [--task TASK] --approve|--reject
  run guide-approve RUN --scenario ID [--planned-step STEP_ID | --action TEXT --expected TEXT] --confirmed-by HUMAN --confirmation-text TEXT
  run step RUN --action TEXT --detail TEXT --screenshot PATH [--ui-action launch|navigate|click|input|fill|swipe|back|wait|assert|screenshot|reset|restart-app] [--safety-action ACTION] [--scenario SCENARIO] [--status passed|failed|paused|blocked|adapted] [--visual-inspection performed|not-required|skipped] [--execution-mode host-automated|user-assisted|system-component-blocked|preseeded-test-data] [--locator-strategy STRATEGY] [--locator-value VALUE] [--actual-locator-strategy STRATEGY] [--actual-locator-value VALUE] [--input-refs key=ref,key=ref] [--expected-state TEXT] [--actual-state TEXT] [--adaptation TEXT]
  run evidence RUN --type TYPE --summary TEXT [--file PATH]
  run cleanup RUN --scenario ID --cleanup TEXT --actual TEXT --status passed|failed|blocked|paused|inconclusive [--screenshot PATH]
  run recover RUN --action wait|refresh|back|restart-app|reset-sandbox-data|reconnect-mcp|fallback-locator|resume-checkpoint --reason TEXT --detail TEXT --outcome continued|blocked|paused|failed [--failed-step STEP]
  run guide-verdict RUN --step STEP_ID --status passed|failed|blocked|paused|inconclusive|adapted --confirmed-by HUMAN --confirmation-text TEXT [--note TEXT]
  run observe RUN --scenario ID --assertion ID --expected TEXT --actual TEXT --status passed|failed|paused|blocked [--screenshot PATH]
  run complete RUN | run show RUN | run report RUN
  skill list | skill validate
`;

const usage = `QA Agent — simple project-aware testing

Common commands:
  init [host flags]       Initialize the current project
  check --request TEXT    Start or resume an ordinary QA check
  continue                Continue the active QA task
  finish                  End the current QA session
  doctor                  Check project and test-tool readiness
  update [--migrate]      Update managed integration files

In an Agent conversation, you normally only need to say what to test, “continue”, or “finish”.
Run qa-agent help --advanced for Python regression, release, and administration commands.
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

function runContextFromFlags(): Partial<ExecutionSnapshot> {
  return { environment: flag('--environment'), platform: flag('--platform'), role: flag('--role'), scenarioId: flag('--scenario'), device: flag('--device'), deviceModel: flag('--device-model'), osVersion: flag('--os-version'), appVersion: flag('--app-version'), webBuild: flag('--web-build'), testDataFingerprint: flag('--test-data-fingerprint') };
}

function executionEnvelope(run: TestRun): Record<string, unknown> {
  const running = run.status === 'running';
  const guidedPhase = run.guidedInteraction?.phase;
  const uiAllowed = running && (!guidedPhase || guidedPhase === 'ready_to_execute');
  const taskDirectory = `.qa-agent/modules/${run.moduleId}/tasks/${run.taskId}`;
  const runDirectory = `${taskDirectory}/source-run`;
  return {
    ...run,
    executionMode: 'explore',
    uiExecutionAllowed: uiAllowed,
    runId: running ? run.id : undefined,
    mustStop: !uiAllowed,
    manualReportAllowed: false,
    runtimeReportGenerated: run.reportGeneratedBy === 'qa-agent-runtime',
    assetContract: { taskDirectory, runDirectory, runJson: `${runDirectory}/run.json`, report: `${runDirectory}/report.md`, screenshotsDirectory: `${runDirectory}/screenshots/`, evidenceDirectory: `${runDirectory}/evidence/` },
    forbiddenActions: uiAllowed ? ['manual-report.write', 'pass.claim-before-run-complete'] : ['ui.execute', 'manual-report.write', 'pass.claim'],
    next: guidedPhase === 'awaiting_action_approval' ? 'Ask the QA to approve exactly one next action before using a UI tool.' : guidedPhase === 'awaiting_result_verdict' ? `Present step ${run.guidedInteraction?.pendingStepId} and ask the QA whether the observed result matches expectations.` : running ? 'Execute the approved business flow and persist every UI action, screenshot, assertion, and cleanup.' : run.reportGeneratedBy === 'qa-agent-runtime' ? `Stop UI execution. Inspect the Runtime report at ${run.reportPath}.` : run.conclusion,
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
  const state = bootstrapWorkflow(projectRoot, {
    request: requiredFlag('--request'), moduleId: requiredFlag('--module'), taskId: requiredFlag('--task'),
    moduleName: flag('--module-name'), taskName: flag('--task-name'), platforms: listFlag('--platforms'),
    riskLevel: risk as 'low' | 'medium' | 'high' | 'critical' | undefined,
  });
  const session = bindTaskSession(projectRoot, { sessionKey: flag('--session'), host: flag('--session-host'), moduleId: state.moduleId, taskId: state.taskId, runId: state.runId });
  output({ ...state, session });
}

function archiveTask(projectRoot: string, moduleId: string, taskId: string): void {
  const task = readTask(projectRoot, moduleId, taskId);
  const completeness = inspectTaskArchive(projectRoot, task);
  if (!completeness.valid) {
    output({ archived: false, taskDirectory: completeness.taskDirectory, completeness, task });
    process.exitCode = 1;
    return;
  }
  if (normalizeTaskState(task.metadata.status) !== 'completed') transitionTaskState(projectRoot, task, 'completed', 'task_completed', 'archive_gates_satisfied', { idempotencyKey: `task-completed:${task.metadata.id}:${task.metadata.version}` });
  transitionTaskState(projectRoot, task, 'archived', 'task_archived', 'archive_assets_complete', { idempotencyKey: `task-archived:${task.metadata.id}:${task.metadata.version}` });
  task.metadata.version += 1; task.updatedAt = now(); saveTask(projectRoot, task); rebuildIndexes(projectRoot);
  const sessionCleared = clearTaskSessionIfMatches(projectRoot, moduleId, taskId, flag('--session'));
  output({ ...task, archive: completeness, sessionCleared, workflow: workflowStatus(projectRoot, moduleId, taskId) });
}

function reviewPlanRequirements(projectRoot: string, moduleId: string, taskId: string): TestTask {
  const task = readTask(projectRoot, moduleId, taskId);
  if (!args.includes('--approve')) throw new Error('Plan review requires --approve after the QA has reviewed the complete Task PRD.');
  const confirmedBy = requiredFlag('--confirmed-by'); assertHumanApprover(confirmedBy);
  const confirmationText = requiredFlag('--confirmation-text');
  if (!isExplicitPlanRequirementsConfirmation(confirmationText)) throw new Error(`The QA must explicitly reply “${PLAN_REQUIREMENTS_CONFIRMATION_ZH}” after confirming the PRD matches the requirement.`);
  const confirmationSource = flag('--confirmation-source') ?? 'current-chat-explicit-approval';
  if (!['current-chat-explicit-approval', 'external-review-record'].includes(confirmationSource)) throw new Error('--confirmation-source must be current-chat-explicit-approval or external-review-record.');
  if (!task.scenarios.length || task.scenarios.some(scenario => scenario.planningStatus !== 'applicable' || !scenario.plannedSteps?.length || scenario.plannedSteps.some(step => !step.action.trim() || !step.expected.trim()))) throw new Error('Plan review requires complete applicable Scenarios and detailed steps.');
  const unresolvedQuestions = task.requirements?.userQuestions ?? [];
  if (unresolvedQuestions.length) throw new Error(`The Task PRD still has unresolved QA questions: ${unresolvedQuestions.join(' | ')} Ask the QA, update confirmedDecisions, clear userQuestions, and apply the PlanDraft again.`);
  const prdPath = taskPrdPath(projectRoot, moduleId, taskId);
  if (!planningPrdIsCurrent(prdPath, task)) throw new Error(`Task PRD is missing or stale. Regenerate ${prdPath} before requesting QA confirmation.`);
  const currentPlanHash = testPlanHash(task);
  if (planReviewIsCurrent(task) && task.metadata.planReview?.confirmedBy === confirmedBy && task.metadata.planReview.statement === confirmationText.trim()) return task;
  if (normalizeTaskState(task.metadata.status) === 'running') throw new Error(`Task ${task.metadata.id} has an active Run; its requirements cannot be re-approved.`);
  delete task.metadata.approval;
  task.metadata.planReview = { confirmedBy, confirmedAt: now(), confirmationSource: confirmationSource as 'current-chat-explicit-approval' | 'external-review-record', statement: confirmationText.trim(), planHash: currentPlanHash };
  appendTaskEvent(projectRoot, { type: 'test_plan_requirements_confirmed', actor: { type: 'human', id: confirmedBy }, moduleId, taskId, fromState: normalizeTaskState(task.metadata.status), toState: normalizeTaskState(task.metadata.status), reasonCode: 'qa_confirmed_prd_matches_requirements', artifactHash: currentPlanHash, idempotencyKey: `plan-requirements-confirmed:${taskId}:${currentPlanHash}:${confirmedBy}` });
  task.metadata.version += 1; task.updatedAt = now(); saveTask(projectRoot, task); rebuildIndexes(projectRoot);
  return readTask(projectRoot, moduleId, taskId);
}

function reviewTask(projectRoot: string, moduleId: string, taskId: string): TestTask {
  const task = readTask(projectRoot, moduleId, taskId);
  if (!args.includes('--approve')) throw new Error('Review requires --approve after verifying scope, business logic, scenarios, evidence, safety stops, and cleanup.');
  const confirmedBy = requiredFlag('--confirmed-by'); assertHumanApprover(confirmedBy);
  if (!planReviewIsCurrent(task)) throw new Error(`The current Task PRD has not been confirmed by QA. Present it and obtain the exact reply “${PLAN_REQUIREMENTS_CONFIRMATION_ZH}” through qa-agent plan review first.`);
  const confirmationText = requiredFlag('--confirmation-text');
  if (!isExplicitStartConfirmation(confirmationText)) throw new Error(`The user must explicitly reply “${START_TEST_CONFIRMATION_ZH}” before testing. Pass that exact reply with --confirmation-text.`);
  const confirmationSource = flag('--confirmation-source') ?? 'current-chat-explicit-approval';
  if (!['current-chat-explicit-approval', 'external-review-record'].includes(confirmationSource)) throw new Error('--confirmation-source must be current-chat-explicit-approval or external-review-record.');
  if (!task.scenarios.length) throw new Error('A task needs at least one scenario before approval.');
  if (task.scenarios.some(scenario => !scenario.intent || !Object.keys(scenario.expected ?? {}).length || !(scenario.visualAssertions?.length))) throw new Error('Task review requires every Scenario to declare business intent, expected result, and visual assertions.');
  if (task.scenarios.some(scenario => scenario.planningStatus !== 'applicable' || !scenario.plannedSteps?.length || scenario.plannedSteps.some(step => !step.action.trim() || !step.expected.trim()))) throw new Error('Task review requires every Scenario to be applicable and contain detailed planned steps with an action and expected result. Apply a completed PlanDraft first.');
  if (task.scenarios.some(scenario => (scenario.visualAssertions ?? []).some(assertion => !assertion.importance))) throw new Error('Task review requires every visual assertion to declare importance.');
  const prdPath = taskPrdPath(projectRoot, moduleId, taskId);
  if (!planningPrdIsCurrent(prdPath, task)) throw new Error(`Task PRD is missing or stale. Regenerate ${prdPath}, present it to the user, and request confirmation again.`);
  const currentPlanHash = testPlanHash(task);
  if (approvalIsCurrent(task) && task.metadata.approval?.confirmedBy === confirmedBy && task.metadata.approval.confirmationSource === confirmationSource && task.metadata.approval.statement === confirmationText.trim() && normalizeTaskState(task.metadata.status) === 'ready') return task;
  const currentState = normalizeTaskState(task.metadata.status);
  if (currentState === 'running') throw new Error(`Task ${task.metadata.id} has an active Run; stop or complete it before approving a changed TestPlan.`);
  if (currentState !== 'awaiting_approval') transitionTaskState(projectRoot, task, 'awaiting_approval', 'test_plan_approval_requested', 'current_plan_ready_for_review', { actor: { type: 'agent', id: 'qa-agent' }, artifactHash: currentPlanHash, idempotencyKey: `test-plan-review-requested:${task.metadata.id}:${currentPlanHash}` });
  task.metadata.approval = { confirmedBy, confirmedAt: now(), confirmationSource: confirmationSource as 'current-chat-explicit-approval' | 'external-review-record', statement: confirmationText.trim(), planHash: currentPlanHash };
  transitionTaskState(projectRoot, task, 'ready', 'test_plan_approved', 'explicit_chat_approval', { actor: { type: 'human', id: confirmedBy }, artifactHash: task.metadata.approval.planHash, idempotencyKey: `test-plan-approved:${task.metadata.id}:${task.metadata.approval.planHash}:${confirmedBy}` });
  task.metadata.version += 1; task.updatedAt = now(); saveTask(projectRoot, task); rebuildIndexes(projectRoot);
  return task;
}

async function main(): Promise<void> {
  const [group, action, subject] = args;
  if (!group || group === '--help' || group === '-h' || group === 'help') return output(args.includes('--advanced') ? advancedUsage : usage);
  if (group === '--version' || group === '-v' || group === 'version') return output(QA_AGENT_VERSION);
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
    const projectPlatforms = listFlag('--platforms') ?? readProject(projectRoot).platforms;
    const requiredCapabilities = [...new Set(projectPlatforms.flatMap(platformCapabilities))];
    const missingCapabilities = requiredCapabilities.filter(capability => !available.includes(capability));
    output({
      ok: true,
      projectRoot,
      configuredPlatforms: projectPlatforms,
      availableCapabilities: available,
      notes: capabilityAdvice(missingCapabilities),
      recommendedRegressionStack: recommendedRegressionStackDiagnosis(projectRoot, projectPlatforms),
    }); return;
  }
  if (group === 'update') {
    const projectRoot = root();
    const migration = args.includes('--migrate') ? migrateProjectArtifacts(projectRoot) : undefined;
    const managedAssets = migration ? undefined : syncManagedRuntimeAssets(qaPath(projectRoot));
    const hostUpdate = updateHostIntegrations(projectRoot, { force: args.includes('--force'), migrate: args.includes('--migrate') });
    output({ projectRoot, migration, managedAssets, hostUpdate, migrated: args.includes('--migrate'), next: hostUpdate.conflicts.length ? 'Review conflicts or rerun qa-agent update --force.' : 'Project integrations are current.' }); return;
  }
  if (group === 'check') {
    const projectRoot = root();
    const risk = flag('--risk');
    if (risk && !['low', 'medium', 'high', 'critical'].includes(risk)) throw new Error('--risk must be low, medium, high, or critical.');
    const quickRequest = flag('--request') ?? (action && !action.startsWith('--') ? action : undefined);
    if (!quickRequest) throw new Error('Provide the QA request as qa-agent check "<request>" or with --request.');
    const mode = flag('--mode') ?? 'quick';
    if (!['quick', 'guided'].includes(mode)) throw new Error('--mode must be quick or guided.');
    const prepared = prepareQuickCheck(projectRoot, {
      request: quickRequest,
      mode: mode as 'quick' | 'guided',
      moduleId: flag('--module'),
      taskId: flag('--task'),
      moduleName: flag('--module-name'),
      taskName: flag('--task-name'),
      platforms: listFlag('--platforms'),
      riskLevel: risk as 'low' | 'medium' | 'high' | 'critical' | undefined,
    });
    rebuildIndexes(projectRoot);
    const session = bindTaskSession(projectRoot, { sessionKey: flag('--session'), host: flag('--session-host'), moduleId: prepared.moduleId, taskId: prepared.taskId });
    output({
      message: `${mode === 'guided' ? 'Guided' : 'Quick'} Task prepared. Inspect the project, apply a detailed PlanDraft, present the PRD, resolve all questions, and request QA requirement confirmation before start authorization.`,
      check: { moduleId: prepared.moduleId, taskId: prepared.taskId, mode, moduleCreated: prepared.moduleCreated, taskCreated: prepared.taskCreated, approvalPolicy: 'test-plan-and-side-effects' },
      quickCheck: { moduleId: prepared.moduleId, taskId: prepared.taskId, moduleCreated: prepared.moduleCreated, taskCreated: prepared.taskCreated, approvalPolicy: 'test-plan-and-side-effects' },
      prdPath: taskPrdPath(projectRoot, prepared.moduleId, prepared.taskId),
      planningRequired: true,
      requiredRequirementsConfirmationAfterPlanning: PLAN_REQUIREMENTS_CONFIRMATION_ZH,
      requiredConfirmationAfterPlanning: START_TEST_CONFIRMATION_ZH,
      uiExecutionAllowed: false,
      mustStop: true,
      session,
      workflow: workflowStatus(projectRoot, prepared.moduleId, prepared.taskId, prepared.task.description),
    });
    return;
  }
  if (group === 'continue') {
    output(continueCurrentTask(root(), flag('--session')));
    return;
  }
  if (group === 'finish') {
    output(finishCurrentTask(root(), flag('--session')));
    return;
  }
  if (group === 'session') {
    const projectRoot = root();
    if (action === 'bind') {
      output(bindTaskSession(projectRoot, {
        sessionKey: flag('--session'),
        host: flag('--session-host'),
        moduleId: requiredFlag('--module'),
        taskId: requiredFlag('--task'),
        runId: flag('--run'),
      }));
      return;
    }
    if (action === 'current') { output(readTaskSession(projectRoot, flag('--session')) ?? { current: false }); return; }
    if (action === 'clear') { output({ cleared: clearTaskSession(projectRoot, flag('--session')) }); return; }
    if (action === 'list') { output(listTaskSessions(projectRoot)); return; }
    throw new Error(`Session command must be bind, current, clear, or list.\n\n${advancedUsage}`);
  }
  if (group === 'plan') {
    if (action === 'review') {
      const projectRoot = root(); const moduleId = requiredFlag('--module'); const taskId = requiredFlag('--task');
      const task = reviewPlanRequirements(projectRoot, moduleId, taskId);
      const session = bindTaskSession(projectRoot, { sessionKey: flag('--session'), host: flag('--session-host'), moduleId, taskId });
      output({ task, session, requiredStartConfirmation: START_TEST_CONFIRMATION_ZH, workflow: workflowStatus(projectRoot, moduleId, taskId) });
      return;
    }
    if (action !== 'apply') throw new Error(`Plan command must be apply or review.\n\n${advancedUsage}`);
    const file = flag('--file');
    if (Boolean(file) === args.includes('--stdin')) throw new Error('Specify exactly one of --file PLAN_DRAFT.json or --stdin.');
    const raw = args.includes('--stdin') ? readFileSync(0, 'utf8') : readFileSync(resolve(file!), 'utf8');
    let draft: PlanDraft;
    try { draft = JSON.parse(raw) as PlanDraft; }
    catch (error) { throw new Error(`PlanDraft is not valid JSON: ${(error as Error).message}`); }
    output(applyPlanDraft(root(), draft));
    return;
  }
  if (group === 'start') { bootstrapFromFlags(root()); return; }
  if (group === 'review') { const projectRoot = root(); const moduleId = requiredFlag('--module'); const taskId = requiredFlag('--task'); const task = reviewTask(projectRoot, moduleId, taskId); const session = bindTaskSession(projectRoot, { sessionKey: flag('--session'), host: flag('--session-host'), moduleId, taskId }); output({ task, session, workflow: workflowStatus(projectRoot, moduleId, taskId) }); return; }
  if (group === 'test') {
    const projectRoot = root(); const moduleId = requiredFlag('--module'); const taskId = requiredFlag('--task'); const task = readTask(projectRoot, moduleId, taskId);
    const started = beginAgentGuidedRun(projectRoot, task, runContextFromFlags());
    rebuildIndexes(projectRoot);
    const session = bindTaskSession(projectRoot, { sessionKey: flag('--session'), host: flag('--session-host'), moduleId, taskId, runId: started.id });
    output({ ...executionEnvelope(started), session, workflow: workflowStatus(projectRoot, moduleId, taskId) });
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

${advancedUsage}`);
  }
  if (group === 'host') {
    const projectRoot = root(); const path = qaPath(projectRoot, 'mcp.json');
    const config = readJson<{ version: number; connections: Array<{ id: string; capabilities: string[]; status: 'available' | 'unavailable'; permissionStatus?: PermissionStatus; version?: string; host?: string; attestedAt?: string }> }>(path);
    if (action === 'list') { output(config.connections); return; }
    if (action === 'doctor') {
      if (flag('--platform')) {
        const platform = requiredFlag('--platform');
        output({
          ...hostCapabilityDiagnosis(projectRoot, platform),
          recommendedRegressionStack: recommendedRegressionStackDiagnosis(projectRoot, [platform]),
        }); return;
      }
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
        next: permissionStatus === 'verified' ? 'Run host doctor for the target platform, then retry qa-agent test.' : 'Resolve missing or unknown permissions before UI execution.',
      });
      return;
    }
    if (action !== 'import') throw new Error('Host command must be list, attest, import, or doctor.');
    const snapshot = readJson<{ host?: string; collectedAt?: string; connections?: Array<{ id: string; capabilities: string[]; status?: 'available' | 'unavailable'; permissionStatus?: PermissionStatus; version?: string }> }>(requiredFlag('--file'));
    if (!Array.isArray(snapshot.connections) || snapshot.connections.some(connection => !connection.id || !Array.isArray(connection.capabilities))) throw new Error('Host capability snapshot requires a connections array with id and capabilities.');
    config.connections = snapshot.connections.map(connection => ({ id: connection.id, capabilities: [...new Set(connection.capabilities)], status: connection.status ?? 'available', permissionStatus: connection.permissionStatus ?? 'unknown', version: connection.version, host: snapshot.host, attestedAt: snapshot.collectedAt ?? now() }));
    writeJsonAtomic(path, config); output(config); return;
  }
  if (group === 'regression') {
    const projectRoot = root();
    if (action === 'draft') {
      const result = createPythonRegressionDraft(projectRoot, {
        moduleId: requiredFlag('--module'),
        taskId: requiredFlag('--task'),
        runId: requiredFlag('--run'),
        scriptId: flag('--id'),
        scriptFile: requiredFlag('--file'),
        sessionKey: flag('--session'),
        pythonCommand: flag('--python'),
      });
      output({
        ...result,
        approvalRequired: true,
        next: 'Show the complete script or diff to the user. Publish only after explicit approval.',
      });
      return;
    }
    if (action === 'drafts') {
      output(listPythonRegressionDrafts(projectRoot, flag('--session')));
      return;
    }
    if (action === 'draft-show') {
      if (!subject || subject.startsWith('--')) throw new Error('Python regression draft id is required.');
      output(readPythonRegressionDraft(projectRoot, subject, flag('--session')));
      return;
    }
    if (action === 'publish') {
      const approvalSource = (flag('--confirmation-source') ?? 'current-chat-explicit-approval') as 'current-chat-explicit-approval' | 'external-review-record';
      if (!['current-chat-explicit-approval', 'external-review-record'].includes(approvalSource)) throw new Error('--confirmation-source must be current-chat-explicit-approval or external-review-record.');
      const result = publishPythonRegression(projectRoot, {
        moduleId: requiredFlag('--module'),
        taskId: requiredFlag('--task'),
        draftId: requiredFlag('--draft'),
        confirmedBy: requiredFlag('--confirmed-by'),
        approvalSource,
        sessionKey: flag('--session'),
        pythonCommand: flag('--python'),
        replace: args.includes('--replace'),
      });
      rebuildIndexes(projectRoot);
      output({ ...result, next: 'Run the approved Python script once. Runtime will mark the script validated when its execution contract completes.' });
      return;
    }
    if (action === 'list') {
      output(listPythonRegressions(projectRoot, requiredFlag('--module'), requiredFlag('--task')));
      return;
    }
    if (action === 'show') {
      if (!subject || subject.startsWith('--')) throw new Error('Python regression script id is required.');
      output(readPythonRegression(projectRoot, requiredFlag('--module'), requiredFlag('--task'), subject));
      return;
    }
    if (action === 'run') {
      if (!subject || subject.startsWith('--')) throw new Error('Python regression script id is required.');
      const timeoutSeconds = flag('--timeout-seconds');
      const timeoutMs = timeoutSeconds === undefined ? undefined : Number(timeoutSeconds) * 1000;
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error('--timeout-seconds must be a positive number.');
      const result = runPythonRegression(projectRoot, {
        moduleId: requiredFlag('--module'),
        taskId: requiredFlag('--task'),
        scriptId: subject,
        pythonCommand: flag('--python'),
        bridge: flag('--bridge'),
        timeoutMs,
      });
      rebuildIndexes(projectRoot);
      output({ ...result, reportPath: join(taskDirectory(projectRoot, result.moduleId, result.taskId), 'regression-runs', result.id, result.reportRef), next: 'Agent must inspect every screenshot-backed checkpoint against its expected and actual state before presenting the regression report. Do not trust result.json alone or claim a completed regression when contractStatus is invalid_result.' });
      return;
    }
    throw new Error(`Regression command must be draft, drafts, draft-show, publish, list, show, or run.\n\n${advancedUsage}`);
  }
  if (group === 'impact') {
    if (action !== 'analyze') throw new Error(`Unsupported command.

${advancedUsage}`);
    const analysis = analyzeProjectImpact(root(), { base: flag('--base'), head: flag('--head'), changedFiles: listFlag('--changed-files') });
    output(analysis); return;
  }
  if (group === 'release') {
    const projectRoot = root();
    if (action === 'list') { output(listFiles(qaPath(projectRoot, 'release-checks'), path => path.endsWith('.json')).map(path => readJson<ReleaseCheck>(path)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); return; }
    if (action === 'check') {
      const profile = regressionProfile();
      const impact = analyzeProjectImpact(projectRoot, { base: flag('--base'), head: flag('--head'), changedFiles: listFlag('--changed-files') });
      const selection = buildReleaseRegressionSelection(projectRoot, impact, profile);
      const check = createReleaseCheck(selection, impact, profile);
      saveReleaseCheck(projectRoot, check); writeReleaseReport(projectRoot, check);
      if (args.includes('--plan-only') || !selection.members.length) { output(check); return; }
      const timeoutSeconds = flag('--timeout-seconds'); const timeoutMs = timeoutSeconds === undefined ? undefined : Number(timeoutSeconds) * 1000;
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error('--timeout-seconds must be a positive number.');
      const regressionRun = runRegressionSelection(projectRoot, selection, { pythonCommand: flag('--python'), bridge: flag('--bridge'), timeoutMs });
      attachRegressionRun(check, regressionRun); finalizeReleaseCheck(check, regressionRun);
      saveReleaseCheck(projectRoot, check); writeReleaseReport(projectRoot, check, regressionRun); rebuildIndexes(projectRoot);
      output({ releaseCheck: check, regressionRun }); return;
    }
    if (!subject) throw new Error('release check id is required.');
    const check = readReleaseCheck(projectRoot, subject);
    if (action === 'show') { output(check); return; }
    if (action === 'report') { output(qaPath(projectRoot, 'reports', `${check.id}.md`)); return; }
    throw new Error(`Release command must be check, list, show, or report.\n\n${advancedUsage}`);
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
    output({ project: readProject(projectRoot), module, memories, tasks, skills: readIndex(projectRoot, 'skills'), capabilities: availableCapabilities(projectRoot), policy: readJson(qaPath(projectRoot, 'policies.json')) }); return;
  }
  if (group === 'index' && action === 'rebuild') { output(rebuildIndexes(root())); return; }
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
    if (action === 'operation') throw new Error('Legacy task operation commands were removed in v0.3.2. Use reviewed Python regression scripts.');
    if (action === 'regression' && subject === 'sync') throw new Error('Task regression sync was removed in v0.3.2. Python regression selections are computed directly.');
    if (action === 'list') return output(readIndex(projectRoot, 'tasks'));
    const moduleId = requiredFlag('--module');
    if (!subject) throw new Error('task id is required.');
    if (action === 'create') {
      const task = applyTaskRegressionMetadata(createTaskSkeleton(readModule(projectRoot, moduleId), subject, flag('--name')));
      saveTask(projectRoot, task);
      appendTaskEvent(projectRoot, { type: 'task_created', actor: { type: 'agent', id: 'qa-agent' }, moduleId, taskId: task.metadata.id, toState: 'draft', reasonCode: 'compatibility_task_create', artifactHash: testPlanHash(task), idempotencyKey: `task-created:${moduleId}:${task.metadata.id}:draft` });
      rebuildIndexes(projectRoot); output(task); return;
    }
    if (action === 'update') {
      const task = readTask(projectRoot, moduleId, subject);
      const beforePlanHash = testPlanHash(task);
      const hadApproval = Boolean(task.metadata.approval);
      applyTaskRegressionMetadata(task);
      const name = flag('--name'); if (name) task.metadata.name = name;
      const currentPlanHash = testPlanHash(task);
      if (hadApproval && beforePlanHash !== currentPlanHash) {
        if (normalizeTaskState(task.metadata.status) === 'running') throw new Error(`Task ${task.metadata.id} has an active Run; stop or complete it before changing the approved TestPlan.`);
        invalidateApproval(task);
        if (normalizeTaskState(task.metadata.status) !== 'awaiting_approval') transitionTaskState(projectRoot, task, 'awaiting_approval', 'test_plan_changed', 'task_update_changed_plan_hash', { actor: { type: 'agent', id: 'qa-agent' }, artifactHash: currentPlanHash, idempotencyKey: `test-plan-changed:${task.metadata.id}:${currentPlanHash}` });
              markPythonRegressionsStaleForPlanHash(projectRoot, task, currentPlanHash);
      }
      saveTask(projectRoot, task); rebuildIndexes(projectRoot); output(task); return;
    }
    const nestedAction = action === 'regression' ? subject : undefined;
    const taskId = nestedAction ? (flag('--task') ?? args[3]) : subject;
    if (!taskId || taskId.startsWith('--')) throw new Error('task id is required.');
    const task = readTask(projectRoot, moduleId, taskId);
    if (action === 'plan') return output(taskPlan(task));
    if (action === 'finalize') return output(finalizeTask(projectRoot, moduleId, taskId, flag('--run')));
    if (action === 'regression') {
      const regressionAction = ['show', 'run'].includes(subject ?? '') ? subject : args[3];
      const selection = buildTaskRegressionSelection(projectRoot, task);
      if (regressionAction === 'show') return output(selection);
      if (regressionAction === 'run') {
        const timeoutSeconds = flag('--timeout-seconds'); const timeoutMs = timeoutSeconds === undefined ? undefined : Number(timeoutSeconds) * 1000;
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error('--timeout-seconds must be a positive number.');
        const result = runRegressionSelection(projectRoot, selection, { pythonCommand: flag('--python'), bridge: flag('--bridge'), timeoutMs }); rebuildIndexes(projectRoot); return output(result);
      }
      throw new Error('Task regression action must be show or run.');
    }
    if (action === 'review') { const reviewed = reviewTask(projectRoot, moduleId, taskId); output({ ...reviewed, deprecatedAlias: true, canonicalCommand: 'qa-agent review --module MODULE --task TASK --approve --confirmed-by USER', workflow: workflowStatus(projectRoot, moduleId, taskId) }); return; }
    if (action === 'archive') { archiveTask(projectRoot, moduleId, taskId); return; }
    if (action === 'explore' || action === 'run') {
      const started = beginAgentGuidedRun(projectRoot, task, runContextFromFlags()); rebuildIndexes(projectRoot);
      output({ ...executionEnvelope(started), workflow: workflowStatus(projectRoot, moduleId, taskId), deprecatedAlias: true, canonicalCommand: 'qa-agent test --module MODULE --task TASK' }); return;
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
    if (!['show', 'report', 'guide-approve', 'guide-verdict', 'step', 'evidence', 'cleanup', 'recover', 'observe', 'complete'].includes(action ?? '')) throw new Error(`Unsupported command.\n\n${advancedUsage}`);
    const projectRoot = root();
    if (!subject) throw new Error('run id is required. Start a Task with task run TASK --module MODULE.');
    const run = readRunById(projectRoot, subject);
    if (action === 'show') return output(run);
    if (action === 'report') return output(taskSourceRunReportPath(projectRoot, run.moduleId, run.taskId));
    if (action === 'guide-approve') {
      const updated = approveGuidedAction(projectRoot, subject, { scenarioId: flag('--scenario'), plannedStepId: flag('--planned-step'), action: flag('--action'), expected: flag('--expected'), confirmedBy: requiredFlag('--confirmed-by'), confirmationSource: (flag('--confirmation-source') as 'current-chat-explicit-approval' | 'external-review-record' | undefined), statement: requiredFlag('--confirmation-text') });
      output(executionEnvelope(updated)); return;
    }
    if (action === 'guide-verdict') {
      const status = requiredFlag('--status') as 'passed' | 'failed' | 'blocked' | 'paused' | 'inconclusive' | 'adapted';
      if (!['passed', 'failed', 'blocked', 'paused', 'inconclusive', 'adapted'].includes(status)) throw new Error('--status is invalid for a Guided verdict.');
      const updated = recordGuidedVerdict(projectRoot, subject, { stepId: requiredFlag('--step'), status, confirmedBy: requiredFlag('--confirmed-by'), confirmationSource: (flag('--confirmation-source') as 'current-chat-explicit-approval' | 'external-review-record' | undefined), statement: requiredFlag('--confirmation-text'), note: flag('--note') });
      output(executionEnvelope(updated)); return;
    }
    if (action === 'step') {
      const executionMode = (flag('--execution-mode') ?? 'host-automated') as StepExecutionMode;
      if (!['host-automated', 'user-assisted', 'system-component-blocked', 'preseeded-test-data'].includes(executionMode)) throw new Error('--execution-mode is invalid.');
      const updated = recordAgentStep(projectRoot, subject, { action: requiredFlag('--action'), uiAction: flag('--ui-action') as 'launch' | 'navigate' | 'click' | 'input' | 'fill' | 'swipe' | 'back' | 'wait' | 'assert' | 'screenshot' | 'reset' | 'restart-app' | undefined, safetyAction: flag('--safety-action'), detail: requiredFlag('--detail'), screenshotPath: requiredFlag('--screenshot'), status: (flag('--status') as RunStatus | undefined) ?? 'passed', visualInspection: (flag('--visual-inspection') as 'performed' | 'not-required' | 'not-applicable' | 'skipped' | undefined) ?? 'not-required', executionMode, scenarioId: flag('--scenario'), locator: locatorFromFlags(), actualLocator: locatorFromFlags('actual-'), inputRefs: recordFlag('--input-refs'), expectedState: flag('--expected-state'), actualState: flag('--actual-state'), adaptation: flag('--adaptation') });
      output(executionEnvelope(updated)); return;
    }
    if (action === 'evidence') {
      const updated = recordHostEvidence(projectRoot, subject, { type: requiredFlag('--type'), summary: requiredFlag('--summary'), artifactPath: flag('--file') });
      output(executionEnvelope(updated)); return;
    }
    if (action === 'cleanup') {
      const updated = recordCleanupFinding(projectRoot, subject, { scenarioId: requiredFlag('--scenario'), cleanup: requiredFlag('--cleanup'), actual: requiredFlag('--actual'), status: requiredFlag('--status') as RunStatus, screenshotPath: flag('--screenshot') });
      output(executionEnvelope(updated)); return;
    }
    if (action === 'recover') {
      const updated = recordRecoveryAttempt(projectRoot, subject, { action: requiredFlag('--action'), reason: requiredFlag('--reason'), detail: requiredFlag('--detail'), outcome: requiredFlag('--outcome') as 'continued' | 'blocked' | 'paused' | 'failed', failedStepId: flag('--failed-step') });
      output(executionEnvelope(updated)); return;
    }
    if (action === 'observe') {
      const updated = recordVisualFinding(projectRoot, subject, { scenarioId: requiredFlag('--scenario'), assertionId: requiredFlag('--assertion'), expected: requiredFlag('--expected'), actual: requiredFlag('--actual'), status: requiredFlag('--status') as RunStatus, screenshotPath: flag('--screenshot'), inspectionProvider: flag('--inspection-provider') });
      output(executionEnvelope(updated)); return;
    }
    if (action === 'complete') {
      const updated = completeAgentGuidedRun(projectRoot, readTask(projectRoot, (run as { moduleId: string }).moduleId, (run as { taskId: string }).taskId), subject);
      rebuildIndexes(projectRoot); output(executionEnvelope(updated)); return;
    }
  }
  if (group === 'module' && action === 'regression') {
    const projectRoot = root(); const regressionAction = subject; const moduleId = args[3];
    if (!['show', 'run'].includes(regressionAction ?? '')) throw new Error(`Unsupported command.\n\n${advancedUsage}`);
    if (!moduleId || moduleId.startsWith('--')) throw new Error('module id is required.');
    const selection = buildModuleRegressionSelection(projectRoot, moduleId, priorityValue() ?? 'p3');
    if (regressionAction === 'show') return output(selection);
    const timeoutSeconds = flag('--timeout-seconds'); const timeoutMs = timeoutSeconds === undefined ? undefined : Number(timeoutSeconds) * 1000;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error('--timeout-seconds must be a positive number.');
    const result = runRegressionSelection(projectRoot, selection, { pythonCommand: flag('--python'), bridge: flag('--bridge'), timeoutMs }); rebuildIndexes(projectRoot); return output(result);
  }
  if (group === 'skill') {
    const skillRoot = join(process.cwd(), 'skill', 'qa-agent');
    const projectRoot = findProjectRoot();
    if (action === 'list') return output(projectRoot ? readIndex(projectRoot, 'skills') : [{ name: 'qa-agent', path: skillRoot }]);
    if (action === 'validate') { const result = validateSkill(skillRoot); output(result); if (!result.valid) process.exitCode = 1; return; }
  }
  throw new Error(`Unsupported command.\n\n${advancedUsage}`);
}

main().catch(error => { console.error(`qa-agent: ${(error as Error).message}`); process.exitCode = 1; });
