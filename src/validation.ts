import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { qaPath } from './project.ts';
import { hasSecrets, isSafeId, listFiles, readJson } from './store.ts';
import { isHumanApprover } from './approval.ts';

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
    if (['ready', 'active'].includes(value.metadata?.status) && (!isHumanApprover(value.metadata.approval?.confirmedBy) || !value.metadata.approval?.confirmedAt || !value.metadata.approval?.confirmationSource || !value.metadata.approval?.planHash)) errors.push(`${path}: ready or active task requires explicit approval from a real human reviewer with confirmation source.`);
    if (!Array.isArray(value.scenarioRefs) || !value.scenarioRefs.length) errors.push(`${path}: scenarioRefs must be a non-empty array.`);
  }
  if (/\/scenarios\/[^/]+\.json$/.test(path) && (!isSafeId(value.id) || typeof value.intent !== 'string' || !value.expected || !Array.isArray(value.preconditions))) errors.push(`${path}: invalid Scenario contract.`);
  if (path.endsWith('/module-snapshot.json') && (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'ModuleSnapshot' || !isSafeId(value.moduleId) || typeof value.snapshotHash !== 'string')) errors.push(`${path}: invalid module snapshot.`);
  if (path.endsWith('/requirements.json') && (value.apiVersion !== 'qa-agent/v2' || value.kind !== 'TestRequirements' || !isSafeId(value.taskId) || !isSafeId(value.moduleId))) errors.push(`${path}: invalid test requirements.`);
  if (/\/memory\/[^/]+\.json$/.test(path) || /\/shared-memory\/entries\/[^/]+\.json$/.test(path)) {
    if (!isSafeId(value.id) || !['candidate', 'active', 'superseded', 'deprecated'].includes(value.status)) errors.push(`${path}: invalid memory id or status.`);
    if (hasSecrets({ content: value.content, structuredRule: value.structuredRule })) errors.push(`${path}: contains a potential secret.`);
  }
  if (/\/runs\/[^/]+\/run\.json$/.test(path) && !['pending', 'running', 'passed', 'failed', 'blocked', 'paused', 'inconclusive', 'not_applicable', 'needs_confirmation', 'adapted'].includes(value.status)) errors.push(`${path}: invalid run status.`);
  if (/\/operation-plans\/[^/]+\/v\d+\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/v2') errors.push(`${path}: OperationPlan must use qa-agent/v2.`);
    if (!isSafeId(value.id) || value.kind !== 'OperationPlan' || !['candidate', 'active', 'superseded', 'deprecated'].includes(value.status)) errors.push(`${path}: invalid OperationPlan identity or status.`);
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
