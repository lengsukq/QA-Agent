import { createHash } from 'node:crypto';
import type { ConfirmationMode, ExecutionIntent, TestTask } from './types.ts';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
  return value;
}

const reservedApproverIds = new Set(['qa-agent', 'qa agent', 'assistant', 'system', 'auto-approved', 'auto approved', 'unknown']);
export const PLAN_REQUIREMENTS_CONFIRMATION_ZH = '确认测试方案';
export const PLAN_REQUIREMENTS_CONFIRMATION_EN = 'confirm test plan';
export const START_TEST_CONFIRMATION_ZH = '确认开始测试';
export const START_TEST_CONFIRMATION_EN = 'confirm start testing';
export const MERGED_TEST_CONFIRMATION_ZH = '确认测试并开始执行';
export const MERGED_TEST_CONFIRMATION_EN = 'confirm test and start execution';

export function executionIntent(task: TestTask): ExecutionIntent {
  return task.metadata.executionIntent ?? 'state-changing';
}

export function isExplicitPlanRequirementsConfirmation(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === PLAN_REQUIREMENTS_CONFIRMATION_ZH || normalized === PLAN_REQUIREMENTS_CONFIRMATION_EN;
}

export function isExplicitStartConfirmation(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === START_TEST_CONFIRMATION_ZH || normalized === START_TEST_CONFIRMATION_EN;
}

export function isExplicitMergedConfirmation(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === MERGED_TEST_CONFIRMATION_ZH || normalized === MERGED_TEST_CONFIRMATION_EN;
}

export function isMergedConfirmationEligible(task: TestTask): boolean {
  return executionIntent(task) === 'read-only'
    && task.metadata.mode !== 'guided'
    && task.metadata.releaseGate !== true
    && Boolean(task.requirements?.platformDeclaration)
    && !(task.requirements?.testDataRefs?.length)
    && !(task.requirements?.userQuestions?.length)
    && task.scenarios.length > 0
    && task.scenarios.every(scenario => scenario.risk === 'low' || scenario.risk === 'medium');
}

export function confirmationMode(task: TestTask): ConfirmationMode {
  return isMergedConfirmationEligible(task) ? 'merged' : 'strict';
}

export function isHumanApprover(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return !reservedApproverIds.has(value.trim().toLowerCase());
}

export function assertHumanApprover(value: string): void {
  if (!isHumanApprover(value)) throw new Error('QA approval must identify the real human reviewer; qa-agent, assistant, system, auto-approved, and unknown are not valid approvers.');
}

/** Hash only the user-reviewed execution contract, never mutable run metadata. */
export function testPlanHash(task: TestTask): string {
  const contract = {
    // Keep identity and execution semantics stable, while allowing ordinary
    // display edits (title, description, module labels and snapshots) without
    // invalidating a reviewed execution contract.
    id: task.metadata.id, moduleId: task.metadata.moduleId,
    scope: { platforms: task.scope.platforms, environments: task.scope.environments, roles: task.scope.roles },
    preconditions: task.preconditions,
    executionIntent: executionIntent(task),
    requirements: {
      testDataRefs: task.requirements?.testDataRefs ?? [],
      environments: task.requirements?.environments ?? [],
      confirmedDecisions: task.requirements?.confirmedDecisions ?? [],
      risks: task.requirements?.risks ?? [],
    },
    scenarios: task.scenarios.map(scenario => ({ id: scenario.id, input: scenario.input, preconditions: scenario.preconditions, expected: scenario.expected, evidence: scenario.evidence, cleanup: scenario.cleanup, risk: scenario.risk, planningStatus: scenario.planningStatus, plannedSteps: scenario.plannedSteps, visualAssertions: scenario.visualAssertions })),
    requiredSkills: task.requiredSkills, capabilities: task.capabilities, safety: task.safety, evidence: task.evidence, evidencePolicy: task.evidencePolicy, recoveryPolicy: task.recoveryPolicy, regression: task.regression,
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(contract))).digest('hex');
}

export function planReviewIsCurrent(task: TestTask): boolean {
  const statement = task.metadata.planReview?.statement;
  const statementIsValid = isExplicitPlanRequirementsConfirmation(statement)
    || (isExplicitMergedConfirmation(statement) && confirmationMode(task) === 'merged');
  return Boolean(task.metadata.planReview?.planHash
    && task.metadata.planReview.confirmationSource
    && isHumanApprover(task.metadata.planReview.confirmedBy)
    && statementIsValid
    && !(task.requirements?.userQuestions?.length));
}

export function approvalIsCurrent(task: TestTask): boolean {
  const statement = task.metadata.approval?.statement;
  const statementIsValid = confirmationMode(task) === 'merged'
    ? isExplicitMergedConfirmation(statement)
    : isExplicitStartConfirmation(statement);
  return Boolean(planReviewIsCurrent(task)
    && task.metadata.approval?.planHash
    && task.metadata.approval.confirmationSource
    && isHumanApprover(task.metadata.approval.confirmedBy)
    && statementIsValid
  );
}

export function requiresTestPlanApproval(_task: TestTask): boolean {
  return true;
}

export function executionContractIsCurrent(task: TestTask, planHash?: string): boolean {
  if (planHash && planHash !== testPlanHash(task)) return false;
  return !requiresTestPlanApproval(task) || approvalIsCurrent(task);
}

/** Clear approvals only when a fresh unresolved business question requires QA input. */
export function invalidateApproval(task: TestTask): boolean {
  const changed = Boolean(task.metadata.planReview || task.metadata.approval);
  delete task.metadata.planReview;
  delete task.metadata.approval;
  return changed;
}
