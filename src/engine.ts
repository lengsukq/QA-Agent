import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { capabilityAdvice, capabilitySnapshot, checkCapabilities, platformCapabilities } from './capabilities.ts';
import { checkpointRun, gitMetadata, qaPath, readTask, saveRun } from './project.ts';
import { rebuildIndexes } from './indexer.ts';
import { hasSecrets, now, readJson, writeJsonAtomic } from './store.ts';
import { writeReport } from './report.ts';
import { executeBrowserScenario, type PlaywrightAdapterConfig, SafetyStopError } from './playwright-adapter.ts';
import { curateFailedRun, curateObservedBusinessRules } from './memory.ts';
import type { ExecutionSnapshot, Locator, OperationAction, RunStatus, TestRun, TestTask, VisualInspectionStatus } from './types.ts';
import { approvalIsCurrent } from './approval.ts';
import { approvedOperationForReplay, createOperationCandidates, readOperation } from './operations.ts';
import { assertRecoveryAction, assertSafeAction, type RecoveryAction } from './safety.ts';

type RunContextInput = Partial<ExecutionSnapshot> & { operationId?: string; scenarioId?: string };

function newRun(root: string, task: TestTask, input: RunContextInput = {}): TestRun {
  const startedAt = now();
  const policy = readJson<{ safeMode: boolean }>(qaPath(root, 'policies.json'));
  const platform = input.platform ?? task.scope.platforms[0] ?? 'web';
  const snapshot = capabilitySnapshot(root, platform);
  const context: ExecutionSnapshot = {
    environment: input.environment ?? task.scope.environments[0] ?? 'local', platform, role: input.role ?? task.scope.roles[0] ?? 'default',
    scenarioId: input.scenarioId, device: input.device, deviceModel: input.deviceModel, osVersion: input.osVersion,
    appVersion: input.appVersion, webBuild: input.webBuild, testDataFingerprint: input.testDataFingerprint,
    mcpSnapshot: input.mcpSnapshot ?? snapshot.mcpSnapshot, permissionSnapshot: input.permissionSnapshot ?? snapshot.permissionSnapshot,
  };
  return {
    $schema: '../../schemas/run.schema.json', id: `run-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    taskId: task.metadata.id, moduleId: task.metadata.moduleId, context, git: gitMetadata(root), status: 'pending', safeMode: policy.safeMode,
    steps: [], scenarioResults: [], evidence: [], visualFindings: [], replayStatus: 'not_replay', replayStage: 'idle', replayCursor: 0,
    scenarioId: input.scenarioId, screenshots: [], recoveryAttempts: [], startedAt,
  };
}

function finish(root: string, task: TestTask, run: TestRun): TestRun {
  run.completedAt = now();
  const memoryCandidates = [curateFailedRun(root, task, run), curateObservedBusinessRules(root, task, run)].filter((id): id is string => Boolean(id));
  if (memoryCandidates.length) run.memoryCandidates = memoryCandidates;
  const operationCandidates = createOperationCandidates(root, task, run);
  if (operationCandidates.length) run.operationCandidates = operationCandidates;
  run.reportPath = `reports/${run.id}.md`;
  writeReport(root, task, run); saveRun(root, run); rebuildIndexes(root); return run;
}

function preflightStatus(detail: string): RunStatus {
  return /plan hash|approval|scenario|business|confirmation|operation .*changed|flow/i.test(detail) ? 'needs_confirmation' : 'blocked';
}

function retryDepth(root: string, retryOf?: string): number {
  let depth = 0;
  let current = retryOf;
  while (current) {
    depth += 1;
    const path = qaPath(root, 'runs', `${current}.json`);
    if (!existsSync(path)) break;
    current = readJson<TestRun>(path).retryOf;
  }
  return depth;
}

function block(root: string, task: TestTask, run: TestRun, detail: string, status: RunStatus = preflightStatus(detail)): TestRun {
  run.status = status; run.replayStage = status === 'needs_confirmation' ? 'needs_confirmation' : 'blocked';
  run.steps.push({ id: 'preflight', action: 'Execution preflight', status, detail, at: now(), source: 'internal' });
  run.evidence.push({ type: 'preflight', summary: detail });
  run.scenarioResults = task.scenarios.map(scenario => ({ scenarioId: scenario.id, status, detail }));
  run.conclusion = status === 'needs_confirmation' ? 'Execution paused because the reviewed business contract or replay meaning needs user confirmation.' : 'Execution did not start because a capability, permission, device, environment, or safety precondition was unavailable.';
  return finish(root, task, run);
}

export async function executeTask(root: string, task: TestTask, context: RunContextInput = {}, retryOf?: string): Promise<TestRun> {
  const run = newRun(root, task, context); run.retryOf = retryOf;
  if (retryOf && retryDepth(root, retryOf) >= task.recoveryPolicy.maxRetries) return block(root, task, run, `Retry limit ${task.recoveryPolicy.maxRetries} was reached.`, 'blocked');
  const policy = readJson<{ safeMode: boolean; prohibitedActions: string[]; stopBefore: string[] }>(qaPath(root, 'policies.json'));
  if (!['ready', 'active'].includes(task.metadata.status)) return block(root, task, run, `Task status is ${task.metadata.status}; review and mark it ready before execution.`);
  if (!approvalIsCurrent(task)) return block(root, task, run, 'Generated test cases are unapproved or changed after approval. Present the current plan and obtain user confirmation before execution.', 'needs_confirmation');
  const capabilities = checkCapabilities(root, [...new Set([...task.capabilities.required, ...platformCapabilities(run.context.platform)])], task.capabilities.optional);
  if (capabilities.missing.length) return block(root, task, run, `Missing required capabilities: ${capabilities.missing.join(', ')}. ${capabilityAdvice(capabilities.missing).join(' ')}`, 'blocked');
  if (run.context.platform !== 'web') return block(root, task, run, `Platform ${run.context.platform} requires an Agent-guided mobile Run with the approved simulator/device MCP.`, 'blocked');
  const adapterPath = qaPath(root, 'adapters', 'playwright.json');
  if (!existsSync(adapterPath)) return block(root, task, run, 'Browser capabilities are declared but no validated Playwright adapter configuration exists.', 'blocked');
  const config = readJson<PlaywrightAdapterConfig>(adapterPath);
  const executable = task.scenarios.filter(scenario => (scenario.execution?.steps.length ?? 0) > 0);
  if (!executable.length) return block(root, task, run, 'No deterministic Scenario execution runbook exists.', 'blocked');
  const prohibited = executable.flatMap(scenario => scenario.execution?.steps ?? []).map(step => step.safetyAction).filter((action): action is string => Boolean(action)).filter(action => policy.prohibitedActions.includes(action));
  if (prohibited.length) return block(root, task, run, `Task contains prohibited actions: ${[...new Set(prohibited)].join(', ')}.`, 'paused');
  run.status = 'running'; run.replayStage = 'step_pending';
  run.steps.push({ id: 'capability-check', action: 'Capability preflight', status: 'passed', detail: `Required capabilities available. Optional missing: ${capabilities.optionalMissing.join(', ') || 'none'}.`, at: now(), source: 'internal' }); checkpointRun(root, run);
  for (const scenario of executable) {
    try {
      const result = await executeBrowserScenario({ root, runId: run.id, scenario, config, stopBefore: [...policy.stopBefore, ...task.safety.stopBefore], prohibitedActions: policy.prohibitedActions });
      run.steps.push(...result.steps); run.evidence.push(...result.evidence); run.scenarioResults.push({ scenarioId: scenario.id, status: 'passed', detail: `Verified at ${result.url}.` });
    } catch (error) {
      const resultError = error as Error & { qaEvidence?: TestRun['evidence']; qaSteps?: TestRun['steps'] };
      if (resultError.qaEvidence) run.evidence.push(...resultError.qaEvidence); if (resultError.qaSteps) run.steps.push(...resultError.qaSteps);
      const status: RunStatus = resultError instanceof SafetyStopError ? 'paused' : 'failed'; run.steps.push({ id: `scenario-${scenario.id}`, action: 'Execute scenario', status, detail: resultError.message, at: now(), source: 'internal' }); run.scenarioResults.push({ scenarioId: scenario.id, status, detail: resultError.message });
    }
    checkpointRun(root, run);
  }
  run.status = finalStatus(run.scenarioResults.map(result => result.status)); run.replayStage = run.status === 'passed' ? 'completed' : run.replayStage;
  run.conclusion = run.status === 'passed' ? 'All executable scenarios satisfied their declared assertions.' : run.status === 'failed' ? 'At least one scenario did not satisfy its declared assertions.' : 'Run did not complete; inspect the recorded blocker or safety pause.';
  return finish(root, task, run);
}

export function beginAgentGuidedRun(root: string, task: TestTask, context: RunContextInput = {}): TestRun {
  const run = newRun(root, task, context);
  if (!['ready', 'active'].includes(task.metadata.status)) return block(root, task, run, `Task status is ${task.metadata.status}; review and mark it ready before execution.`);
  if (!approvalIsCurrent(task)) return block(root, task, run, 'Generated test cases are unapproved or changed after approval. Present the current plan and obtain user confirmation before execution.', 'needs_confirmation');
  const required = [...new Set([...task.capabilities.required, ...platformCapabilities(run.context.platform)])];
  const capabilities = checkCapabilities(root, required, task.capabilities.optional);
  if (capabilities.missing.length) return block(root, task, run, `Missing required capabilities: ${capabilities.missing.join(', ')}. ${capabilityAdvice(capabilities.missing).join(' ')}`, 'blocked');
  if (run.context.platform !== 'web' && run.context.permissionSnapshot.status !== 'verified') return block(root, task, run, 'macOS/MCP permissions are not verified. Run mobile doctor, grant Screen Recording and Accessibility, then retry.', 'blocked');
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

export function recordAgentStep(root: string, runId: string, input: { action: string; operationAction?: OperationAction; safetyAction?: string; detail: string; status?: RunStatus; screenshotPath?: string; visualInspection?: VisualInspectionStatus; source?: TestRun['steps'][number]['source']; operationStepId?: string; scenarioId?: string; locator?: Locator; actualLocator?: Locator; inputRefs?: Record<string, string>; expectedState?: string; actualState?: string; adaptation?: string }): TestRun {
  const run = readJson<TestRun>(qaPath(root, 'runs', `${runId}.json`)); if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  const task = readTask(root, run.moduleId, run.taskId); const scenarioId = input.scenarioId ?? run.scenarioId ?? (task.scenarios.length === 1 ? task.scenarios[0]?.id : undefined);
  if (!scenarioId) throw new Error('A UI step must specify --scenario when the Task contains multiple scenarios.');
  const source = input.source ?? (run.replayStatus === 'replayed' || run.replayStatus === 'adapted' ? 'operation-replay' : 'ui'); const visualInspection = input.visualInspection ?? 'not-required';
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
  run.steps.push({ id: stepId, action: input.action, operationAction: input.operationAction, safetyAction: input.safetyAction, status: input.status ?? 'passed', detail: input.detail, at: now(), scenarioId, screenshotPath, visualInspection, source, operationStepId: input.operationStepId, locator: input.locator, actualLocator: input.actualLocator, inputRefs: input.inputRefs, expectedState: input.expectedState, actualState: input.actualState, adaptation: input.adaptation });
  if (run.replayStatus !== 'not_replay') { if (input.status === 'adapted' || input.adaptation) run.replayStatus = 'adapted'; run.replayCursor = (run.replayCursor ?? 0) + 1; run.replayStage = visualInspection === 'performed' ? 'assertion_checked' : 'visual_check_optional'; }
  checkpointRun(root, run); return run;
}

function captureScreenshot(root: string, run: TestRun, stepId: string, sourcePath: string, visualInspection: VisualInspectionStatus, summary: string): string {
  if (!existsSync(sourcePath)) throw new Error(`Screenshot does not exist: ${sourcePath}`);
  const destination = join(qaPath(root, 'evidence', run.id, 'steps', `${stepId}-${basename(sourcePath)}`)); mkdirSync(join(destination, '..'), { recursive: true }); copyFileSync(sourcePath, destination);
  const relativePath = destination.slice(qaPath(root).length + 1); run.screenshots.push({ stepId, path: relativePath, capturedAt: now(), visualInspection, summary }); run.evidence.push({ type: 'screenshot', path: relativePath, summary: `Screenshot captured: ${summary}` }); if (run.replayStatus !== 'not_replay') run.replayStage = 'screenshot_captured'; return relativePath;
}

export function recordRecoveryAttempt(root: string, runId: string, input: { reason: string; action: string; outcome: 'continued' | 'blocked' | 'paused' | 'failed'; detail: string; failedStepId?: string }): TestRun {
  const run = readJson<TestRun>(qaPath(root, 'runs', `${runId}.json`)); if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  assertRecoveryAction(input.action); const task = readTask(root, run.moduleId, run.taskId); const max = task.recoveryPolicy.maxRecoveryAttempts; if (run.recoveryAttempts.length >= max) return block(root, task, run, `Recovery attempt limit ${max} was reached.`, 'blocked'); if (input.action === 'reset-sandbox-data' && !task.recoveryPolicy.allowSandboxDataReset) throw new Error('Task recovery policy does not allow sandbox data reset.');
  const attempt = { id: `recovery-${run.recoveryAttempts.length + 1}`, reason: input.reason, action: input.action, outcome: input.outcome, detail: input.detail, failedStepId: input.failedStepId, at: now() };
  run.recoveryAttempts.push(attempt); run.steps.push({ id: attempt.id, action: `Recovery: ${input.action}`, status: input.outcome === 'continued' ? 'passed' : input.outcome, detail: `${input.reason}\n${input.detail}`, at: attempt.at, source: 'recovery', scenarioId: run.scenarioId, visualInspection: 'not-required' });
  if (input.outcome === 'continued') { run.status = 'running'; run.replayStage = run.replayStatus === 'not_replay' ? 'ready' : 'step_pending'; checkpointRun(root, run); return run; }
  run.status = input.outcome; run.replayStage = input.outcome === 'paused' ? 'blocked' : 'blocked'; run.scenarioResults = task.scenarios.map(scenario => ({ scenarioId: scenario.id, status: input.outcome, detail: `Recovery stopped the run: ${input.detail}` })); run.conclusion = `Run stopped during recovery: ${input.outcome}.`; return finish(root, task, run);
}

export function recordVisualFinding(root: string, runId: string, input: { scenarioId: string; assertionId: string; expected: string; actual: string; status: RunStatus; screenshotPath?: string; inspectionProvider?: string }): TestRun {
  const run = readJson<TestRun>(qaPath(root, 'runs', `${runId}.json`)); if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
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

export function completeAgentGuidedRun(root: string, task: TestTask, runId: string): TestRun {
  const run = readJson<TestRun>(qaPath(root, 'runs', `${runId}.json`)); if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  if (run.replayStatus !== 'not_replay' && run.operationPlanId) { const operation = readOperation(root, task, run.operationPlanId); if ((run.replayCursor ?? 0) < operation.steps.length) return block(root, task, run, `Replay is incomplete: ${operation.steps.length - (run.replayCursor ?? 0)} Operation steps remain.`, 'blocked'); }
  const active = task.scenarios.filter(scenario => !run.scenarioId || scenario.id === run.scenarioId);
  run.scenarioResults = task.scenarios.map(scenario => {
    if (!active.some(item => item.id === scenario.id)) return { scenarioId: scenario.id, status: 'not_applicable' as const, detail: 'Scenario was not selected for this Run.' };
    const findings = run.visualFindings.filter(item => item.scenarioId === scenario.id); if (!findings.length) return { scenarioId: scenario.id, status: 'blocked' as const, detail: 'No visual business observation was recorded for this scenario.' };
    const missing = (scenario.visualAssertions ?? []).filter(assertion => !findings.some(finding => finding.assertionId === assertion.id)); if (missing.length) return { scenarioId: scenario.id, status: 'blocked' as const, detail: `Missing visual evidence for: ${missing.map(item => item.id).join(', ')}.` };
    return { scenarioId: scenario.id, status: finalStatus(findings.map(item => item.status)), detail: findings.map(item => `${item.assertionId}: ${item.status}`).join('; ') };
  });
  run.status = finalStatus(run.scenarioResults.filter(item => item.status !== 'not_applicable').map(item => item.status)); if (run.status === 'passed' && run.replayStatus === 'adapted') run.status = 'adapted'; run.replayStage = 'completed';
  run.conclusion = run.status === 'passed' ? 'All selected scenarios satisfied their declared business assertions.' : run.status === 'adapted' ? 'The replay completed after semantic locator adaptation without changing business meaning.' : run.status === 'failed' ? 'At least one business assertion did not match the observed result.' : 'Run lacks complete evidence or was stopped by a safety or precondition rule.';
  return finish(root, task, run);
}

function finalStatus(statuses: RunStatus[]): RunStatus {
  if (!statuses.length || statuses.includes('pending') || statuses.includes('running')) return 'blocked'; if (statuses.includes('failed')) return 'failed'; if (statuses.includes('needs_confirmation')) return 'needs_confirmation'; if (statuses.includes('inconclusive')) return 'inconclusive'; if (statuses.includes('paused')) return 'paused'; if (statuses.includes('blocked')) return 'blocked'; if (statuses.includes('adapted')) return 'adapted'; if (statuses.every(status => status === 'not_applicable')) return 'not_applicable'; return 'passed';
}

export function configurePlaywrightAdapter(root: string, baseUrl: string, headless = true): void {
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('Playwright base URL must start with http:// or https://.');
  writeJsonAtomic(qaPath(root, 'adapters', 'playwright.json'), { version: 2, kind: 'playwright', baseUrl, headless, configuredAt: now(), capabilities: ['browser.interact', 'browser.inspect'] } satisfies PlaywrightAdapterConfig);
}
