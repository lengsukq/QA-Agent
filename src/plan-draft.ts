import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { invalidateApproval, PLAN_REQUIREMENTS_CONFIRMATION_ZH, START_TEST_CONFIRMATION_ZH, testPlanHash } from './approval.ts';
import { appendTaskEvent } from './events.ts';
import { rebuildIndexes } from './indexer.ts';
import { markPythonRegressionsStaleForPlanHash } from './python-regression.ts';
import { readModule, readTask, saveTask, taskDirectory, taskPrdPath } from './project.ts';
import { assertSafeId, hasSecrets, isSafeId, now } from './store.ts';
import type { PlannedTestStep, PlanDraft, PlanDraftScenario, RequirementTrace, RiskLevel, TestScenario, TestTask, VisualAssertion } from './types.ts';
import { taskState as resolveTaskState, transitionTaskState } from './workflow-model.ts';

export interface PlanDraftApplyResult {
  changed: boolean;
  moduleId: string;
  taskId: string;
  planHash: string;
  previousPlanHash: string;
  requirementsConfirmationRequired: boolean;
  requiredRequirementsConfirmation: string;
  unresolvedQuestions: string[];
  approvalRequired: boolean;
  requiredConfirmation: string;
  prdPath: string;
  scenarioIds: string[];
  task: TestTask;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function stringArray(value: unknown, label: string, fallback: string[] = []): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${label} must be an array of non-empty strings.`);
  return [...new Set(value.map(item => item.trim()))];
}

function safeSlug(value: string, fallback: string): string {
  const slug = value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return isSafeId(slug) ? slug : fallback;
}

function uniqueId(candidate: string, used: Set<string>, fallback: string): string {
  const base = isSafeId(candidate) ? candidate : fallback;
  assertSafeId(base, 'generated id');
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    const tail = `-${suffix}`;
    id = `${base.slice(0, 63 - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function expectedObject(value: PlanDraftScenario['expected'], label: string): Record<string, unknown> {
  if (typeof value === 'string') return { outcome: requiredText(value, label) };
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw new Error(`${label} must be a non-empty object or string.`);
  return value;
}

function assertionsFor(input: PlanDraftScenario, scenarioId: string, risk: RiskLevel, expected: Record<string, unknown>): VisualAssertion[] {
  const source = input.visualAssertions?.length ? input.visualAssertions : [{ expected: typeof expected.outcome === 'string' ? expected.outcome : JSON.stringify(expected), importance: risk }];
  const used = new Set<string>();
  return source.map((item, index) => {
    const importance = item.importance ?? risk;
    if (!['low', 'medium', 'high', 'critical'].includes(importance)) throw new Error(`Scenario ${scenarioId} assertion ${index + 1} has invalid importance.`);
    return {
      id: uniqueId(item.id ? requiredText(item.id, `Scenario ${scenarioId} assertion id`) : safeSlug(item.expected, `assertion-${index + 1}`), used, `assertion-${index + 1}`),
      expected: requiredText(item.expected, `Scenario ${scenarioId} assertion expected`),
      importance,
      businessRuleRef: item.businessRuleRef,
    };
  });
}

function plannedStepsFor(input: PlanDraftScenario, scenarioId: string): PlannedTestStep[] {
  if (!Array.isArray(input.steps) || !input.steps.length) throw new Error(`Scenario ${scenarioId} requires explicit detailed steps before review.`);
  const used = new Set<string>();
  return input.steps.map((step, index) => ({
    id: uniqueId(step.id ? requiredText(step.id, `Scenario ${scenarioId} step id`) : safeSlug(step.action, `step-${index + 1}`), used, `step-${index + 1}`),
    action: requiredText(step.action, `Scenario ${scenarioId} step ${index + 1} action`),
    expected: requiredText(step.expected, `Scenario ${scenarioId} step ${index + 1} expected`),
  }));
}

function materializeScenarios(draft: PlanDraft, task: TestTask, moduleRisk: RiskLevel): TestScenario[] {
  if (!Array.isArray(draft.scenarios) || !draft.scenarios.length) throw new Error('PlanDraft requires at least one Scenario.');
  const used = new Set<string>();
  return draft.scenarios.map((input, index) => {
    const title = requiredText(input.title, `Scenario ${index + 1} title`);
    const scenarioId = uniqueId(input.id ? requiredText(input.id, `Scenario ${index + 1} id`) : safeSlug(title, `scenario-${index + 1}`), used, `scenario-${index + 1}`);
    const risk = input.risk ?? moduleRisk;
    if (!['low', 'medium', 'high', 'critical'].includes(risk)) throw new Error(`Scenario ${scenarioId} has invalid risk.`);
    if (input.input !== undefined && (!input.input || typeof input.input !== 'object' || Array.isArray(input.input))) throw new Error(`Scenario ${scenarioId} input must be an object.`);
    const planningStatus = input.planningStatus ?? 'applicable';
    if (!['applicable', 'not_applicable', 'deferred', 'needs_user_decision'].includes(planningStatus)) throw new Error(`Scenario ${scenarioId} has invalid planningStatus.`);
    const priority = input.priority ?? task.metadata.priority;
    if (!['p0', 'p1', 'p2', 'p3'].includes(priority)) throw new Error(`Scenario ${scenarioId} has invalid priority.`);
    const expected = expectedObject(input.expected, `Scenario ${scenarioId} expected`);
    const visualAssertions = assertionsFor(input, scenarioId, risk, expected);
    return {
      id: scenarioId,
      title,
      intent: requiredText(input.intent, `Scenario ${scenarioId} intent`),
      input: input.input ?? {},
      preconditions: stringArray(input.preconditions, `Scenario ${scenarioId} preconditions`),
      expected,
      evidence: stringArray(input.evidence, `Scenario ${scenarioId} evidence`, ['screenshot', 'visible-text-summary']),
      cleanup: stringArray(input.cleanup, `Scenario ${scenarioId} cleanup`),
      risk,
      planningStatus,
      priority,
      requirementRefs: stringArray(input.requirementRefs, `Scenario ${scenarioId} requirementRefs`, [`requirement-${index + 1}`]),
      sourceRefs: stringArray(input.sourceRefs, `Scenario ${scenarioId} sourceRefs`, draft.sourceRefs ?? []),
      plannedSteps: plannedStepsFor(input, scenarioId),
      visualAssertions,
    };
  });
}

function requirementTrace(scenarios: TestScenario[]): RequirementTrace[] {
  const ids = [...new Set(scenarios.flatMap(scenario => scenario.requirementRefs ?? []))];
  return ids.map(requirementId => {
    const related = scenarios.filter(scenario => scenario.requirementRefs?.includes(requirementId));
    return {
      requirementId,
      scenarioIds: related.map(scenario => scenario.id),
      assertionIds: related.flatMap(scenario => (scenario.visualAssertions ?? []).map(assertion => assertion.id)),
      sourceRefs: [...new Set(related.flatMap(scenario => scenario.sourceRefs ?? []))],
      status: 'covered',
    };
  });
}

export function applyPlanDraft(root: string, draft: PlanDraft): PlanDraftApplyResult {
  if (!draft || draft.apiVersion !== 'qa-agent/plan-draft/v1') throw new Error('PlanDraft apiVersion must be qa-agent/plan-draft/v1.');
  if (hasSecrets(draft)) throw new Error('PlanDraft contains a potential secret. Replace passwords, tokens, cookies, private keys, or payment data with env: references or sanitized fixture references.');
  assertSafeId(draft.moduleId, 'PlanDraft moduleId');
  assertSafeId(draft.taskId, 'PlanDraft taskId');
  if (!existsSync(join(taskDirectory(root, draft.moduleId, draft.taskId), 'task.json'))) throw new Error(`Task ${draft.moduleId}/${draft.taskId} does not exist. Run qa-agent start first.`);

  const module = readModule(root, draft.moduleId);
  const task = readTask(root, draft.moduleId, draft.taskId);
  const state = resolveTaskState(task.metadata.status);
  if (state === 'running') throw new Error(`Task ${task.metadata.id} has an active Run; complete or stop it before applying a changed PlanDraft.`);
  if (['archived', 'deprecated', 'superseded'].includes(state)) throw new Error(`Task ${task.metadata.id} is ${state}; its TestPlan cannot be replaced.`);

  const previousPlanHash = testPlanHash(task);
  task.metadata.name = draft.taskName?.trim() || task.metadata.name;
  task.description = requiredText(draft.description, 'PlanDraft description');
  task.objectives = stringArray(draft.objectives, 'PlanDraft objectives');
  if (!task.objectives.length) throw new Error('PlanDraft objectives must not be empty.');
  task.preconditions = stringArray(draft.preconditions, 'PlanDraft preconditions');
  task.scope = {
    platforms: stringArray(draft.scope?.platforms, 'PlanDraft scope.platforms', task.scope.platforms),
    environments: stringArray(draft.scope?.environments, 'PlanDraft scope.environments', task.scope.environments),
    roles: stringArray(draft.scope?.roles, 'PlanDraft scope.roles', task.scope.roles),
  };
  task.scenarios = materializeScenarios(draft, task, module.riskLevel);
  task.evidence.required = [...new Set(task.scenarios.flatMap(scenario => scenario.evidence))];

  task.requirements ??= {
    $schema: '../../../../schemas/requirements.schema.json', apiVersion: 'qa-agent/v2', kind: 'TestRequirements', taskId: task.metadata.id, moduleId: task.metadata.moduleId, businessGoals: [], actors: [], flows: [], rules: [], scope: { included: [], excluded: [] }, preconditions: [], testDataRefs: [], environments: [], sourceRefs: [], risks: [], userQuestions: [], confirmedDecisions: [], createdAt: now(), updatedAt: now(),
  };
  task.requirements.businessGoals = task.objectives;
  task.requirements.actors = task.scope.roles;
  task.requirements.scope = {
    included: stringArray(draft.scope?.included, 'PlanDraft scope.included', task.objectives),
    excluded: stringArray(draft.scope?.excluded, 'PlanDraft scope.excluded'),
  };
  task.requirements.preconditions = task.preconditions;
  task.requirements.testDataRefs = stringArray(draft.testDataRefs, 'PlanDraft testDataRefs');
  task.requirements.environments = task.scope.environments;
  task.requirements.sourceRefs = stringArray(draft.sourceRefs, 'PlanDraft sourceRefs');
  task.requirements.risks = stringArray(draft.risks, 'PlanDraft risks');
  task.requirements.userQuestions = stringArray(draft.userQuestions, 'PlanDraft userQuestions');
  task.requirements.confirmedDecisions = stringArray(draft.confirmedDecisions, 'PlanDraft confirmedDecisions');
  task.requirements.requirementTrace = requirementTrace(task.scenarios);

  let planHash = testPlanHash(task);
  if (planHash === previousPlanHash) return { changed: false, moduleId: draft.moduleId, taskId: draft.taskId, planHash, previousPlanHash, requirementsConfirmationRequired: true, requiredRequirementsConfirmation: PLAN_REQUIREMENTS_CONFIRMATION_ZH, unresolvedQuestions: task.requirements?.userQuestions ?? [], approvalRequired: true, requiredConfirmation: START_TEST_CONFIRMATION_ZH, prdPath: taskPrdPath(root, draft.moduleId, draft.taskId), scenarioIds: task.scenarios.map(scenario => scenario.id), task };
  task.requirements.updatedAt = now();
  planHash = testPlanHash(task);

  invalidateApproval(task);
  const fromState = resolveTaskState(task.metadata.status);
  if (fromState !== 'awaiting_approval') transitionTaskState(root, task, 'awaiting_approval', 'test_plan_changed', 'plan_draft_applied', { actor: { type: 'agent', id: 'qa-agent' }, artifactHash: planHash, idempotencyKey: `plan-draft-state:${task.metadata.id}:${planHash}` });
  appendTaskEvent(root, {
    type: 'plan_draft_applied', actor: { type: 'agent', id: 'qa-agent' }, moduleId: task.metadata.moduleId, taskId: task.metadata.id, reasonCode: 'structured_plan_materialized', artifactHash: planHash, idempotencyKey: `plan-draft-applied:${task.metadata.id}:${planHash}`, metadata: { previousPlanHash, scenarioIds: task.scenarios.map(scenario => scenario.id) },
  });
  task.metadata.version += 1;
  task.updatedAt = now();
  saveTask(root, task);
  markPythonRegressionsStaleForPlanHash(root, task, planHash);
  rebuildIndexes(root);
  return { changed: true, moduleId: draft.moduleId, taskId: draft.taskId, planHash, previousPlanHash, requirementsConfirmationRequired: true, requiredRequirementsConfirmation: PLAN_REQUIREMENTS_CONFIRMATION_ZH, unresolvedQuestions: task.requirements?.userQuestions ?? [], approvalRequired: true, requiredConfirmation: START_TEST_CONFIRMATION_ZH, prdPath: taskPrdPath(root, draft.moduleId, draft.taskId), scenarioIds: task.scenarios.map(scenario => scenario.id), task: readTask(root, draft.moduleId, draft.taskId) };
}
