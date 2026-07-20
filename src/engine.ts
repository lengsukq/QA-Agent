import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { capabilityAdvice, capabilitySnapshot, checkCapabilities, platformCapabilities } from './capabilities.ts';
import { checkpointRun, gitMetadata, qaPath, readProjectPromptBundle, readRunById, readTask, saveRun, saveTask, taskDirectory, taskEvidenceDirectory, taskReportDirectory } from './project.ts';
import { rebuildIndexes } from './indexer.ts';
import { hasSecrets, now, readJson, writeJsonAtomic } from './store.ts';
import { writeReport } from './report.ts';
import { curateFailedRun, curateObservedBusinessRules } from './memory.ts';
import type { ExecutionSnapshot, Locator, OperationAction, RegressionRun, RegressionSuite, RunStatus, StepExecutionMode, TestRun, TestTask, VisualInspectionStatus } from './types.ts';
import { approvalIsCurrent } from './approval.ts';
import { approvedOperationForReplay, createOperationCandidates, readOperation } from './operations.ts';
import { assertRecoveryAction, assertSafeAction, type RecoveryAction } from './safety.ts';
import { newRegressionRun, saveRegressionRun, suitePreflight, writeRegressionReport } from './regression.ts';

type RunContextInput = Partial<ExecutionSnapshot> & { operationId?: string; scenarioId?: string };

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
  const context = buildExecutionSnapshot(root, task, input);
  return {
    $schema: '../../../../schemas/run.schema.json', id: `run-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    taskId: task.metadata.id, moduleId: task.metadata.moduleId, context, git: gitMetadata(root), status: 'pending', safeMode: policy.safeMode,
    steps: [], scenarioResults: [], evidence: [], visualFindings: [], replayStatus: 'not_replay', replayStage: 'idle', replayCursor: 0,
    scenarioId: input.scenarioId, screenshots: [], recoveryAttempts: [], cleanupFindings: [], startedAt,
  };
}

export function beginRegressionRun(root: string, suite: RegressionSuite, context: ExecutionSnapshot): RegressionRun {
  const run = newRegressionRun(suite, context);
  const errors = suitePreflight(root, suite, context);
  if (errors.length) {
    run.status = errors.some(error => /plan hash|approval|changed|confirmation/i.test(error)) ? 'needs_confirmation' : 'blocked';
    run.childRuns = suite.members.map(member => ({ runId: '', taskId: member.taskId, moduleId: member.moduleId, scenarioId: member.scenarioId, operationPlanId: member.operationPlanId, priority: member.priority, releaseGate: member.releaseGate, status: run.status, detail: errors.find(error => error.includes(member.taskId)) ?? errors.join(' ') }));
    run.completedAt = now(); run.reportPath = run.suiteScope === 'release' ? `reports/${run.id}.md` : `modules/${run.moduleId}/reports/${run.id}.md`; saveRegressionRun(root, run); writeRegressionReport(root, run); return run;
  }
  for (const member of suite.members) {
    const task = readTask(root, member.moduleId, member.taskId);
    const child = beginAgentGuidedRun(root, task, { ...context, scenarioId: member.scenarioId, operationId: member.operationPlanId });
    run.childRuns.push({ runId: child.id, taskId: member.taskId, moduleId: member.moduleId, scenarioId: member.scenarioId, operationPlanId: member.operationPlanId, priority: member.priority, releaseGate: member.releaseGate, status: child.status, reportPath: child.reportPath, detail: child.conclusion });
  }
  saveRegressionRun(root, run); return run;
}

export function completeRegressionRun(root: string, run: RegressionRun): RegressionRun {
  for (const child of run.childRuns) {
    if (!child.runId) continue;
    try { const childRun = readRunById(root, child.runId); child.status = childRun.status; child.reportPath = childRun.reportPath; child.detail = childRun.conclusion; } catch { /* Child may not have been started by the host yet. */ }
  }
  if (run.childRuns.some(child => child.status === 'running' || child.status === 'pending')) return run;
  const statuses = run.childRuns.map(child => child.status);
  run.status = finalStatus(statuses); run.completedAt = now(); run.reportPath = run.suiteScope === 'release' ? `reports/${run.id}.md` : `modules/${run.moduleId}/reports/${run.id}.md`; saveRegressionRun(root, run); writeRegressionReport(root, run); return run;
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
  const operationCandidateResult = createOperationCandidates(root, task, run);
  if (operationCandidateResult.candidates.length) run.operationCandidates = operationCandidateResult.candidates;
  if (operationCandidateResult.issues.length) {
    run.operationCandidateIssues = operationCandidateResult.issues;
    if (run.status === 'passed' || run.status === 'adapted') {
      const summary = operationCandidateResult.issues.flatMap(item => item.reasons.map(reason => `${item.scenarioId}: ${reason}`)).join(' ');
      run.conclusion = `${run.conclusion ?? 'Business verification completed.'} No OperationPlan candidate was generated because the replay contract is incomplete. ${summary}`;
    }
  }
  run.reportPath = `reports/${run.id}.md`;
  task.runRefs ??= []; const runRef = `runs/${run.id}/run.json`; if (!task.runRefs.includes(runRef)) task.runRefs.push(runRef); task.updatedAt = now();
  writeReport(root, task, run); saveRun(root, run); saveTask(root, task);
  const reportDirectory = taskReportDirectory(root, task.metadata.moduleId, task.metadata.id);
  const reportIndexPath = join(reportDirectory, 'index.json');
  const reportIndex = existsSync(reportIndexPath) ? readJson<{ runs: Array<Record<string, unknown>> }>(reportIndexPath) : { runs: [] };
  reportIndex.runs = [{ runId: run.id, status: run.status, reportPath: run.reportPath, completedAt: run.completedAt }, ...reportIndex.runs.filter(item => item.runId !== run.id)];
  writeJsonAtomic(reportIndexPath, { version: 1, updatedAt: now(), runs: reportIndex.runs });
  writeJsonAtomic(join(reportDirectory, 'latest.json'), { runId: run.id, reportPath: run.reportPath, status: run.status, updatedAt: now() });
  rebuildIndexes(root); return run;
}

function preflightStatus(detail: string): RunStatus {
  return /plan hash|approval|scenario|business|confirmation|operation .*changed|flow/i.test(detail) ? 'needs_confirmation' : 'blocked';
}

function block(root: string, task: TestTask, run: TestRun, detail: string, status: RunStatus = preflightStatus(detail)): TestRun {
  run.status = status; run.replayStage = status === 'needs_confirmation' ? 'needs_confirmation' : 'blocked';
  run.steps.push({ id: 'preflight', action: 'Execution preflight', status, detail, at: now(), source: 'internal' });
  run.evidence.push({ type: 'preflight', summary: detail });
  run.scenarioResults = task.scenarios.map(scenario => ({ scenarioId: scenario.id, status, detail }));
  run.conclusion = status === 'needs_confirmation' ? 'Execution paused because the reviewed business contract or replay meaning needs user confirmation.' : 'Execution did not start because a capability, permission, device, environment, or safety precondition was unavailable.';
  return finish(root, task, run);
}

export function beginAgentGuidedRun(root: string, task: TestTask, context: RunContextInput = {}): TestRun {
  const run = newRun(root, task, context);
  const promptBundle = readProjectPromptBundle(root);
  if (!promptBundle.current) return block(root, task, run, `Canonical project prompts are missing or stale. Run qa-agent prompts sync before execution. Missing: ${promptBundle.missing.join(', ') || 'none'}. Stale: ${promptBundle.stale.join(', ') || 'none'}.`, 'needs_confirmation');
  if (!['ready', 'active'].includes(task.metadata.status)) return block(root, task, run, `Task status is ${task.metadata.status}; review and mark it ready before execution.`);
  if (!approvalIsCurrent(task)) return block(root, task, run, 'Generated test cases are unapproved or changed after approval. Present the current plan and obtain user confirmation before execution.', 'needs_confirmation');
  const required = [...new Set([...task.capabilities.required, ...platformCapabilities(run.context.platform)])];
  const capabilities = checkCapabilities(root, required, task.capabilities.optional);
  if (capabilities.missing.length) return block(root, task, run, `Missing required capabilities: ${capabilities.missing.join(', ')}. ${capabilityAdvice(capabilities.missing).join(' ')}`, 'blocked');
  if (run.context.platform !== 'web' && run.context.permissionSnapshot.status !== 'verified') return block(root, task, run, 'macOS/MCP permissions are not verified. Run host doctor --platform android|ios, grant Screen Recording and Accessibility, then retry.', 'blocked');
  if (context.operationId) {
    try {
      const operation = approvedOperationForReplay(root, task, context.operationId, run.context);
      run.replayStatus = 'replayed'; run.replayStage = 'preflight_passed'; run.operationPlanId = operation.id; run.operationVersion = operation.version; run.scenarioId = operation.scenarioId; run.context.scenarioId = operation.scenarioId; run.replayCursor = 0;
      run.steps.push({ id: 'replay-preflight', action: 'Load approved OperationPlan', status: 'passed', detail: `Replay ${operation.id} v${operation.version} passed plan, context, capability, MCP, and permission checks.`, at: now(), source: 'internal' });
    } catch (error) { return block(root, task, run, (error as Error).message); }
  }
  run.status = 'running'; if (run.replayStatus === 'not_replay') run.replayStage = 'ready';
  run.steps.push({ id: 'agent-guided-preflight', action: 'Agent-guided execution preflight', status: 'passed', detail: `Required capabilities are available. Host MCP must execute the real browser, simulator, or device action. Capture a screenshot after every real UI action and inspect only adaptive checkpoints.`, at: now(), source: 'internal' });
  checkpointRun(root, run); return run;
}

export function recordAgentStep(root: string, runId: string, input: { action: string; operationAction?: OperationAction; safetyAction?: string; detail: string; status?: RunStatus; screenshotPath?: string; visualInspection?: VisualInspectionStatus; source?: TestRun['steps'][number]['source']; executionMode?: StepExecutionMode; operationStepId?: string; scenarioId?: string; locator?: Locator; actualLocator?: Locator; inputRefs?: Record<string, string>; expectedState?: string; actualState?: string; adaptation?: string }): TestRun {
  const run = readRunById(root, runId); if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  const task = readTask(root, run.moduleId, run.taskId); const scenarioId = input.scenarioId ?? run.scenarioId ?? (task.scenarios.length === 1 ? task.scenarios[0]?.id : undefined);
  if (!scenarioId) throw new Error('A UI step must specify --scenario when the Task contains multiple scenarios.');
  const source = input.source ?? (run.replayStatus === 'replayed' || run.replayStatus === 'adapted' ? 'operation-replay' : 'ui'); const visualInspection = input.visualInspection ?? 'not-required'; const executionMode = input.executionMode ?? 'host-automated';
  if (executionMode === 'system-component-blocked' && ['passed', 'adapted'].includes(input.status ?? 'passed')) throw new Error('A system-component-blocked step cannot be recorded as passed or adapted. Use blocked, paused, or inconclusive.');
  assertSafeAction(root, input.action, input.safetyAction);
  if (hasSecrets({ inputRefs: input.inputRefs, detail: input.detail, locator: input.locator, actualLocator: input.actualLocator })) throw new Error('Operation step contains a potential secret. Use an env: reference instead.');
  const stepId = `agent-${run.steps.length + 1}`;
  if (source === 'ui' || source === 'operation-replay') { if (!input.screenshotPath) throw new Error('Every real UI action requires --screenshot.'); }
  if (run.replayStatus !== 'not_replay') {
    if (!run.operationPlanId || !input.operationStepId) throw new Error('Replay UI actions must reference operationStepId.');
    const operation = readOperation(root, task, run.operationPlanId); const expected = operation.steps[run.replayCursor ?? 0];
    if (!expected || expected.id !== input.operationStepId) throw new Error(`Replay step order violation: expected ${expected?.id ?? 'completed'}, received ${input.operationStepId}.`);
    if (input.scenarioId && input.scenarioId !== expected.scenarioId) throw new Error(`Replay scenario mismatch: expected ${expected.scenarioId}.`);
    run.replayStage = 'executing';
  }
  const screenshotPath = input.screenshotPath ? captureScreenshot(root, run, stepId, input.screenshotPath, visualInspection, `${input.action}: ${input.detail}`) : undefined;
  run.steps.push({ id: stepId, action: input.action, operationAction: input.operationAction, safetyAction: input.safetyAction, status: input.status ?? 'passed', detail: input.detail, at: now(), scenarioId, screenshotPath, visualInspection, source, executionMode, operationStepId: input.operationStepId, locator: input.locator, actualLocator: input.actualLocator, inputRefs: input.inputRefs, expectedState: input.expectedState, actualState: input.actualState, adaptation: input.adaptation });
  if (run.replayStatus !== 'not_replay') { if (input.status === 'adapted' || input.adaptation) run.replayStatus = 'adapted'; run.replayCursor = (run.replayCursor ?? 0) + 1; run.replayStage = visualInspection === 'performed' ? 'assertion_checked' : 'visual_check_optional'; }
  checkpointRun(root, run); return run;
}

function captureScreenshot(root: string, run: TestRun, stepId: string, sourcePath: string, visualInspection: VisualInspectionStatus, summary: string): string {
  if (!existsSync(sourcePath)) throw new Error(`Screenshot does not exist: ${sourcePath}`);
  const destination = join(taskEvidenceDirectory(root, run.moduleId, run.taskId, run.id), 'screenshots', 'steps', `${stepId}-${basename(sourcePath)}`); mkdirSync(join(destination, '..'), { recursive: true }); copyFileSync(sourcePath, destination);
  const relativePath = destination.slice(taskDirectory(root, run.moduleId, run.taskId).length + 1); run.screenshots.push({ stepId, path: relativePath, capturedAt: now(), visualInspection, summary }); run.evidence.push({ type: 'screenshot', path: relativePath, summary: `Screenshot captured: ${summary}` }); if (run.replayStatus !== 'not_replay') run.replayStage = 'screenshot_captured'; return relativePath;
}

/** Import an artifact produced by the host tool; this runtime never captures it itself. */
export function recordHostEvidence(root: string, runId: string, input: { type: string; summary: string; artifactPath?: string }): TestRun {
  const run = readRunById(root, runId);
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  if (!input.type.trim() || !input.summary.trim()) throw new Error('Evidence type and summary are required.');
  if (hasSecrets({ summary: input.summary })) throw new Error('Evidence summary contains a potential secret.');
  let path: string | undefined;
  if (input.artifactPath) {
    if (!existsSync(input.artifactPath)) throw new Error(`Evidence artifact does not exist: ${input.artifactPath}`);
    const destination = join(taskEvidenceDirectory(root, run.moduleId, run.taskId, run.id), 'artifacts', `${run.evidence.length + 1}-${basename(input.artifactPath)}`);
    mkdirSync(join(destination, '..'), { recursive: true }); copyFileSync(input.artifactPath, destination);
    path = destination.slice(taskDirectory(root, run.moduleId, run.taskId).length + 1);
  }
  run.evidence.push({ type: input.type, path, summary: input.summary });
  checkpointRun(root, run);
  return run;
}

export function recordRecoveryAttempt(root: string, runId: string, input: { reason: string; action: string; outcome: 'continued' | 'blocked' | 'paused' | 'failed'; detail: string; failedStepId?: string }): TestRun {
  const run = readRunById(root, runId); if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  assertRecoveryAction(input.action); const task = readTask(root, run.moduleId, run.taskId); const max = task.recoveryPolicy.maxRecoveryAttempts; if (run.recoveryAttempts.length >= max) return block(root, task, run, `Recovery attempt limit ${max} was reached.`, 'blocked'); if (input.action === 'reset-sandbox-data' && !task.recoveryPolicy.allowSandboxDataReset) throw new Error('Task recovery policy does not allow sandbox data reset.');
  const attempt = { id: `recovery-${run.recoveryAttempts.length + 1}`, reason: input.reason, action: input.action, outcome: input.outcome, detail: input.detail, failedStepId: input.failedStepId, at: now() };
  run.recoveryAttempts.push(attempt); run.steps.push({ id: attempt.id, action: `Recovery: ${input.action}`, status: input.outcome === 'continued' ? 'passed' : input.outcome, detail: `${input.reason}\n${input.detail}`, at: attempt.at, source: 'recovery', scenarioId: run.scenarioId, visualInspection: 'not-required' });
  if (input.outcome === 'continued') { run.status = 'running'; run.replayStage = run.replayStatus === 'not_replay' ? 'ready' : 'step_pending'; checkpointRun(root, run); return run; }
  run.status = input.outcome; run.replayStage = input.outcome === 'paused' ? 'blocked' : 'blocked'; run.scenarioResults = task.scenarios.map(scenario => ({ scenarioId: scenario.id, status: input.outcome, detail: `Recovery stopped the run: ${input.detail}` })); run.conclusion = `Run stopped during recovery: ${input.outcome}.`; return finish(root, task, run);
}

export function recordVisualFinding(root: string, runId: string, input: { scenarioId: string; assertionId: string; expected: string; actual: string; status: RunStatus; screenshotPath?: string; inspectionProvider?: string }): TestRun {
  const run = readRunById(root, runId); if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  if (!['passed', 'failed', 'blocked', 'paused', 'inconclusive', 'not_applicable', 'needs_confirmation', 'adapted'].includes(input.status)) throw new Error('A visual observation must use a terminal QA conclusion status.');
  const task = readTask(root, run.moduleId, run.taskId); const scenario = task.scenarios.find(item => item.id === input.scenarioId); if (!scenario) throw new Error(`Scenario ${input.scenarioId} does not belong to task ${run.taskId}.`);
  if (run.scenarioId && run.scenarioId !== input.scenarioId) throw new Error(`Run is scoped to scenario ${run.scenarioId}; received visual finding for ${input.scenarioId}.`);
  if (scenario.visualAssertions?.length && !scenario.visualAssertions.some(item => item.id === input.assertionId)) throw new Error(`Visual assertion ${input.assertionId} is not declared for scenario ${input.scenarioId}.`);
  if (['passed', 'failed', 'adapted'].includes(input.status) && !input.screenshotPath) throw new Error('A terminal visual observation requires a screenshot artifact.');
  let screenshotPath: string | undefined;
  if (input.screenshotPath) screenshotPath = captureScreenshot(root, run, `visual-${input.assertionId}-${run.visualFindings.length + 1}`, input.screenshotPath, 'performed', `Visual assertion ${input.assertionId}`);
  const finding = { scenarioId: input.scenarioId, assertionId: input.assertionId, expected: input.expected, actual: input.actual, status: input.status, screenshotPath, visualInspection: 'performed' as const, inspectionProvider: input.inspectionProvider, at: now() }; run.visualFindings.push(finding);
  run.steps.push({ id: `visual-${input.assertionId}-${run.visualFindings.length}`, action: 'Visual business assertion', status: input.status, detail: `Expected: ${input.expected}\nActual: ${input.actual}`, at: finding.at, scenarioId: input.scenarioId, source: 'internal', visualInspection: 'performed' });
  if (run.replayStatus !== 'not_replay' && input.status === 'adapted') run.replayStatus = 'adapted'; run.replayStage = 'assertion_checked'; checkpointRun(root, run); return run;
}


export function recordCleanupFinding(root: string, runId: string, input: { scenarioId: string; cleanup: string; actual: string; status: RunStatus; screenshotPath?: string }): TestRun {
  const run = readRunById(root, runId); if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  const task = readTask(root, run.moduleId, run.taskId); const scenario = task.scenarios.find(item => item.id === input.scenarioId);
  if (!scenario) throw new Error(`Scenario ${input.scenarioId} does not belong to task ${run.taskId}.`);
  if (run.scenarioId && run.scenarioId !== input.scenarioId) throw new Error(`Run is scoped to scenario ${run.scenarioId}; received cleanup for ${input.scenarioId}.`);
  if (!scenario.cleanup.includes(input.cleanup)) throw new Error(`Cleanup ${input.cleanup} is not declared for scenario ${input.scenarioId}.`);
  if (!['passed', 'failed', 'blocked', 'paused', 'inconclusive', 'not_applicable', 'needs_confirmation'].includes(input.status)) throw new Error('Cleanup must use a terminal status.');
  let screenshotPath: string | undefined;
  if (input.screenshotPath) screenshotPath = captureScreenshot(root, run, `cleanup-${run.cleanupFindings.length + 1}`, input.screenshotPath, 'performed', `Cleanup: ${input.cleanup}`);
  const finding = { scenarioId: input.scenarioId, cleanup: input.cleanup, actual: input.actual, status: input.status, screenshotPath, at: now() };
  run.cleanupFindings.push(finding);
  run.steps.push({ id: `cleanup-${run.cleanupFindings.length}`, action: 'Scenario cleanup', status: input.status, detail: `Cleanup: ${input.cleanup}
Actual: ${input.actual}`, at: finding.at, scenarioId: input.scenarioId, source: 'internal', executionMode: 'host-automated', screenshotPath, visualInspection: screenshotPath ? 'performed' : 'not-required' });
  checkpointRun(root, run); return run;
}

export function completeAgentGuidedRun(root: string, task: TestTask, runId: string): TestRun {
  const run = readRunById(root, runId); if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  if (run.replayStatus !== 'not_replay' && run.operationPlanId) { const operation = readOperation(root, task, run.operationPlanId); if ((run.replayCursor ?? 0) < operation.steps.length) return block(root, task, run, `Replay is incomplete: ${operation.steps.length - (run.replayCursor ?? 0)} Operation steps remain.`, 'blocked'); }
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
  run.status = finalStatus(run.scenarioResults.filter(item => item.status !== 'not_applicable').map(item => item.status)); if (run.status === 'passed' && run.replayStatus === 'adapted') run.status = 'adapted'; run.replayStage = 'completed';
  run.conclusion = run.status === 'passed' ? 'All selected scenarios satisfied their declared business assertions.' : run.status === 'adapted' ? 'The replay completed after semantic locator adaptation without changing business meaning.' : run.status === 'failed' ? 'At least one business assertion did not match the observed result.' : 'Run lacks complete evidence or was stopped by a safety or precondition rule.';
  return finish(root, task, run);
}

function finalStatus(statuses: RunStatus[]): RunStatus {
  if (!statuses.length || statuses.includes('pending') || statuses.includes('running')) return 'blocked'; if (statuses.includes('failed')) return 'failed'; if (statuses.includes('needs_confirmation')) return 'needs_confirmation'; if (statuses.includes('inconclusive')) return 'inconclusive'; if (statuses.includes('paused')) return 'paused'; if (statuses.includes('blocked')) return 'blocked'; if (statuses.includes('adapted')) return 'adapted'; if (statuses.every(status => status === 'not_applicable')) return 'not_applicable'; return 'passed';
}
