import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { approvalIsCurrent, START_TEST_CONFIRMATION_ZH, testPlanHash } from './approval.ts';
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
  const approved = planReady && approvalIsCurrent(task);
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
    '## 测试计划（待用户审阅）',
    '',
    `> 当前状态：${approved ? '已确认，可以开始测试' : planReady ? '等待用户审阅，禁止执行任何 UI 测试' : '等待 Agent 根据项目生成详细步骤，禁止请求开始确认'}`,
    `> 开始口令：${planReady ? `用户必须明确回复“${START_TEST_CONFIRMATION_ZH}”后，Runtime 才允许进入测试。` : '详细步骤尚未完成，当前不能批准或开始测试。'}`,
    '',
    '## Task 信息',
    '',
    `- 名称：${inline(task.metadata.name)}`,
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
    ...scenarioSections,
    '## 审阅确认',
    '',
    approved
      ? `- 已由 ${inline(task.metadata.approval?.confirmedBy ?? 'unknown')} 于 ${task.metadata.approval?.confirmedAt ?? 'unknown'} 确认。`
      : planReady
        ? `- 请审阅以上场景、步骤和预期结果。确认无误后，明确回复：**${START_TEST_CONFIRMATION_ZH}**。`
        : '- 当前仅为 Task 初始草案。Agent 必须先读取项目并通过 PlanDraft 补全可执行的详细步骤。',
    '- 在确认前，Agent 只能修改计划，不能启动 Run，也不能调用 UI 自动化工具。',
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
