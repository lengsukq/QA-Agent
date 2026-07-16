import { qaPath, readProject } from './project.ts';
import { writeTextAtomic } from './store.ts';
import type { TestRun, TestTask } from './types.ts';

export function writeReport(root: string, task: TestTask, run: TestRun): string {
  const project = readProject(root);
  const screenshotMarkdown = (path: string, alt: string) => `![${alt}](../${path})`;
  const visualFailures = (run.visualFindings ?? []).filter(item => item.status === 'failed');
  const scenarioFailures = run.scenarioResults.filter(item => item.status === 'failed');
  const defectCandidates = [
    ...visualFailures.map(item => ({ id: `visual-${item.scenarioId}-${item.assertionId}`, type: 'business-ui-mismatch', scenario: item.scenarioId, expected: item.expected, actual: item.actual, screenshot: item.screenshotPath })),
    ...scenarioFailures.filter(item => !visualFailures.some(finding => finding.scenarioId === item.scenarioId)).map(item => ({ id: `execution-${item.scenarioId}`, type: 'execution-or-business-failure', scenario: item.scenarioId, expected: 'Declared scenario expectations', actual: item.detail ?? 'Scenario failed without additional detail.' })),
  ];
  const lines = [
    `# QA Run: ${task.metadata.name}`, '', '## 测试上下文', '',
    `- Project: ${project.project.name}`, `- Module: ${run.moduleId}`, `- Task: ${run.taskId}`,
    `- Environment: ${run.context.environment}`, `- Platform: ${run.context.platform}`, `- Role: ${run.context.role}`,
    `- Git Branch: ${run.git.branch ?? 'unknown'}`, `- Git Commit: ${run.git.commit ?? 'unknown'}`, `- Safe Mode: ${run.safeMode}`, `- Test plan approval: ${task.metadata.approval ? `${task.metadata.approval.confirmedBy} at ${task.metadata.approval.confirmedAt}` : 'missing'}`, `- Plan hash: ${task.metadata.approval?.planHash ?? 'unapproved'}`, '',
    '## 测试用例与业务逻辑', '', `- Description: ${task.description}`, ...task.objectives.map(item => `- Business objective: ${item}`),
    ...task.scenarios.flatMap(scenario => [`- ${scenario.id}: ${scenario.title}`, `  - Intent: ${scenario.intent}`, `  - Expected: ${JSON.stringify(scenario.expected)}`, `  - Evidence: ${scenario.evidence.join(', ')}`]), '',
    '## 结论', '', run.status.toUpperCase(), '', '## 场景结果', '',
    ...run.scenarioResults.map(item => `- ${item.scenarioId}: ${item.status.toUpperCase()}${item.detail ? ` — ${item.detail}` : ''}`), '',
    '## 执行步骤', '', ...run.steps.map(step => `- ${step.action}: ${step.status.toUpperCase()} — ${step.detail}`), '',
    '## 证据', '', ...run.evidence.flatMap(item => [`- ${item.type}: ${item.summary}${item.path ? ` (${item.path})` : ''}`, ...(item.type === 'screenshot' && item.path ? [screenshotMarkdown(item.path, item.summary)] : [])]), '',
    '## 视觉业务验证', '', ...(run.visualFindings ?? []).flatMap(item => [`- ${item.scenarioId}/${item.assertionId}: ${item.status.toUpperCase()}\n  - Expected: ${item.expected}\n  - Actual: ${item.actual}${item.screenshotPath ? `\n  - Screenshot: ${item.screenshotPath}` : ''}`, ...(item.screenshotPath ? [screenshotMarkdown(item.screenshotPath, `${item.scenarioId} ${item.assertionId}`)] : [])]), '',
    '## 缺陷候选与决策建议', '', ...(defectCandidates.length ? defectCandidates.flatMap(item => [`- ${item.id} [${item.type}]`, `  - Scenario: ${item.scenario}`, `  - Expected: ${item.expected}`, `  - Actual: ${item.actual}`, ...(item.screenshot ? [`  - Screenshot: ${item.screenshot}`] : [])]) : ['- 未发现可归类的失败证据。']),
    `- Release recommendation: ${run.status === 'passed' ? 'No QA evidence currently blocks release.' : run.status === 'failed' ? 'Do not treat this scope as release-ready until failed scenarios are assessed.' : 'Decision deferred: complete blocked or paused preconditions first.'}`, '',
    ...(run.memoryCandidates?.length ? ['## 候选项目记忆', '', ...run.memoryCandidates.map(item => `- ${item}`), ''] : []),
    '## 源码辅助分析', '', '未在本次运行中执行源码诊断。业务结论应以实际页面、接口和运行证据为准。', '',
  ];
  const path = qaPath(root, 'reports', `${run.id}.md`);
  writeTextAtomic(path, `${lines.join('\n')}\n`);
  return path;
}
