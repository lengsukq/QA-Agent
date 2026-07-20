import { now } from './store.ts';
import { createHash } from 'node:crypto';
import type { ModuleSnapshot, ProjectMemory, QaModule, TestRequirements, TestScenario, TestTask } from './types.ts';
import { platformCapabilities } from './capabilities.ts';
import { approvalIsCurrent, testPlanHash } from './approval.ts';

const coverageDimensions = [
  ['core-flow', '完成核心业务流程'], ['boundary', '覆盖输入、金额、数量、时间等边界'], ['permission', '覆盖不同角色的可见性和操作权限'],
  ['state-transition', '覆盖合法、非法与终态状态流转'], ['exception', '覆盖网络、服务和会话异常'], ['idempotency', '覆盖重复提交、刷新和返回'],
  ['cross-module', '覆盖依赖模块的关键影响'], ['historical-regression', '覆盖历史问题与回归风险'],
] as const;

export function planModule(module: QaModule, existingTaskIds: string[], memories: Array<Pick<ProjectMemory, 'id' | 'type' | 'title' | 'status' | 'importance'>> = []): Array<{ id: string; title: string; dimension: string; reason: string; exists: boolean; memoryRefs?: string[] }> {
  const baseline = coverageDimensions.map(([suffix, reason]) => {
    const id = `${module.id}-${suffix}`;
    return { id, title: `${module.name}：${reason}`, dimension: suffix, reason, exists: existingTaskIds.includes(id) };
  });
  const regressions = memories.filter(memory => memory.status === 'active' && ['known_issue', 'regression_note', 'business_rule'].includes(memory.type)).map(memory => {
    const id = `${module.id}-regression-${memory.id}`.slice(0, 63);
    return { id, title: `${module.name}：${memory.title}`, dimension: 'memory-regression', reason: `根据 ${memory.type} 记忆生成长期回归场景（${memory.importance}）。`, exists: existingTaskIds.includes(id), memoryRefs: [memory.id] };
  });
  return [...baseline, ...regressions];
}

export function createTaskSkeleton(module: QaModule, id: string, name?: string): TestTask {
  const timestamp = now();
  const businessObjectives = [...module.businessGoals, ...(module.coreFlows ?? [])];
  const businessRules = module.businessRules ?? [];
  const scenario: TestScenario = {
    id: 'happy-path', title: '核心业务流程', input: {}, preconditions: [], intent: `完成 ${module.name} 的核心业务目标`,
    expected: { outcome: '业务目标完成且页面状态符合预期', businessRules }, evidence: ['screenshot', 'current-url', 'visible-text-summary'], cleanup: [], risk: module.riskLevel,
    visualAssertions: [{ id: 'business-outcome', expected: businessRules.length ? `${module.name} 符合已知业务规则：${businessRules.join('；')}` : `${module.name} 的核心业务结果、关键状态和可见反馈符合预期。`, importance: module.riskLevel }],
  };
  const snapshotSeed = { moduleId: module.id, moduleName: module.name, moduleRevision: module.revision ?? 1, platforms: module.platforms, roles: module.roles, businessGoals: module.businessGoals, coreFlows: module.coreFlows ?? [], businessRules: module.businessRules ?? [], keyStates: module.keyStates ?? [], regressionFocus: module.regressionFocus ?? [] };
  const moduleSnapshot: ModuleSnapshot = { $schema: '../../../../schemas/module-snapshot.schema.json', apiVersion: 'qa-agent/v2', kind: 'ModuleSnapshot', ...snapshotSeed, snapshotHash: createHash('sha256').update(JSON.stringify(snapshotSeed)).digest('hex'), capturedAt: timestamp };
  const requirements: TestRequirements = { $schema: '../../../../schemas/requirements.schema.json', apiVersion: 'qa-agent/v2', kind: 'TestRequirements', taskId: id, moduleId: module.id, businessGoals: businessObjectives.length ? businessObjectives : [`完成 ${module.name} 核心业务流程`], actors: module.roles, flows: module.coreFlows ?? [], rules: businessRules.map((statement, index) => ({ id: `rule-${index + 1}`, statement, knowledgeLevel: 'inferred' as const, source: 'module definition' })), scope: { included: businessObjectives, excluded: [] }, preconditions: [], testDataRefs: [], environments: ['local'], sourceRefs: module.sourceHints ?? [], risks: [], userQuestions: [], confirmedDecisions: [], createdAt: timestamp, updatedAt: timestamp };
  return {
    $schema: '../../../../schemas/task.schema.json', apiVersion: 'qa-agent/v2', kind: 'TestTask',
    metadata: { id, name: name ?? `${module.name} 核心流程`, moduleId: module.id, version: 1, status: 'draft', priority: module.riskLevel === 'critical' ? 'p0' : 'p1', tags: [module.id, 'regression'], frequency: ['critical', 'high'].includes(module.riskLevel) ? 'every-release' : 'manual', releaseGate: module.riskLevel === 'critical', estimatedDurationMinutes: 5 },
    moduleSnapshotRef: 'module-snapshot.json', requirementsRef: 'requirements.json', testPlanRef: 'test-plan.json', scenarioRefs: ['scenarios/happy-path.json'], regressionSuiteRef: 'regression-suite.json', reportIndexRef: 'runs/index.json', runRefs: [],
    description: `验证 ${module.name} 的核心业务目标。`, objectives: businessObjectives.length ? businessObjectives : [`完成 ${module.name} 核心业务流程`],
    scope: { platforms: module.platforms, environments: ['local'], roles: module.roles }, preconditions: module.entryPoints?.length ? [`Entry points: ${module.entryPoints.join(', ')}`] : [], memoryRefs: [], scenarios: [scenario],
    requiredSkills: ['execution.contract', 'evidence.record', 'operation.replay'], capabilities: { required: [...new Set(module.platforms.flatMap(platformCapabilities))], optional: ['network.read', 'source.readonly', 'logs.read'] },
    safety: { safeMode: true, stopBefore: ['payment.submit', 'refund.submit', 'data.delete', 'notification.send'] }, evidence: { required: scenario.evidence },
    evidencePolicy: { capture: 'every-action', visual: 'adaptive', required: ['baseline', 'key-business-state', 'failure', 'final-result'] },
    operationPlanRefs: [], recoveryPolicy: { maxRetries: 1, maxRecoveryAttempts: 3, allowSandboxDataReset: true }, regression: { triggers: [] }, createdAt: timestamp, updatedAt: timestamp,
    moduleSnapshot, requirements,
  };
}

export function taskPlan(task: TestTask): object {
  return {
    apiVersion: 'qa-agent/v2', taskId: task.metadata.id, planHash: testPlanHash(task), businessLogic: { description: task.description, objectives: task.objectives, memoryRefs: task.memoryRefs }, approvalRequired: !approvalIsCurrent(task), approval: task.metadata.approval,
    preconditions: task.preconditions, scenarios: task.scenarios.map(scenario => ({ id: scenario.id, title: scenario.title, intent: scenario.intent, preconditions: scenario.preconditions, input: scenario.input, expected: scenario.expected, visualAssertions: scenario.visualAssertions ?? [], evidence: scenario.evidence })),
    requiredSkills: task.requiredSkills, requiredCapabilities: task.capabilities, safety: task.safety, stopConditions: task.safety.stopBefore, cleanup: task.scenarios.flatMap(scenario => scenario.cleanup), evidencePolicy: task.evidencePolicy, operationPlanRefs: task.operationPlanRefs, recoveryPolicy: task.recoveryPolicy,
  };
}
