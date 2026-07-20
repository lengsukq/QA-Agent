import { createHash } from 'node:crypto';
import { qaPath } from './project.ts';
import type { RegressionProfile, RegressionRun, RegressionSuite, ReleaseCheck } from './types.ts';
import { now, readJson, writeJsonAtomic, writeTextAtomic } from './store.ts';

export function createReleaseCheck(
  suite: RegressionSuite,
  impact: ReleaseCheck['impactAnalysis'],
  profile: RegressionProfile,
): ReleaseCheck {
  const timestamp = now();
  const timestampId = timestamp.replace(/[-:.TZ]/g, '').slice(0, 14);
  const id = `release-${timestampId}-${createHash('sha1').update(`${profile}:${suite.id}:${suite.suiteHash}:${timestamp}`).digest('hex').slice(0, 8)}`;
  const requiredAssetGaps = suite.requiredAssetGaps ?? [];
  const hasCriticalAssetGap = requiredAssetGaps.some(gap => gap.releaseGate || gap.priority === 'p0');
  return {
    $schema: './schemas/release-check.schema.json',
    apiVersion: 'qa-agent/v2',
    kind: 'ReleaseCheck',
    id,
    version: 1,
    name: `${suite.name} check`,
    profile,
    base: impact.base,
    head: impact.head,
    priorityThreshold: suite.priorityThreshold,
    impactAnalysis: impact,
    suite,
    status: hasCriticalAssetGap ? 'blocked' : requiredAssetGaps.length ? 'review' : 'planned',
    releaseDecision: hasCriticalAssetGap ? 'no-go' : requiredAssetGaps.length ? 'review' : 'pending',
    blockers: [],
    requiredAssetGaps,
    reportPath: `reports/${id}.md`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function releaseCheckPath(root: string, id: string): string {
  return qaPath(root, 'release-checks', `${id}.json`);
}

export function saveReleaseCheck(root: string, check: ReleaseCheck): void {
  writeJsonAtomic(releaseCheckPath(root, check.id), check);
}

export function readReleaseCheck(root: string, id: string): ReleaseCheck {
  const check = readJson<ReleaseCheck>(releaseCheckPath(root, id)); check.requiredAssetGaps ??= []; return check;
}

export function attachRegressionRun(check: ReleaseCheck, run: RegressionRun): ReleaseCheck {
  check.regressionRunId = run.id;
  check.status = run.status === 'running' || run.status === 'pending' ? 'running' : check.status;
  check.updatedAt = now();
  return check;
}

export function finalizeReleaseCheck(check: ReleaseCheck, run: RegressionRun): ReleaseCheck {
  check.regressionRunId = run.id;
  check.blockers = run.childRuns
    .filter(child => !['passed', 'adapted', 'not_applicable'].includes(child.status))
    .map(child => ({
      moduleId: child.moduleId,
      taskId: child.taskId,
      scenarioId: child.scenarioId,
      status: child.status,
      detail: child.detail,
    }));

  const hasCriticalAssetGap = check.requiredAssetGaps.some(gap => gap.releaseGate || gap.priority === 'p0');
  const hasAnyAssetGap = check.requiredAssetGaps.length > 0;
  const hasFailed = run.childRuns.some(child => child.status === 'failed');
  const hasGateBlocker = run.childRuns.some(child =>
    (child.releaseGate || child.priority === 'p0')
    && !['passed', 'adapted', 'not_applicable'].includes(child.status),
  );

  if (hasCriticalAssetGap) {
    check.status = 'blocked';
    check.releaseDecision = 'no-go';
  } else if (hasAnyAssetGap && ['passed', 'adapted'].includes(run.status)) {
    check.status = 'review';
    check.releaseDecision = 'review';
  } else if (run.status === 'passed') {
    check.status = 'passed';
    check.releaseDecision = 'go';
  } else if (run.status === 'adapted') {
    check.status = 'review';
    check.releaseDecision = 'review';
  } else if (hasFailed || hasGateBlocker) {
    check.status = run.status === 'needs_confirmation' ? 'needs_confirmation' : run.status === 'blocked' ? 'blocked' : 'failed';
    check.releaseDecision = 'no-go';
  } else {
    check.status = run.status === 'needs_confirmation' ? 'needs_confirmation' : run.status === 'blocked' ? 'blocked' : 'review';
    check.releaseDecision = 'review';
  }

  check.completedAt = run.completedAt ?? now();
  check.updatedAt = now();
  check.reportPath = `reports/${check.id}.md`;
  return check;
}

export function writeReleaseReport(root: string, check: ReleaseCheck, run?: RegressionRun): string {
  const path = qaPath(root, 'reports', `${check.id}.md`);
  const impact = check.impactAnalysis;
  const lines = [
    `# Release QA Report: ${check.name}`,
    '',
    '## Release Decision',
    '',
    `- Decision: ${check.releaseDecision.toUpperCase()}`,
    `- Status: ${check.status.toUpperCase()}`,
    `- Profile: ${check.profile}`,
    `- Priority threshold: ${check.priorityThreshold.toUpperCase()}`,
    `- Estimated duration: ${check.suite.estimatedDurationMinutes} minutes`,
    `- Regression run: ${check.regressionRunId ?? 'not started'}`,
    '',
    '## Change Impact',
    '',
    `- Base: ${check.base ?? 'working tree'}`,
    `- Head: ${check.head ?? 'current workspace'}`,
    `- Changed files: ${impact.changedFiles.length}`,
    ...impact.changedFiles.map(file => `  - ${file}`),
    `- Impacted modules: ${impact.impactedModules.length}`,
    ...impact.impactedModules.map(module => `  - ${module.moduleId}: score ${module.score} — ${module.reasons.join(' ')}`),
    ...(impact.unmatchedFiles.length ? ['- Unmatched changed files:', ...impact.unmatchedFiles.map(file => `  - ${file}`)] : []),
    '',
    '## Selected Regression Scope',
    '',
    `- Suite: ${check.suite.name}`,
    `- Members: ${check.suite.members.length}`,
    `- Modules: ${check.suite.moduleIds.join(', ') || 'none'}`,
    ...check.suite.members.map(member =>
      `  - ${member.moduleId}/${member.taskId}/${member.scenarioId} — ${member.priority.toUpperCase()}${member.releaseGate ? ' — RELEASE GATE' : ''}${member.tags.includes('golden-path') ? ' — GOLDEN PATH' : ''}\n    - Reason: ${member.selectionReason ?? 'Selected by suite policy.'}`,
    ),
    '',
    '## Required QA Asset Gaps',
    '',
    ...(check.requiredAssetGaps.length
      ? check.requiredAssetGaps.map(gap => `- ${gap.moduleId}/${gap.taskId}: ${gap.priority.toUpperCase()}${gap.releaseGate ? ' — RELEASE GATE' : ''}${gap.goldenPath ? ' — GOLDEN PATH' : ''} — ${gap.reason}`)
      : ['- No required QA asset gap recorded.']),
    '',
    '## Blocking Issues',
    '',
    ...(check.blockers.length
      ? check.blockers.map(blocker => `- ${blocker.moduleId}/${blocker.taskId}/${blocker.scenarioId}: ${blocker.status.toUpperCase()}${blocker.detail ? ` — ${blocker.detail}` : ''}`)
      : ['- No blocking issue recorded.']),
    '',
    '## Child Reports and Evidence',
    '',
    ...(run?.childRuns.length
      ? run.childRuns.map(child => `- ${child.moduleId}/${child.taskId}/${child.scenarioId}: ${child.status.toUpperCase()}${child.reportPath ? ` — ${child.reportPath}` : ''}`)
      : ['- Regression has not produced child reports yet.']),
    '',
    'The release report references Task reports rather than duplicating their screenshots, logs, and other evidence.',
    '',
  ];
  writeTextAtomic(path, `${lines.join('\n')}\n`);
  return path;
}
