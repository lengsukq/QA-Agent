import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { qaPath } from './project.ts';
import type { ImpactAnalysis, QaModule, TestTask } from './types.ts';
import { listFiles, now, readJson, writeJsonAtomic } from './store.ts';

export interface ImpactOptions {
  base?: string;
  head?: string;
  changedFiles?: string[];
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const genericPathTokens = new Set(['lib', 'src', 'app', 'apps', 'code', 'feature', 'features', 'module', 'modules', 'service', 'services', 'page', 'pages', 'screen', 'screens', 'component', 'components']);
function meaningfulTokens(value: string): string[] {
  return normalized(value).split('-').filter(token => token.length > 3 && !genericPathTokens.has(token));
}

function git(root: string, arguments_: string[]): string {
  try {
    return execFileSync('git', ['-c', `safe.directory=${root}`, ...arguments_], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function changedFilesFromGit(root: string, options: ImpactOptions = {}): string[] {
  if (options.changedFiles?.length) return [...new Set(options.changedFiles.map(item => item.trim()).filter(Boolean))].sort();

  if (options.base || options.head) {
    const range = options.base
      ? `${options.base}...${options.head ?? 'HEAD'}`
      : `HEAD...${options.head}`;
    return [...new Set(git(root, ['diff', '--name-only', range]).split('\n').map(item => item.trim()).filter(Boolean))].sort();
  }

  const status = git(root, ['status', '--porcelain']);
  return [...new Set(status.split('\n').map(line => {
    const path = line.slice(3).trim();
    return path.includes(' -> ') ? path.split(' -> ').at(-1)!.trim() : path;
  }).filter(Boolean))].sort();
}

function directModuleImpact(file: string, module: QaModule): { score: number; reasons: string[] } {
  const lowerFile = file.toLowerCase();
  const fileTokens = meaningfulTokens(file);
  const aliases = [module.id, module.name, ...(module.sourceHints ?? []), ...(module.entryPoints ?? [])]
    .map(normalized)
    .filter(Boolean);
  const reasons: string[] = [];
  let score = 0;

  if (lowerFile.split('/').some(segment => normalized(segment) === normalized(module.id))) {
    score += 65;
    reasons.push(`Changed path contains module id "${module.id}".`);
  }
  if (aliases.some(alias => alias.length > 2 && normalized(file).includes(alias))) {
    score += 45;
    reasons.push('Changed path matches module name, source hint, or entry point.');
  }
  const moduleTokens = aliases.flatMap(meaningfulTokens);
  const overlap = [...new Set(fileTokens.filter(token => moduleTokens.includes(token)))];
  if (overlap.length) {
    score += Math.min(30, overlap.length * 10);
    reasons.push(`Shared path tokens: ${overlap.join(', ')}.`);
  }
  if (module.riskLevel === 'critical' && score > 0) score += 10;
  return { score: Math.min(100, score), reasons };
}

/** Map changed files to modules and reviewed QA Tasks. */
export function analyzeImpact(
  changedFiles: string[],
  modules: QaModule[],
  tasks: TestTask[],
  options: Pick<ImpactOptions, 'base' | 'head'> = {},
): ImpactAnalysis {
  const direct = modules.map(module => {
    const matches = changedFiles.map(file => ({ file, ...directModuleImpact(file, module) })).filter(item => item.score > 0);
    return {
      moduleId: module.id,
      score: Math.min(100, matches.reduce((maximum, item) => Math.max(maximum, item.score), 0)),
      reasons: [...new Set(matches.flatMap(item => item.reasons))],
      changedFiles: matches.map(item => item.file),
    };
  }).filter(item => item.score > 0);

  const directIds = new Set(direct.map(item => item.moduleId));
  const propagated = modules.filter(module => !directIds.has(module.id) && module.dependencies.some(dependency => directIds.has(dependency))).map(module => ({
    moduleId: module.id,
    score: 35,
    reasons: [`Module depends on directly impacted module(s): ${module.dependencies.filter(dependency => directIds.has(dependency)).join(', ')}.`],
    changedFiles: [],
  }));
  const impactedModules = [...direct, ...propagated].sort((a, b) => b.score - a.score || a.moduleId.localeCompare(b.moduleId));
  const impactedIds = new Set(impactedModules.map(item => item.moduleId));

  const selectedTasks = tasks.filter(task => ['ready', 'active'].includes(task.metadata.status)).flatMap(task => {
    const reasons: string[] = [];
    if (impactedIds.has(task.metadata.moduleId)) reasons.push('Task belongs to an impacted module.');
    const impactTags = (task.metadata.tags ?? []).filter(tag => tag.startsWith('impact:')).map(tag => tag.slice('impact:'.length));
    const triggers = [...(task.regression?.triggers ?? []), ...impactTags].map(normalized).filter(Boolean);
    const triggerMatches = changedFiles.filter(file => triggers.some(trigger => normalized(file).includes(trigger)));
    if (triggerMatches.length) reasons.push(`Regression trigger matched: ${triggerMatches.join(', ')}.`);
    return reasons.length ? [{ moduleId: task.metadata.moduleId, taskId: task.metadata.id, priority: task.metadata.priority, reasons }] : [];
  });

  const matchedFiles = new Set(direct.flatMap(module => module.changedFiles));
  const seed = JSON.stringify({ base: options.base, head: options.head, changedFiles });
  return {
    $schema: './schemas/impact-analysis.schema.json',
    apiVersion: 'qa-agent/v2',
    kind: 'ImpactAnalysis',
    id: `impact-${createHash('sha1').update(seed).digest('hex').slice(0, 10)}`,
    base: options.base,
    head: options.head,
    changedFiles,
    impactedModules,
    selectedTasks,
    unmatchedFiles: changedFiles.filter(file => !matchedFiles.has(file)),
    generatedAt: now(),
  };
}

export function analyzeProjectImpact(root: string, options: ImpactOptions = {}): ImpactAnalysis {
  const changedFiles = changedFilesFromGit(root, options);
  const modules = listFiles(qaPath(root, 'modules'), path => basename(path) === 'module.json').map(path => readJson<QaModule>(path));
  const tasks = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path)).map(path => readJson<TestTask>(path));
  const analysis = analyzeImpact(changedFiles, modules, tasks, options);
  writeJsonAtomic(qaPath(root, 'impact-analysis', `${analysis.id}.json`), analysis);
  return analysis;
}
