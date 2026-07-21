import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { listFiles, writeTextAtomic } from '../store.ts';
import type { ConfigureOptions, HostInstallResult, HostPlatformConfig } from './registry.ts';

export function skillSource(): string {
  return fileURLToPath(new URL('../../skill/qa-agent', import.meta.url));
}

export function requireProjectPath(projectPath: string | undefined): string {
  if (!projectPath) throw new Error('This host requires --project PROJECT_DIRECTORY.');
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) throw new Error(`Project directory does not exist: ${projectPath}`);
  return projectPath;
}

function contentHash(path: string): string {
  const hash = createHash('sha256');
  if (existsSync(path) && statSync(path).isDirectory()) for (const file of listFiles(path, () => true).sort()) hash.update(file.slice(path.length)).update(readFileSync(file));
  else if (existsSync(path)) hash.update(readFileSync(path));
  return hash.digest('hex');
}

export function copySkill(destination: string, force: boolean): void {
  if (existsSync(destination) && !force && contentHash(destination) === contentHash(skillSource())) return;
  if (existsSync(destination) && !force) throw new Error(`Host integration already exists at ${destination}. Use --force only if replacing it is intended.`);
  cpSync(skillSource(), destination, { recursive: true, force, errorOnExist: !force });
}

export const QA_SUBSKILLS = ['test', 'operation', 'regression', 'archive'] as const;

export function copySubSkills(parent: string, force: boolean): string[] {
  const sourceRoot = skillSource();
  return QA_SUBSKILLS.map(name => {
    const destination = join(parent, `qa-agent-${name}`);
    const source = join(sourceRoot, 'skills', name);
    if (existsSync(destination) && !force && contentHash(destination) === contentHash(source)) return destination;
    if (existsSync(destination) && !force) throw new Error(`Host subskill already exists at ${destination}. Use --force only if replacing it is intended.`);
    cpSync(source, destination, { recursive: true, force, errorOnExist: !force });
    return destination;
  });
}

export function assertWritableTargets(paths: string[], force: boolean): void {
  const existing = paths.filter(existsSync);
  if (existing.length && !force) throw new Error(`Host integration already exists at ${existing.join(', ')}. Use --force only if replacing it is intended.`);
}

export function writeManagedText(path: string, content: string, force: boolean): void {
  assertWritableTargets([path], force);
  writeTextAtomic(path, content);
}

export function scopedPath(options: ConfigureOptions, projectPath: string, userPath: string, projectSuffix: string): string {
  return options.scope === 'user' ? join(homedir(), userPath) : join(projectPath, projectSuffix);
}

export function managedTemplate(config: HostPlatformConfig, content: string): Map<string, string> {
  return new Map([[`${config.configDir}/qa-agent`, content]]);
}

export function detected(config: HostPlatformConfig, projectRoot: string): boolean {
  return config.managedPaths.some(path => existsSync(join(projectRoot, path)));
}

export const sharedGuidance = `# QA Agent

Use the CLI as the only project mutation and Runtime entry point.
1. Run qa-agent start --request "<request>" --module <module> --task <task>; it creates the complete Task package in one call. Never create Task JSON or Markdown files one by one.
2. Present the returned plan, taskDirectory, planHash, and TodoList. Wait for human approval; approval must not start a Run.
3. Persist approval only with qa-agent task review <task> --module <module> --approve --confirmed-by <human>.
4. Only after review succeeds run qa-agent test --module <module> --task <task>; this is the command that starts execution.
5. After a successful exploratory Run report, actively call qa-agent operation generate --module <module> --task <task> --run <run-id> [--scenario <scenario>] to persist the quick-regression OperationPlan candidate. Tell the user its ID, Scenario, source Run, plan hash, and issues, then ask for approval.
6. Use qa-agent task operation review <task> --module <module> --operation <operation-id> --approve, then run qa-agent test again so the approved OperationPlan is really replayed and reported.
7. Use qa-agent archive only after the successful replay/adapted regression Run and the complete screenshot, OperationPlan, and RegressionSuite gates pass.
8. Never use UI tools unless the Runtime response has uiExecutionAllowed=true, mustStop=false, and runId. Never write a manual report or claim PASS.
`;

export function renderGuidance(config: HostPlatformConfig): string {
  return `${sharedGuidance}\nPlatform: ${config.name}. Use ${config.templateContext.userActionLabel} through ${config.templateContext.commandPrefix} where the host supports it. CLI commands and Runtime safety rules are platform-independent.\n`;
}

export function renderCursorRule(config: HostPlatformConfig): string {
  return `---\ndescription: Execute project-aware visual QA with the local qa-agent Runtime.\nalwaysApply: false\n---\n\n${renderGuidance(config)}`;
}

export function renderCopilotAgent(config: HostPlatformConfig): string {
  return `---\nname: QA Agent\ndescription: Plans, executes, verifies, reports, and archives project-aware QA.\ntools:\n  - read\n  - search\n  - terminal\n---\n\n${renderGuidance(config)}`;
}

export function renderGeminiCommand(config: HostPlatformConfig): string {
  const prompt = renderGuidance(config).replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `description = "Execute project-aware visual QA"\nprompt = "${prompt}\\n\\nUser request: {{args}}"\n`;
}
