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
    join(skillRoot, 'references', 'regression-runner.md'),
    join(skillRoot, 'references', 'recommended-regression-stack.md'),
    join(skillRoot, 'references', 'cli-command-reference.md'),
    join(skillRoot, 'skills', 'guided', 'SKILL.md'),
    join(skillRoot, 'skills', 'regression-test', 'SKILL.md'),
  ];
  return files.map(path => readFileSync(path, 'utf8')).join('\n');
}

test('uses installed workflow references without a project Prompt Bundle', () => {
  for (const file of ['workflow.md', 'regression-runner.md', 'recommended-regression-stack.md', 'cli-command-reference.md']) assert.ok(existsSync(join(skillRoot, 'references', file)));
  const workflow = readFileSync(join(skillRoot, 'references', 'workflow.md'), 'utf8');
  for (const heading of ['## Request classification', '## Session continuity', '## Shared PRD review gates', '## Daily Quick workflow', '## Guided workflow', '## Strict and release workflow', '## Session finish', '## User-visible language', '## Safety boundaries']) assert.match(workflow, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-no-prompt-bundle-'));
  initializeProject(root, { id: 'no-prompt-bundle' });
  assert.equal(existsSync(join(root, '.qa-agent', 'prompts')), false);
  assert.equal(existsSync(join(repository, 'src', 'prompts.ts')), false);
  assert.equal(existsSync(join(repository, 'src', 'workflow-guidance.ts')), false);
});

test('documents one advisory recommended regression stack for Web and iOS', () => {
  const stack = readFileSync(join(skillRoot, 'references', 'recommended-regression-stack.md'), 'utf8');
  for (const phrase of ['recommended, not mandatory', 'Python 3.12', 'pytest-playwright', 'xcrun simctl', 'fb-idb', 'idb_companion', 'ios-simulator-mcp', 'result.json', 'report.md', 'screenshots/', 'stdout.log', 'stderr.log', 'evidence/']) assert.match(stack, new RegExp(phrase, 'i'));
  assert.doesNotMatch(stack, /junit|allure|ui-tree|Playwright Trace|videos?\//i);
  const runner = readFileSync(join(skillRoot, 'references', 'regression-runner.md'), 'utf8');
  assert.match(runner, /QA_AGENT_SCREENSHOT_DIR/);
  assert.match(runner, /QA_AGENT_RESULT_PATH/);
});

test('guides first-time users to run Doctor after initialization', () => {
  const readme = readFileSync(join(repository, 'README.md'), 'utf8');
  const englishReadme = readFileSync(join(repository, 'README.en.md'), 'utf8');
  assert.match(readme, /初始化[\s\S]*qa-agent doctor[\s\S]*不会自动阻止 QA Agent[\s\S]*第一次测试/);
  assert.match(readme, /推荐技术栈缺失只会作为建议提示，不会自动阻止 QA Agent/);
  assert.match(englishReadme, /## First-run check \(recommended\)[\s\S]*qa-agent doctor[\s\S]*initialize the tested project and Agent host[\s\S]*start the first test/);
  assert.match(englishReadme, /Missing recommended tools are advisory and do not automatically block QA Agent/);
});

test('keeps one compact ordinary QA Skill with act commands and regression ownership', () => {
  const main = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
  assert.ok(words(main) < 600, `main Skill is too large: ${words(main)} words`);
  for (const phrase of ['qa-agent check', 'qa-agent continue', 'qa-agent finish', 'qa-agent-guided', 'qa-agent-regression-test', 'userQuestions', 'confirmedDecisions', 'Task PRD', '确认测试方案', '确认开始测试', 'qa-agent act', 'qa-agent regression publish']) assert.match(main, new RegExp(phrase, 'i'));
  assert.doesNotMatch(main, /qa-agent-(quick|start|review|test|result|finish|operation|recovery|archive)/);
});

test('installs only guided and regression-test advanced Skills', () => {
  assert.deepEqual([...QA_SUBSKILLS], ['guided', 'regression-test']);
  assert.ok(existsSync(join(skillRoot, 'skills', 'guided', 'SKILL.md')));
  assert.ok(existsSync(join(skillRoot, 'skills', 'regression-test', 'SKILL.md')));
  for (const removed of ['quick', 'start', 'review', 'test', 'result', 'finish', 'operation', 'recovery', 'archive', 'regression', 'plan']) assert.equal(existsSync(join(skillRoot, 'skills', removed)), false);
});

test('documents the Guided QA action and verdict handshake', () => {
  const guided = readFileSync(join(skillRoot, 'skills', 'guided', 'SKILL.md'), 'utf8');
  const workflow = readFileSync(join(skillRoot, 'references', 'workflow.md'), 'utf8');
  const cliReference = readFileSync(join(skillRoot, 'references', 'cli-command-reference.md'), 'utf8');
  for (const text of [guided, workflow, cliReference]) {
    assert.match(text, /qa-agent run guide-approve/);
    assert.match(text, /qa-agent run guide-verdict/);
    assert.match(text, /one|每个|exactly one/i);
  }
  assert.match(guided, /Do not use a UI tool before Runtime returns `uiExecutionAllowed=true`/i);
  assert.match(guided, /do not execute another UI action or complete the Run/i);
});

test('keeps host guidance thin and routes published scripts to regression-test', () => {
  assert.ok(words(sharedGuidance) < 240, `shared host guidance is too large: ${words(sharedGuidance)} words`);
  for (const phrase of ['references/workflow.md', 'qa-agent continue', 'QA_AGENT_SESSION_KEY', 'Task prd.md', '确认测试方案', '确认开始测试', 'qa-agent-guided', 'qa-agent-regression-test', 'Python draft']) assert.match(sharedGuidance, new RegExp(phrase, 'i'));
  assert.doesNotMatch(sharedGuidance, /approved_unverified|planHash|resumeToken|contextHash/);
});

test('keeps Quick completion and Session finish assets minimal', () => {
  const text = sourceText();
  assert.doesNotMatch(text, /summaryRef|taskSummaryPath|observedScenarioRefs|SessionJournal/);
  assert.doesNotMatch(text, /taskRunDirectory|taskRunIndexPath|taskRunLatestPath/);
  assert.match(readFileSync(join(repository, 'src', 'task-finalizer.ts'), 'utf8'), /prd\.md/);
  assert.match(readFileSync(join(repository, 'src', 'engine.ts'), 'utf8'), /finalizeTask\(root/);
  assert.match(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8'), /Session finish is not Task archive/i);
  assert.match(readFileSync(join(skillRoot, 'references', 'workflow.md'), 'utf8'), /Session finish and Task archive are different/i);
  assert.equal(existsSync(join(repository, 'src', 'session-journal.ts')), false);
});

test('keeps one Source Run per Task and routes later execution to regression-runs', () => {
  const project = readFileSync(join(repository, 'src', 'project.ts'), 'utf8');
  const types = readFileSync(join(repository, 'src', 'types.ts'), 'utf8');
  const engine = readFileSync(join(repository, 'src', 'engine.ts'), 'utf8');
  const workflow = readFileSync(join(skillRoot, 'references', 'workflow.md'), 'utf8');
  const cliReference = readFileSync(join(skillRoot, 'references', 'cli-command-reference.md'), 'utf8');
  const readme = readFileSync(join(repository, 'README.md'), 'utf8');
  for (const text of [project, types, workflow]) assert.match(text, /source-run/i);
  assert.match(workflow, /Publication freezes the Source Run|Source Run is frozen/i);
  assert.match(workflow, /regression-runs\//i);
  assert.match(engine, /source_run_restarted/);
  assert.match(engine, /Source Run .* frozen|formal Python regression script/);
  assert.match(cliReference, /There is no exploratory `runs\/<run-id>\/` history/i);
  assert.doesNotMatch(project, /taskRunDirectory|taskRunIndexPath|taskRunLatestPath/);
  assert.doesNotMatch(project, /runs\.jsonl/);
  assert.doesNotMatch(readme, /└── runs\/\s*\n\s*└── <run-id>/);
});

test('requires Task PRD review and exact start confirmation before UI execution', () => {
  const main = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
  const workflow = readFileSync(join(skillRoot, 'references', 'workflow.md'), 'utf8');
  const guided = readFileSync(join(skillRoot, 'skills', 'guided', 'SKILL.md'), 'utf8');
  const cliReference = readFileSync(join(skillRoot, 'references', 'cli-command-reference.md'), 'utf8');
  for (const text of [main, workflow, guided, cliReference]) {
    assert.match(text, /确认测试方案/);
    assert.match(text, /确认开始测试/);
    assert.match(text, /Task (?:`?prd\.md`?|PRD)/i);
  }
  assert.match(main, /must not start a Run|Only after both gates/i);
  assert.match(main, /Every Scenario (?:must contain|requires) ordered `steps`/i);
  assert.match(workflow, /Only after both gates may|UI operation/i);
  assert.match(cliReference, /fails without creating a Run/i);
  assert.match(readFileSync(join(repository, 'src', 'engine.ts'), 'utf8'), /before creating a Run/);
  assert.match(readFileSync(join(repository, 'src', 'task-prd.ts'), 'utf8'), /\| 步骤 \| 操作 \| 预期结果 \|/);
});

test('requires separate export and publication approval with Run-level flow traceability', () => {
  const main = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
  const workflow = readFileSync(join(skillRoot, 'references', 'workflow.md'), 'utf8');
  const contract = readFileSync(join(skillRoot, 'references', 'regression-runner.md'), 'utf8');
  const regressionSkill = readFileSync(join(skillRoot, 'skills', 'regression-test', 'SKILL.md'), 'utf8');
  for (const phrase of ['Export approval', 'publication approval', 'sourceFlowHash', 'QA_AGENT_RESULT_PATH', 'qa-agent/python-regression-result/v1']) assert.match(contract, new RegExp(phrase, 'i'));
  assert.match(main, /separate explicit approval/i);
  assert.match(workflow, /separate explicit approval/i);
  assert.match(regressionSkill, /Runtime-generated regression report/i);
  assert.doesNotMatch(regressionSkill, /qa-agent regression export|qa-agent regression publish/);
  assert.match(sourceText(), /sourceFlowHash/);
});

test('requires clickable artifacts, Markdown-embedded screenshots, and an explicit regression offer', () => {
  const main = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
  const workflow = readFileSync(join(skillRoot, 'references', 'workflow.md'), 'utf8');
  const guided = readFileSync(join(skillRoot, 'skills', 'guided', 'SKILL.md'), 'utf8');
  const regression = readFileSync(join(skillRoot, 'skills', 'regression-test', 'SKILL.md'), 'utf8');
  for (const text of [main, workflow, guided, regression, sharedGuidance]) {
    assert.match(text, /clickable|Markdown link|markdownLink/i);
    assert.match(text, /Markdown image syntax|embed/i);
    assert.match(text, /plain path|paths alone|path-only/i);
  }
  assert.match(readFileSync(join(repository, 'src', 'report.ts'), 'utf8'), /## Embedded Screenshots/);
  assert.match(readFileSync(join(repository, 'src', 'cli.ts'), 'utf8'), /mustAskUserQuestion/);
});

test('publishes v0.3.7 without source and lockfile implementation payloads', () => {
  const pkg = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string; files: string[] };
  assert.equal(pkg.version, '0.3.7');
  assert.equal(pkg.files.includes('src/'), false);
  assert.equal(pkg.files.includes('package-lock.json'), false);
});
