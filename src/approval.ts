import { createHash } from 'node:crypto';
import type { TestTask } from './types.ts';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
  return value;
}


const reservedApproverIds = new Set(['qa-agent', 'qa agent', 'assistant', 'system', 'auto-approved', 'auto approved', 'unknown']);

export function isHumanApprover(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return !reservedApproverIds.has(value.trim().toLowerCase());
}

export function assertHumanApprover(value: string): void {
  if (!isHumanApprover(value)) throw new Error('Test Plan approval must identify the real human reviewer; qa-agent, assistant, system, auto-approved, and unknown are not valid approvers.');
}

/** Hash only the user-reviewed execution contract, never mutable run metadata. */
export function testPlanHash(task: TestTask): string {
  const contract = {
    id: task.metadata.id, moduleId: task.metadata.moduleId, name: task.metadata.name,
    description: task.description, objectives: task.objectives, scope: task.scope, preconditions: task.preconditions, moduleSnapshot: task.moduleSnapshot, requirements: task.requirements,
    scenarios: task.scenarios.map(scenario => ({ id: scenario.id, title: scenario.title, input: scenario.input, preconditions: scenario.preconditions, intent: scenario.intent, expected: scenario.expected, evidence: scenario.evidence, cleanup: scenario.cleanup, risk: scenario.risk, visualAssertions: scenario.visualAssertions })),
    requiredSkills: task.requiredSkills, capabilities: task.capabilities, safety: task.safety, evidence: task.evidence, evidencePolicy: task.evidencePolicy, recoveryPolicy: task.recoveryPolicy, regression: task.regression,
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(contract))).digest('hex');
}

export function approvalIsCurrent(task: TestTask): boolean {
  return Boolean(task.metadata.approval?.planHash && task.metadata.approval.confirmationSource && isHumanApprover(task.metadata.approval.confirmedBy) && task.metadata.approval.planHash === testPlanHash(task));
}

export function invalidateApproval(task: TestTask): boolean {
  if (!task.metadata.approval) return false;
  delete task.metadata.approval;
  return true;
}
