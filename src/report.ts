import { readProject, taskRunReportPath } from './project.ts';
import { readOperation } from './operations.ts';
import { writeTextAtomic } from './store.ts';
import type { TestRun, TestTask } from './types.ts';

export function writeReport(root: string, task: TestTask, run: TestRun): string {
  const project = readProject(root);
  const runRelativePath = (path: string) => path.startsWith(`runs/${run.id}/`) ? path.slice(`runs/${run.id}/`.length) : path;
  const screenshotMarkdown = (path: string, alt: string) => `![${alt}](./${runRelativePath(path)})`;
  const visualFailures = (run.visualFindings ?? []).filter(item => item.status === 'failed');
  const scenarioFailures = run.scenarioResults.filter(item => item.status === 'failed');
  const defectCandidates = [
    ...visualFailures.map(item => ({ id: `visual-${item.scenarioId}-${item.assertionId}`, type: 'business-ui-mismatch', scenario: item.scenarioId, expected: item.expected, actual: item.actual, screenshot: item.screenshotPath })),
    ...scenarioFailures.filter(item => !visualFailures.some(finding => finding.scenarioId === item.scenarioId)).map(item => ({ id: `execution-${item.scenarioId}`, type: 'execution-or-business-failure', scenario: item.scenarioId, expected: 'Declared scenario expectations', actual: item.detail ?? 'Scenario failed without additional detail.' })),
  ];
  const checkpointDefinitions = (() => {
    if (run.operationPlanId) {
      try {
        const plan = readOperation(root, task, run.operationPlanId);
        return (plan.checkpoints ?? []).map(checkpoint => ({ ...checkpoint, scenarioId: plan.scenarioId }));
      } catch { /* A legacy or removed OperationPlan should not prevent report creation. */ }
    }
    return task.scenarios
      .filter(scenario => !run.scenarioId || scenario.id === run.scenarioId)
      .flatMap(scenario => (scenario.visualAssertions ?? []).map(assertion => ({ id: assertion.id, description: assertion.expected, screenshotRequired: true, reportVisible: true, scenarioId: scenario.id })));
  })();
  const checkpointLines = checkpointDefinitions.filter(checkpoint => checkpoint.reportVisible).flatMap(checkpoint => {
    const finding = run.visualFindings.find(item => item.scenarioId === checkpoint.scenarioId && item.assertionId === checkpoint.id);
    if (!finding) return [`### ${checkpoint.id}`, '', `- Scenario: ${checkpoint.scenarioId}`, `- Expected: ${checkpoint.description}`, '- Status: MISSING', '- Screenshot: missing', ''];
    return [
      `### ${checkpoint.id}`, '',
      `- Scenario: ${checkpoint.scenarioId}`,
      `- Description: ${checkpoint.description}`,
      `- Status: ${finding.status.toUpperCase()}`,
      `- Expected: ${finding.expected}`,
      `- Actual: ${finding.actual}`,
      `- Screenshot: ${finding.screenshotPath ?? 'missing'}`,
      ...(finding.screenshotPath ? [screenshotMarkdown(finding.screenshotPath, `Checkpoint ${checkpoint.id}`)] : []),
      '',
    ];
  });
  const lines = [
    `# QA Run: ${task.metadata.name}`, '', '## 测试上下文', '',
    `- Project: ${project.project.name}`, `- Module: ${run.moduleId}`, `- Task: ${run.taskId}`, `- Module snapshot: ${task.moduleSnapshot?.snapshotHash ?? 'not materialized'} (revision ${task.moduleSnapshot?.moduleRevision ?? 'unknown'})`, `- Requirements: ${task.requirementsRef}`, `- Test plan: ${task.testPlanRef}`,
    `- Environment: ${run.context.environment}`, `- Platform: ${run.context.platform}`, `- Role: ${run.context.role}`, `- Scenario: ${run.scenarioId ?? 'all selected scenarios'}`, `- Device: ${run.context.device ?? 'unknown'}`, `- Device model: ${run.context.deviceModel ?? 'unknown'}`, `- OS version: ${run.context.osVersion ?? 'unknown'}`, `- App version: ${run.context.appVersion ?? 'unknown'}`, `- Web build: ${run.context.webBuild ?? 'unknown'}`, `- Test data fingerprint: ${run.context.testDataFingerprint ?? 'unknown'}`,
    `- Execution mode: ${run.mode ?? (run.replayStatus === 'not_replay' ? 'explore' : 'replay')}` , `- Git Branch: ${run.git.branch ?? 'unknown'}`, `- Git Commit: ${run.git.commit ?? 'unknown'}`, `- Safe Mode: ${run.safeMode}`, `- Test plan approval: ${task.metadata.approval ? `${task.metadata.approval.confirmedBy} at ${task.metadata.approval.confirmedAt} via ${task.metadata.approval.confirmationSource}` : 'missing'}`, `- Plan hash: ${task.metadata.approval?.planHash ?? 'unapproved'}`, `- Replay: ${run.replayStatus}${run.operationPlanId ? ` (${run.operationPlanId} v${run.operationVersion ?? '?'})` : ''}`, `- Replay stage: ${run.replayStage}`, `- MCP snapshot: ${run.context.mcpSnapshot.map(item => `${item.id}:${item.status}/${item.permissionStatus}`).join(', ') || 'none'}`, `- Permission snapshot: ${run.context.permissionSnapshot.status}`, '',
    '## 测试用例与业务逻辑', '', `- Description: ${task.description}`, ...task.objectives.map(item => `- Business objective: ${item}`),
    ...task.scenarios.flatMap(scenario => [`- ${scenario.id}: ${scenario.title}`, `  - Intent: ${scenario.intent}`, `  - Expected: ${JSON.stringify(scenario.expected)}`, `  - Evidence: ${scenario.evidence.join(', ')}`]), '',
    '## 结论', '', run.status.toUpperCase(), '', '## 场景结果', '',
    ...run.scenarioResults.map(item => `- ${item.scenarioId}: ${item.status.toUpperCase()}${item.detail ? ` — ${item.detail}` : ''}`), '',
    '## 执行步骤', '', ...run.steps.map(step => `- ${step.action}: ${step.status.toUpperCase()} — ${step.detail}${step.operationStepId ? `\n  - Operation step: ${step.operationStepId}` : ''}${step.operationAction ? `\n  - Planned operation: ${step.operationAction}` : ''}${step.safetyAction ? `\n  - Safety action: ${step.safetyAction}` : ''}${step.executionMode ? `\n  - Execution mode: ${step.executionMode}` : ''}${step.locator ? `\n  - Planned locator: ${step.locator.strategy}${step.locator.value ? `=${step.locator.value}` : ''}` : ''}${step.actualLocator ? `\n  - Actual locator: ${step.actualLocator.strategy}${step.actualLocator.value ? `=${step.actualLocator.value}` : ''}` : ''}${step.expectedState ? `\n  - Expected state: ${step.expectedState}` : ''}${step.actualState ? `\n  - Actual state: ${step.actualState}` : ''}${step.adaptation ? `\n  - Adaptation: ${step.adaptation}` : ''}${step.screenshotPath ? `\n  - Screenshot captured: ${step.screenshotPath}` : ''}${step.visualInspection ? `\n  - Visual inspection: ${step.visualInspection === 'performed' ? 'performed' : step.visualInspection}` : ''}`), '',
    '## 证据', '', ...run.evidence.flatMap(item => [`- ${item.type}: ${item.summary}${item.path ? ` (${item.path})` : ''}`, ...(item.type === 'screenshot' && item.path ? [screenshotMarkdown(item.path, item.summary)] : [])]), '',
    '## 截图与视觉识别', '', ...(run.screenshots?.length ? run.screenshots.map(item => `- ${item.stepId}: Screenshot captured — ${item.path}\n  - Visual inspection: ${item.visualInspection === 'performed' ? 'performed' : 'not required'}`) : ['- No step screenshots recorded.']), '',
    '## Critical Checkpoints', '', ...(run.operationPlanId ? [`- OperationPlan: ${run.operationPlanId}${run.operationVersion ? ` v${run.operationVersion}` : ''}`, ''] : []), ...(checkpointLines.length ? checkpointLines : ['- No report-visible checkpoint was declared.', '']),
    '## 视觉业务验证', '', ...(run.visualFindings ?? []).flatMap(item => [`- ${item.scenarioId}/${item.assertionId}: ${item.status.toUpperCase()}\n  - Expected: ${item.expected}\n  - Actual: ${item.actual}${item.screenshotPath ? `\n  - Screenshot: ${item.screenshotPath}` : ''}`, ...(item.screenshotPath ? [screenshotMarkdown(item.screenshotPath, `${item.scenarioId} ${item.assertionId}`)] : [])]), '',
    '## 缺陷候选与决策建议', '', ...(defectCandidates.length ? defectCandidates.flatMap(item => [`- ${item.id} [${item.type}]`, `  - Scenario: ${item.scenario}`, `  - Expected: ${item.expected}`, `  - Actual: ${item.actual}`, ...(item.screenshot ? [`  - Screenshot: ${item.screenshot}`] : [])]) : ['- 未发现可归类的失败证据。']),
    '## 恢复过程', '', ...(run.recoveryAttempts?.length ? run.recoveryAttempts.map(item => `- ${item.id}: ${item.reason}\n  - Failed step: ${item.failedStepId ?? 'unspecified'}\n  - Action: ${item.action}\n  - Outcome: ${item.outcome}\n  - Detail: ${item.detail}`) : ['- No recovery attempt recorded.']), '',
    '## Scenario Cleanup', '', ...(run.cleanupFindings?.length ? run.cleanupFindings.map(item => `- ${item.scenarioId}: ${item.cleanup} — ${item.status.toUpperCase()}\n  - Actual: ${item.actual}${item.screenshotPath ? `\n  - Screenshot: ${item.screenshotPath}` : ''}`) : ['- No declared cleanup result recorded.']), '',
    ...(run.operationCandidates?.length ? ['## OperationPlan 候选', '', ...run.operationCandidates.map(item => `- ${item}`), ''] : []),
    ...(run.operationCandidateIssues?.length ? ['## OperationPlan 未生成原因', '', ...run.operationCandidateIssues.flatMap(item => [`- ${item.scenarioId}`, ...item.reasons.map(reason => `  - ${reason}`)]), '', '- Business verification can still pass, but fast replay is not ready until these structured step issues are corrected.', ''] : []),
    `- Release recommendation: ${run.status === 'passed' ? 'No QA evidence currently blocks release.' : run.status === 'adapted' ? 'Release decision is available, but review the adapted Operation candidate before promoting it.' : run.status === 'failed' ? 'Do not treat this scope as release-ready until failed scenarios are assessed.' : 'Decision deferred: complete blocked, paused, or confirmation preconditions first.'}`, '',
    ...(run.memoryCandidates?.length ? ['## 候选项目记忆', '', ...run.memoryCandidates.map(item => `- ${item}`), ''] : []),
    '## 源码辅助分析', '', '未在本次运行中执行源码诊断。业务结论应以实际页面、接口和运行证据为准。', '',
  ];
  const path = taskRunReportPath(root, task.metadata.moduleId, task.metadata.id, run.id);
  writeTextAtomic(path, `${lines.join('\n')}\n`);
  return path;
}
