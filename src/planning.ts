import { now } from './store.ts';
import { createHash } from 'node:crypto';
import type { ModuleSnapshot, ProjectMemory, QaModule, TestRequirements, TestScenario, TestTask } from './types.ts';
import { platformCapabilities } from './capabilities.ts';
import { approvalIsCurrent, planReviewIsCurrent, requiresTestPlanApproval, testPlanHash } from './approval.ts';
import { normalizeSupportedPlatforms, PLATFORM_DECLARATION_PROMPT_ZH } from './platform.ts';

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
  const platforms = normalizeSupportedPlatforms(module.platforms, ['web'], `module ${module.id} platforms`);
  const timestamp = now();
  const businessObjectives = [...module.businessGoals, ...(module.coreFlows ?? [])];
  const businessRules = module.businessRules ?? [];
  const scenario: TestScenario = {
    id: 'happy-path', title: '核心业务流程', input: {}, preconditions: [], intent: `完成 ${module.name} 的核心业务目标`,
    expected: { outcome: '业务目标完成且页面状态符合预期', businessRules }, evidence: ['screenshot', 'current-url', 'visible-text-summary'], cleanup: [], risk: module.riskLevel, planningStatus: 'applicable', priority: module.riskLevel === 'critical' ? 'p0' : 'p1', requirementRefs: ['requirement-1'], sourceRefs: module.sourceHints ?? [],
    plannedSteps: [
      { id: 'open-entry', action: `打开 ${module.name} 的测试入口`, expected: '目标页面正常加载，关键内容可见。' },
      { id: 'locate-target', action: '根据源码、页面状态或稳定定位信息找到目标业务控件或状态', expected: '目标控件或业务状态可以被明确识别。' },
      { id: 'execute-flow', action: `执行 ${module.name} 的核心业务操作`, expected: '操作完成且页面进入预期业务状态。' },
      { id: 'verify-result', action: '验证页面文案、控件状态和业务结果', expected: '所有已声明业务断言均符合预期。' },
      { id: 'capture-evidence', action: '截取关键结果页面作为证据', expected: '截图保存在对应 Task Run 目录。' },
    ],
    visualAssertions: [{ id: 'business-outcome', expected: businessRules.length ? `${module.name} 符合已知业务规则：${businessRules.join('；')}` : `${module.name} 的核心业务结果、关键状态和可见反馈符合预期。`, importance: module.riskLevel }],
  };
  const snapshotSeed = { moduleId: module.id, moduleName: module.name, moduleRevision: module.revision ?? 1, platforms, roles: module.roles, businessGoals: module.businessGoals, coreFlows: module.coreFlows ?? [], businessRules: module.businessRules ?? [], keyStates: module.keyStates ?? [], regressionFocus: module.regressionFocus ?? [] };
  const moduleSnapshot: ModuleSnapshot = { $schema: '../../../../schemas/module-snapshot.schema.json', apiVersion: 'qa-agent/v2', kind: 'ModuleSnapshot', ...snapshotSeed, snapshotHash: createHash('sha256').update(JSON.stringify(snapshotSeed)).digest('hex'), capturedAt: timestamp };
  const requirements: TestRequirements = { $schema: '../../../../schemas/requirements.schema.json', apiVersion: 'qa-agent/v2', kind: 'TestRequirements', taskId: id, moduleId: module.id, businessGoals: businessObjectives.length ? businessObjectives : [`完成 ${module.name} 核心业务流程`], actors: module.roles, flows: module.coreFlows ?? [], rules: businessRules.map((statement, index) => ({ id: `rule-${index + 1}`, statement, knowledgeLevel: 'inferred' as const, source: 'module definition' })), scope: { included: businessObjectives, excluded: [] }, preconditions: [], testDataRefs: [], environments: ['local'], sourceRefs: module.sourceHints ?? [], risks: [], userQuestions: [], confirmedDecisions: [], requirementTrace: [{ requirementId: 'requirement-1', scenarioIds: ['happy-path'], assertionIds: ['business-outcome'], sourceRefs: module.sourceHints ?? [], status: 'covered' }], createdAt: timestamp, updatedAt: timestamp };
  return {
    $schema: '../../../../schemas/task.schema.json', apiVersion: 'qa-agent/v2', kind: 'TestTask',
    metadata: { id, name: name ?? `${module.name} 核心流程`, moduleId: module.id, version: 1, status: 'draft', priority: module.riskLevel === 'critical' ? 'p0' : 'p1', tags: [module.id, 'regression'], mode: 'regression', approvalPolicy: 'test-plan-and-side-effects', frequency: ['critical', 'high'].includes(module.riskLevel) ? 'every-release' : 'manual', releaseGate: module.riskLevel === 'critical', estimatedDurationMinutes: 5 },
    moduleSnapshotRef: 'module-snapshot.json', requirementsRef: 'requirements.json', testPlanRef: 'test-plan.json', scenarioRefs: ['scenarios/happy-path.json'],
    description: `验证 ${module.name} 的核心业务目标。`, objectives: businessObjectives.length ? businessObjectives : [`完成 ${module.name} 核心业务流程`],
    scope: { platforms, environments: ['local'], roles: module.roles }, preconditions: module.entryPoints?.length ? [`Entry points: ${module.entryPoints.join(', ')}`] : [], memoryRefs: [], scenarios: [scenario],
    requiredSkills: ['execution.contract', 'evidence.record', 'python.regression'], capabilities: { required: [...new Set(platforms.flatMap(platformCapabilities))], optional: ['network.read', 'source.readonly', 'logs.read'] },
    safety: { safeMode: true, stopBefore: ['payment.submit', 'refund.submit', 'data.delete', 'notification.send'] }, evidence: { required: scenario.evidence },
    evidencePolicy: { capture: 'every-action', visual: 'adaptive', required: ['baseline', 'key-business-state', 'failure', 'final-result'] },
    recoveryPolicy: { maxRecoveryAttempts: 3, allowSandboxDataReset: true }, regression: { triggers: [] }, createdAt: timestamp, updatedAt: timestamp,
    moduleSnapshot, requirements,
  };
}

export function createQuickTaskShell(module: QaModule, id: string, request: string, name?: string): TestTask {
  const normalizedRequest = request.trim();
  if (!normalizedRequest) throw new Error('Quick Task request is required.');
  const task = createTaskSkeleton(module, id, name ?? normalizedRequest.slice(0, 80));
  const scenario = task.scenarios[0]!;
  task.metadata.mode = 'quick';
  task.metadata.approvalPolicy = 'test-plan-and-side-effects';
  task.metadata.tags = [module.id, 'quick'];
  task.metadata.frequency = 'manual';
  task.metadata.releaseGate = false;
  task.description = normalizedRequest;
  task.objectives = [normalizedRequest];
  scenario.id = 'exploration';
  scenario.title = normalizedRequest.slice(0, 80);
  scenario.intent = normalizedRequest;
  scenario.planningStatus = 'needs_user_decision';
  scenario.expected = { outcome: `Observe and evaluate the requested business behavior: ${normalizedRequest}` };
  scenario.plannedSteps = [
    { id: 'open-target', action: '打开与本次请求相关的页面或应用入口', expected: '目标页面正常加载，可以开始检查。' },
    { id: 'locate-business-state', action: `根据源码和当前界面定位需要验证的业务状态：${normalizedRequest}`, expected: '目标控件、文案或状态被明确识别。' },
    { id: 'execute-or-inspect', action: `执行或检查用户请求的行为：${normalizedRequest}`, expected: `页面表现可以与请求目标进行比较：${normalizedRequest}` },
    { id: 'verify-visible-result', action: '验证最终可见结果、控件状态和必要业务反馈', expected: '实际结果与审阅后的预期结果一致，或记录明确失败差异。' },
    { id: 'capture-evidence', action: '截取关键结果页面作为证据', expected: '截图保存在对应 Task Run 目录。' },
  ];
  scenario.requirementRefs = ['request-goal'];
  scenario.visualAssertions = [{ id: 'observed-outcome', expected: `The visible behavior can be evaluated against the request: ${normalizedRequest}`, importance: scenario.risk }];
  task.scenarioRefs = ['scenarios/exploration.json'];
  task.evidence.required = scenario.evidence;
  if (task.requirements) {
    task.requirements.businessGoals = [normalizedRequest];
    task.requirements.scope.included = [normalizedRequest];
    task.requirements.requirementTrace = [{ requirementId: 'request-goal', scenarioIds: ['exploration'], assertionIds: ['observed-outcome'], sourceRefs: task.requirements.sourceRefs, status: 'covered' }];
  }
  return task;
}

export function taskPlan(task: TestTask): object {
  return {
    apiVersion: 'qa-agent/v2', taskId: task.metadata.id, mode: task.metadata.mode ?? 'regression', planHash: testPlanHash(task), businessLogic: { description: task.description, objectives: task.objectives, memoryRefs: task.memoryRefs }, platformDeclarationRequired: !task.requirements?.platformDeclaration, requiredPlatformDeclaration: PLATFORM_DECLARATION_PROMPT_ZH, platformDeclaration: task.requirements?.platformDeclaration, requirementsConfirmationRequired: !task.requirements?.platformDeclaration || !planReviewIsCurrent(task), unresolvedQuestions: task.requirements?.userQuestions ?? [], planReview: task.metadata.planReview, approvalRequired: requiresTestPlanApproval(task) && !approvalIsCurrent(task), approval: task.metadata.approval,
    prdRef: task.prdRef, preconditions: task.preconditions, scenarios: task.scenarios.map(scenario => ({ id: scenario.id, title: scenario.title, intent: scenario.intent, preconditions: scenario.preconditions, input: scenario.input, expected: scenario.expected, planningStatus: scenario.planningStatus ?? 'applicable', priority: scenario.priority ?? task.metadata.priority, requirementRefs: scenario.requirementRefs ?? [], sourceRefs: scenario.sourceRefs ?? [], plannedSteps: scenario.plannedSteps, visualAssertions: scenario.visualAssertions ?? [], evidence: scenario.evidence })),
    coverage: { requirementTrace: task.requirements?.requirementTrace ?? [], covered: (task.requirements?.requirementTrace ?? []).filter(item => item.status === 'covered').length, total: task.requirements?.requirementTrace?.length ?? 0 }, requiredSkills: task.requiredSkills, requiredCapabilities: task.capabilities, safety: task.safety, stopConditions: task.safety.stopBefore, cleanup: task.scenarios.flatMap(scenario => scenario.cleanup), evidencePolicy: task.evidencePolicy, recoveryPolicy: task.recoveryPolicy,
  };
}
