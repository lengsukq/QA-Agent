import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { capabilityAdvice, capabilitySnapshot, checkCapabilities, platformCapabilities } from './capabilities.ts';
import { checkpointRun, gitMetadata, qaPath, readRunById, readTask, saveRun, saveTask, taskSourceEvidenceDirectory, taskSourceRunDirectory, taskSourceRunPath } from './project.ts';
import { rebuildIndexes } from './indexer.ts';
import { appendTaskEvent } from './events.ts';
import { normalizeTaskState, transitionTaskState } from './workflow-model.ts';
import { hasSecrets, now, readJson, withFileLock } from './store.ts';
import { writeReport } from './report.ts';
import { clearTaskResultSection, finalizeTask } from './task-finalizer.ts';
import { curateFailedRun, curateObservedBusinessRules } from './memory.ts';
import { inspectPythonRegressionEligibility, listPythonRegressions } from './python-regression.ts';
import type { ExecutionSnapshot, Locator, UiAction, RunStatus, StepExecutionMode, TestRun, TestTask, VisualInspectionStatus } from './types.ts';
import { executionContractIsCurrent, requiresTestPlanApproval, testPlanHash } from './approval.ts';
import { assertRecoveryAction, assertSafeAction } from './safety.ts';

type RunContextInput = Partial<ExecutionSnapshot> & { scenarioId?: string };

export function buildExecutionSnapshot(root: string, task: TestTask, input: RunContextInput = {}): ExecutionSnapshot {
  const platform = input.platform ?? task.scope.platforms[0] ?? 'web';
  const snapshot = capabilitySnapshot(root, platform);
  return {
    environment: input.environment ?? task.scope.environments[0] ?? 'local', platform, role: input.role ?? task.scope.roles[0] ?? 'default',
    scenarioId: input.scenarioId, device: input.device, deviceModel: input.deviceModel, osVersion: input.osVersion,
    appVersion: input.appVersion, webBuild: input.webBuild, testDataFingerprint: input.testDataFingerprint,
    mcpSnapshot: input.mcpSnapshot ?? snapshot.mcpSnapshot, permissionSnapshot: input.permissionSnapshot ?? snapshot.permissionSnapshot,
  };
}

function newRun(root: string, task: TestTask, input: RunContextInput = {}): TestRun {
  const startedAt = now();
  const policy = readJson<{ safeMode: boolean }>(qaPath(root, 'policies.json'));
  return {
    $schema: '../../../../schemas/run.schema.json',
    id: `run-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    taskId: task.metadata.id,
    moduleId: task.metadata.moduleId,
    planHash: task.metadata.approval?.planHash ?? testPlanHash(task),
    context: buildExecutionSnapshot(root, task, input),
    git: gitMetadata(root),
    status: 'pending',
    safeMode: policy.safeMode,
    mode: 'explore',
    steps: [], scenarioResults: [], evidence: [], visualFindings: [],
    scenarioId: input.scenarioId, screenshots: [], recoveryAttempts: [], cleanupFindings: [], startedAt,
  };
}

function finish(root: string, task: TestTask, run: TestRun): TestRun {
  run.completedAt = now();
  const memoryCandidates = [curateFailedRun(root, task, run), curateObservedBusinessRules(root, task, run)].filter((id): id is string => Boolean(id));
  if (memoryCandidates.length) {
    run.memoryCandidates = memoryCandidates;
    task.memoryRefs ??= [];
    for (const id of memoryCandidates) {
      const ref = `memory/${id}.json`;
      if (!task.memoryRefs.includes(ref)) task.memoryRefs.push(ref);
    }
  }
  run.pythonRegressionEligibility = inspectPythonRegressionEligibility(task, run);
  const taskStateBeforeFinish = normalizeTaskState(task.metadata.status);
  const targetTaskState = run.status === 'paused'
    ? 'paused'
    : ['blocked', 'needs_confirmation', 'inconclusive'].includes(run.status) || run.steps.some(step => step.id === 'preflight')
      ? 'blocked'
      : 'reviewing_result';
  if (taskStateBeforeFinish === targetTaskState) {
    appendTaskEvent(root, { type: 'run_completed', actor: { type: 'runtime', id: 'qa-agent-runtime' }, moduleId: task.metadata.moduleId, taskId: task.metadata.id, fromState: taskStateBeforeFinish, toState: targetTaskState, reasonCode: `run_${run.status}`, artifactHash: run.planHash, idempotencyKey: `run-completed:${run.id}`, metadata: { runId: run.id, status: run.status, mode: run.mode, pythonRegressionEligible: run.pythonRegressionEligibility.eligible } });
  } else {
    transitionTaskState(root, task, targetTaskState, 'run_completed', `run_${run.status}`, { artifactHash: run.planHash, idempotencyKey: `run-completed:${run.id}`, metadata: { runId: run.id, status: run.status, mode: run.mode, pythonRegressionEligible: run.pythonRegressionEligibility.eligible } });
  }
  run.reportPath = 'source-run/report.md';
  run.reportGeneratedBy = 'qa-agent-runtime';
  run.reportGeneratedAt = now();
  task.sourceRunRef = 'source-run/run.json';
  task.sourceReportRef = 'source-run/report.md';
  task.updatedAt = now();
  writeReport(root, task, run);
  saveRun(root, run);
  saveTask(root, task);
  if (task.metadata.mode === 'quick' && targetTaskState === 'reviewing_result') finalizeTask(root, task.metadata.moduleId, task.metadata.id, run.id);
  else rebuildIndexes(root);
  return run;
}

function preflightStatus(detail: string): RunStatus {
  return /plan hash|approval|scenario|business|confirmation|flow/i.test(detail) ? 'needs_confirmation' : 'blocked';
}

function block(root: string, task: TestTask, run: TestRun, detail: string, status: RunStatus = preflightStatus(detail)): TestRun {
  run.status = status;
  run.steps.push({ id: 'preflight', action: 'Execution preflight', status, detail, at: now(), source: 'internal' });
  run.evidence.push({ type: 'preflight', summary: detail });
  run.scenarioResults = task.scenarios.map(scenario => ({ scenarioId: scenario.id, status, detail }));
  run.conclusion = status === 'needs_confirmation'
    ? 'Execution paused because the reviewed business contract needs user confirmation.'
    : 'Execution did not start because a capability, permission, device, environment, or safety precondition was unavailable.';
  return finish(root, task, run);
}

function currentSourceRun(root: string, task: TestTask): TestRun | undefined {
  const path = taskSourceRunPath(root, task.metadata.moduleId, task.metadata.id);
  if (!existsSync(path)) return undefined;
  return readJson<TestRun>(path);
}

function resetSourceRunSlot(root: string, task: TestTask, previous: TestRun): void {
  const activeScripts = listPythonRegressions(root, task.metadata.moduleId, task.metadata.id)
    .filter(script => ['approved_unverified', 'validated'].includes(script.status));
  if (activeScripts.length) {
    throw new Error(`Source Run ${previous.id} is frozen by formal Python regression script(s): ${activeScripts.map(script => script.id).join(', ')}. Run those scripts through regression-runs, or change the reviewed plan so Runtime marks them stale before creating a new Source Run.`);
  }
  rmSync(taskSourceRunDirectory(root, task.metadata.moduleId, task.metadata.id), { recursive: true, force: true });
  clearTaskResultSection(root, task);
  delete task.sourceRunRef;
  delete task.sourceReportRef;
  delete task.finalization;
  task.metadata.version += 1;
  task.updatedAt = now();
  appendTaskEvent(root, {
    type: 'source_run_restarted',
    actor: { type: 'runtime', id: 'qa-agent-runtime' },
    moduleId: task.metadata.moduleId,
    taskId: task.metadata.id,
    fromState: normalizeTaskState(task.metadata.status),
    toState: normalizeTaskState(task.metadata.status),
    reasonCode: 'replace_unpublished_source_run',
    artifactHash: previous.planHash,
    idempotencyKey: `source-run-restarted:${previous.id}:${task.metadata.version}`,
    metadata: { previousRunId: previous.id, previousStatus: previous.status },
  });
}

function beginAgentGuidedRunUnlocked(root: string, task: TestTask, context: RunContextInput = {}): TestRun {
  const current = currentSourceRun(root, task);
  if (current?.status === 'running') {
    if (!executionContractIsCurrent(task, current.planHash)) return block(root, task, current, `Task plan changed after active Source Run ${current.id} started. Stop execution and obtain a new TestPlan approval before resuming.`, 'needs_confirmation');
    if (context.scenarioId && current.scenarioId && current.scenarioId !== context.scenarioId) throw new Error(`Task ${task.metadata.id} already has active Source Run ${current.id} for Scenario ${current.scenarioId}.`);
    const contextKeys = ['environment', 'platform', 'role', 'device', 'deviceModel', 'osVersion', 'appVersion', 'webBuild', 'testDataFingerprint'] as const;
    for (const key of contextKeys) if (context[key] !== undefined && context[key] !== current.context[key]) throw new Error(`Task ${task.metadata.id} already has active Source Run ${current.id} with ${key}=${current.context[key] ?? 'unknown'}, not ${context[key]}.`);
    return current;
  }
  if (current) resetSourceRunSlot(root, task, current);
  const taskState = normalizeTaskState(task.metadata.status);
  if (['archived', 'deprecated', 'superseded'].includes(taskState)) throw new Error(`Task ${task.metadata.id} is ${taskState} and cannot start a new Run.`);
  if (!['ready', 'reviewing_result', 'completed', 'blocked', 'paused'].includes(taskState)) throw new Error(`Task status is ${task.metadata.status}; present the Task PRD and wait for the user to reply “确认开始测试” before creating a Run.`);
  if (!executionContractIsCurrent(task)) throw new Error('The Task plan is unapproved or changed after approval. Present the current Task PRD and obtain the exact user reply “确认开始测试” before creating a Run.');
  const run = newRun(root, task, context);
  const required = [...new Set([...task.capabilities.required, ...platformCapabilities(run.context.platform)])];
  const capabilities = checkCapabilities(root, required, task.capabilities.optional);
  if (capabilities.missing.length) return block(root, task, run, `Missing required capabilities: ${capabilities.missing.join(', ')}. ${capabilityAdvice(capabilities.missing).join(' ')}`, 'blocked');
  if (run.context.platform !== 'web' && run.context.permissionSnapshot.status !== 'verified') return block(root, task, run, 'macOS/MCP permissions are not verified. Run host doctor --platform android|ios, grant Screen Recording and Accessibility, then retry.', 'blocked');
  run.status = 'running';
  run.steps.push({ id: 'agent-guided-preflight', action: 'Agent-guided test preflight', status: 'passed', detail: 'Required capabilities are available. Persist every real UI action, screenshot, assertion, and cleanup.', at: now(), source: 'internal' });
  task.sourceRunRef = 'source-run/run.json';
  delete task.sourceReportRef;
  transitionTaskState(root, task, 'running', 'run_started', task.metadata.mode === 'quick' ? 'quick_test_started' : 'approved_test_started', { artifactHash: run.planHash, idempotencyKey: `run-started:${run.id}`, metadata: { runId: run.id, mode: run.mode, scenarioId: run.scenarioId, taskMode: task.metadata.mode ?? 'regression' } });
  saveTask(root, task);
  checkpointRun(root, run);
  return run;
}

export function beginAgentGuidedRun(root: string, task: TestTask, context: RunContextInput = {}): TestRun {
  const lockPath = qaPath(root, '.locks', `run-start-${task.metadata.moduleId}-${task.metadata.id}.lock`);
  return withFileLock(lockPath, () => beginAgentGuidedRunUnlocked(root, readTask(root, task.metadata.moduleId, task.metadata.id), context));
}

export function recordAgentStep(root: string, runId: string, input: { action: string; uiAction?: UiAction; safetyAction?: string; detail: string; status?: RunStatus; screenshotPath?: string; visualInspection?: VisualInspectionStatus; source?: TestRun['steps'][number]['source']; executionMode?: StepExecutionMode; scenarioId?: string; locator?: Locator; actualLocator?: Locator; inputRefs?: Record<string, string>; expectedState?: string; actualState?: string; adaptation?: string }): TestRun {
  const run = readRunById(root, runId);
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  const task = readTask(root, run.moduleId, run.taskId);
  if (!executionContractIsCurrent(task, run.planHash)) throw new Error(requiresTestPlanApproval(task) ? `Task ${task.metadata.id} plan changed after Run ${run.id} started; stop UI execution and obtain a new TestPlan approval.` : `Quick Task ${task.metadata.id} execution contract changed after Run ${run.id} started; stop UI execution and refresh the Task.`);
  const scenarioId = input.scenarioId ?? run.scenarioId ?? (task.scenarios.length === 1 ? task.scenarios[0]?.id : undefined);
  if (!scenarioId) throw new Error('A UI step must specify --scenario when the Task contains multiple scenarios.');
  const source = input.source ?? 'ui';
  const visualInspection = input.visualInspection ?? 'not-required';
  const executionMode = input.executionMode ?? 'host-automated';
  if (executionMode === 'system-component-blocked' && ['passed', 'adapted'].includes(input.status ?? 'passed')) throw new Error('A system-component-blocked step cannot be recorded as passed or adapted. Use blocked, paused, or inconclusive.');
  assertSafeAction(root, input.action, input.safetyAction);
  if (hasSecrets({ inputRefs: input.inputRefs, detail: input.detail, locator: input.locator, actualLocator: input.actualLocator })) throw new Error('Test step contains a potential secret. Use an env: reference instead.');
  const stepId = `agent-${run.steps.length + 1}`;
  if (source === 'ui' && !input.screenshotPath) throw new Error('Every real UI action requires --screenshot.');
  const screenshotPath = input.screenshotPath ? captureScreenshot(root, run, stepId, input.screenshotPath, visualInspection, `${input.action}: ${input.detail}`) : undefined;
  run.steps.push({ id: stepId, action: input.action, uiAction: input.uiAction, safetyAction: input.safetyAction, status: input.status ?? 'passed', detail: input.detail, at: now(), scenarioId, screenshotPath, visualInspection, source, executionMode, locator: input.locator, actualLocator: input.actualLocator, inputRefs: input.inputRefs, expectedState: input.expectedState, actualState: input.actualState, adaptation: input.adaptation });
  checkpointRun(root, run);
  return run;
}

function captureScreenshot(root: string, run: TestRun, stepId: string, sourcePath: string, visualInspection: VisualInspectionStatus, summary: string): string {
  if (!existsSync(sourcePath)) throw new Error(`Screenshot does not exist: ${sourcePath}`);
  const runDirectory = taskSourceRunDirectory(root, run.moduleId, run.taskId);
  const destination = join(runDirectory, 'screenshots', 'steps', `${stepId}-${basename(sourcePath)}`);
  mkdirSync(join(destination, '..'), { recursive: true });
  copyFileSync(sourcePath, destination);
  const relativePath = destination.slice(runDirectory.length + 1);
  run.screenshots.push({ stepId, path: relativePath, capturedAt: now(), visualInspection, summary });
  run.evidence.push({ type: 'screenshot', path: relativePath, summary: `Screenshot captured: ${summary}` });
  return relativePath;
}

export function recordHostEvidence(root: string, runId: string, input: { type: string; summary: string; artifactPath?: string }): TestRun {
  const run = readRunById(root, runId);
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  if (!input.type.trim() || !input.summary.trim()) throw new Error('Evidence type and summary are required.');
  if (hasSecrets({ summary: input.summary })) throw new Error('Evidence summary contains a potential secret.');
  let path: string | undefined;
  if (input.artifactPath) {
    if (!existsSync(input.artifactPath)) throw new Error(`Evidence artifact does not exist: ${input.artifactPath}`);
    const runDirectory = taskSourceRunDirectory(root, run.moduleId, run.taskId);
    const destination = join(taskSourceEvidenceDirectory(root, run.moduleId, run.taskId), 'artifacts', `${run.evidence.length + 1}-${basename(input.artifactPath)}`);
    mkdirSync(join(destination, '..'), { recursive: true });
    copyFileSync(input.artifactPath, destination);
    path = destination.slice(runDirectory.length + 1);
  }
  run.evidence.push({ type: input.type, path, summary: input.summary });
  checkpointRun(root, run);
  return run;
}

export function recordRecoveryAttempt(root: string, runId: string, input: { reason: string; action: string; outcome: 'continued' | 'blocked' | 'paused' | 'failed'; detail: string; failedStepId?: string }): TestRun {
  const run = readRunById(root, runId);
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  assertRecoveryAction(input.action);
  const task = readTask(root, run.moduleId, run.taskId);
  const max = task.recoveryPolicy.maxRecoveryAttempts;
  if (run.recoveryAttempts.length >= max) return block(root, task, run, `Recovery attempt limit ${max} was reached.`, 'blocked');
  if (input.action === 'reset-sandbox-data' && !task.recoveryPolicy.allowSandboxDataReset) throw new Error('Task recovery policy does not allow sandbox data reset.');
  const attempt = { id: `recovery-${run.recoveryAttempts.length + 1}`, reason: input.reason, action: input.action, outcome: input.outcome, detail: input.detail, failedStepId: input.failedStepId, at: now() };
  run.recoveryAttempts.push(attempt);
  run.steps.push({ id: attempt.id, action: `Recovery: ${input.action}`, status: input.outcome === 'continued' ? 'passed' : input.outcome, detail: `${input.reason}\n${input.detail}`, at: attempt.at, source: 'recovery', scenarioId: run.scenarioId, visualInspection: 'not-required' });
  if (input.outcome === 'continued') { run.status = 'running'; checkpointRun(root, run); return run; }
  run.status = input.outcome;
  run.scenarioResults = task.scenarios.map(scenario => ({ scenarioId: scenario.id, status: input.outcome as Exclude<typeof input.outcome, 'continued'>, detail: `Recovery stopped the run: ${input.detail}` }));
  run.conclusion = `Run stopped during recovery: ${input.outcome}.`;
  return finish(root, task, run);
}

export function recordVisualFinding(root: string, runId: string, input: { scenarioId: string; assertionId: string; expected: string; actual: string; status: RunStatus; screenshotPath?: string; inspectionProvider?: string }): TestRun {
  const run = readRunById(root, runId);
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  if (!['passed', 'failed', 'blocked', 'paused', 'inconclusive', 'not_applicable', 'needs_confirmation', 'adapted'].includes(input.status)) throw new Error('A visual observation must use a terminal QA conclusion status.');
  const task = readTask(root, run.moduleId, run.taskId);
  if (!executionContractIsCurrent(task, run.planHash)) throw new Error(requiresTestPlanApproval(task) ? `Task ${task.metadata.id} plan changed after Run ${run.id} started; stop assertion recording and obtain a new TestPlan approval.` : `Quick Task ${task.metadata.id} execution contract changed after Run ${run.id} started; stop assertion recording and refresh the Task.`);
  const scenario = task.scenarios.find(item => item.id === input.scenarioId);
  if (!scenario) throw new Error(`Scenario ${input.scenarioId} does not belong to task ${run.taskId}.`);
  if (run.scenarioId && run.scenarioId !== input.scenarioId) throw new Error(`Run is scoped to scenario ${run.scenarioId}; received visual finding for ${input.scenarioId}.`);
  if (scenario.visualAssertions?.length && !scenario.visualAssertions.some(item => item.id === input.assertionId)) throw new Error(`Visual assertion ${input.assertionId} is not declared for scenario ${input.scenarioId}.`);
  if (['passed', 'failed', 'adapted'].includes(input.status) && !input.screenshotPath) throw new Error('A terminal visual observation requires a screenshot artifact.');
  const screenshotPath = input.screenshotPath ? captureScreenshot(root, run, `visual-${input.assertionId}-${run.visualFindings.length + 1}`, input.screenshotPath, 'performed', `Visual assertion ${input.assertionId}`) : undefined;
  const finding = { scenarioId: input.scenarioId, assertionId: input.assertionId, expected: input.expected, actual: input.actual, status: input.status, screenshotPath, visualInspection: 'performed' as const, inspectionProvider: input.inspectionProvider, at: now() };
  run.visualFindings.push(finding);
  run.steps.push({ id: `visual-${input.assertionId}-${run.visualFindings.length}`, action: 'Visual business assertion', status: input.status, detail: `Expected: ${input.expected}\nActual: ${input.actual}`, at: finding.at, scenarioId: input.scenarioId, source: 'internal', visualInspection: 'performed' });
  checkpointRun(root, run);
  return run;
}

export function recordCleanupFinding(root: string, runId: string, input: { scenarioId: string; cleanup: string; actual: string; status: RunStatus; screenshotPath?: string }): TestRun {
  const run = readRunById(root, runId);
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  const task = readTask(root, run.moduleId, run.taskId);
  const scenario = task.scenarios.find(item => item.id === input.scenarioId);
  if (!scenario) throw new Error(`Scenario ${input.scenarioId} does not belong to task ${run.taskId}.`);
  if (run.scenarioId && run.scenarioId !== input.scenarioId) throw new Error(`Run is scoped to scenario ${run.scenarioId}; received cleanup for ${input.scenarioId}.`);
  if (!scenario.cleanup.includes(input.cleanup)) throw new Error(`Cleanup ${input.cleanup} is not declared for scenario ${input.scenarioId}.`);
  if (!['passed', 'failed', 'blocked', 'paused', 'inconclusive', 'not_applicable', 'needs_confirmation'].includes(input.status)) throw new Error('Cleanup must use a terminal status.');
  const screenshotPath = input.screenshotPath ? captureScreenshot(root, run, `cleanup-${run.cleanupFindings.length + 1}`, input.screenshotPath, 'performed', `Cleanup: ${input.cleanup}`) : undefined;
  const finding = { scenarioId: input.scenarioId, cleanup: input.cleanup, actual: input.actual, status: input.status, screenshotPath, at: now() };
  run.cleanupFindings.push(finding);
  run.steps.push({ id: `cleanup-${run.cleanupFindings.length}`, action: 'Scenario cleanup', status: input.status, detail: `Cleanup: ${input.cleanup}\nActual: ${input.actual}`, at: finding.at, scenarioId: input.scenarioId, source: 'internal', executionMode: 'host-automated', screenshotPath, visualInspection: screenshotPath ? 'performed' : 'not-required' });
  checkpointRun(root, run);
  return run;
}

export function completeAgentGuidedRun(root: string, task: TestTask, runId: string): TestRun {
  const run = readRunById(root, runId);
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  const currentTask = readTask(root, run.moduleId, run.taskId);
  if (!executionContractIsCurrent(currentTask, run.planHash)) return block(root, currentTask, run, requiresTestPlanApproval(currentTask) ? 'Task plan changed after this Run started. Stop execution and obtain a new TestPlan approval before retrying.' : 'Quick Task execution contract changed after this Run started. Stop execution and refresh the Task before retrying.', 'needs_confirmation');
  task = currentTask;
  const active = task.scenarios.filter(scenario => !run.scenarioId || scenario.id === run.scenarioId);
  const closureIssues = active.flatMap(scenario => {
    const findings = run.visualFindings.filter(item => item.scenarioId === scenario.id);
    if (!findings.length) return [`${scenario.id}: no run observe result was recorded. A passed run step does not satisfy a business assertion.`];
    const missing = (scenario.visualAssertions ?? []).filter(assertion => !findings.some(finding => finding.assertionId === assertion.id));
    const cleanupFindings = run.cleanupFindings.filter(item => item.scenarioId === scenario.id);
    const missingCleanup = scenario.cleanup.filter(cleanup => !cleanupFindings.some(finding => finding.cleanup === cleanup));
    return [
      ...missing.map(assertion => `${scenario.id}: missing run observe for visual assertion ${assertion.id}.`),
      ...missingCleanup.map(cleanup => `${scenario.id}: missing cleanup result for ${cleanup}.`),
    ];
  });
  if (closureIssues.length) throw new Error(`Run ${runId} cannot complete. ${closureIssues.join(' ')} Record every declared assertion with run observe, including expected, actual, terminal status, and screenshot when passing or failing; then retry run complete.`);
  run.scenarioResults = task.scenarios.map(scenario => {
    if (!active.some(item => item.id === scenario.id)) return { scenarioId: scenario.id, status: 'not_applicable' as const, detail: 'Scenario was not selected for this Run.' };
    const findings = run.visualFindings.filter(item => item.scenarioId === scenario.id);
    const cleanup = run.cleanupFindings.filter(item => item.scenarioId === scenario.id);
    return { scenarioId: scenario.id, status: finalStatus([...findings.map(item => item.status), ...cleanup.map(item => item.status)]), detail: [...findings.map(item => `${item.assertionId}: ${item.status}`), ...cleanup.map(item => `cleanup ${item.cleanup}: ${item.status}`)].join('; ') };
  });
  run.status = finalStatus(run.scenarioResults.filter(item => item.status !== 'not_applicable').map(item => item.status));
  run.conclusion = run.status === 'passed'
    ? 'All selected scenarios satisfied their declared business assertions.'
    : run.status === 'adapted'
      ? 'The business flow completed after a semantic locator adaptation without changing business meaning.'
      : run.status === 'failed'
        ? 'At least one business assertion did not match the observed result.'
        : 'Run lacks complete evidence or was stopped by a safety or precondition rule.';
  return finish(root, task, run);
}

function finalStatus(statuses: RunStatus[]): RunStatus {
  if (!statuses.length || statuses.includes('pending') || statuses.includes('running')) return 'blocked';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('needs_confirmation')) return 'needs_confirmation';
  if (statuses.includes('inconclusive')) return 'inconclusive';
  if (statuses.includes('paused')) return 'paused';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('adapted')) return 'adapted';
  if (statuses.every(status => status === 'not_applicable')) return 'not_applicable';
  return 'passed';
}
