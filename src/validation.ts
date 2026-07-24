import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { qaPath, readTask, taskPrdPath, taskSourceRunPath, taskSourceRunReportPath } from './project.ts';
import { hasSecrets, isSafeId, listFiles, readJson } from './store.ts';
import { isExplicitPlanRequirementsConfirmation, isExplicitStartConfirmation, isHumanApprover, testPlanHash } from './approval.ts';
import { hasRuntimeReportMarker, RUNTIME_REPORT_GENERATOR } from './report-contract.ts';
import type { RegressionRun, TaskLifecycleState, TestRun } from './types.ts';
import { readTaskEvents } from './events.ts';
import { taskState as resolveTaskState } from './workflow-model.ts';
import { inspectPythonRegressionEligibility } from './python-regression.ts';
import { inspectManagedRuntimeAssets } from './managed-assets.ts';
import { planningPrdIsCurrent } from './task-prd.ts';

export interface ValidationResult { valid: boolean; errors: string[]; checked: number }
function textHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function pythonContainsRawSecret(script: string): boolean { return /\b(?:password|token|secret|cookie|authorization|private_?key|credit_?card)\w*\s*=\s*(["'])(?!env:|\$\{|QA_|os\.environ|os\.getenv)[^"'\n]+\1/i.test(script) || /\b(?:authorization|cookie)\b\s*:\s*(["'])(?!env:|\$\{|QA_)[^"'\n]+\1/i.test(script); }
function validateObject(path: string, fields: string[]): string[] { try { const value = readJson<Record<string, unknown>>(path); return fields.filter(field => value[field] === undefined).map(field => `${path}: missing ${field}`); } catch (error) { return [`${path}: ${(error as Error).message}`]; } }

function validateDomainObject(path: string): string[] {
  const value = readJson<Record<string, any>>(path); const errors: string[] = [];
  if (path.endsWith('module.json') && (!isSafeId(value.id) || !['active', 'deprecated', 'archived'].includes(value.status) || typeof value.revision !== 'number')) errors.push(`${path}: invalid module id, revision, or status.`);
  if (/\/tasks\/[^/]+\/task\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/v2' || !value.metadata || !isSafeId(value.metadata.id) || !isSafeId(value.metadata.moduleId)) errors.push(`${path}: invalid Task contract.`);
    const statuses = ['draft', 'planning', 'awaiting_approval', 'ready', 'running', 'reviewing_result', 'completed', 'archived', 'blocked', 'paused', 'retired'];
    if (!statuses.includes(value.metadata?.status)) errors.push(`${path}: invalid Task lifecycle state ${value.metadata?.status}.`);
    if (value.metadata?.mode && !['quick', 'guided', 'regression'].includes(value.metadata.mode)) errors.push(`${path}: invalid QA mode ${value.metadata.mode}.`);
    if (value.metadata?.approvalPolicy !== 'test-plan-and-side-effects') errors.push(`${path}: every Task must require reviewed TestPlan and explicit start confirmation.`);
    if (['ready', 'running', 'reviewing_result', 'completed', 'archived'].includes(value.metadata?.status) && (!isHumanApprover(value.metadata.planReview?.confirmedBy) || !value.metadata.planReview?.confirmedAt || !value.metadata.planReview?.confirmationSource || !value.metadata.planReview?.planHash || !isExplicitPlanRequirementsConfirmation(value.metadata.planReview?.statement))) errors.push(`${path}: executable or completed Task requires QA confirmation that the PRD matches requirements.`);
    if (['ready', 'running', 'reviewing_result', 'completed', 'archived'].includes(value.metadata?.status) && (!isHumanApprover(value.metadata.approval?.confirmedBy) || !value.metadata.approval?.confirmedAt || !value.metadata.approval?.confirmationSource || !value.metadata.approval?.planHash || !isExplicitStartConfirmation(value.metadata.approval?.statement))) errors.push(`${path}: executable or completed Task requires the exact human start confirmation.`);
    if (!Array.isArray(value.scenarioRefs) || !value.scenarioRefs.length || value.scenarioRefs.some((ref: unknown) => typeof ref !== 'string' || !/^scenarios\/[a-z0-9][a-z0-9-]{0,62}\.json$/.test(ref))) errors.push(`${path}: invalid scenarioRefs.`);
    if (value.pythonRegressionRefs !== undefined && (!Array.isArray(value.pythonRegressionRefs) || value.pythonRegressionRefs.some((ref: unknown) => typeof ref !== 'string' || !/^regression\/[a-z0-9][a-z0-9-]{0,62}\.json$/.test(ref)))) errors.push(`${path}: invalid pythonRegressionRefs.`);
    if (value.sourceRunRef !== undefined && value.sourceRunRef !== 'source-run/run.json') errors.push(`${path}: sourceRunRef must be source-run/run.json.`);
    if (value.sourceReportRef !== undefined && value.sourceReportRef !== 'source-run/report.md') errors.push(`${path}: sourceReportRef must be source-run/report.md.`);
    if (value.metadata?.mode === 'quick' && value.metadata?.status === 'completed' && (value.prdRef !== 'prd.md' || value.finalization?.status !== 'completed' || !value.finalization?.sourceRunId || !value.finalization?.artifactHash)) errors.push(`${path}: completed Quick Task requires finalized prd.md metadata.`);
  }
  if (/\/scenarios\/[^/]+\.json$/.test(path)) {
    if (!isSafeId(value.id) || typeof value.title !== 'string' || typeof value.intent !== 'string' || !value.expected || !Array.isArray(value.preconditions) || !Array.isArray(value.evidence) || !Array.isArray(value.cleanup) || !['low', 'medium', 'high', 'critical'].includes(value.risk)) errors.push(`${path}: invalid Scenario contract.`);
    if (!Array.isArray(value.plannedSteps) || !value.plannedSteps.length) errors.push(`${path}: plannedSteps must contain detailed reviewable steps.`);
    for (const [index, step] of (value.plannedSteps ?? []).entries()) if (!step || !isSafeId(step.id) || typeof step.action !== 'string' || !step.action.trim() || typeof step.expected !== 'string' || !step.expected.trim()) errors.push(`${path}: invalid planned step ${index + 1}.`);
    if (!Array.isArray(value.visualAssertions) || !value.visualAssertions.length) errors.push(`${path}: visualAssertions must be non-empty.`);
    for (const [index, assertion] of (value.visualAssertions ?? []).entries()) if (!assertion || !isSafeId(assertion.id) || typeof assertion.expected !== 'string' || !['low', 'medium', 'high', 'critical'].includes(assertion.importance)) errors.push(`${path}: invalid visual assertion ${index + 1}.`);
  }
  if (path.endsWith('/module-snapshot.json') && (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'ModuleSnapshot' || !isSafeId(value.moduleId) || typeof value.snapshotHash !== 'string')) errors.push(`${path}: invalid module snapshot.`);
  if (path.endsWith('/requirements.json') && (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'TestRequirements' || !isSafeId(value.taskId) || !isSafeId(value.moduleId))) errors.push(`${path}: invalid requirements.`);
  if (/\/memory\/[^/]+\.json$/.test(path) || /\/shared-memory\/entries\/[^/]+\.json$/.test(path)) { if (!isSafeId(value.id) || !['candidate', 'active', 'superseded', 'deprecated'].includes(value.status)) errors.push(`${path}: invalid memory.`); if (hasSecrets({ content: value.content, structuredRule: value.structuredRule })) errors.push(`${path}: contains a potential secret.`); }
  if (/\/tasks\/[^/]+\/source-run\/run\.json$/.test(path)) {
    if (!['pending', 'running', 'passed', 'failed', 'blocked', 'paused', 'inconclusive', 'not_applicable', 'adapted'].includes(value.status)) errors.push(`${path}: invalid Source Run status.`);
    if (value.guidedPending) {
      if (!['execute_action', 'result_verdict'].includes(value.guidedPending.type)) errors.push(`${path}: invalid user-led pending interaction.`);
      if (value.guidedPending.type === 'execute_action' && (!isSafeId(value.guidedPending.scenarioId) || typeof value.guidedPending.action !== 'string' || typeof value.guidedPending.expected !== 'string' || !isHumanApprover(value.guidedPending.approval?.confirmedBy))) errors.push(`${path}: user-led approved action is incomplete.`);
      if (value.guidedPending.type === 'result_verdict' && typeof value.guidedPending.stepId !== 'string') errors.push(`${path}: user-led result verdict target is missing.`);
      if (value.completedAt) errors.push(`${path}: completed user-led Run must not keep a pending interaction.`);
    }
    if (value.completedAt && (value.steps ?? []).some((step: Record<string, unknown>) => step.humanApproval && !step.humanVerdict)) errors.push(`${path}: completed user-led Run has an approved UI step without a QA verdict.`);
    if (Array.isArray(value.scenarioRegressionDrafts)) {
      for (const draft of value.scenarioRegressionDrafts) {
        if (!isSafeId(draft.scenarioId) || !isSafeId(draft.scriptId) || typeof draft.scriptRef !== 'string' || typeof draft.manifestRef !== 'string' || !Array.isArray(draft.sourceStepIds) || !draft.sourceStepIds.length || !draft.sourceFlowHash || !draft.scriptHash) errors.push(`${path}: invalid Scenario regression draft traceability.`);
      }
    }
    if (value.completedAt) {
      if (!value.planHash) errors.push(`${path}: completed Run requires planHash.`);
      const expected = 'source-run/report.md'; if (value.reportPath !== expected) errors.push(`${path}: reportPath must be ${expected}.`);
      if (value.reportGeneratedBy !== RUNTIME_REPORT_GENERATOR || !value.reportGeneratedAt) errors.push(`${path}: completed Run must be Runtime-owned.`);
      const reportPath = join(dirname(path), 'report.md');
      if (!existsSync(reportPath) || !hasRuntimeReportMarker(readFileSync(reportPath, 'utf8'), value.id)) errors.push(`${path}: Runtime report is missing or invalid.`);
      else {
        const report = readFileSync(reportPath, 'utf8');
        const screenshots = Array.isArray(value.screenshots) ? value.screenshots : [];
        const formalReportRequired = ['passed', 'adapted', 'failed'].includes(value.status) || (Array.isArray(value.steps) && value.steps.some((step: Record<string, unknown>) => step.source === 'ui'));
        if (formalReportRequired && !screenshots.length) errors.push(`${path}: formal Source Run report requires screenshots.`);
        if (formalReportRequired && report.includes('QA-AGENT:SOURCE-RUN-DIAGNOSTIC')) errors.push(`${path}: screenshot-backed Source Run must not be marked diagnostic.`);
        if (!formalReportRequired && !screenshots.length && !report.includes('QA-AGENT:SOURCE-RUN-DIAGNOSTIC')) errors.push(`${path}: screenshot-free Source Run must be marked diagnostic rather than formal.`);
        if (!report.includes('## Embedded Screenshots')) errors.push(`${path}: Source Run report must contain an Embedded Screenshots section.`);
        for (const screenshot of screenshots) {
          const screenshotPath = typeof screenshot?.path === 'string' ? screenshot.path.replace(/^source-run\//, '') : '';
          if (!screenshotPath || (!report.includes(`](./${screenshotPath})`) && !report.includes(`](${screenshotPath})`))) errors.push(`${path}: Source Run report does not embed screenshot ${screenshotPath || 'unknown'}.`);
        }
      }
    }
    if (['passed', 'adapted'].includes(value.status) && (!Array.isArray(value.screenshots) || !value.screenshots.length || !(value.visualFindings ?? []).length)) errors.push(`${path}: successful Run requires screenshot-backed findings.`);
  }
  if (/\/tasks\/[^/]+\/source-run\/scenario-regressions\/[^/]+\/manifest\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/scenario-regression-draft/v1' || value.kind !== 'ScenarioRegressionDraft' || !isSafeId(value.scenarioId) || !isSafeId(value.scriptId)) errors.push(`${path}: invalid Scenario regression draft manifest.`);
    if (!value.runId || !value.sourceFlowHash || !value.scriptHash || !Array.isArray(value.sourceStepIds) || !value.sourceStepIds.length) errors.push(`${path}: Scenario regression draft traceability is incomplete.`);
    const scriptPath = join(dirname(path), 'steps.json');
    if (!existsSync(scriptPath)) errors.push(`${path}: Scenario regression draft script is missing.`);
    else {
      const script = readFileSync(scriptPath, 'utf8');
      if (![textHash(script), textHash(script.trimEnd())].includes(value.scriptHash)) errors.push(`${scriptPath}: Scenario regression draft hash mismatch.`);
      let stepsDoc: Record<string, unknown> | undefined; try { stepsDoc = JSON.parse(script); } catch { stepsDoc = undefined; }
      if (!stepsDoc || stepsDoc.apiVersion !== 'qa-agent/regression-steps/v1' || !Array.isArray(stepsDoc.steps) || stepsDoc.steps.length === 0) errors.push(`${scriptPath}: Scenario regression steps file is invalid.`);
    }
  }
  if (/\/tasks\/[^/]+\/regression\/[^/]+\.json$/.test(path) && !path.endsWith('.steps.json')) {
    if (value.apiVersion !== 'qa-agent/python-regression/v2' || value.kind !== 'PythonRegression' || !isSafeId(value.id) || !['approved_unverified', 'validated', 'stale', 'deprecated'].includes(value.status)) errors.push(`${path}: invalid Python regression manifest.`);
    if (!isHumanApprover(value.approvedBy) || !value.approvedAt || !['current-chat-explicit-approval', 'external-review-record'].includes(value.approvalSource)) errors.push(`${path}: Python regression requires human approval.`);
    if (!/^regression\/[a-z0-9][a-z0-9-]{0,62}(?:\.steps\.json|\.py)$/.test(value.scriptRef ?? '')) errors.push(`${path}: invalid scriptRef.`);
    if (!value.sourceRunId || !value.sourceReportRef || !value.sourcePlanHash || !value.sourceFlowHash || !value.scriptHash || !Array.isArray(value.sourceStepIds) || !value.sourceStepIds.length || !Array.isArray(value.scenarioIds) || !value.scenarioIds.length) errors.push(`${path}: missing Run and flow traceability.`);
    if (value.status === 'validated' && (!value.validatedByRunId || !value.validatedAt)) errors.push(`${path}: validated script requires a completed validation Run.`);
    const isStepsManifest = typeof value.scriptRef === 'string' && value.scriptRef.endsWith('.steps.json');
    const scriptPath = join(dirname(path), isStepsManifest ? `${value.id}.steps.json` : `${value.id}.py`);
    if (!existsSync(scriptPath)) errors.push(`${path}: script is missing.`); else { const script = readFileSync(scriptPath, 'utf8'); if (![textHash(script), textHash(script.trimEnd())].includes(value.scriptHash)) errors.push(`${scriptPath}: script hash mismatch.`); if (isStepsManifest) { let stepsDoc: Record<string, unknown> | undefined; try { stepsDoc = JSON.parse(script); } catch { stepsDoc = undefined; } if (!stepsDoc || stepsDoc.apiVersion !== 'qa-agent/regression-steps/v1' || !Array.isArray(stepsDoc.steps) || stepsDoc.steps.length === 0) errors.push(`${scriptPath}: invalid regression steps file.`); } else { if (pythonContainsRawSecret(script)) errors.push(`${scriptPath}: potential raw secret.`); if (!script.includes(`"sourceFlowHash":"${value.sourceFlowHash}"`) && !script.includes(`"sourceFlowHash": "${value.sourceFlowHash}"`)) errors.push(`${scriptPath}: sourceFlowHash metadata mismatch.`); if (!script.includes('QA_AGENT_RESULT_PATH') || !script.includes('qa-agent/python-regression-result/v1')) errors.push(`${scriptPath}: result contract missing.`); if (!script.includes('QA_AGENT_SCREENSHOT_DIR') || !/[\"\']screenshot[\"\']/.test(script)) errors.push(`${scriptPath}: screenshot checkpoint contract missing.`); } }
  }
  if (/\/tasks\/[^/]+\/regression-runs\/[^/]+\/run\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/python-regression-run/v1' || value.kind !== 'PythonRegressionRun' || !isSafeId(value.id) || !isSafeId(value.regressionId)) errors.push(`${path}: invalid Python regression Run.`);
    if (!['passed', 'failed', 'blocked', 'inconclusive'].includes(value.status) || !['completed', 'blocked', 'invalid_result', 'failed_to_start'].includes(value.contractStatus)) errors.push(`${path}: invalid Python regression Run status.`);
    const directory = dirname(path);
    for (const ref of [value.reportRef, value.stdoutRef, value.stderrRef]) if (typeof ref !== 'string' || !existsSync(join(directory, ref))) errors.push(`${path}: missing asset ${String(ref)}.`);
    const screenshots = Array.isArray(value.screenshots) ? value.screenshots : [];
    for (const screenshot of screenshots) if (typeof screenshot !== 'string' || !screenshot.startsWith('screenshots/') || !existsSync(join(directory, screenshot))) errors.push(`${path}: missing or invalid regression screenshot ${String(screenshot)}.`);
    if (value.contractStatus === 'completed') {
      if (!screenshots.length) errors.push(`${path}: completed Python regression Run requires screenshot-backed checkpoints.`);
      const reportPath = typeof value.reportRef === 'string' ? join(directory, value.reportRef) : undefined;
      if (reportPath && existsSync(reportPath)) {
        const report = readFileSync(reportPath, 'utf8');
        if (!report.includes('## Screenshot-backed Checkpoints') || !/!\[[^\]]*\]\(screenshots\/[^\)]+\)/.test(report)) errors.push(`${path}: completed regression report must embed checkpoint screenshots.`);
        for (const screenshot of screenshots) if (!report.includes(`](${screenshot})`)) errors.push(`${path}: completed regression report does not embed screenshot ${screenshot}.`);
      }
    }
  }
  if (/\/\.runtime\/drafts\/[^/]+\/[^/]+\/draft\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/python-regression-draft/v2' || value.kind !== 'PythonRegressionDraft' || value.status !== 'draft' || !isSafeId(value.id)) errors.push(`${path}: invalid regression draft.`);
    if (!value.sourceRunId || !value.sourcePlanHash || !value.sourceFlowHash || !Array.isArray(value.sourceStepIds) || !value.sourceStepIds.length || !Array.isArray(value.scenarioIds) || !value.scenarioIds.length || !value.scriptHash) errors.push(`${path}: draft traceability is incomplete.`);
    const isStepsDraft = typeof value.scriptRef === 'string' && value.scriptRef.endsWith('.steps.json');
    const scriptPath = join(dirname(path), isStepsDraft ? `${value.id}.steps.json` : `${value.id}.py`); if (!existsSync(scriptPath)) errors.push(`${path}: draft script is missing.`); else { const script = readFileSync(scriptPath, 'utf8'); if (![textHash(script), textHash(script.trimEnd())].includes(value.scriptHash)) errors.push(`${scriptPath}: draft hash mismatch.`); if (!isStepsDraft && pythonContainsRawSecret(script)) errors.push(`${scriptPath}: potential raw secret.`); }
  }
  if (/\/regression-runs\/[^/]+\.json$/.test(path) && !/\/tasks\//.test(path)) {
    if (value.apiVersion !== 'qa-agent/python-regression-batch-run/v1' || value.kind !== 'PythonRegressionBatchRun' || !isSafeId(value.id) || !['task', 'module', 'release'].includes(value.selectionScope) || !Array.isArray(value.childRuns)) errors.push(`${path}: invalid Python regression batch Run.`);
  }
  if (/\/impact-analysis\/[^/]+\.json$/.test(path) && (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'ImpactAnalysis')) errors.push(`${path}: invalid ImpactAnalysis.`);
  if (/\/release-checks\/[^/]+\.json$/.test(path) && (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'ReleaseCheck' || !value.selection || !['pending', 'go', 'no-go', 'review'].includes(value.releaseDecision))) errors.push(`${path}: invalid ReleaseCheck.`);
  if (/\/\.runtime\/(?:sessions\/(?![^/]+\.closed\.json$)[^/]+\.json|current-task\.json)$/.test(path) && (value.apiVersion !== 'qa-agent/session/v1' || !isSafeId(value.storageKey) || !isSafeId(value.moduleId) || !isSafeId(value.taskId))) errors.push(`${path}: invalid Session binding.`);
  if (/\/\.runtime\/sessions\/[^/]+\.closed\.json$/.test(path) && (value.apiVersion !== 'qa-agent/session-closure/v1' || value.reason !== 'finish' || !isSafeId(value.storageKey) || !isSafeId(value.moduleId) || !isSafeId(value.taskId))) errors.push(`${path}: invalid Session closure.`);
  return errors;
}

export function validateProject(root: string): ValidationResult {
  const files: Array<[string, string[]]> = [[qaPath(root, 'project.json'), ['version', 'project', 'platforms', 'defaultContext', 'source', 'storage']], [qaPath(root, 'policies.json'), ['safeMode', 'prohibitedActions', 'stopBefore']], [qaPath(root, 'mcp.json'), ['version', 'connections']]];
  const add = (paths: string[], fields: string[]): void => { for (const path of paths) files.push([path, fields]); };
  add(listFiles(qaPath(root, 'modules'), path => basename(path) === 'module.json'), ['id', 'name', 'status', 'riskLevel', 'platforms', 'roles']);
  add(listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path)), ['apiVersion', 'kind', 'metadata', 'moduleSnapshotRef', 'requirementsRef', 'testPlanRef', 'scenarioRefs', 'prdRef', 'capabilities', 'safety', 'evidence']);
  add(listFiles(qaPath(root, 'modules'), path => path.endsWith('/module-snapshot.json')), ['apiVersion', 'kind', 'moduleId', 'snapshotHash']);
  add(listFiles(qaPath(root, 'modules'), path => path.endsWith('/requirements.json')), ['apiVersion', 'kind', 'taskId', 'moduleId', 'businessGoals']);
  add(listFiles(qaPath(root, 'modules'), path => path.endsWith('/test-plan.json')), ['apiVersion', 'kind', 'taskId', 'moduleId', 'planHash', 'scenarioRefs']);
  add(listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/scenarios\/[^/]+\.json$/.test(path)), ['id', 'title', 'intent', 'expected', 'evidence', 'cleanup', 'visualAssertions']);
  add(listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/source-run\/run\.json$/.test(path)), ['id', 'taskId', 'moduleId', 'context', 'status', 'steps', 'startedAt']);
  add(listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/regression\/[^/]+\.json$/.test(path) && !path.endsWith('.steps.json')), ['apiVersion', 'kind', 'id', 'moduleId', 'taskId', 'scriptRef', 'sourceRunId', 'sourcePlanHash', 'sourceStepIds', 'scenarioIds', 'sourceFlowHash', 'scriptHash', 'status', 'approvedBy']);
  add(listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/regression-runs\/[^/]+\/run\.json$/.test(path)), ['apiVersion', 'kind', 'id', 'regressionId', 'status', 'contractStatus', 'reportRef', 'stdoutRef', 'stderrRef']);
  add(listFiles(qaPath(root, 'regression-runs'), path => path.endsWith('.json')), ['apiVersion', 'kind', 'id', 'selectionId', 'selectionScope', 'selectionHash', 'status', 'childRuns']);
  add(listFiles(qaPath(root, 'impact-analysis'), path => path.endsWith('.json')), ['apiVersion', 'kind', 'id', 'changedFiles', 'impactedModules']);
  add(listFiles(qaPath(root, 'release-checks'), path => path.endsWith('.json')), ['apiVersion', 'kind', 'id', 'profile', 'impactAnalysis', 'selection', 'status', 'releaseDecision']);
  add(listFiles(qaPath(root, 'modules'), path => /\/memory\/[^/]+\.json$/.test(path)), ['id', 'type', 'title', 'content', 'status']);
  add(listFiles(qaPath(root, 'shared-memory', 'entries'), path => path.endsWith('.json')), ['id', 'type', 'title', 'content', 'status']);
  add(listFiles(qaPath(root, '.runtime', 'sessions'), path => path.endsWith('.json') && !path.endsWith('.closed.json')), ['apiVersion', 'storageKey', 'moduleId', 'taskId']);
  add(listFiles(qaPath(root, '.runtime', 'sessions'), path => path.endsWith('.closed.json')), ['apiVersion', 'storageKey', 'moduleId', 'taskId', 'reason']);
  add(listFiles(qaPath(root, '.runtime', 'drafts'), path => path.endsWith('/draft.json')), ['apiVersion', 'kind', 'id', 'moduleId', 'taskId', 'sourceRunId', 'sourceStepIds', 'scenarioIds', 'sourceFlowHash', 'scriptHash']);
  const current = qaPath(root, '.runtime', 'current-task.json'); if (existsSync(current)) files.push([current, ['apiVersion', 'storageKey', 'moduleId', 'taskId']]);
  const errors = files.filter(([path]) => !existsSync(path)).map(([path]) => `${path}: not found`);
  for (const [path, fields] of files) if (existsSync(path)) { errors.push(...validateObject(path, fields)); try { errors.push(...validateDomainObject(path)); } catch (error) { errors.push(`${path}: ${(error as Error).message}`); } }
  errors.push(...inspectManagedRuntimeAssets(qaPath(root)));

  const validStates = new Set<TaskLifecycleState>(['draft', 'planning', 'awaiting_approval', 'ready', 'running', 'reviewing_result', 'completed', 'archived', 'blocked', 'paused', 'retired']);
  for (const manifestPath of listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path))) {
    const manifest = readJson<Record<string, any>>(manifestPath); const moduleId = manifest.metadata?.moduleId; const taskId = manifest.metadata?.id; if (!moduleId || !taskId) continue;
    const taskDir = dirname(manifestPath); const task = readTask(root, moduleId, taskId);
    if (!planningPrdIsCurrent(taskPrdPath(root, moduleId, taskId), task)) errors.push(`${manifestPath}: Task prd.md is missing or stale for the current detailed TestPlan.`);
    try { const events = readTaskEvents(root, moduleId, taskId); const ids = new Set<string>(); const keys = new Set<string>(); for (const [index, event] of events.entries()) { if (event.seq !== index + 1) errors.push(`${manifestPath}: invalid event sequence.`); if (!event.id || ids.has(event.id)) errors.push(`${manifestPath}: duplicate event id.`); else ids.add(event.id); if (!event.idempotencyKey || keys.has(event.idempotencyKey)) errors.push(`${manifestPath}: duplicate event idempotencyKey.`); else keys.add(event.idempotencyKey); if (event.fromState && !validStates.has(resolveTaskState(event.fromState))) errors.push(`${manifestPath}: invalid event fromState.`); if (event.toState && !validStates.has(resolveTaskState(event.toState))) errors.push(`${manifestPath}: invalid event toState.`); } } catch (error) { errors.push((error as Error).message); }
    const sourcePath = taskSourceRunPath(root, moduleId, taskId);
    const sourceRun = existsSync(sourcePath) ? readJson<TestRun>(sourcePath) : undefined;
    if (sourceRun && (sourceRun.moduleId !== moduleId || sourceRun.taskId !== taskId)) errors.push(`${sourcePath}: Source Run identity does not match its Task.`);
    if (sourceRun && manifest.sourceRunRef !== 'source-run/run.json') errors.push(`${manifestPath}: Source Run exists but sourceRunRef is missing.`);
    if (!sourceRun && manifest.sourceRunRef !== undefined) errors.push(`${manifestPath}: sourceRunRef exists without source-run/run.json.`);
    if (sourceRun?.completedAt) {
      if (manifest.sourceReportRef !== 'source-run/report.md') errors.push(`${manifestPath}: completed Source Run requires sourceReportRef=source-run/report.md.`);
      const sourceReport = taskSourceRunReportPath(root, moduleId, taskId);
      if (!existsSync(sourceReport) || !hasRuntimeReportMarker(readFileSync(sourceReport, 'utf8'), sourceRun.id)) errors.push(`${manifestPath}: completed Source Run report is missing or invalid.`);
      for (const screenshot of sourceRun.screenshots ?? []) if (!existsSync(join(taskDir, 'source-run', screenshot.path))) errors.push(`${manifestPath}: Source Run screenshot is missing: ${screenshot.path}.`);
    } else if (manifest.sourceReportRef !== undefined) errors.push(`${manifestPath}: sourceReportRef exists before the Source Run is completed.`);
    const planHash = testPlanHash(task); const regressions = listFiles(join(taskDir, 'regression'), path => path.endsWith('.json') && !path.endsWith('.steps.json')).map(path => readJson<Record<string, any>>(path)); const regressionRuns = listFiles(join(taskDir, 'regression-runs'), path => path.endsWith('/run.json')).map(path => readJson<Record<string, any>>(path)); const declared = new Set<string>(manifest.pythonRegressionRefs ?? []);
    for (const regression of regressions) {
      if (!declared.has(`regression/${regression.id}.json`)) errors.push(`${manifestPath}: script ${regression.id} is missing from pythonRegressionRefs.`);
      if (!sourceRun || sourceRun.id !== regression.sourceRunId) { if (regression.status !== 'stale') errors.push(`${manifestPath}: script ${regression.id} Source Run is missing or no longer current.`); continue; }
      const eligibility = inspectPythonRegressionEligibility(task, sourceRun); if (eligibility.flowHash !== regression.sourceFlowHash && regression.status !== 'stale') errors.push(`${manifestPath}: script ${regression.id} should be stale because sourceFlowHash changed.`);
      if (['approved_unverified', 'validated'].includes(regression.status) && regression.sourcePlanHash !== planHash) errors.push(`${manifestPath}: script ${regression.id} should be stale because planHash changed.`);
      if (regression.status === 'validated' && !regressionRuns.some(run => run.id === regression.validatedByRunId && run.regressionId === regression.id && run.contractStatus === 'completed')) errors.push(`${manifestPath}: validated script ${regression.id} lacks a completed regression Run.`);
    }
    for (const ref of declared) if (!existsSync(join(taskDir, ref))) errors.push(`${manifestPath}: missing script reference ${ref}.`);
    if (manifest.metadata?.mode === 'quick' && manifest.metadata?.status === 'completed') { const prd = join(taskDir, 'prd.md'); if (!existsSync(prd) || !readFileSync(prd, 'utf8').includes('<!-- QA-AGENT:RESULTS:START -->')) errors.push(`${manifestPath}: completed Quick Task is missing finalized prd.md.`); }
    if (resolveTaskState(manifest.metadata?.status) === 'archived') {
      const covered = new Set(regressions.filter(item => item.status === 'validated' && item.sourcePlanHash === planHash).flatMap(item => item.scenarioIds ?? []));
      for (const scenario of task.scenarios) if (!covered.has(scenario.id)) errors.push(`${manifestPath}: archived Scenario ${scenario.id} lacks a validated Python regression.`);
      if (!sourceRun?.completedAt || !['passed', 'adapted'].includes(sourceRun.status)) errors.push(`${manifestPath}: archived Task requires the Source Run passed or adapted.`);
    }
  }

  for (const path of listFiles(qaPath(root, 'reports'), item => item.endsWith('.md'))) { const id = basename(path, '.md'); let owner = existsSync(qaPath(root, 'release-checks', `${id}.json`)); if (!owner && existsSync(qaPath(root, 'regression-runs', `${id}.json`))) { try { owner = readJson<RegressionRun>(qaPath(root, 'regression-runs', `${id}.json`)).selectionScope === 'release'; } catch { owner = false; } } if (!owner) errors.push(`${path}: orphan Runtime report.`); }
  return { valid: errors.length === 0, errors, checked: files.length };
}

export function validateSkill(skillRoot: string): ValidationResult {
  const path = join(skillRoot, 'SKILL.md'); if (!existsSync(path)) return { valid: false, errors: [`${path}: not found`], checked: 0 };
  const text = readFileSync(path, 'utf8'); const errors: string[] = [];
  if (!new RegExp('^---\\nname: [a-z0-9-]+\\ndescription: .+\\n---\\n', 's').test(text)) errors.push('SKILL.md: invalid frontmatter.');
  if (text.includes('[TODO:')) errors.push('SKILL.md: contains TODO text.');
  const workflowPath = join(skillRoot, 'references', 'workflow.md'); const runnerPath = join(skillRoot, 'references', 'regression-runner.md'); const recommendedStackPath = join(skillRoot, 'references', 'recommended-regression-stack.md');
  for (const file of [workflowPath, runnerPath, recommendedStackPath]) if (!existsSync(file)) errors.push(`${file}: not found`);
  for (const phase of ['doctor', 'guided', 'regression-test']) { const phasePath = join(skillRoot, 'skills', phase, 'SKILL.md'); if (!existsSync(phasePath)) { errors.push(`${phasePath}: not found`); continue; } const phaseText = readFileSync(phasePath, 'utf8'); if (!new RegExp(`^---\\nname: qa-agent-${phase}\\ndescription: .+\\n---\\n`, 's').test(phaseText)) errors.push(`${phasePath}: invalid frontmatter.`); if (!text.includes(`qa-agent-${phase}`)) errors.push(`SKILL.md: route qa-agent-${phase} is missing.`); if (phase === 'doctor' && (!phaseText.includes('qa-agent doctor') || !phaseText.includes('.qa-agent/runner') || !phaseText.includes('do not install'))) errors.push(`${phasePath}: Doctor must guide readiness without automatic dependency installation.`); if (phase === 'regression-test' && (!phaseText.includes('qa-agent regression run') || /qa-agent regression (?:draft|publish)/.test(phaseText))) errors.push(`${phasePath}: regression-test must only run formal regression scripts.`); }
  const recommendedStackText = existsSync(recommendedStackPath) ? readFileSync(recommendedStackPath, 'utf8') : '';
  if (recommendedStackText && (!/Python 3\.12/.test(recommendedStackText) || !/pytest-playwright/.test(recommendedStackText) || !/xcrun simctl/.test(recommendedStackText) || !/fb-idb/.test(recommendedStackText) || !/idb_companion/.test(recommendedStackText) || !/ios-simulator-mcp/.test(recommendedStackText) || !/result\.json/.test(recommendedStackText) || !/report\.md/.test(recommendedStackText) || !/screenshots\//.test(recommendedStackText) || !/stdout\.log/.test(recommendedStackText) || !/stderr\.log/.test(recommendedStackText) || !/evidence\//.test(recommendedStackText))) errors.push(`${recommendedStackPath}: recommended stack contract is incomplete.`);
  if (recommendedStackText && /junit|allure|ui-tree|playwright trace|videos?\//i.test(recommendedStackText)) errors.push(`${recommendedStackPath}: removed extended artifact requirements must not be documented.`);
  return { valid: errors.length === 0, errors, checked: 7 };
}
