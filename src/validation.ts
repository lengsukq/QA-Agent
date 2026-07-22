import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { qaPath, readTask } from './project.ts';
import { hasSecrets, isSafeId, listFiles, readJson } from './store.ts';
import { isHumanApprover, testPlanHash } from './approval.ts';
import { hasRuntimeReportMarker, RUNTIME_REPORT_GENERATOR } from './report-contract.ts';
import type { RegressionRun, TaskLifecycleState, TestRun } from './types.ts';
import { readTaskEvents } from './events.ts';
import { normalizeTaskState } from './workflow-model.ts';
import { inspectPythonRegressionEligibility } from './python-regression.ts';
import { inspectManagedRuntimeAssets } from './managed-assets.ts';

export interface ValidationResult { valid: boolean; errors: string[]; checked: number }
function textHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function pythonContainsRawSecret(script: string): boolean { return /\b(?:password|token|secret|cookie|authorization|private_?key|credit_?card)\w*\s*=\s*(["'])(?!env:|\$\{|QA_|os\.environ|os\.getenv)[^"'\n]+\1/i.test(script) || /\b(?:authorization|cookie)\b\s*:\s*(["'])(?!env:|\$\{|QA_)[^"'\n]+\1/i.test(script); }
function validateObject(path: string, fields: string[]): string[] { try { const value = readJson<Record<string, unknown>>(path); return fields.filter(field => value[field] === undefined).map(field => `${path}: missing ${field}`); } catch (error) { return [`${path}: ${(error as Error).message}`]; } }

function validateDomainObject(path: string): string[] {
  const value = readJson<Record<string, any>>(path); const errors: string[] = [];
  if (path.endsWith('module.json') && (!isSafeId(value.id) || !['active', 'deprecated', 'archived'].includes(value.status) || typeof value.revision !== 'number')) errors.push(`${path}: invalid module id, revision, or status.`);
  if (/\/tasks\/[^/]+\/task\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/v2' || !value.metadata || !isSafeId(value.metadata.id) || !isSafeId(value.metadata.moduleId)) errors.push(`${path}: invalid Task contract.`);
    const statuses = ['draft', 'planning', 'awaiting_approval', 'ready', 'running', 'reviewing_result', 'completed', 'archived', 'needs_input', 'blocked', 'paused', 'deprecated', 'superseded', 'active', 'needs_review', 'finalizing', 'regression_ready'];
    if (!statuses.includes(value.metadata?.status)) errors.push(`${path}: invalid Task lifecycle state ${value.metadata?.status}.`);
    const quick = value.metadata?.mode === 'quick' && value.metadata?.approvalPolicy === 'side-effect-only';
    if (value.metadata?.mode && !['quick', 'regression'].includes(value.metadata.mode)) errors.push(`${path}: invalid QA mode ${value.metadata.mode}.`);
    if (value.metadata?.mode === 'quick' && value.metadata?.approvalPolicy !== 'side-effect-only') errors.push(`${path}: Quick Tasks must use approvalPolicy=side-effect-only.`);
    if (['ready', 'running', 'reviewing_result', 'completed', 'archived', 'active'].includes(value.metadata?.status) && !quick && (!isHumanApprover(value.metadata.approval?.confirmedBy) || !value.metadata.approval?.confirmedAt || !value.metadata.approval?.confirmationSource || !value.metadata.approval?.planHash)) errors.push(`${path}: executable or completed strict Task requires explicit human approval.`);
    if (!Array.isArray(value.scenarioRefs) || !value.scenarioRefs.length || value.scenarioRefs.some((ref: unknown) => typeof ref !== 'string' || !/^scenarios\/[a-z0-9][a-z0-9-]{0,62}\.json$/.test(ref))) errors.push(`${path}: invalid scenarioRefs.`);
    if (value.pythonRegressionRefs !== undefined && (!Array.isArray(value.pythonRegressionRefs) || value.pythonRegressionRefs.some((ref: unknown) => typeof ref !== 'string' || !/^regression\/[a-z0-9][a-z0-9-]{0,62}\.json$/.test(ref)))) errors.push(`${path}: invalid pythonRegressionRefs.`);
    if (value.operationPlanRefs !== undefined || value.regressionSuiteRef !== undefined) errors.push(`${path}: legacy OperationPlan or RegressionSuite references remain; run qa-agent migrate.`);
    if (value.metadata?.mode === 'quick' && value.metadata?.status === 'completed' && (value.prdRef !== 'prd.md' || value.finalization?.status !== 'completed' || !value.finalization?.sourceRunId || !value.finalization?.artifactHash)) errors.push(`${path}: completed Quick Task requires finalized prd.md metadata.`);
    if (value.reportIndexRef !== 'runs/index.json') errors.push(`${path}: reportIndexRef must be runs/index.json.`);
  }
  if (/\/scenarios\/[^/]+\.json$/.test(path)) {
    if (!isSafeId(value.id) || typeof value.title !== 'string' || typeof value.intent !== 'string' || !value.expected || !Array.isArray(value.preconditions) || !Array.isArray(value.evidence) || !Array.isArray(value.cleanup) || !['low', 'medium', 'high', 'critical'].includes(value.risk)) errors.push(`${path}: invalid Scenario contract.`);
    if (!Array.isArray(value.visualAssertions) || !value.visualAssertions.length) errors.push(`${path}: visualAssertions must be non-empty.`);
    for (const [index, assertion] of (value.visualAssertions ?? []).entries()) if (!assertion || !isSafeId(assertion.id) || typeof assertion.expected !== 'string' || !['low', 'medium', 'high', 'critical'].includes(assertion.importance)) errors.push(`${path}: invalid visual assertion ${index + 1}.`);
  }
  if (path.endsWith('/module-snapshot.json') && (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'ModuleSnapshot' || !isSafeId(value.moduleId) || typeof value.snapshotHash !== 'string')) errors.push(`${path}: invalid module snapshot.`);
  if (path.endsWith('/requirements.json') && (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'TestRequirements' || !isSafeId(value.taskId) || !isSafeId(value.moduleId))) errors.push(`${path}: invalid requirements.`);
  if (/\/memory\/[^/]+\.json$/.test(path) || /\/shared-memory\/entries\/[^/]+\.json$/.test(path)) { if (!isSafeId(value.id) || !['candidate', 'active', 'superseded', 'deprecated'].includes(value.status)) errors.push(`${path}: invalid memory.`); if (hasSecrets({ content: value.content, structuredRule: value.structuredRule })) errors.push(`${path}: contains a potential secret.`); }
  if (/\/tasks\/[^/]+\/runs\/[^/]+\/run\.json$/.test(path)) {
    if (!['pending', 'running', 'passed', 'failed', 'blocked', 'paused', 'inconclusive', 'not_applicable', 'needs_confirmation', 'adapted'].includes(value.status)) errors.push(`${path}: invalid Run status.`);
    if (value.operationPlanId !== undefined || value.replayStatus !== undefined || value.replayStage !== undefined || value.replayCursor !== undefined || value.operationCandidates !== undefined || (value.steps ?? []).some((step: Record<string, unknown>) => step.operationAction !== undefined)) errors.push(`${path}: legacy replay or action fields remain; run qa-agent migrate.`);
    if (value.completedAt) {
      if (!value.planHash) errors.push(`${path}: completed Run requires planHash.`);
      const expected = `runs/${value.id}/report.md`; if (value.reportPath !== expected) errors.push(`${path}: reportPath must be ${expected}.`);
      if (value.reportGeneratedBy !== RUNTIME_REPORT_GENERATOR || !value.reportGeneratedAt) errors.push(`${path}: completed Run must be Runtime-owned.`);
      const reportPath = join(dirname(path), 'report.md'); if (!existsSync(reportPath) || !hasRuntimeReportMarker(readFileSync(reportPath, 'utf8'), value.id)) errors.push(`${path}: Runtime report is missing or invalid.`);
    }
    if (['passed', 'adapted'].includes(value.status) && (!Array.isArray(value.screenshots) || !value.screenshots.length || !(value.visualFindings ?? []).length)) errors.push(`${path}: successful Run requires screenshot-backed findings.`);
  }
  if (/\/tasks\/[^/]+\/regression\/[^/]+\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/python-regression/v2' || value.kind !== 'PythonRegression' || !isSafeId(value.id) || !['approved_unverified', 'validated', 'stale', 'deprecated'].includes(value.status)) errors.push(`${path}: invalid Python regression manifest.`);
    if (!isHumanApprover(value.approvedBy) || !value.approvedAt || !['current-chat-explicit-approval', 'external-review-record'].includes(value.approvalSource)) errors.push(`${path}: Python regression requires human approval.`);
    if (!/^regression\/[a-z0-9][a-z0-9-]{0,62}\.py$/.test(value.scriptRef ?? '')) errors.push(`${path}: invalid scriptRef.`);
    if (!value.sourceRunId || !value.sourceReportRef || !value.sourcePlanHash || !value.sourceFlowHash || !value.scriptHash || !Array.isArray(value.sourceStepIds) || !value.sourceStepIds.length || !Array.isArray(value.scenarioIds) || !value.scenarioIds.length) errors.push(`${path}: missing Run and flow traceability.`);
    if (value.sourceOperationPlanIds !== undefined) errors.push(`${path}: legacy sourceOperationPlanIds remains; run qa-agent migrate.`);
    if (value.status === 'validated' && (!value.validatedByRunId || !value.validatedAt)) errors.push(`${path}: validated script requires a completed validation Run.`);
    const scriptPath = join(dirname(path), `${value.id}.py`);
    if (!existsSync(scriptPath)) errors.push(`${path}: script is missing.`); else { const script = readFileSync(scriptPath, 'utf8'); if (![textHash(script), textHash(script.trimEnd())].includes(value.scriptHash)) errors.push(`${scriptPath}: script hash mismatch.`); if (pythonContainsRawSecret(script)) errors.push(`${scriptPath}: potential raw secret.`); if (!script.includes(`"sourceFlowHash":"${value.sourceFlowHash}"`) && !script.includes(`"sourceFlowHash": "${value.sourceFlowHash}"`)) errors.push(`${scriptPath}: sourceFlowHash metadata mismatch.`); if (!script.includes('QA_AGENT_RESULT_PATH') || !script.includes('qa-agent/python-regression-result/v1')) errors.push(`${scriptPath}: result contract missing.`); }
  }
  if (/\/tasks\/[^/]+\/regression-runs\/[^/]+\/run\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/python-regression-run/v1' || value.kind !== 'PythonRegressionRun' || !isSafeId(value.id) || !isSafeId(value.regressionId)) errors.push(`${path}: invalid Python regression Run.`);
    if (!['passed', 'failed', 'blocked', 'inconclusive'].includes(value.status) || !['completed', 'blocked', 'invalid_result', 'failed_to_start'].includes(value.contractStatus)) errors.push(`${path}: invalid Python regression Run status.`);
    const directory = dirname(path); for (const ref of [value.reportRef, value.stdoutRef, value.stderrRef]) if (typeof ref !== 'string' || !existsSync(join(directory, ref))) errors.push(`${path}: missing asset ${String(ref)}.`);
  }
  if (/\/\.runtime\/drafts\/[^/]+\/[^/]+\/draft\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/python-regression-draft/v2' || value.kind !== 'PythonRegressionDraft' || value.status !== 'draft' || !isSafeId(value.id)) errors.push(`${path}: invalid Python draft.`);
    if (!value.sourceRunId || !value.sourcePlanHash || !value.sourceFlowHash || !Array.isArray(value.sourceStepIds) || !value.sourceStepIds.length || !Array.isArray(value.scenarioIds) || !value.scenarioIds.length || !value.scriptHash) errors.push(`${path}: draft traceability is incomplete.`);
    if (value.sourceOperationPlanIds !== undefined) errors.push(`${path}: legacy sourceOperationPlanIds remains.`);
    const scriptPath = join(dirname(path), `${value.id}.py`); if (!existsSync(scriptPath)) errors.push(`${path}: draft script is missing.`); else { const script = readFileSync(scriptPath, 'utf8'); if (![textHash(script), textHash(script.trimEnd())].includes(value.scriptHash)) errors.push(`${scriptPath}: draft hash mismatch.`); if (pythonContainsRawSecret(script)) errors.push(`${scriptPath}: potential raw secret.`); }
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
  add(listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path)), ['apiVersion', 'kind', 'metadata', 'moduleSnapshotRef', 'requirementsRef', 'testPlanRef', 'scenarioRefs', 'capabilities', 'safety', 'evidence']);
  add(listFiles(qaPath(root, 'modules'), path => path.endsWith('/module-snapshot.json')), ['apiVersion', 'kind', 'moduleId', 'snapshotHash']);
  add(listFiles(qaPath(root, 'modules'), path => path.endsWith('/requirements.json')), ['apiVersion', 'kind', 'taskId', 'moduleId', 'businessGoals']);
  add(listFiles(qaPath(root, 'modules'), path => path.endsWith('/test-plan.json')), ['apiVersion', 'kind', 'taskId', 'moduleId', 'planHash', 'scenarioRefs']);
  add(listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/scenarios\/[^/]+\.json$/.test(path)), ['id', 'title', 'intent', 'expected', 'evidence', 'cleanup', 'visualAssertions']);
  add(listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/runs\/[^/]+\/run\.json$/.test(path)), ['id', 'taskId', 'moduleId', 'context', 'status', 'steps', 'startedAt']);
  add(listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/regression\/[^/]+\.json$/.test(path)), ['apiVersion', 'kind', 'id', 'moduleId', 'taskId', 'scriptRef', 'sourceRunId', 'sourcePlanHash', 'sourceStepIds', 'scenarioIds', 'sourceFlowHash', 'scriptHash', 'status', 'approvedBy']);
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
  for (const legacy of listFiles(qaPath(root, 'modules'), path => path.includes('/operation-plans/') || path.endsWith('/regression-suite.json'))) errors.push(`${legacy}: legacy OperationPlan asset remains; run qa-agent migrate.`);
  for (const name of ['archive', 'cache', 'evidence', 'runs']) if (existsSync(qaPath(root, name))) errors.push(`${qaPath(root, name)}: legacy project-level Runtime directory remains; run qa-agent update --migrate.`);

  const validStates = new Set<TaskLifecycleState>(['draft', 'planning', 'awaiting_approval', 'ready', 'running', 'reviewing_result', 'completed', 'archived', 'needs_input', 'blocked', 'paused', 'deprecated', 'superseded']);
  for (const manifestPath of listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path))) {
    const manifest = readJson<Record<string, any>>(manifestPath); const moduleId = manifest.metadata?.moduleId; const taskId = manifest.metadata?.id; if (!moduleId || !taskId) continue;
    const taskDir = dirname(manifestPath); const task = readTask(root, moduleId, taskId);
    if (existsSync(join(taskDir, 'reports'))) errors.push(`${join(taskDir, 'reports')}: legacy Task reports directory remains; run qa-agent update --migrate.`);
    try { const events = readTaskEvents(root, moduleId, taskId); const ids = new Set<string>(); const keys = new Set<string>(); for (const [index, event] of events.entries()) { if (event.seq !== index + 1) errors.push(`${manifestPath}: invalid event sequence.`); if (!event.id || ids.has(event.id)) errors.push(`${manifestPath}: duplicate event id.`); else ids.add(event.id); if (!event.idempotencyKey || keys.has(event.idempotencyKey)) errors.push(`${manifestPath}: duplicate event idempotencyKey.`); else keys.add(event.idempotencyKey); if (event.fromState && !validStates.has(normalizeTaskState(event.fromState))) errors.push(`${manifestPath}: invalid event fromState.`); if (event.toState && !validStates.has(normalizeTaskState(event.toState))) errors.push(`${manifestPath}: invalid event toState.`); } } catch (error) { errors.push((error as Error).message); }
    const taskRuns = listFiles(join(taskDir, 'runs'), path => path.endsWith('/run.json')).map(path => readJson<TestRun>(path));
    if (taskRuns.filter(run => run.status === 'running').length > 1) errors.push(`${manifestPath}: multiple active Runs.`);
    const planHash = testPlanHash(task); const regressions = listFiles(join(taskDir, 'regression'), path => path.endsWith('.json')).map(path => readJson<Record<string, any>>(path)); const regressionRuns = listFiles(join(taskDir, 'regression-runs'), path => path.endsWith('/run.json')).map(path => readJson<Record<string, any>>(path)); const declared = new Set<string>(manifest.pythonRegressionRefs ?? []);
    for (const regression of regressions) {
      if (!declared.has(`regression/${regression.id}.json`)) errors.push(`${manifestPath}: script ${regression.id} is missing from pythonRegressionRefs.`);
      const source = taskRuns.find(run => run.id === regression.sourceRunId); if (!source) { if (regression.status !== 'stale') errors.push(`${manifestPath}: script ${regression.id} source Run is missing.`); continue; }
      const eligibility = inspectPythonRegressionEligibility(task, source); if (eligibility.flowHash !== regression.sourceFlowHash && regression.status !== 'stale') errors.push(`${manifestPath}: script ${regression.id} should be stale because sourceFlowHash changed.`);
      if (['approved_unverified', 'validated'].includes(regression.status) && regression.sourcePlanHash !== planHash) errors.push(`${manifestPath}: script ${regression.id} should be stale because planHash changed.`);
      if (regression.status === 'validated' && !regressionRuns.some(run => run.id === regression.validatedByRunId && run.regressionId === regression.id && run.contractStatus === 'completed')) errors.push(`${manifestPath}: validated script ${regression.id} lacks a completed regression Run.`);
    }
    for (const ref of declared) if (!existsSync(join(taskDir, ref))) errors.push(`${manifestPath}: missing script reference ${ref}.`);
    if (manifest.metadata?.mode === 'quick' && manifest.metadata?.status === 'completed') { const prd = join(taskDir, 'prd.md'); if (!existsSync(prd) || !readFileSync(prd, 'utf8').includes('<!-- QA-AGENT:RESULTS:START -->')) errors.push(`${manifestPath}: completed Quick Task is missing finalized prd.md.`); }
    if (normalizeTaskState(manifest.metadata?.status) === 'archived') {
      const covered = new Set(regressions.filter(item => item.status === 'validated' && item.sourcePlanHash === planHash).flatMap(item => item.scenarioIds ?? []));
      for (const scenario of task.scenarios) if (!covered.has(scenario.id)) errors.push(`${manifestPath}: archived Scenario ${scenario.id} lacks a validated Python regression.`);
      const latest = taskRuns.filter(run => Boolean(run.completedAt)).sort((a, b) => (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt))[0]; if (!latest || !['passed', 'adapted'].includes(latest.status)) errors.push(`${manifestPath}: archived Task requires latest exploratory Run passed or adapted.`);
    }
  }

  for (const path of listFiles(qaPath(root, 'reports'), item => item.endsWith('.md'))) { const id = basename(path, '.md'); let owner = existsSync(qaPath(root, 'release-checks', `${id}.json`)); if (!owner && existsSync(qaPath(root, 'regression-runs', `${id}.json`))) { try { owner = readJson<RegressionRun>(qaPath(root, 'regression-runs', `${id}.json`)).selectionScope === 'release'; } catch { owner = false; } } if (!owner) errors.push(`${path}: orphan Runtime report.`); }
  return { valid: errors.length === 0, errors, checked: files.length };
}

export function validateSkill(skillRoot: string): ValidationResult {
  const path = join(skillRoot, 'SKILL.md'); if (!existsSync(path)) return { valid: false, errors: [`${path}: not found`], checked: 0 };
  const text = readFileSync(path, 'utf8'); const errors: string[] = [];
  if (!/^---\nname: [a-z0-9-]+\ndescription: .+\n---\n/s.test(text)) errors.push('SKILL.md: invalid frontmatter.');
  if (text.includes('[TODO:')) errors.push('SKILL.md: contains TODO text.');
  const workflowPath = join(skillRoot, 'references', 'workflow.md'); const pythonPath = join(skillRoot, 'references', 'python-regression.md'); const recommendedStackPath = join(skillRoot, 'references', 'recommended-regression-stack.md');
  for (const file of [workflowPath, pythonPath, recommendedStackPath]) if (!existsSync(file)) errors.push(`${file}: not found`);
  for (const phase of ['plan', 'regression-test']) { const phasePath = join(skillRoot, 'skills', phase, 'SKILL.md'); if (!existsSync(phasePath)) { errors.push(`${phasePath}: not found`); continue; } const phaseText = readFileSync(phasePath, 'utf8'); if (!new RegExp(`^---\\nname: qa-agent-${phase}\\ndescription: .+\\n---\\n`, 's').test(phaseText)) errors.push(`${phasePath}: invalid frontmatter.`); if (!text.includes(`qa-agent-${phase}`)) errors.push(`SKILL.md: route qa-agent-${phase} is missing.`); if (phase === 'regression-test' && (!phaseText.includes('qa-agent regression run') || /qa-agent regression (?:draft|publish)/.test(phaseText))) errors.push(`${phasePath}: regression-test must only run formal Python scripts.`); }
  const recommendedStackText = existsSync(recommendedStackPath) ? readFileSync(recommendedStackPath, 'utf8') : '';
  if (recommendedStackText && (!/Python 3\.12/.test(recommendedStackText) || !/pytest-playwright/.test(recommendedStackText) || !/xcrun simctl/.test(recommendedStackText) || !/fb-idb/.test(recommendedStackText) || !/idb_companion/.test(recommendedStackText) || !/ios-simulator-mcp/.test(recommendedStackText) || !/result\.json/.test(recommendedStackText) || !/report\.md/.test(recommendedStackText) || !/screenshots\//.test(recommendedStackText) || !/stdout\.log/.test(recommendedStackText) || !/stderr\.log/.test(recommendedStackText) || !/evidence\//.test(recommendedStackText))) errors.push(`${recommendedStackPath}: recommended stack contract is incomplete.`);
  if (recommendedStackText && /junit|allure|ui-tree|playwright trace|videos?\//i.test(recommendedStackText)) errors.push(`${recommendedStackPath}: removed extended artifact requirements must not be documented.`);
  const allSkillText = [text, existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : '', existsSync(pythonPath) ? readFileSync(pythonPath, 'utf8') : '', recommendedStackText, ...['plan', 'regression-test'].map(name => { const p = join(skillRoot, 'skills', name, 'SKILL.md'); return existsSync(p) ? readFileSync(p, 'utf8') : ''; })].join('\n');
  if (/OperationPlan|operation-plans|RegressionSuite|regression-suite|sourceOperationPlanIds/.test(allSkillText)) errors.push('Skill package still references removed OperationPlan or RegressionSuite assets.');
  return { valid: errors.length === 0, errors, checked: 6 };
}
