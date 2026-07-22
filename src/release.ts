import { createHash } from 'node:crypto';
import { qaPath } from './project.ts';
import type { PythonRegressionSelection, RegressionProfile, RegressionRun, ReleaseCheck } from './types.ts';
import { now, readJson, writeJsonAtomic, writeTextAtomic } from './store.ts';

export function createReleaseCheck(selection: PythonRegressionSelection, impact: ReleaseCheck['impactAnalysis'], profile: RegressionProfile): ReleaseCheck {
  const timestamp = now();
  const timestampId = timestamp.replace(/[-:.TZ]/g, '').slice(0, 14);
  const id = `release-${timestampId}-${createHash('sha1').update(`${profile}:${selection.id}:${selection.selectionHash}:${timestamp}`).digest('hex').slice(0, 8)}`;
  const requiredAssetGaps = selection.requiredAssetGaps ?? [];
  const hasCriticalAssetGap = requiredAssetGaps.some(gap => gap.releaseGate || gap.priority === 'p0');
  return {
    $schema: './schemas/release-check.schema.json', apiVersion: 'qa-agent/v2', kind: 'ReleaseCheck', id, version: 1,
    name: `${selection.name} check`, profile, base: impact.base, head: impact.head, priorityThreshold: selection.priorityThreshold,
    impactAnalysis: impact, selection,
    status: hasCriticalAssetGap ? 'blocked' : requiredAssetGaps.length ? 'review' : 'planned',
    releaseDecision: hasCriticalAssetGap ? 'no-go' : requiredAssetGaps.length ? 'review' : 'pending',
    blockers: [], requiredAssetGaps, reportPath: `reports/${id}.md`, createdAt: timestamp, updatedAt: timestamp,
  };
}

export function releaseCheckPath(root: string, id: string): string { return qaPath(root, 'release-checks', `${id}.json`); }
export function saveReleaseCheck(root: string, check: ReleaseCheck): void { writeJsonAtomic(releaseCheckPath(root, check.id), check); }
export function readReleaseCheck(root: string, id: string): ReleaseCheck { const check = readJson<ReleaseCheck>(releaseCheckPath(root, id)); check.requiredAssetGaps ??= []; return check; }

export function attachRegressionRun(check: ReleaseCheck, run: RegressionRun): ReleaseCheck {
  check.regressionRunId = run.id;
  check.updatedAt = now();
  return check;
}

export function finalizeReleaseCheck(check: ReleaseCheck, run: RegressionRun): ReleaseCheck {
  check.regressionRunId = run.id;
  check.blockers = run.childRuns.filter(child => child.status !== 'passed').map(child => ({
    moduleId: child.moduleId, taskId: child.taskId, regressionId: child.regressionId, scenarioIds: child.scenarioIds, status: child.status, detail: child.detail,
  }));
  const hasCriticalAssetGap = check.requiredAssetGaps.some(gap => gap.releaseGate || gap.priority === 'p0');
  const hasAnyAssetGap = check.requiredAssetGaps.length > 0;
  const hasGateBlocker = run.childRuns.some(child => (child.releaseGate || child.priority === 'p0') && child.status !== 'passed');
  if (hasCriticalAssetGap) { check.status = 'blocked'; check.releaseDecision = 'no-go'; }
  else if (hasAnyAssetGap && run.status === 'passed') { check.status = 'review'; check.releaseDecision = 'review'; }
  else if (run.status === 'passed') { check.status = 'passed'; check.releaseDecision = 'go'; }
  else if (run.status === 'failed' || hasGateBlocker) { check.status = 'failed'; check.releaseDecision = 'no-go'; }
  else if (run.status === 'blocked') { check.status = 'blocked'; check.releaseDecision = hasGateBlocker ? 'no-go' : 'review'; }
  else { check.status = 'review'; check.releaseDecision = 'review'; }
  check.completedAt = run.completedAt;
  check.updatedAt = now();
  check.reportPath = `reports/${check.id}.md`;
  return check;
}

export function writeReleaseReport(root: string, check: ReleaseCheck, run?: RegressionRun): string {
  const path = qaPath(root, 'reports', `${check.id}.md`);
  const impact = check.impactAnalysis;
  const lines = [
    `# Release QA Report: ${check.name}`, '',
    '## Release Decision', '',
    `- Decision: ${check.releaseDecision.toUpperCase()}`,
    `- Status: ${check.status.toUpperCase()}`,
    `- Profile: ${check.profile}`,
    `- Priority threshold: ${check.priorityThreshold.toUpperCase()}`,
    `- Estimated duration: ${check.selection.estimatedDurationMinutes} minutes`,
    `- Regression run: ${check.regressionRunId ?? 'not started'}`, '',
    '## Change Impact', '',
    `- Base: ${check.base ?? 'working tree'}`,
    `- Head: ${check.head ?? 'current workspace'}`,
    `- Changed files: ${impact.changedFiles.length}`,
    ...impact.changedFiles.map(file => `  - ${file}`),
    `- Impacted modules: ${impact.impactedModules.length}`,
    ...impact.impactedModules.map(module => `  - ${module.moduleId}: score ${module.score} — ${module.reasons.join(' ')}`),
    ...(impact.unmatchedFiles.length ? ['- Unmatched changed files:', ...impact.unmatchedFiles.map(file => `  - ${file}`)] : []), '',
    '## Selected Python Regression Scope', '',
    `- Selection: ${check.selection.name}`,
    `- Scripts: ${check.selection.members.length}`,
    `- Modules: ${check.selection.moduleIds.join(', ') || 'none'}`,
    ...check.selection.members.map(member => `  - ${member.moduleId}/${member.taskId}/${member.regressionId} — ${member.priority.toUpperCase()}${member.releaseGate ? ' — RELEASE GATE' : ''}${member.tags.includes('golden-path') ? ' — GOLDEN PATH' : ''}\n    - Scenarios: ${member.scenarioIds.join(', ') || 'none'}\n    - Reason: ${member.selectionReason ?? 'Selected by regression policy.'}`), '',
    '## Required QA Asset Gaps', '',
    ...(check.requiredAssetGaps.length ? check.requiredAssetGaps.map(gap => `- ${gap.moduleId}/${gap.taskId}: ${gap.priority.toUpperCase()}${gap.releaseGate ? ' — RELEASE GATE' : ''}${gap.goldenPath ? ' — GOLDEN PATH' : ''} — ${gap.reason}`) : ['- No required QA asset gap recorded.']), '',
    '## Blocking Issues', '',
    ...(check.blockers.length ? check.blockers.map(blocker => `- ${blocker.moduleId}/${blocker.taskId}/${blocker.regressionId}: ${blocker.status.toUpperCase()}${blocker.detail ? ` — ${blocker.detail}` : ''}`) : ['- No blocking issue recorded.']), '',
    '## Child Reports and Evidence', '',
    ...(run?.childRuns.length ? run.childRuns.map(child => `- ${child.moduleId}/${child.taskId}/${child.regressionId}: ${child.status.toUpperCase()} — contract ${child.contractStatus}${child.reportPath ? ` — ${child.reportPath}` : ''}`) : ['- Regression has not produced child reports yet.']), '',
    'The release report references Task regression reports rather than duplicating screenshots, logs, and other evidence.', '',
  ];
  writeTextAtomic(path, `${lines.join('\n')}\n`);
  return path;
}
