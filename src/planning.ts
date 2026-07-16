import { now } from './store.ts';
import type { ProjectMemory, QaModule, TestScenario, TestTask } from './types.ts';
import { platformCapabilities } from './capabilities.ts';
import { testPlanHash } from './approval.ts';

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
  return {
    $schema: '../../../schemas/task.schema.json', apiVersion: 'qa-agent/v1', kind: 'TestTask',
    metadata: { id, name: name ?? `${module.name} 核心流程`, moduleId: module.id, version: 1, status: 'draft', priority: module.riskLevel === 'critical' ? 'p0' : 'p1', tags: [module.id, 'regression'] },
    description: `验证 ${module.name} 的核心业务目标。`, objectives: businessObjectives.length ? businessObjectives : [`完成 ${module.name} 核心业务流程`],
    scope: { platforms: module.platforms, environments: ['local'], roles: module.roles }, preconditions: module.entryPoints?.length ? [`Entry points: ${module.entryPoints.join(', ')}`] : [], memoryRefs: [], scenarios: [scenario],
    requiredSkills: ['evidence.capture', 'visual.verify'], capabilities: { required: [...new Set(module.platforms.flatMap(platformCapabilities))], optional: ['network.read', 'source.readonly', 'logs.read'] },
    safety: { safeMode: true, stopBefore: ['payment.submit', 'refund.submit', 'data.delete', 'notification.send'] }, evidence: { required: scenario.evidence }, regression: { triggers: [] }, createdAt: timestamp, updatedAt: timestamp,
  };
}

export function taskPlan(task: TestTask): object {
  return {
    taskId: task.metadata.id, planHash: testPlanHash(task), businessLogic: { description: task.description, objectives: task.objectives, memoryRefs: task.memoryRefs }, approvalRequired: !task.metadata.approval || task.metadata.approval.planHash !== testPlanHash(task), approval: task.metadata.approval,
    preconditions: task.preconditions, scenarios: task.scenarios.map(scenario => ({ id: scenario.id, title: scenario.title, intent: scenario.intent, preconditions: scenario.preconditions, input: scenario.input, expected: scenario.expected, visualAssertions: scenario.visualAssertions ?? [], evidence: scenario.evidence })),
    requiredSkills: task.requiredSkills, requiredCapabilities: task.capabilities, safety: task.safety, stopConditions: task.safety.stopBefore, cleanup: task.scenarios.flatMap(scenario => scenario.cleanup),
  };
}
