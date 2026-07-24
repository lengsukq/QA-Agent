import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { approvalIsCurrent, confirmationMode, executionIntent, MERGED_TEST_CONFIRMATION_ZH, PLAN_REQUIREMENTS_CONFIRMATION_ZH, planReviewIsCurrent, START_TEST_CONFIRMATION_ZH, testPlanHash } from './approval.ts';
import { PLATFORM_DECLARATION_PROMPT_ZH } from './platform.ts';
import { writeTextAtomic } from './store.ts';
import type { TestTask } from './types.ts';

export const PRD_PLAN_START = '<!-- QA-AGENT:PLAN:START -->';
export const PRD_PLAN_END = '<!-- QA-AGENT:PLAN:END -->';

function inline(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('|', '\\|').trim();
}

function list(values: string[]): string {
  return values.length ? values.map(value => `- ${inline(value)}`).join('\n') : '- 无';
}

export function renderTaskPlanningPrd(task: TestTask): string {
  const planHash = testPlanHash(task);
  const planReady = task.scenarios.length > 0 && task.scenarios.every(scenario => scenario.planningStatus === 'applicable' && scenario.plannedSteps.length > 0);
  const unresolvedQuestions = task.requirements?.userQuestions ?? [];
  const platformDeclared = Boolean(task.requirements?.platformDeclaration);
  const mode = confirmationMode(task);
  const requirementsConfirmed = planReady && platformDeclared && planReviewIsCurrent(task);
  const approved = requirementsConfirmed && approvalIsCurrent(task);
  const status = !planReady
    ? '等待 Agent 根据项目生成详细步骤，禁止请求确认或执行'
    : !platformDeclared
      ? '等待 Agent 根据源码、配置和可用能力确定唯一测试平台，禁止确认或执行'
    : unresolvedQuestions.length
      ? '存在待 QA 回答的问题，禁止确认方案或执行'
      : !requirementsConfirmed
        ? `等待 QA 回复“${mode === 'merged' ? MERGED_TEST_CONFIRMATION_ZH : PLAN_REQUIREMENTS_CONFIRMATION_ZH}”`
        : !approved
          ? mode === 'merged' ? `等待 QA 回复“${MERGED_TEST_CONFIRMATION_ZH}”` : `测试方案已确认，等待 QA 回复“${START_TEST_CONFIRMATION_ZH}”`
          : '测试方案和开始执行均已确认';
  const scenarioSections = task.scenarios.flatMap((scenario, scenarioIndex) => {
    const rows = scenario.plannedSteps.map((step, stepIndex) => `| ${scenarioIndex + 1}.${stepIndex + 1} | ${inline(step.action)} | ${inline(step.expected)} |`);
    return [
      `## 场景 ${scenarioIndex + 1}：${inline(scenario.title)}`,
      '',
      `**目标：** ${inline(scenario.intent)}`,
      '',
      `**优先级：** ${scenario.priority ?? task.metadata.priority}　 **风险：** ${scenario.risk}`,
      '',
      ...(scenario.preconditions.length ? ['**前置条件：**', '', list(scenario.preconditions), ''] : []),
      '| 步骤 | 操作 | 预期结果 |',
      '| --- | --- | --- |',
      ...(rows.length ? rows : [`| ${scenarioIndex + 1}.1 | 待补充详细操作步骤 | 不允许开始测试 |`]),
      '',
      '**业务断言：**',
      '',
      ...(scenario.visualAssertions?.length ? scenario.visualAssertions.map(assertion => `- ${inline(assertion.expected)}`) : ['- 待补充']),
      '',
      '**清理动作：**',
      '',
      list(scenario.cleanup),
      '',
    ];
  });

  return [
    PRD_PLAN_START,
    `<!-- QA-AGENT:PLAN-HASH:${planHash} -->`,
    '## 测试计划（待 QA 审阅）',
    '',
    `> 当前状态：${status}`,
    `> 执行意图：${executionIntent(task)}`,
    `> 确认模式：${mode}`,
    `> 平台声明：${platformDeclared ? `${task.requirements?.platformDeclaration?.platform}（${inline(task.requirements?.platformDeclaration?.statement)}，声明者：${inline(task.requirements?.platformDeclaration?.declaredBy ?? 'qa-agent')}）` : `Agent 必须根据源码和配置确定平台；${PLATFORM_DECLARATION_PROMPT_ZH}。`}`,
    `> 确认口令：${planReady && platformDeclared && !unresolvedQuestions.length ? `回复“${mode === 'merged' ? MERGED_TEST_CONFIRMATION_ZH : PLAN_REQUIREMENTS_CONFIRMATION_ZH}”。` : '当前不能确认测试方案。'}`,
    `> 开始口令：${mode === 'merged' ? '已合并到上面的确认口令。' : requirementsConfirmed ? `准备执行时，还必须明确回复“${START_TEST_CONFIRMATION_ZH}”。` : `方案确认后，还必须明确回复“${START_TEST_CONFIRMATION_ZH}”。`}`,
    '',
    '## Task 信息',
    '',
    `- 名称：${inline(task.metadata.name)}`,
    `- 模式：${task.metadata.mode ?? 'regression'}`,
    `- 目标：${inline(task.description)}`,
    `- 模块：${task.metadata.moduleId}`,
    `- 平台：${task.scope.platforms.join(', ') || '未指定'}`,
    `- 环境：${task.scope.environments.join(', ') || '未指定'}`,
    `- 角色：${task.scope.roles.join(', ') || '未指定'}`,
    `- Plan Hash：\`${planHash}\``,
    '',
    '## 测试目标',
    '',
    list(task.objectives),
    '',
    '## 总体前置条件',
    '',
    list(task.preconditions),
    '',
    '## 待 QA 确认的问题',
    '',
    unresolvedQuestions.length ? list(unresolvedQuestions) : '- 无。若 Agent 对需求、环境、账号、预期结果或危险操作仍有疑问，必须先补充到这里并暂停。',
    '',
    '## 已确认决定',
    '',
    list(task.requirements?.confirmedDecisions ?? []),
    '',
    ...scenarioSections,
    '## 审阅确认',
    '',
    requirementsConfirmed
      ? `- 测试方案已由 ${inline(task.metadata.planReview?.confirmedBy ?? 'unknown')} 于 ${task.metadata.planReview?.confirmedAt ?? 'unknown'} 确认。`
      : planReady && !unresolvedQuestions.length
        ? `- 请 QA 审阅测试目标、范围、场景、每一步操作和预期结果。符合需求后明确回复：**${PLAN_REQUIREMENTS_CONFIRMATION_ZH}**。`
        : '- 需要先补全详细步骤并解决所有待确认问题。',
    approved
      ? `- 已由 ${inline(task.metadata.approval?.confirmedBy ?? 'unknown')} 于 ${task.metadata.approval?.confirmedAt ?? 'unknown'} 授权开始测试。`
      : requirementsConfirmed
        ? `- 方案确认不等于授权执行。准备开始时，请 QA 再明确回复：**${START_TEST_CONFIRMATION_ZH}**。`
        : '- 在方案确认前不得请求开始执行。',
    '- 在两个确认门禁完成前，Agent 只能修改计划或询问 QA，不能启动 Run，也不能调用 UI 自动化工具。',
    '',
    PRD_PLAN_END,
  ].join('\n');
}

function upsert(existing: string | undefined, task: TestTask, generated: string): string {
  if (!existing) return `# ${task.metadata.name}\n\n${generated}\n`;
  const start = existing.indexOf(PRD_PLAN_START);
  const end = existing.indexOf(PRD_PLAN_END);
  if (start >= 0 && end > start) return `${existing.slice(0, start)}${generated}${existing.slice(end + PRD_PLAN_END.length)}`.trimEnd() + '\n';
  return `${existing.trimEnd()}\n\n${generated}\n`;
}

export function writeTaskPlanningPrd(path: string, task: TestTask): { path: string; hash: string } {
  const generated = renderTaskPlanningPrd(task);
  const content = upsert(existsSync(path) ? readFileSync(path, 'utf8') : undefined, task, generated);
  writeTextAtomic(path, content);
  return { path, hash: createHash('sha256').update(content).digest('hex') };
}

export function planningPrdIsCurrent(path: string, task: TestTask): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  return text.includes(PRD_PLAN_START)
    && text.includes(PRD_PLAN_END)
    && text.includes(`<!-- QA-AGENT:PLAN-HASH:${testPlanHash(task)} -->`);
}
