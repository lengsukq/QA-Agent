import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { qaPath } from './project.ts';
import { hasSecrets, isSafeId, listFiles, readJson } from './store.ts';
import { isHumanApprover } from './approval.ts';
import { hasRuntimeReportMarker, RUNTIME_REPORT_GENERATOR } from './report-contract.ts';
import type { RegressionRun, TaskLifecycleState } from './types.ts';
import { readTaskEvents } from './events.ts';
import { normalizeTaskState } from './workflow-model.ts';

export interface ValidationResult { valid: boolean; errors: string[]; checked: number; }

function validateObject(path: string, fields: string[]): string[] {
  try {
    const value = readJson<Record<string, unknown>>(path);
    return fields.filter(field => value[field] === undefined).map(field => `${path}: missing ${field}`);
  } catch (error) { return [`${path}: ${(error as Error).message}`]; }
}

function validateDomainObject(path: string): string[] {
  const value = readJson<Record<string, any>>(path);
  const errors: string[] = [];
  if (path.endsWith('module.json') && (!isSafeId(value.id) || !['active', 'deprecated', 'archived'].includes(value.status) || typeof value.revision !== 'number')) errors.push(`${path}: invalid module id, revision, or status.`);
  if (/\/tasks\/[^/]+\/task\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/v2') errors.push(`${path}: Task must use qa-agent/v2.`);
    if (!value.metadata || !isSafeId(value.metadata.id) || !isSafeId(value.metadata.moduleId)) errors.push(`${path}: invalid task metadata.`);
    const taskStatuses = ['draft', 'planning', 'awaiting_approval', 'ready', 'running', 'reviewing_result', 'regression_ready', 'completed', 'archived', 'needs_input', 'blocked', 'paused', 'deprecated', 'superseded', 'active', 'needs_review'];
    if (!taskStatuses.includes(value.metadata?.status)) errors.push(`${path}: invalid Task lifecycle state ${value.metadata?.status}.`);
    if (['ready', 'running', 'reviewing_result', 'regression_ready', 'completed', 'archived', 'active'].includes(value.metadata?.status) && (!isHumanApprover(value.metadata.approval?.confirmedBy) || !value.metadata.approval?.confirmedAt || !value.metadata.approval?.confirmationSource || !value.metadata.approval?.planHash)) errors.push(`${path}: executable or completed task requires explicit approval from a real human reviewer with confirmation source.`);
    if (!Array.isArray(value.scenarioRefs) || !value.scenarioRefs.length) errors.push(`${path}: scenarioRefs must be a non-empty array.`);
    else for (const ref of value.scenarioRefs) if (typeof ref !== 'string' || !/^scenarios\/[a-z0-9][a-z0-9-]{0,62}\.json$/.test(ref)) errors.push(`${path}: invalid Scenario reference ${String(ref)}.`);
    if (value.reportIndexRef !== 'runs/index.json') errors.push(`${path}: reportIndexRef must be runs/index.json; Task reports belong to self-contained Run packages.`);
  }
  if (/\/scenarios\/[^/]+\.json$/.test(path)) {
    if (!isSafeId(value.id) || typeof value.title !== 'string' || typeof value.intent !== 'string' || !value.expected || !Array.isArray(value.preconditions) || !Array.isArray(value.evidence) || !Array.isArray(value.cleanup) || !['low', 'medium', 'high', 'critical'].includes(value.risk)) errors.push(`${path}: invalid Scenario contract.`);
    if (value.planningStatus && !['applicable', 'not_applicable', 'deferred', 'needs_user_decision'].includes(value.planningStatus)) errors.push(`${path}: invalid Scenario planningStatus.`);
    if (!Array.isArray(value.visualAssertions) || !value.visualAssertions.length) errors.push(`${path}: visualAssertions must be a non-empty array.`);
    for (const [index, assertion] of (value.visualAssertions ?? []).entries()) {
      if (!assertion || !isSafeId(assertion.id) || typeof assertion.expected !== 'string' || !assertion.expected.trim() || !['low', 'medium', 'high', 'critical'].includes(assertion.importance)) errors.push(`${path}: visual assertion ${index + 1} requires id, expected, and importance low|medium|high|critical.`);
    }
  }
  if (path.endsWith('/module-snapshot.json') && (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'ModuleSnapshot' || !isSafeId(value.moduleId) || typeof value.snapshotHash !== 'string')) errors.push(`${path}: invalid module snapshot.`);
  if (path.endsWith('/requirements.json')) {
    if (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'TestRequirements' || !isSafeId(value.taskId) || !isSafeId(value.moduleId)) errors.push(`${path}: invalid test requirements.`);
    for (const [index, trace] of (value.requirementTrace ?? []).entries()) if (!trace.requirementId || !Array.isArray(trace.scenarioIds) || !Array.isArray(trace.assertionIds) || !['covered', 'partial', 'not_covered', 'deferred'].includes(trace.status)) errors.push(`${path}: invalid requirementTrace entry ${index + 1}.`);
  }
  if (/\/memory\/[^/]+\.json$/.test(path) || /\/shared-memory\/entries\/[^/]+\.json$/.test(path)) {
    if (!isSafeId(value.id) || !['candidate', 'active', 'superseded', 'deprecated'].includes(value.status)) errors.push(`${path}: invalid memory id or status.`);
    if (hasSecrets({ content: value.content, structuredRule: value.structuredRule })) errors.push(`${path}: contains a potential secret.`);
  }
  if (/\/runs\/[^/]+\/run\.json$/.test(path)) {
    if (!['pending', 'running', 'passed', 'failed', 'blocked', 'paused', 'inconclusive', 'not_applicable', 'needs_confirmation', 'adapted'].includes(value.status)) errors.push(`${path}: invalid run status.`);
    if (value.completedAt) {
      if (typeof value.planHash !== 'string' || !value.planHash) errors.push(`${path}: completed Run requires planHash; run qa-agent migrate for legacy assets.`);
      const expectedReportPath = `runs/${value.id}/report.md`;
      if (value.reportPath !== expectedReportPath) errors.push(`${path}: completed Run reportPath must be ${expectedReportPath}.`);
      if (value.reportGeneratedBy !== RUNTIME_REPORT_GENERATOR) errors.push(`${path}: completed Run must declare reportGeneratedBy=${RUNTIME_REPORT_GENERATOR}.`);
      if (!value.reportGeneratedAt) errors.push(`${path}: completed Run must declare reportGeneratedAt.`);
      const reportPath = join(dirname(path), 'report.md');
      if (!existsSync(reportPath)) errors.push(`${path}: Runtime report is missing at ${reportPath}.`);
      else {
        const report = readFileSync(reportPath, 'utf8');
        if (!hasRuntimeReportMarker(report, value.id)) errors.push(`${reportPath}: missing QA-Agent Runtime ownership marker for Run ${value.id}.`);
      }
    }
    if (['passed', 'adapted'].includes(value.status)) {
      if (!Array.isArray(value.screenshots) || value.screenshots.length === 0) errors.push(`${path}: passed or adapted Run requires screenshot evidence.`);
      const findings = Array.isArray(value.visualFindings) ? value.visualFindings : [];
      if (!findings.length || findings.some((item: any) => ['passed', 'adapted'].includes(item.status) && !item.screenshotPath)) errors.push(`${path}: passed or adapted Run requires screenshot-backed business findings.`);
    }
  }
  if (/\/operation-plans\/[^/]+\/v\d+\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/v2') errors.push(`${path}: OperationPlan must use qa-agent/v2.`);
    const operationStatuses = ['candidate', 'approved_unverified', 'validated', 'stale', 'rejected', 'superseded', 'active', 'deprecated'];
    if (!isSafeId(value.id) || value.kind !== 'OperationPlan' || !operationStatuses.includes(value.status) || (value.validationStatus && !['unverified', 'passed', 'failed', 'stale'].includes(value.validationStatus))) errors.push(`${path}: invalid OperationPlan identity, status, or validationStatus.`);
    if (['approved_unverified', 'validated'].includes(value.status) && (!isHumanApprover(value.approvedBy) || !value.approvedAt)) errors.push(`${path}: approved or validated OperationPlan requires approvedBy and approvedAt from a real human reviewer.`);
    if (value.status === 'validated' && (!value.validatedByRunId || !value.validatedAt)) errors.push(`${path}: validated OperationPlan requires validatedByRunId and validatedAt.`);
    if (!Array.isArray(value.steps)) errors.push(`${path}: OperationPlan steps must be an array.`);
    for (const [index, step] of (value.steps ?? []).entries()) {
      if (!step || typeof step !== 'object') { errors.push(`${path}: step ${index + 1} must be an object.`); continue; }
      const item = step as Record<string, any>;
      if (!isSafeId(item.id) || !isSafeId(item.scenarioId)) errors.push(`${path}: step ${index + 1} requires safe id and scenarioId.`);
      if (!['launch', 'navigate', 'click', 'input', 'fill', 'swipe', 'back', 'wait', 'assert', 'screenshot', 'reset', 'restart-app'].includes(item.action)) errors.push(`${path}: unsupported OperationPlan action ${item.action}.`);
      if (typeof item.intent !== 'string' || !item.intent.trim()) errors.push(`${path}: step ${index + 1} requires intent.`);
      if (!Array.isArray(item.preconditions)) errors.push(`${path}: step ${index + 1} requires preconditions.`);
      if (!['after-action', 'on-state-change', 'none'].includes(item.screenshotPolicy)) errors.push(`${path}: step ${index + 1} has invalid screenshotPolicy.`);
      if (!['required', 'adaptive', 'not-required'].includes(item.visualInspectionPolicy)) errors.push(`${path}: step ${index + 1} has invalid visualInspectionPolicy.`);
      if (item.inputRefs && hasSecrets(item.inputRefs)) errors.push(`${path}: step ${index + 1} contains a potential secret; use env: references.`);
    }
  }
  if (/\/regression-suite\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'RegressionSuite' || !['task', 'module', 'release'].includes(value.scope) || !['draft', 'active', 'stale', 'superseded'].includes(value.status)) errors.push(`${path}: invalid RegressionSuite.`);
    if (!Array.isArray(value.members)) errors.push(`${path}: RegressionSuite members must be an array.`);
    if (!['p0', 'p1', 'p2', 'p3'].includes(value.priorityThreshold)) errors.push(`${path}: RegressionSuite requires a valid priorityThreshold.`);
    for (const [index, member] of (value.members ?? []).entries()) {
      if (!isSafeId(member.taskId) || !isSafeId(member.moduleId) || !isSafeId(member.scenarioId)) errors.push(`${path}: member ${index + 1} has invalid identity.`);
      if (!['p0', 'p1', 'p2', 'p3'].includes(member.priority)) errors.push(`${path}: member ${index + 1} has invalid priority.`);
    }
  }
  if (/\/impact-analysis\/[^/]+\.json$/.test(path) && (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'ImpactAnalysis' || !Array.isArray(value.changedFiles) || !Array.isArray(value.impactedModules))) errors.push(`${path}: invalid ImpactAnalysis.`);
  if (/\/release-checks\/[^/]+\.json$/.test(path) && (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'ReleaseCheck' || !['fast', 'normal', 'full'].includes(value.profile) || !['pending', 'go', 'no-go', 'review'].includes(value.releaseDecision))) errors.push(`${path}: invalid ReleaseCheck.`);
  return errors;
}

export function validateProject(root: string): ValidationResult {
  const files: Array<[string, string[]]> = [
    [qaPath(root, 'project.json'), ['version', 'project', 'platforms', 'defaultContext', 'source', 'storage']],
    [qaPath(root, 'policies.json'), ['safeMode', 'prohibitedActions', 'stopBefore']],
    [qaPath(root, 'mcp.json'), ['version', 'connections']],
  ];
  files.push(...listFiles(qaPath(root, 'modules'), path => basename(path) === 'module.json').map(path => [path, ['id', 'name', 'status', 'riskLevel', 'platforms', 'roles']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path)).map(path => [path, ['apiVersion', 'kind', 'metadata', 'moduleSnapshotRef', 'requirementsRef', 'testPlanRef', 'scenarioRefs', 'regressionSuiteRef', 'capabilities', 'safety', 'evidence']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'modules'), path => path.endsWith('/module-snapshot.json')).map(path => [path, ['apiVersion', 'kind', 'moduleId', 'moduleName', 'moduleRevision', 'snapshotHash', 'capturedAt']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'modules'), path => path.endsWith('/requirements.json')).map(path => [path, ['apiVersion', 'kind', 'taskId', 'moduleId', 'businessGoals', 'actors', 'flows', 'rules', 'scope', 'preconditions', 'testDataRefs', 'environments']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'modules'), path => path.endsWith('/test-plan.json')).map(path => [path, ['apiVersion', 'kind', 'taskId', 'moduleId', 'version', 'planHash', 'scenarioRefs', 'capabilities', 'safety', 'evidencePolicy', 'recoveryPolicy', 'status']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/scenarios\/[^/]+\.json$/.test(path)).map(path => [path, ['id', 'title', 'input', 'preconditions', 'intent', 'expected', 'evidence', 'cleanup', 'risk', 'visualAssertions']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'modules'), path => /\/operation-plans\/[^/]+\/v\d+\.json$/.test(path)).map(path => [path, ['apiVersion', 'kind', 'id', 'version', 'status', 'taskId', 'moduleId', 'scenarioId', 'planHash', 'executionSnapshot', 'steps']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/runs\/[^/]+\/run\.json$/.test(path)).map(path => [path, ['id', 'taskId', 'moduleId', 'context', 'status', 'steps', 'startedAt']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'modules'), path => /\/regression-suite\.json$/.test(path)).map(path => [path, ['apiVersion', 'kind', 'id', 'scope', 'name', 'purpose', 'moduleId', 'moduleIds', 'members', 'priorityThreshold', 'suiteHash', 'status']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'regression-runs'), path => path.endsWith('.json')).map(path => [path, ['apiVersion', 'kind', 'id', 'suiteId', 'suiteName', 'suiteScope', 'suiteVersion', 'suiteHash', 'moduleId', 'moduleIds', 'priorityThreshold', 'context', 'status', 'childRuns', 'startedAt']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'impact-analysis'), path => path.endsWith('.json')).map(path => [path, ['apiVersion', 'kind', 'id', 'changedFiles', 'impactedModules', 'selectedTasks', 'unmatchedFiles', 'generatedAt']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'release-checks'), path => path.endsWith('.json')).map(path => [path, ['apiVersion', 'kind', 'id', 'name', 'profile', 'priorityThreshold', 'impactAnalysis', 'suite', 'status', 'releaseDecision', 'blockers', 'createdAt', 'updatedAt']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'modules'), path => /\/memory\/[^/]+\.json$/.test(path)).map(path => [path, ['id', 'type', 'title', 'content', 'knowledgeLevel', 'confidence', 'source']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'shared-memory', 'entries'), path => path.endsWith('.json')).map(path => [path, ['id', 'type', 'title', 'content', 'knowledgeLevel', 'confidence', 'source']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'skills'), path => path.endsWith('.json')).map(path => [path, ['apiVersion', 'kind', 'metadata', 'requirements', 'safety', 'outputs']] as [string, string[]]));
  const errors = files.filter(([path]) => !existsSync(path)).map(([path]) => `${path}: not found`);
  for (const [path, fields] of files) if (existsSync(path)) {
    errors.push(...validateObject(path, fields));
    try { errors.push(...validateDomainObject(path)); } catch (error) { errors.push(`${path}: ${(error as Error).message}`); }
  }

  const taskManifests = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path));
  const validTaskStates = new Set<TaskLifecycleState>(['draft', 'planning', 'awaiting_approval', 'ready', 'running', 'reviewing_result', 'regression_ready', 'completed', 'archived', 'needs_input', 'blocked', 'paused', 'deprecated', 'superseded']);
  for (const manifestPath of taskManifests) {
    const manifest = readJson<Record<string, any>>(manifestPath);
    const moduleId = manifest.metadata?.moduleId;
    const taskId = manifest.metadata?.id;
    if (!moduleId || !taskId) continue;
    try {
      const taskEvents = readTaskEvents(root, moduleId, taskId);
      const seenIds = new Set<string>();
      const seenKeys = new Set<string>();
      for (const [index, event] of taskEvents.entries()) {
        if (event.seq !== index + 1) errors.push(`${manifestPath}: events.jsonl sequence expected ${index + 1}, received ${event.seq}.`);
        if (!event.id || seenIds.has(event.id)) errors.push(`${manifestPath}: duplicate or missing event id at seq ${event.seq}.`); else seenIds.add(event.id);
        if (!event.idempotencyKey || seenKeys.has(event.idempotencyKey)) errors.push(`${manifestPath}: duplicate or missing event idempotencyKey at seq ${event.seq}.`); else seenKeys.add(event.idempotencyKey);
        if (!event.type || !event.reasonCode || event.moduleId !== moduleId || event.taskId !== taskId) errors.push(`${manifestPath}: invalid event identity at seq ${event.seq}.`);
        if (event.fromState && !validTaskStates.has(event.fromState)) errors.push(`${manifestPath}: invalid event fromState ${event.fromState}.`);
        if (event.toState && !validTaskStates.has(event.toState)) errors.push(`${manifestPath}: invalid event toState ${event.toState}.`);
      }
      const lastStateEvent = [...taskEvents].reverse().find(event => event.toState);
      if (lastStateEvent?.toState && lastStateEvent.toState !== normalizeTaskState(manifest.metadata?.status)) errors.push(`${manifestPath}: Task state ${manifest.metadata?.status} does not match latest state event ${lastStateEvent.toState}.`);
    } catch (error) { errors.push((error as Error).message); }

    const taskDir = dirname(manifestPath);
    const taskOperations = listFiles(join(taskDir, 'operation-plans'), path => /\/v\d+\.json$/.test(path)).map(path => readJson<Record<string, any>>(path));
    const taskRuns = listFiles(join(taskDir, 'runs'), path => path.endsWith('/run.json')).map(path => readJson<Record<string, any>>(path));
    const runningRuns = taskRuns.filter(run => run.status === 'running');
    if (runningRuns.length > 1) errors.push(`${manifestPath}: Task has multiple active Runs: ${runningRuns.map(run => run.id).join(', ')}.`);
    for (const operation of taskOperations.filter(item => item.status === 'validated')) {
      const validationRun = taskRuns.find(run => run.id === operation.validatedByRunId && run.operationPlanId === operation.id && run.replayStatus !== 'not_replay' && ['passed', 'adapted', 'failed'].includes(run.status) && run.replayStage === 'completed' && Boolean(run.completedAt));
      if (!validationRun) errors.push(`${manifestPath}: validated OperationPlan ${operation.id} requires a completed persisted replay Run that executed its contract.`);
    }
    for (const pointerPath of listFiles(join(taskDir, 'operation-plans'), path => path.endsWith('/current.json'))) {
      const pointer = readJson<Record<string, any>>(pointerPath);
      const pointed = taskOperations.find(operation => operation.id === pointer.operationPlanId);
      if (!pointed || !['approved_unverified', 'validated'].includes(pointed.status)) errors.push(`${pointerPath}: current OperationPlan pointer must reference an approved_unverified or validated plan.`);
    }

    if (manifest.metadata?.status === 'archived') {
      const approvedPlanHash = manifest.metadata?.approval?.planHash;
      const scenarioIds = (manifest.scenarioRefs ?? []).map((ref: string) => basename(ref, '.json'));
      const operations = taskOperations;
      const runs = taskRuns;
      const unresolvedKnownIssues = listFiles(join(taskDir, 'memory'), path => path.endsWith('.json')).map(path => readJson<Record<string, any>>(path)).filter(memory => memory.type === 'known_issue' && memory.status === 'candidate');
      if (unresolvedKnownIssues.length) errors.push(`${manifestPath}: archived Task has unresolved known_issue memory candidates: ${unresolvedKnownIssues.map(memory => memory.id).join(', ')}.`);
      const completedRuns = runs.filter(run => Boolean(run.completedAt)).sort((left, right) => (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt));
      if (!completedRuns[0] || !['passed', 'adapted'].includes(completedRuns[0].status)) errors.push(`${manifestPath}: archived Task requires its latest completed Run to be passed or adapted.`);
      const suitePath = join(taskDir, 'regression-suite.json');
      const suite = existsSync(suitePath) ? readJson<Record<string, any>>(suitePath) : undefined;
      if (!suite || suite.status !== 'active') errors.push(`${manifestPath}: archived Task requires an active RegressionSuite.`);
      for (const scenarioId of scenarioIds) {
        const operation = operations.filter(item => item.scenarioId === scenarioId && item.status === 'validated' && item.planHash === approvedPlanHash).sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0];
        if (!operation) {
          errors.push(`${manifestPath}: archived Scenario ${scenarioId} requires a validated OperationPlan with the current approved planHash.`);
          continue;
        }
        const validationRun = runs.find(run => run.id === operation.validatedByRunId && run.operationPlanId === operation.id && run.replayStatus !== 'not_replay' && ['passed', 'adapted'].includes(run.status) && Boolean(run.completedAt));
        if (!validationRun) errors.push(`${manifestPath}: validated OperationPlan ${operation.id} requires a successful persisted replay/adapted Run.`);
        if (!suite?.members?.some((member: any) => member.scenarioId === scenarioId && member.operationPlanId === operation.id && member.taskPlanHash === approvedPlanHash)) errors.push(`${manifestPath}: RegressionSuite does not cover archived Scenario ${scenarioId} with its validated OperationPlan.`);
      }
    }
  }

  const legacyTaskReports = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/reports\/.+\.md$/.test(path));
  for (const path of legacyTaskReports) errors.push(`${path}: legacy Task report is outside runs/<run-id>/; run qa-agent migrate.`);

  const globalReportRoot = qaPath(root, 'reports');
  for (const path of listFiles(globalReportRoot, item => item.endsWith('.md'))) {
    const id = basename(path, '.md');
    const releaseCheckPath = qaPath(root, 'release-checks', `${id}.json`);
    const regressionPath = qaPath(root, 'regression-runs', `${id}.json`);
    let validOwner = existsSync(releaseCheckPath);
    if (!validOwner && existsSync(regressionPath)) {
      try { validOwner = readJson<RegressionRun>(regressionPath).suiteScope === 'release'; }
      catch { validOwner = false; }
    }
    if (!validOwner) errors.push(`${path}: orphan or manually written QA report. Formal Task reports must be generated by the Runtime under tasks/<task>/runs/<run-id>/report.md.`);
  }

  return { valid: errors.length === 0, errors, checked: files.length };
}

export function validateSkill(skillRoot: string): ValidationResult {
  const path = join(skillRoot, 'SKILL.md');
  if (!existsSync(path)) return { valid: false, errors: [`${path}: not found`], checked: 0 };
  const text = readFileSync(path, 'utf8');
  const errors: string[] = [];
  if (!/^---\nname: [a-z0-9-]+\ndescription: .+\n---\n/s.test(text)) errors.push('SKILL.md: invalid or incomplete YAML frontmatter.');
  if (text.includes('[TODO:')) errors.push('SKILL.md: contains template TODO text.');
  return { valid: errors.length === 0, errors, checked: 1 };
}
