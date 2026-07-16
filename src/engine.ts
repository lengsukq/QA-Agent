import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { checkCapabilities, capabilityAdvice, platformCapabilities } from './capabilities.ts';
import { checkpointRun, gitMetadata, qaPath, readTask, saveRun } from './project.ts';
import { now, readJson, writeJsonAtomic } from './store.ts';
import { writeReport } from './report.ts';
import { executeBrowserScenario, type PlaywrightAdapterConfig, SafetyStopError } from './playwright-adapter.ts';
import { curateFailedRun, curateObservedBusinessRules } from './memory.ts';
import type { RunStatus, TestRun, TestTask } from './types.ts';
import { approvalIsCurrent } from './approval.ts';
import { approvedOperationForReplay, createOperationCandidate } from './operations.ts';

function newRun(root: string, task: TestTask, context?: Partial<TestRun['context']>): TestRun {
  const startedAt = now();
  const policy = readJson<{ safeMode: boolean }>(qaPath(root, 'policies.json'));
  return {
    $schema: '../../schemas/run.schema.json', id: `run-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    taskId: task.metadata.id, moduleId: task.metadata.moduleId,
    context: { environment: context?.environment ?? task.scope.environments[0] ?? 'local', platform: context?.platform ?? task.scope.platforms[0] ?? 'web', role: context?.role ?? task.scope.roles[0] ?? 'default' },
    git: gitMetadata(root), status: 'pending', safeMode: policy.safeMode, steps: [], scenarioResults: [], evidence: [], visualFindings: [], replayStatus: 'not_replay', screenshots: [], recoveryAttempts: [], startedAt,
  };
}

function finish(root: string, task: TestTask, run: TestRun): TestRun {
  run.completedAt = now();
  const memoryCandidates = [curateFailedRun(root, task, run), curateObservedBusinessRules(root, task, run)].filter((id): id is string => Boolean(id));
  if (memoryCandidates.length) run.memoryCandidates = memoryCandidates;
  const operationCandidates = createOperationCandidate(root, task, run);
  if (operationCandidates.length) run.operationCandidates = operationCandidates;
  run.reportPath = `reports/${run.id}.md`;
  writeReport(root, task, run);
  saveRun(root, run);
  return run;
}

function block(root: string, task: TestTask, run: TestRun, detail: string): TestRun {
  run.status = 'blocked';
  run.steps.push({ id: 'preflight', action: '运行前检查', status: 'blocked', detail, at: now() });
  run.evidence.push({ type: 'preflight', summary: detail });
  run.scenarioResults = task.scenarios.map(scenario => ({ scenarioId: scenario.id, status: 'blocked', detail }));
  run.conclusion = '测试未执行：运行前置条件未满足，未对业务结果作出断言。';
  return finish(root, task, run);
}

export async function executeTask(root: string, task: TestTask, context?: Partial<TestRun['context']>, retryOf?: string): Promise<TestRun> {
  const run = newRun(root, task, context); run.retryOf = retryOf;
  const policy = readJson<{ safeMode: boolean; prohibitedActions: string[]; stopBefore: string[] }>(qaPath(root, 'policies.json'));
  if (!['ready', 'active'].includes(task.metadata.status)) return block(root, task, run, `Task status is ${task.metadata.status}; review and mark it ready before execution.`);
  if (!approvalIsCurrent(task)) return block(root, task, run, 'Generated test cases are unapproved or changed after approval. Present the current plan and obtain user confirmation before execution.');
  const capabilities = checkCapabilities(root, [...new Set([...task.capabilities.required, ...platformCapabilities(run.context.platform)])], task.capabilities.optional);
  if (capabilities.missing.length) return block(root, task, run, `Missing required capabilities: ${capabilities.missing.join(', ')}. ${capabilityAdvice(capabilities.missing).join(' ')}`);
  if (run.context.platform !== 'web') return block(root, task, run, `Platform ${run.context.platform} requires an Agent-guided mobile Run with the approved simulator/device MCP. The deterministic Playwright adapter only executes web scenarios.`);
  const adapterPath = qaPath(root, 'adapters', 'playwright.json');
  if (!existsSync(adapterPath)) return block(root, task, run, 'Browser capabilities are declared but no validated Playwright adapter configuration exists. Run qa-agent adapter playwright --base-url URL first.');
  const config = readJson<PlaywrightAdapterConfig>(adapterPath);
  const executable = task.scenarios.filter(scenario => (scenario.execution?.steps.length ?? 0) > 0);
  if (!executable.length) return block(root, task, run, 'No deterministic Scenario execution runbook exists. Add explicit steps with qa-agent task runbook before executing UI actions.');
  const prohibited = executable.flatMap(scenario => scenario.execution?.steps ?? []).map(step => step.safetyAction).filter((action): action is string => Boolean(action)).filter(action => policy.prohibitedActions.includes(action));
  if (prohibited.length) return block(root, task, run, `Task contains prohibited actions: ${[...new Set(prohibited)].join(', ')}.`);
  run.status = 'running';
  run.steps.push({ id: 'capability-check', action: '检查能力', status: 'passed', detail: `Required capabilities available. Optional missing: ${capabilities.optionalMissing.join(', ') || 'none'}.`, at: now() });
  checkpointRun(root, run);
  for (const scenario of task.scenarios) {
    if (!scenario.execution?.steps.length) {
      run.scenarioResults.push({ scenarioId: scenario.id, status: 'blocked', detail: 'Scenario has no deterministic runbook.' });
      checkpointRun(root, run);
      continue;
    }
    try {
      const result = await executeBrowserScenario({ root, runId: run.id, scenario, config, stopBefore: [...policy.stopBefore, ...task.safety.stopBefore], prohibitedActions: policy.prohibitedActions });
      run.steps.push(...result.steps); run.evidence.push(...result.evidence);
      run.scenarioResults.push({ scenarioId: scenario.id, status: 'passed', detail: `Verified at ${result.url}.` });
    } catch (error) {
      const resultError = error as Error & { qaEvidence?: TestRun['evidence']; qaSteps?: TestRun['steps'] };
      if (resultError.qaEvidence) run.evidence.push(...resultError.qaEvidence);
      if (resultError.qaSteps) run.steps.push(...resultError.qaSteps);
      const status: RunStatus = resultError instanceof SafetyStopError ? 'paused' : 'failed';
      run.steps.push({ id: `scenario-${scenario.id}`, action: '执行场景', status, detail: resultError.message, at: now() });
      run.scenarioResults.push({ scenarioId: scenario.id, status, detail: resultError.message });
    }
    checkpointRun(root, run);
  }
  run.status = finalStatus(run.scenarioResults.map(result => result.status));
  run.conclusion = run.status === 'passed' ? '所有已执行场景均满足声明的断言。' : run.status === 'failed' ? '至少一个场景未满足声明的断言。请查看报告与证据。' : '运行未完成；请查看阻塞或安全暂停原因。';
  return finish(root, task, run);
}

export function beginAgentGuidedRun(root: string, task: TestTask, context?: Partial<TestRun['context']> & { operationId?: string; device?: string; appVersion?: string }): TestRun {
  const run = newRun(root, task, context);
  if (!['ready', 'active'].includes(task.metadata.status)) return block(root, task, run, `Task status is ${task.metadata.status}; review and mark it ready before execution.`);
  if (!approvalIsCurrent(task)) return block(root, task, run, 'Generated test cases are unapproved or changed after approval. Present the current plan and obtain user confirmation before execution.');
  const capabilities = checkCapabilities(root, [...new Set([...task.capabilities.required, ...platformCapabilities(run.context.platform)])], task.capabilities.optional);
  if (capabilities.missing.length) return block(root, task, run, `Missing required capabilities: ${capabilities.missing.join(', ')}. ${capabilityAdvice(capabilities.missing).join(' ')}`);
  if (context?.operationId) {
    try {
      const operation = approvedOperationForReplay(root, task, context.operationId, { platform: run.context.platform, environment: run.context.environment, device: context.device, appVersion: context.appVersion });
      run.replayStatus = 'replayed'; run.operationPlanId = operation.id; run.operationVersion = operation.version;
      run.steps.push({ id: 'replay-preflight', action: 'Load approved Operation JSON', status: 'passed', detail: `Replay ${operation.id} v${operation.version} is compatible with the current Task, context, and capability checks.`, at: now(), source: 'internal' });
    } catch (error) { return block(root, task, run, (error as Error).message); }
  }
  run.status = 'running';
  run.steps.push({ id: 'agent-guided-preflight', action: 'Agent-guided execution preflight', status: 'passed', detail: `Use a real browser, simulator, or device. Required capabilities are available. Optional missing: ${capabilities.optionalMissing.join(', ') || 'none'}. Capture a screenshot after every real UI action; perform visual inspection only at key or adaptive checkpoints.`, at: now(), source: 'internal' });
  checkpointRun(root, run);
  return run;
}

export function recordAgentStep(root: string, runId: string, input: { action: string; detail: string; status?: RunStatus; screenshotPath?: string; visualInspection?: TestRun['steps'][number]['visualInspection']; source?: TestRun['steps'][number]['source']; operationStepId?: string }): TestRun {
  const run = readJson<TestRun>(qaPath(root, 'runs', `${runId}.json`));
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  const status = input.status ?? 'passed';
  const source = input.source ?? 'ui';
  const visualInspection = input.visualInspection ?? 'not-required';
  const stepId = `agent-${run.steps.length + 1}`;
  if (source === 'ui' && !input.screenshotPath) throw new Error('Every real UI action requires --screenshot so the report retains an evidence artifact.');
  let screenshotPath: string | undefined;
  if (input.screenshotPath) screenshotPath = captureScreenshot(root, run, stepId, input.screenshotPath, visualInspection, `${input.action}: ${input.detail}`);
  run.steps.push({ id: stepId, action: input.action, status, detail: input.detail, at: now(), screenshotPath, visualInspection, source, operationStepId: input.operationStepId });
  if (run.replayStatus === 'replayed' && status === 'adapted') run.replayStatus = 'adapted';
  checkpointRun(root, run); return run;
}

function captureScreenshot(root: string, run: TestRun, stepId: string, sourcePath: string, visualInspection: NonNullable<TestRun['steps'][number]['visualInspection']>, summary: string): string {
  if (!existsSync(sourcePath)) throw new Error(`Screenshot does not exist: ${sourcePath}`);
  const destination = join(qaPath(root, 'evidence', run.id, 'steps', `${stepId}-${basename(sourcePath)}`));
  mkdirSync(join(destination, '..'), { recursive: true }); copyFileSync(sourcePath, destination);
  const relativePath = destination.slice(qaPath(root).length + 1);
  run.screenshots ??= []; run.screenshots.push({ stepId, path: relativePath, capturedAt: now(), visualInspection, summary });
  run.evidence.push({ type: 'screenshot', path: relativePath, summary: `Screenshot captured after UI action: ${summary}` });
  return relativePath;
}

export function recordRecoveryAttempt(root: string, runId: string, input: { reason: string; action: string; outcome: 'continued' | 'blocked' | 'paused' | 'failed'; detail: string }): TestRun {
  const run = readJson<TestRun>(qaPath(root, 'runs', `${runId}.json`));
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  const attempt = { id: `recovery-${run.recoveryAttempts.length + 1}`, ...input, at: now() };
  run.recoveryAttempts ??= []; run.recoveryAttempts.push(attempt);
  run.steps.push({ id: attempt.id, action: `Recovery: ${input.action}`, status: input.outcome === 'continued' ? 'passed' : input.outcome, detail: `${input.reason}\n${input.detail}`, at: attempt.at, source: 'recovery', visualInspection: 'not-required' });
  if (input.outcome === 'continued') run.status = 'running';
  else {
    const task = readTask(root, run.moduleId, run.taskId);
    run.status = input.outcome;
    run.scenarioResults = task.scenarios.map(scenario => ({ scenarioId: scenario.id, status: input.outcome, detail: `Recovery stopped the run: ${input.detail}` }));
    run.conclusion = `Run stopped during recovery: ${input.outcome}.`;
    return finish(root, task, run);
  }
  checkpointRun(root, run); return run;
}

export function recordVisualFinding(root: string, runId: string, input: { scenarioId: string; assertionId: string; expected: string; actual: string; status: RunStatus; screenshotPath?: string }): TestRun {
  const run = readJson<TestRun>(qaPath(root, 'runs', `${runId}.json`));
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  if (!['passed', 'failed', 'blocked', 'paused', 'inconclusive', 'not_applicable', 'needs_confirmation', 'adapted'].includes(input.status)) throw new Error('A visual observation must use a terminal QA conclusion status.');
  const task = readTask(root, run.moduleId, run.taskId);
  const scenario = task.scenarios.find(item => item.id === input.scenarioId);
  if (!scenario) throw new Error(`Scenario ${input.scenarioId} does not belong to task ${run.taskId}.`);
  if (scenario.visualAssertions?.length && !scenario.visualAssertions.some(item => item.id === input.assertionId)) throw new Error(`Visual assertion ${input.assertionId} is not declared for scenario ${input.scenarioId}.`);
  if (['passed', 'failed'].includes(input.status) && !input.screenshotPath) throw new Error('A passed or failed visual observation requires a screenshot artifact.');
  let screenshotPath: string | undefined;
  if (input.screenshotPath) {
    if (!existsSync(input.screenshotPath)) throw new Error(`Screenshot does not exist: ${input.screenshotPath}`);
    const destination = join(qaPath(root, 'evidence', runId, input.scenarioId, `agent-${Date.now()}-${basename(input.screenshotPath)}`));
    mkdirSync(join(destination, '..'), { recursive: true });
    copyFileSync(input.screenshotPath, destination); screenshotPath = destination.slice(qaPath(root).length + 1);
    run.evidence.push({ type: 'screenshot', path: screenshotPath, summary: `Agent visual observation: ${input.assertionId}.` });
  }
  run.visualFindings ??= [];
  const finding = { ...input, screenshotPath, at: now() }; run.visualFindings.push(finding);
  run.steps.push({ id: `visual-${input.assertionId}-${run.visualFindings.length}`, action: 'Visual business assertion', status: input.status, detail: `Expected: ${input.expected}\nActual: ${input.actual}`, at: finding.at, source: 'internal', visualInspection: 'performed' });
  if (run.replayStatus === 'replayed' && input.status === 'adapted') run.replayStatus = 'adapted';
  checkpointRun(root, run); return run;
}

export function completeAgentGuidedRun(root: string, task: TestTask, runId: string): TestRun {
  const run = readJson<TestRun>(qaPath(root, 'runs', `${runId}.json`));
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running.`);
  run.visualFindings ??= [];
  run.scenarioResults = task.scenarios.map(scenario => {
    const findings = run.visualFindings.filter(item => item.scenarioId === scenario.id);
    if (!findings.length) return { scenarioId: scenario.id, status: 'blocked' as const, detail: 'No agent visual observation was recorded for this scenario.' };
    const missing = (scenario.visualAssertions ?? []).filter(assertion => !findings.some(finding => finding.assertionId === assertion.id));
    if (missing.length) return { scenarioId: scenario.id, status: 'blocked' as const, detail: `Missing visual evidence for: ${missing.map(item => item.id).join(', ')}.` };
    const statuses = findings.map(item => item.status);
    return { scenarioId: scenario.id, status: finalStatus(statuses), detail: findings.map(item => `${item.assertionId}: ${item.status}`).join('; ') };
  });
  run.status = finalStatus(run.scenarioResults.map(item => item.status));
  if (run.status === 'passed' && run.replayStatus === 'adapted') run.status = 'adapted';
  run.conclusion = run.status === 'passed' ? 'Agent 在真实界面上完成了所有视觉业务断言。' : run.status === 'failed' ? 'Agent 观察到至少一项业务预期与实际界面不一致。' : '运行缺少完整视觉证据或被安全机制暂停。';
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

export function configurePlaywrightAdapter(root: string, baseUrl: string, headless = true): void {
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('Playwright base URL must start with http:// or https://.');
  writeJsonAtomic(qaPath(root, 'adapters', 'playwright.json'), { version: 1, kind: 'playwright', baseUrl, headless, configuredAt: now(), capabilities: ['browser.interact', 'browser.inspect'] } satisfies PlaywrightAdapterConfig);
}
