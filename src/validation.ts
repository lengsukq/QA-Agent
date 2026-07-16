import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { qaPath } from './project.ts';
import { hasSecrets, isSafeId, listFiles, readJson } from './store.ts';
import { approvalIsCurrent } from './approval.ts';

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
  if (path.endsWith('module.json') && (!isSafeId(value.id) || !['active', 'deprecated', 'archived'].includes(value.status))) errors.push(`${path}: invalid module id or status.`);
  if (/\/tasks\/[^/]+\.json$/.test(path)) {
    if (value.apiVersion !== 'qa-agent/v2') errors.push(`${path}: Task must use qa-agent/v2.`);
    if (!value.metadata || !isSafeId(value.metadata.id) || !isSafeId(value.metadata.moduleId)) errors.push(`${path}: invalid task metadata.`);
    if (['ready', 'active'].includes(value.metadata?.status) && (!value.metadata.approval?.confirmedBy || !value.metadata.approval?.confirmedAt || !value.metadata.approval?.planHash || !approvalIsCurrent(value))) errors.push(`${path}: ready or active task requires current explicit user approval.`);
    if (!Array.isArray(value.scenarios) || new Set(value.scenarios.map((scenario: any) => scenario.id)).size !== value.scenarios.length) errors.push(`${path}: scenarios must be an array with unique ids.`);
    for (const scenario of value.scenarios ?? []) for (const step of scenario.execution?.steps ?? []) if (!['navigate', 'click', 'fill', 'assert-visible', 'assert-hidden', 'assert-text', 'assert-url', 'wait-for', 'screenshot'].includes(step.action)) errors.push(`${path}: unsupported browser action ${step.action}.`);
  }
  if (/\/memory\/[^/]+\.json$/.test(path) || /\/shared-memory\/entries\/[^/]+\.json$/.test(path)) {
    if (!isSafeId(value.id) || !['candidate', 'active', 'superseded', 'deprecated'].includes(value.status)) errors.push(`${path}: invalid memory id or status.`);
    if (hasSecrets({ content: value.content, structuredRule: value.structuredRule })) errors.push(`${path}: contains a potential secret.`);
  }
  if (/\/runs\/[^/]+\.json$/.test(path) && !['pending', 'running', 'passed', 'failed', 'blocked', 'paused', 'inconclusive', 'not_applicable', 'needs_confirmation', 'adapted'].includes(value.status)) errors.push(`${path}: invalid run status.`);
  if (/\/operations\/[^/]+\.json$/.test(path)) {
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
  return errors;
}

export function validateProject(root: string): ValidationResult {
  const files: Array<[string, string[]]> = [
    [qaPath(root, 'project.json'), ['version', 'project', 'platforms', 'defaultContext', 'source', 'storage']],
    [qaPath(root, 'policies.json'), ['safeMode', 'prohibitedActions', 'stopBefore']],
    [qaPath(root, 'capabilities.json'), ['version', 'capabilities']],
    [qaPath(root, 'mcp.json'), ['version', 'connections']],
  ];
  files.push(...listFiles(qaPath(root, 'modules'), path => basename(path) === 'module.json').map(path => [path, ['id', 'name', 'status', 'riskLevel', 'platforms', 'roles']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\.json$/.test(path)).map(path => [path, ['apiVersion', 'kind', 'metadata', 'scenarios', 'capabilities', 'safety', 'evidence']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'modules'), path => /\/operations\/[^/]+\.json$/.test(path)).map(path => [path, ['apiVersion', 'kind', 'id', 'version', 'status', 'taskId', 'moduleId', 'scenarioId', 'planHash', 'steps']] as [string, string[]]));
  files.push(...listFiles(qaPath(root, 'runs'), path => path.endsWith('.json')).map(path => [path, ['id', 'taskId', 'moduleId', 'context', 'status', 'steps', 'startedAt']] as [string, string[]]));
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
