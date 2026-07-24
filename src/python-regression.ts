import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { assertHumanApprover, testPlanHash } from './approval.ts';
import { appendTaskEvent } from './events.ts';
import {
  qaPath,
  readRun,
  readTask,
  saveTask,
  taskDirectory,
  taskSourceRunReportPath,
} from './project.ts';
import { hasRuntimeReportMarker } from './report-contract.ts';
import { exportStepsFromRun, validateStepsFile, type RegressionStepsFile } from './regression-steps.ts';
import { projectRunnerDir } from './runner-path.ts';
import { resolveSessionIdentity } from './session.ts';
import {
  assertSafeId,
  ensureDir,
  listFiles,
  now,
  readJson,
  withFileLock,
  writeJsonAtomic,
  writeTextAtomic,
} from './store.ts';
import type {
  PythonRegressionBusinessStatus,
  PythonRegressionDraft,
  PythonRegressionManifest,
  PythonRegressionRun,
  PythonRegressionScriptResult,
  TestRun,
  TestTask,
} from './types.ts';

const METADATA_PREFIX = '# QA_AGENT_REGRESSION: ';
const RESULT_API_VERSION = 'qa-agent/python-regression-result/v1';
const DRAFT_API_VERSION = 'qa-agent/python-regression-draft/v2';
const MANIFEST_API_VERSION = 'qa-agent/python-regression/v2';
const RUN_API_VERSION = 'qa-agent/python-regression-run/v1';
const allowedBusinessStatuses = new Set<PythonRegressionBusinessStatus>(['passed', 'failed', 'blocked', 'inconclusive']);

interface ScriptMetadata {
  scriptId: string;
  sourceRunId: string;
  sourceStepIds: string[];
  sourceFlowHash: string;
}

export interface CreatePythonRegressionDraftInput {
  moduleId: string;
  taskId: string;
  runId: string;
  scriptId?: string;
  scriptFile: string;
  sessionKey?: string;
  pythonCommand?: string;
}

export interface CreateStepsRegressionDraftInput {
  moduleId: string;
  taskId: string;
  runId: string;
  scriptId?: string;
  sessionKey?: string;
}

export interface PublishPythonRegressionInput {
  moduleId: string;
  taskId: string;
  draftId: string;
  confirmedBy: string;
  approvalSource?: 'current-chat-explicit-approval' | 'external-review-record';
  sessionKey?: string;
  pythonCommand?: string;
  replace?: boolean;
}

export interface RunPythonRegressionInput {
  moduleId: string;
  taskId: string;
  scriptId: string;
  pythonCommand?: string;
  timeoutMs?: number;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeRelativePath(base: string, path: string, label: string): string {
  const resolvedBase = resolve(base);
  const resolvedPath = resolve(base, path);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(`${resolvedBase}${sep}`)) {
    throw new Error(`${label} escapes its allowed directory: ${path}.`);
  }
  return resolvedPath;
}

function scriptIdFromTask(task: TestTask): string {
  const candidate = `${task.metadata.id}-regression`.slice(0, 63);
  assertSafeId(candidate, 'Python regression id');
  return candidate;
}

function draftDirectory(root: string, sessionKey: string | undefined, draftId: string): string {
  const identity = resolveSessionIdentity(sessionKey);
  return qaPath(root, '.runtime', 'drafts', identity.storageKey, draftId);
}

function draftManifestPath(root: string, sessionKey: string | undefined, draftId: string): string {
  return join(draftDirectory(root, sessionKey, draftId), 'draft.json');
}

function draftScriptPath(root: string, sessionKey: string | undefined, draftId: string): string {
  return join(draftDirectory(root, sessionKey, draftId), `${draftId}.py`);
}

function draftStepsPath(root: string, sessionKey: string | undefined, draftId: string): string {
  return join(draftDirectory(root, sessionKey, draftId), `${draftId}.steps.json`);
}

function regressionDirectory(root: string, moduleId: string, taskId: string): string {
  return join(taskDirectory(root, moduleId, taskId), 'regression');
}

function regressionManifestPath(root: string, moduleId: string, taskId: string, scriptId: string): string {
  assertSafeId(scriptId, 'Python regression id');
  return join(regressionDirectory(root, moduleId, taskId), `${scriptId}.json`);
}

function regressionScriptPath(root: string, moduleId: string, taskId: string, scriptId: string): string {
  assertSafeId(scriptId, 'Python regression id');
  return join(regressionDirectory(root, moduleId, taskId), `${scriptId}.py`);
}

function regressionRunDirectory(root: string, moduleId: string, taskId: string, runId: string): string {
  assertSafeId(runId, 'Python regression run id');
  return join(taskDirectory(root, moduleId, taskId), 'regression-runs', runId);
}

function metadataFromScript(script: string): ScriptMetadata {
  const line = script.split(/\r?\n/).slice(0, 20).find(item => item.startsWith(METADATA_PREFIX));
  if (!line) {
    throw new Error(`Python regression script must include a metadata line near the top: ${METADATA_PREFIX}{...}`);
  }
  let value: unknown;
  try { value = JSON.parse(line.slice(METADATA_PREFIX.length)); }
  catch { throw new Error('Python regression metadata is not valid JSON.'); }
  const metadata = value as Partial<ScriptMetadata>;
  if (!metadata.scriptId || !metadata.sourceRunId || !Array.isArray(metadata.sourceStepIds) || !metadata.sourceFlowHash) {
    throw new Error('Python regression metadata requires scriptId, sourceRunId, sourceStepIds, and sourceFlowHash.');
  }
  assertSafeId(metadata.scriptId, 'Python regression metadata scriptId');
  if (metadata.sourceStepIds.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('Python regression metadata sourceStepIds must contain non-empty strings.');
  }
  return { scriptId: metadata.scriptId, sourceRunId: metadata.sourceRunId, sourceStepIds: [...new Set(metadata.sourceStepIds)], sourceFlowHash: metadata.sourceFlowHash };
}

function validatePythonSyntax(script: string, pythonCommand = 'python3'): void {
  const result = spawnSync(pythonCommand, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
    input: script,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`Python syntax validation could not start ${pythonCommand}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Python syntax validation failed: ${(result.stderr || result.stdout || 'unknown syntax error').trim()}`);
}

function pythonContainsRawSecret(script: string): boolean {
  const assignment = /\b(?:password|token|secret|cookie|authorization|private_?key|credit_?card)\w*\s*=\s*(["'])(?!env:|\$\{|QA_|os\.environ|os\.getenv)[^"'\n]+\1/i;
  const inlineHeader = /\b(?:authorization|cookie)\b\s*:\s*(["'])(?!env:|\$\{|QA_)[^"'\n]+\1/i;
  return assignment.test(script) || inlineHeader.test(script);
}

function validatePythonSafety(script: string): void {
  if (pythonContainsRawSecret(script)) throw new Error('Python regression script appears to contain a raw secret. Use environment-variable references.');
  const prohibited: Array<[RegExp, string]> = [
    [/\b(?:eval|exec|compile|__import__)\s*\(/, 'dynamic code execution'],
    [/\bos\.system\s*\(/, 'os.system'],
    [/\bshell\s*=\s*True\b/, 'shell=True'],
    [/\bsubprocess\.(?:Popen|call|check_call|check_output)\s*\(/, 'unrestricted subprocess execution'],
  ];
  const violation = prohibited.find(([pattern]) => pattern.test(script));
  if (violation) throw new Error(`Python regression script uses prohibited ${violation[1]}. Use subprocess.run without shell=True only for the approved host bridge.`);
}

function sourceAutomationSteps(run: TestRun): TestRun['steps'] {
  return run.steps.filter(step => step.source === 'ui' && step.executionMode === 'host-automated');
}

export interface PythonRegressionEligibility {
  eligible: boolean;
  sourceStepIds: string[];
  scenarioIds: string[];
  flowHash?: string;
  issues: Array<{ scenarioId: string; reasons: string[] }>;
}

function normalizedFlow(task: TestTask, run: TestRun, scenarioIds: string[], steps: TestRun['steps']): object {
  return {
    taskId: task.metadata.id,
    planHash: run.planHash ?? testPlanHash(task),
    scenarioIds,
    steps: steps.map(step => ({
      id: step.id,
      scenarioId: step.scenarioId,
      action: step.uiAction,
      driverCommand: step.driverCommand,
      driverParams: step.driverParams ?? {},
      locator: step.actualLocator ?? step.locator,
      inputRefs: step.inputRefs ?? {},
      expectedState: step.expectedState,
      actualState: step.actualState,
      screenshot: Boolean(step.screenshotPath),
    })),
    assertions: run.visualFindings
      .filter(item => scenarioIds.includes(item.scenarioId))
      .map(item => ({ scenarioId: item.scenarioId, assertionId: item.assertionId, expected: item.expected, status: item.status, screenshot: Boolean(item.screenshotPath) }))
      .sort((a, b) => `${a.scenarioId}/${a.assertionId}`.localeCompare(`${b.scenarioId}/${b.assertionId}`)),
    cleanup: run.cleanupFindings
      .filter(item => scenarioIds.includes(item.scenarioId))
      .map(item => ({ scenarioId: item.scenarioId, cleanup: item.cleanup, status: item.status }))
      .sort((a, b) => `${a.scenarioId}/${a.cleanup}`.localeCompare(`${b.scenarioId}/${b.cleanup}`)),
  };
}

export function inspectPythonRegressionEligibility(task: TestTask, run: TestRun): PythonRegressionEligibility {
  const issues: Array<{ scenarioId: string; reasons: string[] }> = [];
  if (!run.completedAt || !['passed', 'adapted'].includes(run.status)) {
    return { eligible: false, sourceStepIds: [], scenarioIds: [], issues: [{ scenarioId: run.scenarioId ?? 'run', reasons: ['Source Run must be completed with status passed or adapted.'] }] };
  }
  const selectedScenarios = task.scenarios.filter(scenario => {
    if (run.scenarioId && run.scenarioId !== scenario.id) return false;
    return ['passed', 'adapted'].includes(run.scenarioResults.find(item => item.scenarioId === scenario.id)?.status ?? '');
  });
  const targetActions = new Set(['navigate', 'click', 'input', 'fill']);
  const platform = run.context.platform;
  const allSteps: TestRun['steps'] = [];
  for (const scenario of selectedScenarios) {
    const reasons: string[] = [];
    const steps = sourceAutomationSteps(run).filter(step => step.scenarioId === scenario.id);
    if (!steps.length) reasons.push('No host-automated UI steps were recorded for this successful Scenario.');
    for (const step of steps) {
      if (!step.uiAction) reasons.push(`${step.id}: uiAction is required for regression step generation.`);
      const command = step.driverCommand ?? '';
      const nativeFocusedAction = platform === 'ios' && ['type-text', 'key', 'clear'].includes(command);
      if (step.uiAction && targetActions.has(step.uiAction) && !(step.actualLocator ?? step.locator) && !nativeFocusedAction) reasons.push(`${step.id}: ${step.uiAction} requires a stable locator.`);
      const requiresInputRef = (step.uiAction === 'input' || step.uiAction === 'fill') && !['key', 'clear'].includes(command);
      if (requiresInputRef && !Object.keys(step.inputRefs ?? {}).length) reasons.push(`${step.id}: input actions require structured inputRefs.`);
      if (!step.screenshotPath) reasons.push(`${step.id}: every source UI step requires screenshot evidence.`);
    }
    for (const assertion of scenario.visualAssertions ?? []) {
      const finding = run.visualFindings.find(item => item.scenarioId === scenario.id && item.assertionId === assertion.id);
      if (!finding || !['passed', 'adapted'].includes(finding.status) || !finding.screenshotPath) reasons.push(`Assertion ${assertion.id} needs a passed or adapted observation with screenshot evidence.`);
    }
    for (const cleanup of scenario.cleanup) {
      const finding = run.cleanupFindings.find(item => item.scenarioId === scenario.id && item.cleanup === cleanup);
      if (!finding || !['passed', 'adapted', 'not_applicable'].includes(finding.status)) reasons.push(`Cleanup ${cleanup} requires a successful recorded result.`);
    }
    if (reasons.length) issues.push({ scenarioId: scenario.id, reasons: [...new Set(reasons)] });
    allSteps.push(...steps);
  }
  if (!selectedScenarios.length) issues.push({ scenarioId: run.scenarioId ?? 'run', reasons: ['No successful Scenario was available for Python generation.'] });
  const scenarioIds = selectedScenarios.map(item => item.id);
  const sourceStepIds = allSteps.map(step => step.id);
  const eligible = issues.length === 0 && sourceStepIds.length > 0;
  return {
    eligible,
    sourceStepIds,
    scenarioIds,
    flowHash: eligible ? hashText(JSON.stringify(normalizedFlow(task, run, scenarioIds, allSteps))) : undefined,
    issues,
  };
}

function validateSourceRun(root: string, task: TestTask, runId: string): { run: TestRun; stepIds: string[]; scenarioIds: string[]; flowHash: string; reportRef: string } {
  const run = readRun(root, task.metadata.moduleId, task.metadata.id, runId);
  if (run.moduleId !== task.metadata.moduleId || run.taskId !== task.metadata.id) throw new Error(`Run ${runId} does not belong to this Task.`);
  if (run.reportGeneratedBy !== 'qa-agent-runtime' || !run.reportPath) throw new Error('Source Run must have a Runtime-owned report.');
  const reportPath = taskSourceRunReportPath(root, task.metadata.moduleId, task.metadata.id);
  if (!existsSync(reportPath) || !hasRuntimeReportMarker(readFileSync(reportPath, 'utf8'), run.id)) throw new Error('Source Run report is missing or is not Runtime-owned.');
  const eligibility = inspectPythonRegressionEligibility(task, run);
  if (!eligibility.eligible || !eligibility.flowHash) {
    const reasons = eligibility.issues.flatMap(item => item.reasons.map(reason => `${item.scenarioId}: ${reason}`)).join(' ');
    throw new Error(`Source Run is not ready for Python generation. ${reasons}`);
  }
  return {
    run,
    stepIds: eligibility.sourceStepIds,
    scenarioIds: eligibility.scenarioIds,
    flowHash: eligibility.flowHash,
    reportRef: relative(taskDirectory(root, task.metadata.moduleId, task.metadata.id), reportPath),
  };
}

function validateScriptAgainstSource(script: string, scriptId: string, runId: string, sourceStepIds: string[], sourceFlowHash: string): ScriptMetadata {
  validatePythonSafety(script);
  const metadata = metadataFromScript(script);
  if (metadata.scriptId !== scriptId) throw new Error(`Python regression metadata scriptId must be ${scriptId}.`);
  if (metadata.sourceRunId !== runId) throw new Error(`Python regression metadata sourceRunId must be ${runId}.`);
  if (metadata.sourceFlowHash !== sourceFlowHash) throw new Error(`Python regression metadata sourceFlowHash must be ${sourceFlowHash}.`);
  const expected = [...sourceStepIds].sort();
  const actual = [...metadata.sourceStepIds].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Python regression metadata must reference every host-automated source step exactly once. Expected: ${expected.join(', ')}.`);
  }
  for (const stepId of expected) {
    if (!script.includes(stepId)) throw new Error(`Python regression script does not contain source step trace ${stepId}.`);
  }
  if (!script.includes('QA_AGENT_RESULT_PATH')) throw new Error('Python regression script must write its structured result to QA_AGENT_RESULT_PATH.');
  if (!script.includes('QA_AGENT_SCREENSHOT_DIR')) throw new Error('Python regression script must capture checkpoint screenshots under QA_AGENT_SCREENSHOT_DIR.');
  if (!/[\"\']screenshot[\"\']/.test(script)) throw new Error('Python regression script result must reference screenshot artifacts for its checkpoint steps.');
  if (!script.includes(RESULT_API_VERSION)) throw new Error(`Python regression script must emit ${RESULT_API_VERSION}.`);
  return metadata;
}

export function createPythonRegressionDraft(root: string, input: CreatePythonRegressionDraftInput): { draft: PythonRegressionDraft; script: string; scriptPath: string } {
  assertSafeId(input.moduleId, 'module id');
  assertSafeId(input.taskId, 'task id');
  const task = readTask(root, input.moduleId, input.taskId);
  const scriptId = input.scriptId ?? scriptIdFromTask(task);
  assertSafeId(scriptId, 'Python regression id');
  const source = validateSourceRun(root, task, input.runId);
  const script = readFileSync(resolve(input.scriptFile), 'utf8');
  if (!script.trim()) throw new Error('Python regression script draft is empty.');
  if (Buffer.byteLength(script, 'utf8') > 512 * 1024) throw new Error('Python regression script draft exceeds 512 KB.');
  validatePythonSyntax(script, input.pythonCommand);
  validateScriptAgainstSource(script, scriptId, input.runId, source.stepIds, source.flowHash);
  const identity = resolveSessionIdentity(input.sessionKey);
  const path = draftScriptPath(root, input.sessionKey, scriptId);
  const manifestPath = draftManifestPath(root, input.sessionKey, scriptId);
  return withFileLock(qaPath(root, '.locks', `python-draft-${identity.storageKey}-${scriptId}.lock`), () => {
    const existing = existsSync(manifestPath) ? readJson<PythonRegressionDraft>(manifestPath) : undefined;
    if (existing && (existing.moduleId !== input.moduleId || existing.taskId !== input.taskId || existing.sourceRunId !== input.runId)) {
      throw new Error(`Draft ${scriptId} already belongs to another Task or source Run.`);
    }
    const timestamp = now();
    const draft: PythonRegressionDraft = {
      apiVersion: DRAFT_API_VERSION,
      kind: 'PythonRegressionDraft',
      id: scriptId,
      moduleId: input.moduleId,
      taskId: input.taskId,
      sessionKey: identity.sessionKey,
      sourceRunId: input.runId,
      sourceReportRef: source.reportRef,
      sourcePlanHash: source.run.planHash ?? testPlanHash(task),
      sourceStepIds: source.stepIds,
      scenarioIds: source.scenarioIds,
      sourceFlowHash: source.flowHash,
      scriptRef: relative(qaPath(root), path),
      scriptHash: hashText(script),
      status: 'draft',
      createdBy: 'agent',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    writeTextAtomic(path, script.endsWith('\n') ? script : `${script}\n`);
    writeJsonAtomic(manifestPath, draft);
    appendTaskEvent(root, {
      type: 'python_regression_draft_saved',
      actor: { type: 'agent', id: 'qa-agent' },
      moduleId: input.moduleId,
      taskId: input.taskId,
      reasonCode: 'user_requested_python_regression_draft',
      artifactHash: draft.scriptHash,
      idempotencyKey: `python-regression-draft:${identity.storageKey}:${scriptId}:${draft.scriptHash}`,
      metadata: { sourceRunId: input.runId, sourceStepIds: source.stepIds, draftRef: draft.scriptRef },
    });
    return { draft, script, scriptPath: path };
  });
}

export function createStepsRegressionDraft(root: string, input: CreateStepsRegressionDraftInput): { draft: PythonRegressionDraft; stepsFile: RegressionStepsFile; scriptPath: string } {
  assertSafeId(input.moduleId, 'module id');
  assertSafeId(input.taskId, 'task id');
  const task = readTask(root, input.moduleId, input.taskId);
  const scriptId = input.scriptId ?? scriptIdFromTask(task);
  assertSafeId(scriptId, 'regression id');
  const source = validateSourceRun(root, task, input.runId);
  const stepsFile = exportStepsFromRun(root, source.run, scriptId, source.stepIds);
  if (!stepsFile.steps.length) throw new Error('Source Run produced no exportable regression steps.');
  const exportedIds = [...stepsFile.steps.map(step => step.id)].sort();
  const expectedIds = [...source.stepIds].sort();
  if (JSON.stringify(exportedIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`Regression step export does not cover the validated source flow. Expected: ${expectedIds.join(', ')}.`);
  }
  const identity = resolveSessionIdentity(input.sessionKey);
  const path = draftStepsPath(root, input.sessionKey, scriptId);
  const manifestPath = draftManifestPath(root, input.sessionKey, scriptId);
  const serialized = `${JSON.stringify(stepsFile, null, 2)}\n`;
  return withFileLock(qaPath(root, '.locks', `python-draft-${identity.storageKey}-${scriptId}.lock`), () => {
    const existing = existsSync(manifestPath) ? readJson<PythonRegressionDraft>(manifestPath) : undefined;
    if (existing && (existing.moduleId !== input.moduleId || existing.taskId !== input.taskId || existing.sourceRunId !== input.runId)) {
      throw new Error(`Draft ${scriptId} already belongs to another Task or source Run.`);
    }
    const timestamp = now();
    const draft: PythonRegressionDraft = {
      apiVersion: DRAFT_API_VERSION,
      kind: 'PythonRegressionDraft',
      id: scriptId,
      moduleId: input.moduleId,
      taskId: input.taskId,
      sessionKey: identity.sessionKey,
      sourceRunId: input.runId,
      sourceReportRef: source.reportRef,
      sourcePlanHash: source.run.planHash ?? testPlanHash(task),
      sourceStepIds: source.stepIds,
      scenarioIds: source.scenarioIds,
      sourceFlowHash: source.flowHash,
      scriptRef: relative(qaPath(root), path),
      scriptHash: hashText(serialized),
      status: 'draft',
      createdBy: 'agent',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    writeTextAtomic(path, serialized);
    writeJsonAtomic(manifestPath, draft);
    appendTaskEvent(root, {
      type: 'python_regression_draft_saved',
      actor: { type: 'agent', id: 'qa-agent' },
      moduleId: input.moduleId,
      taskId: input.taskId,
      reasonCode: 'user_requested_regression_steps_draft',
      artifactHash: draft.scriptHash,
      idempotencyKey: `regression-steps-draft:${identity.storageKey}:${scriptId}:${draft.scriptHash}`,
      metadata: { sourceRunId: input.runId, sourceStepIds: source.stepIds, draftRef: draft.scriptRef },
    });
    return { draft, stepsFile, scriptPath: path };
  });
}

export function readPythonRegressionDraft(root: string, draftId: string, sessionKey?: string): { draft: PythonRegressionDraft; script: string; scriptPath: string } {
  assertSafeId(draftId, 'Python regression draft id');
  const manifestPath = draftManifestPath(root, sessionKey, draftId);
  if (!existsSync(manifestPath)) throw new Error(`Python regression draft ${draftId} was not found for this Session.`);
  const draft = readJson<PythonRegressionDraft>(manifestPath);
  if (draft.apiVersion !== DRAFT_API_VERSION || draft.kind !== 'PythonRegressionDraft') throw new Error(`Python regression draft ${draftId} has an unsupported format.`);
  const scriptPath = resolve(qaPath(root), draft.scriptRef);
  if (!existsSync(scriptPath)) throw new Error(`Python regression draft ${draftId} was not found for this Session.`);
  const script = readFileSync(scriptPath, 'utf8');
  if (hashText(script) !== draft.scriptHash && hashText(script.trimEnd()) !== draft.scriptHash) throw new Error(`Python regression draft ${draftId} script hash changed outside Runtime.`);
  return { draft, script, scriptPath };
}

export function listPythonRegressionDrafts(root: string, sessionKey?: string): PythonRegressionDraft[] {
  const identity = resolveSessionIdentity(sessionKey);
  const rootPath = qaPath(root, '.runtime', 'drafts', identity.storageKey);
  return listFiles(rootPath, path => path.endsWith('/draft.json'))
    .map(path => readJson<PythonRegressionDraft>(path))
    .filter(item => item.apiVersion === DRAFT_API_VERSION)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function publishPythonRegression(root: string, input: PublishPythonRegressionInput): { manifest: PythonRegressionManifest; scriptPath: string } {
  assertHumanApprover(input.confirmedBy);
  const approvalSource = input.approvalSource ?? 'current-chat-explicit-approval';
  const { draft, script, scriptPath: draftScriptFile } = readPythonRegressionDraft(root, input.draftId, input.sessionKey);
  if (draft.moduleId !== input.moduleId || draft.taskId !== input.taskId) throw new Error('Draft does not belong to the requested Task.');
  const task = readTask(root, input.moduleId, input.taskId);
  const source = validateSourceRun(root, task, draft.sourceRunId);
  if (draft.sourcePlanHash !== testPlanHash(task)) throw new Error('Task plan changed after the draft was generated. Regenerate the script from a current successful Run.');
  if (draft.sourceFlowHash !== source.flowHash) throw new Error('Source Run flow changed after the draft was generated. Regenerate the script.');
  const isSteps = draft.scriptRef.endsWith('.steps.json');
  if (isSteps) {
    const validation = validateStepsFile(draftScriptFile);
    if (!validation.valid) throw new Error(`Regression steps draft is invalid: ${validation.errors.join(' ')}`);
    const doc = readJson<RegressionStepsFile>(draftScriptFile);
    const exportedIds = [...doc.steps.map(step => step.id)].sort();
    const expectedIds = [...source.stepIds].sort();
    if (JSON.stringify(exportedIds) !== JSON.stringify(expectedIds)) throw new Error('Regression steps draft no longer covers the validated source flow. Regenerate the steps.');
  } else {
    validatePythonSyntax(script, input.pythonCommand);
    validateScriptAgainstSource(script, draft.id, draft.sourceRunId, source.stepIds, source.flowHash);
  }
  const manifestPath = regressionManifestPath(root, input.moduleId, input.taskId, draft.id);
  const scriptPath = isSteps
    ? join(regressionDirectory(root, input.moduleId, input.taskId), `${draft.id}.steps.json`)
    : regressionScriptPath(root, input.moduleId, input.taskId, draft.id);
  return withFileLock(qaPath(root, '.locks', `python-regression-${input.moduleId}-${input.taskId}-${draft.id}.lock`), () => {
    const existing = existsSync(manifestPath) ? readJson<PythonRegressionManifest>(manifestPath) : undefined;
    if (existing && !input.replace) throw new Error(`Python regression ${draft.id} already exists. Use --replace only after the user approves the revised draft.`);
    const timestamp = now();
    const manifest: PythonRegressionManifest = {
      apiVersion: MANIFEST_API_VERSION,
      kind: 'PythonRegression',
      id: draft.id,
      version: (existing?.version ?? 0) + 1,
      name: task.metadata.name,
      moduleId: input.moduleId,
      taskId: input.taskId,
      scriptRef: relative(taskDirectory(root, input.moduleId, input.taskId), scriptPath),
      sourceRunId: draft.sourceRunId,
      sourceReportRef: draft.sourceReportRef,
      sourcePlanHash: draft.sourcePlanHash,
      sourceStepIds: draft.sourceStepIds,
      scenarioIds: draft.scenarioIds,
      sourceFlowHash: draft.sourceFlowHash,
      scriptHash: draft.scriptHash,
      status: 'approved_unverified',
      approvedBy: input.confirmedBy,
      approvalSource,
      approvedAt: timestamp,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    writeTextAtomic(scriptPath, script.endsWith('\n') ? script : `${script}\n`);
    writeJsonAtomic(manifestPath, manifest);
    task.pythonRegressionRefs ??= [];
    const ref = relative(taskDirectory(root, input.moduleId, input.taskId), manifestPath);
    if (!task.pythonRegressionRefs.includes(ref)) task.pythonRegressionRefs.push(ref);
    task.updatedAt = timestamp;
    saveTask(root, task);
    rmSync(draftDirectory(root, input.sessionKey, draft.id), { recursive: true, force: true });
    appendTaskEvent(root, {
      type: 'python_regression_published',
      actor: { type: 'human', id: input.confirmedBy },
      moduleId: input.moduleId,
      taskId: input.taskId,
      reasonCode: 'explicit_python_regression_script_approval',
      artifactHash: manifest.scriptHash,
      idempotencyKey: `python-regression-published:${manifest.id}:v${manifest.version}:${manifest.scriptHash}`,
      metadata: { sourceRunId: manifest.sourceRunId, scriptRef: manifest.scriptRef, approvalSource },
    });
    return { manifest, scriptPath };
  });
}

export function readPythonRegression(root: string, moduleId: string, taskId: string, scriptId: string): PythonRegressionManifest {
  const path = regressionManifestPath(root, moduleId, taskId, scriptId);
  if (!existsSync(path)) throw new Error(`Python regression ${scriptId} was not found for Task ${moduleId}/${taskId}.`);
  const manifest = readJson<PythonRegressionManifest>(path);
  if (manifest.apiVersion !== MANIFEST_API_VERSION || manifest.kind !== 'PythonRegression') throw new Error(`Python regression ${scriptId} has an unsupported format.`);
  if (manifest.moduleId !== moduleId || manifest.taskId !== taskId || manifest.id !== scriptId) throw new Error(`Python regression ${scriptId} identity does not match its Task path.`);
  return manifest;
}

export function listPythonRegressions(root: string, moduleId: string, taskId: string): PythonRegressionManifest[] {
  const directory = regressionDirectory(root, moduleId, taskId);
  return listFiles(directory, path => path.endsWith('.json'))
    .map(path => readJson<PythonRegressionManifest>(path))
    .filter(item => item.apiVersion === MANIFEST_API_VERSION && item.moduleId === moduleId && item.taskId === taskId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function validateScriptResult(value: unknown, runDirectory: string, sourceStepIds: string[]): { result: PythonRegressionScriptResult; screenshots: string[] } {
  const result = value as Partial<PythonRegressionScriptResult>;
  if (result.apiVersion !== RESULT_API_VERSION || !allowedBusinessStatuses.has(result.status as PythonRegressionBusinessStatus)) {
    throw new Error(`Python script result must use ${RESULT_API_VERSION} and a valid status.`);
  }
  if (!['completed', 'blocked'].includes(result.contractStatus ?? '')) throw new Error('Python script result contractStatus must be completed or blocked.');
  if (!result.conclusion?.trim() || !Array.isArray(result.steps)) throw new Error('Python script result requires conclusion and steps.');
  if (result.contractStatus === 'completed' && !result.steps.length) throw new Error('A completed Python regression result requires screenshot-backed checkpoint steps.');

  const expectedStepIds = new Set(sourceStepIds);
  const seenStepIds = new Set<string>();
  const screenshots: string[] = [];
  const inspectScreenshot = (path: string | undefined, label: string, required: boolean): void => {
    if (!path) {
      if (required) throw new Error(`${label} requires a screenshot artifact.`);
      return;
    }
    const absolute = safeRelativePath(runDirectory, path, 'Python regression screenshot');
    const relativePath = relative(runDirectory, absolute);
    if (relativePath.split(sep)[0] !== 'screenshots') throw new Error(`Python regression screenshot must be stored under screenshots/: ${path}.`);
    if (!existsSync(absolute)) throw new Error(`Python regression screenshot does not exist: ${path}.`);
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size === 0) throw new Error(`Python regression screenshot is empty or invalid: ${path}.`);
    screenshots.push(relativePath);
  };
  for (const step of result.steps) {
    if (!step?.id || !step.name || !allowedBusinessStatuses.has(step.status)) throw new Error('Every Python regression result step requires id, name, and a valid status.');
    if (!expectedStepIds.has(step.id)) throw new Error(`Python regression result contains unknown source step ${step.id}.`);
    if (seenStepIds.has(step.id)) throw new Error(`Python regression result contains duplicate source step ${step.id}.`);
    seenStepIds.add(step.id);
    inspectScreenshot(step.screenshot, `Python regression step ${step.id}`, true);
  }
  if (result.contractStatus === 'completed') {
    const missing = sourceStepIds.filter(stepId => !seenStepIds.has(stepId));
    if (missing.length) throw new Error(`Completed Python regression result is missing screenshot-backed source steps: ${missing.join(', ')}.`);
  }
  for (const cleanup of result.cleanup ?? []) {
    if (!cleanup?.name || !allowedBusinessStatuses.has(cleanup.status)) throw new Error('Every Python regression cleanup result requires name and a valid status.');
    inspectScreenshot(cleanup.screenshot, `Python regression cleanup ${cleanup.name}`, false);
  }
  return { result: result as PythonRegressionScriptResult, screenshots: [...new Set(screenshots)] };
}

function markdownEscape(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function writePythonRegressionReport(root: string, run: PythonRegressionRun, result?: PythonRegressionScriptResult): string {
  const directory = regressionRunDirectory(root, run.moduleId, run.taskId, run.id);
  const path = join(directory, 'report.md');
  const screenshotBacked = Boolean(result?.steps.length && run.screenshots.length && ['completed', 'blocked'].includes(run.contractStatus));
  const lines = [
    screenshotBacked ? '<!-- QA-AGENT:PYTHON-REGRESSION-REPORT -->' : '<!-- QA-AGENT:PYTHON-REGRESSION-DIAGNOSTIC -->',
    '',
    screenshotBacked ? `# Python Regression: ${run.regressionId}` : `# Python Regression Diagnostic: ${run.regressionId}`,
    '',
    `- Run: ${run.id}`,
    `- Business result: ${run.status.toUpperCase()}`,
    `- Script contract: ${run.contractStatus}`,
    `- Script: ${run.scriptRef}`,
    `- Source Run: ${run.sourceRunId}`,
    `- Exit code: ${run.exitCode ?? 'not available'}`,
    '',
    '## Conclusion',
    '',
    run.conclusion,
    '',
    '## Steps',
    '',
    '| Step | Status | Expected | Actual | Screenshot |',
    '| --- | --- | --- | --- | --- |',
    ...(result?.steps.length
      ? result.steps.map(step => `| ${markdownEscape(step.name)} | ${step.status.toUpperCase()} | ${markdownEscape(step.expected ?? '')} | ${markdownEscape(step.actual ?? '')} | ${markdownEscape(step.screenshot ?? 'missing')} |`)
      : ['| Script result unavailable | INCONCLUSIVE |  |  | missing |']),
    '',
    '## Screenshot-backed Checkpoints',
    '',
    ...(result?.steps.length
      ? result.steps.flatMap(step => [
          `### ${markdownEscape(step.name)}`,
          '',
          `- Source step: ${step.id}`,
          `- Status: ${step.status.toUpperCase()}`,
          `- Expected: ${markdownEscape(step.expected ?? '')}`,
          `- Actual: ${markdownEscape(step.actual ?? '')}`,
          `- Screenshot: ${step.screenshot ?? 'missing'}`,
          ...(step.screenshot ? [`![${basename(step.screenshot)}](${step.screenshot})`] : []),
          '',
        ])
      : ['No screenshot-backed checkpoints were available because the script result contract was invalid.', '']),
    '## Screenshots',
    '',
    ...(run.screenshots.length ? run.screenshots.map(path => `![${basename(path)}](${path})`) : ['No valid screenshots were produced. This Run is diagnostic only and must not be treated as a completed regression report.']),
    '',
    '## Logs',
    '',
    `- stdout: ${run.stdoutRef}`,
    `- stderr: ${run.stderrRef}`,
    '',
  ];
  writeTextAtomic(path, `${lines.join('\n')}\n`);
  return path;
}

export function runPythonRegression(root: string, input: RunPythonRegressionInput): PythonRegressionRun {
  const task = readTask(root, input.moduleId, input.taskId);
  const manifest = readPythonRegression(root, input.moduleId, input.taskId, input.scriptId);
  if (!['approved_unverified', 'validated'].includes(manifest.status)) throw new Error(`Python regression ${manifest.id} is ${manifest.status} and cannot run.`);
  if (manifest.sourcePlanHash !== testPlanHash(task)) {
    manifest.status = 'stale';
    manifest.staleReason = 'Task plan hash changed after script approval.';
    manifest.updatedAt = now();
    writeJsonAtomic(regressionManifestPath(root, input.moduleId, input.taskId, input.scriptId), manifest);
    throw new Error(`Python regression ${manifest.id} is stale because the Task plan changed.`);
  }
  const source = validateSourceRun(root, task, manifest.sourceRunId);
  if (manifest.sourceFlowHash !== source.flowHash) {
    manifest.status = 'stale';
    manifest.staleReason = 'Source Run flow hash no longer matches the approved script.';
    manifest.updatedAt = now();
    writeJsonAtomic(regressionManifestPath(root, input.moduleId, input.taskId, input.scriptId), manifest);
    throw new Error(`Python regression ${manifest.id} is stale because its source flow changed.`);
  }
  const scriptPath = resolve(taskDirectory(root, input.moduleId, input.taskId), manifest.scriptRef);
  if (!existsSync(scriptPath)) throw new Error(`Python regression script is missing: ${manifest.scriptRef}.`);
  const isStepsJson = scriptPath.endsWith('.steps.json');
  const script = readFileSync(scriptPath, 'utf8');
  if (hashText(script) !== manifest.scriptHash && hashText(script.trimEnd()) !== manifest.scriptHash) throw new Error(`Python regression ${manifest.id} script hash changed outside Runtime.`);
  if (!isStepsJson) {
    validatePythonSyntax(script, input.pythonCommand);
    validatePythonSafety(script);
  }

  const runId = `pyreg-${now().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const runDirectory = regressionRunDirectory(root, input.moduleId, input.taskId, runId);
  ensureDir(join(runDirectory, 'screenshots'));
  ensureDir(join(runDirectory, 'evidence'));
  const resultPath = join(runDirectory, 'result.json');
  const stdoutPath = join(runDirectory, 'stdout.log');
  const stderrPath = join(runDirectory, 'stderr.log');
  const startedAt = now();
  const pythonCmd = input.pythonCommand ?? 'python3';
  const spawnArgs = isStepsJson
    ? ['-m', 'qa_agent_runner', 'replay', scriptPath]
    : [scriptPath];
  const spawnCwd = isStepsJson
    ? projectRunnerDir(root)
    : taskDirectory(root, input.moduleId, input.taskId);
  const execution = spawnSync(pythonCmd, spawnArgs, {
    cwd: spawnCwd,
    env: {
      ...process.env,
      ...(isStepsJson ? { PYTHONPATH: spawnCwd } : {}),
      QA_AGENT_PROJECT_ROOT: root,
      QA_AGENT_TASK_DIR: taskDirectory(root, input.moduleId, input.taskId),
      QA_AGENT_REGRESSION_RUN_DIR: runDirectory,
      QA_AGENT_RESULT_PATH: resultPath,
      QA_AGENT_SCREENSHOT_DIR: join(runDirectory, 'screenshots'),
      QA_AGENT_EVIDENCE_DIR: join(runDirectory, 'evidence'),
      QA_AGENT_SOURCE_RUN_ID: manifest.sourceRunId,
      QA_AGENT_REGRESSION_ID: manifest.id,
    },
    encoding: 'utf8',
    timeout: input.timeoutMs ?? 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeTextAtomic(stdoutPath, execution.stdout ?? '');
  writeTextAtomic(stderrPath, `${execution.stderr ?? ''}${execution.error ? `\n${execution.error.message}\n` : ''}`);

  let parsed: PythonRegressionScriptResult | undefined;
  let screenshots: string[] = [];
  let contractStatus: PythonRegressionRun['contractStatus'];
  let status: PythonRegressionBusinessStatus = 'inconclusive';
  let conclusion: string;
  if (execution.error) {
    contractStatus = 'failed_to_start';
    conclusion = `Python regression could not start: ${execution.error.message}`;
  } else if (!existsSync(resultPath)) {
    contractStatus = 'invalid_result';
    conclusion = 'Python regression did not write QA_AGENT_RESULT_PATH.';
  } else {
    try {
      const validated = validateScriptResult(readJson<unknown>(resultPath), runDirectory, manifest.sourceStepIds);
      parsed = validated.result;
      screenshots = validated.screenshots;
      contractStatus = parsed.contractStatus;
      status = parsed.status;
      conclusion = parsed.conclusion;
    } catch (error) {
      contractStatus = 'invalid_result';
      conclusion = `Python regression result is invalid: ${(error as Error).message}`;
    }
  }

  const run: PythonRegressionRun = {
    apiVersion: RUN_API_VERSION,
    kind: 'PythonRegressionRun',
    id: runId,
    regressionId: manifest.id,
    moduleId: input.moduleId,
    taskId: input.taskId,
    scriptRef: manifest.scriptRef,
    scriptHash: manifest.scriptHash,
    sourceRunId: manifest.sourceRunId,
    status,
    contractStatus,
    exitCode: execution.status ?? undefined,
    resultRef: existsSync(resultPath) ? relative(runDirectory, resultPath) : undefined,
    reportRef: 'report.md',
    stdoutRef: 'stdout.log',
    stderrRef: 'stderr.log',
    screenshots,
    conclusion,
    startedAt,
    completedAt: now(),
  };
  writeJsonAtomic(join(runDirectory, 'run.json'), run);
  writePythonRegressionReport(root, run, parsed);

  manifest.lastRunId = run.id;
  manifest.lastRunStatus = run.status;
  if (run.contractStatus === 'completed') {
    manifest.status = 'validated';
    manifest.validatedByRunId = run.id;
    manifest.validatedAt = run.completedAt;
    manifest.staleReason = undefined;
  }
  manifest.updatedAt = run.completedAt;
  writeJsonAtomic(regressionManifestPath(root, input.moduleId, input.taskId, input.scriptId), manifest);
  appendTaskEvent(root, {
    type: 'python_regression_run_completed',
    actor: { type: 'runtime', id: 'qa-agent-runtime' },
    moduleId: input.moduleId,
    taskId: input.taskId,
    reasonCode: run.contractStatus === 'completed' ? 'python_regression_contract_completed' : 'python_regression_contract_not_completed',
    artifactHash: manifest.scriptHash,
    idempotencyKey: `python-regression-run:${run.id}:${run.contractStatus}:${run.status}`,
    metadata: { regressionId: manifest.id, runId: run.id, businessStatus: run.status, contractStatus: run.contractStatus, reportRef: relative(taskDirectory(root, input.moduleId, input.taskId), join(runDirectory, 'report.md')) },
  });
  return run;
}

export function markPythonRegressionsStaleForPlanHash(root: string, task: TestTask, currentPlanHash: string): string[] {
  const stale: string[] = [];
  for (const manifest of listPythonRegressions(root, task.metadata.moduleId, task.metadata.id)) {
    if (manifest.sourcePlanHash === currentPlanHash || !['approved_unverified', 'validated'].includes(manifest.status)) continue;
    manifest.status = 'stale';
    manifest.staleReason = 'Task plan hash changed.';
    manifest.updatedAt = now();
    writeJsonAtomic(regressionManifestPath(root, task.metadata.moduleId, task.metadata.id, manifest.id), manifest);
    appendTaskEvent(root, {
      type: 'python_regression_stale',
      actor: { type: 'runtime', id: 'qa-agent-runtime' },
      moduleId: task.metadata.moduleId,
      taskId: task.metadata.id,
      reasonCode: 'test_plan_hash_changed',
      artifactHash: currentPlanHash,
      idempotencyKey: `python-regression-stale:${manifest.id}:${currentPlanHash}`,
      metadata: { regressionId: manifest.id, previousPlanHash: manifest.sourcePlanHash, currentPlanHash },
    });
    stale.push(manifest.id);
  }
  return stale;
}
