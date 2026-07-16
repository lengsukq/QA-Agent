import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { qaPath, readProject } from './project.ts';

export interface SourceFinding { path: string; line: number; text: string; }

export function sourceRoot(root: string): string {
  const project = readProject(root);
  if (project.source.mode !== 'local-readonly') throw new Error(`Source access mode ${project.source.mode} is not supported by this local verifier.`);
  const path = resolve(qaPath(root), project.source.root);
  if (!existsSync(path)) throw new Error(`Configured source root does not exist: ${path}`);
  return path;
}

export function searchSource(root: string, query: string, limit = 50): SourceFinding[] {
  if (!query.trim()) throw new Error('Source search query is required.');
  const source = sourceRoot(root);
  let output = '';
  try {
    output = execFileSync('rg', ['--line-number', '--no-heading', '--color', 'never', '--glob', '!.qa-agent/**', '--glob', '!node_modules/**', '--', query, source], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    const result = error as { status?: number; stdout?: string };
    if (result.status === 1) return [];
    if (typeof result.stdout === 'string') output = result.stdout; else throw error;
  }
  return output.split('\n').filter(Boolean).slice(0, limit).flatMap(line => {
    const match = line.match(/^(.*):(\d+):(.*)$/);
    return match ? [{ path: relative(root, match[1]!), line: Number(match[2]), text: match[3]!.trim() }] : [];
  });
}

export function diagnoseSource(root: string, moduleId: string, query: string): object {
  const findings = searchSource(root, query);
  return {
    moduleId, query, level: findings.length ? 'investigation_hint' : 'possible_risk', findings,
    disclaimer: '源码分析仅为只读辅助诊断；业务结论必须来自实际页面、接口或运行证据。',
  };
}
