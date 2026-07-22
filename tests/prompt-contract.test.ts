import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeProject } from '../src/project.ts';
import { QA_SUBSKILLS, sharedGuidance } from '../src/host-configurators/shared.ts';

const repository = process.cwd();
const skillRoot = join(repository, 'skill', 'qa-agent');

function words(value: string): number { return value.trim().split(/\s+/).filter(Boolean).length; }
function sourceText(): string {
  return ['project.ts', 'workflow.ts', 'engine.ts', 'types.ts', 'task-finalizer.ts', 'finish.ts', 'python-regression.ts', 'regression.ts', 'release.ts', 'archive.ts']
    .map(name => readFileSync(join(repository, 'src', name), 'utf8')).join('\n');
}
function skillText(): string {
  const files = [
    join(skillRoot, 'SKILL.md'),
    join(skillRoot, 'references', 'workflow.md'),
    join(skillRoot, 'references', 'python-regression.md'),
    join(skillRoot, 'references', 'recommended-regression-stack.md'),
    join(skillRoot, 'references', 'cli-command-reference.md'),
    join(skillRoot, 'skills', 'plan', 'SKILL.md'),
    join(skillRoot, 'skills', 'regression-test', 'SKILL.md'),
  ];
  return files.map(path => readFileSync(path, 'utf8')).join('\n');
}

test('uses installed workflow references without a project Prompt Bundle', () => {
  for (const file of ['workflow.md', 'python-regression.md', 'recommended-regression-stack.md', 'cli-command-reference.md']) assert.ok(existsSync(join(skillRoot, 'references', file)));
  const workflow = readFileSync(join(skillRoot, 'references', 'workflow.md'), 'utf8');
  for (const heading of ['## Request classification', '## Session continuity', '## Daily Quick workflow', '## Strict workflow', '## Session finish', '## User-visible language', '## Safety boundaries']) assert.match(workflow, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-no-prompt-bundle-'));
  initializeProject(root, { id: 'no-prompt-bundle' });
  assert.equal(existsSync(join(root, '.qa-agent', 'prompts')), false);
  assert.equal(existsSync(join(repository, 'src', 'prompts.ts')), false);
  assert.equal(existsSync(join(repository, 'src', 'workflow-guidance.ts')), false);
});

test('documents one advisory recommended regression stack for Web and iOS', () => {
  const stack = readFileSync(join(skillRoot, 'references', 'recommended-regression-stack.md'), 'utf8');
  for (const phrase of ['recommended, not mandatory', 'Python 3.12', 'pytest-playwright', 'Playwright Trace', 'xcrun simctl', 'fb-idb', 'idb_companion', 'ios-simulator-mcp', 'result.json', 'junit.xml', 'allure-results']) assert.match(stack, new RegExp(phrase, 'i'));
  const main = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
  const python = readFileSync(join(skillRoot, 'references', 'python-regression.md'), 'utf8');
  assert.match(main, /recommended-regression-stack\.md/);
  assert.match(python, /recommended-regression-stack\.md/);
});

test('keeps one compact ordinary QA Skill with Python draft and publication ownership', () => {
  const main = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
  assert.ok(words(main) < 600, `main Skill is too large: ${words(main)} words`);
  for (const phrase of ['Quick Check', 'qa-agent check', 'qa-agent continue', 'qa-agent finish', 'qa-agent-plan', 'qa-agent-regression-test', 'user-owned question', 'business test flow', 'pythonRegressionEligibility', 'qa-agent regression draft', 'qa-agent regression publish']) assert.match(main, new RegExp(phrase, 'i'));
  assert.doesNotMatch(main, /qa-agent-(quick|start|review|test|result|finish|operation|recovery|archive)/);
});

test('installs only plan and regression-test advanced Skills', () => {
  assert.deepEqual([...QA_SUBSKILLS], ['plan', 'regression-test']);
  assert.ok(existsSync(join(skillRoot, 'skills', 'plan', 'SKILL.md')));
  assert.ok(existsSync(join(skillRoot, 'skills', 'regression-test', 'SKILL.md')));
  for (const removed of ['quick', 'start', 'review', 'test', 'result', 'finish', 'operation', 'recovery', 'archive', 'regression']) assert.equal(existsSync(join(skillRoot, 'skills', removed)), false);
});

test('keeps host guidance thin and routes published scripts to regression-test', () => {
  assert.ok(words(sharedGuidance) < 240, `shared host guidance is too large: ${words(sharedGuidance)} words`);
  for (const phrase of ['references/workflow.md', 'qa-agent continue', 'QA_AGENT_SESSION_KEY', 'qa-agent-plan', 'qa-agent-regression-test', 'validated Python scripts']) assert.match(sharedGuidance, new RegExp(phrase, 'i'));
  assert.doesNotMatch(sharedGuidance, /approved_unverified|planHash|resumeToken|contextHash/);
});

test('keeps Quick completion and Session finish assets minimal', () => {
  const text = sourceText();
  assert.doesNotMatch(text, /summaryRef|taskSummaryPath|observedScenarioRefs|SessionJournal/);
  assert.match(readFileSync(join(repository, 'src', 'task-finalizer.ts'), 'utf8'), /prd\.md/);
  assert.match(readFileSync(join(repository, 'src', 'engine.ts'), 'utf8'), /finalizeTask\(root/);
  assert.match(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8'), /Session finish is not Task archive/i);
  assert.match(readFileSync(join(skillRoot, 'references', 'workflow.md'), 'utf8'), /Session finish and Task archive are different/i);
  assert.equal(existsSync(join(repository, 'src', 'session-journal.ts')), false);
});

test('requires separate generation and publication approval with Run-level flow traceability', () => {
  const main = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
  const workflow = readFileSync(join(skillRoot, 'references', 'workflow.md'), 'utf8');
  const contract = readFileSync(join(skillRoot, 'references', 'python-regression.md'), 'utf8');
  const regressionSkill = readFileSync(join(skillRoot, 'skills', 'regression-test', 'SKILL.md'), 'utf8');
  for (const phrase of ['Generation approval', 'publication approval', 'Runtime never authors Python', 'sourceFlowHash', 'QA_AGENT_REGRESSION:', 'QA_AGENT_RESULT_PATH', 'qa-agent/python-regression-result/v1']) assert.match(contract, new RegExp(phrase, 'i'));
  assert.match(main, /Generation consent authorizes a draft only/i);
  assert.match(workflow, /first confirmation permits only draft generation/i);
  assert.match(workflow, /second explicit approval/i);
  assert.match(regressionSkill, /previously approved Python regression scripts/i);
  assert.match(regressionSkill, /Runtime-generated regression report/i);
  assert.doesNotMatch(regressionSkill, /qa-agent regression draft|qa-agent regression publish/);
  assert.match(sourceText(), /sourceFlowHash/);
});

test('removes the OperationPlan and RegressionSuite product model completely', () => {
  assert.equal(existsSync(join(repository, 'src', 'operations.ts')), false);
  assert.equal(existsSync(join(skillRoot, 'references', 'operating-model.md')), false);
  assert.doesNotMatch(skillText(), /OperationPlan|operation-plans|RegressionSuite|regression-suite|sourceOperationPlanIds/);
  const productionFiles = ['types.ts', 'engine.ts', 'workflow.ts', 'regression.ts', 'release.ts', 'archive.ts', 'cli.ts', 'project.ts', 'planning.ts'];
  const production = productionFiles.map(name => readFileSync(join(repository, 'src', name), 'utf8')).join('\n');
  assert.doesNotMatch(production, /OperationPlan|operation-plans|RegressionSuite|regression-suite|sourceOperationPlanIds|replayStatus|replayStage|replayCursor/);
});

test('publishes v0.3.0 without source and lockfile implementation payloads', () => {
  const pkg = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string; files: string[] };
  assert.equal(pkg.version, '0.3.0');
  assert.equal(pkg.files.includes('src/'), false);
  assert.equal(pkg.files.includes('package-lock.json'), false);
});
