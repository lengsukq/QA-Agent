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

export const QA_SUBSKILLS = ['start', 'review', 'test', 'result', 'operation', 'regression', 'recovery', 'archive'] as const;

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

Use the qa-agent CLI as the only persistent state and Runtime entry point.
1. Run qa-agent start --request "<request>" --module <module> --task <task>. Inspect relevant source, reviewed memory, historical Runs, and existing OperationPlans before asking the user; ask at most one user-owned decision per turn.
2. Present the Runtime-generated plan, planHash, Scenario coverage, evidence, safety, and cleanup. Wait for explicit human approval.
3. Persist TestPlan approval with qa-agent review --module <module> --task <task> --approve --confirmed-by <human>. Approval must not start a Run.
4. Run qa-agent test --module <module> --task <task>. Follow only returned gates, allowedActions, nextActions, breadcrumb, resumeToken, and runId.
5. Use UI tools only when uiExecutionAllowed=true and mustStop=false. Persist every action, screenshot, assertion, cleanup, evidence, recovery attempt, and completion through Runtime commands.
6. Runtime automatically creates eligible OperationPlan candidates after a successful exploratory Run. Present candidates and request separate promotion approval; do not call operation generate in the normal workflow.
7. After promotion approval, use qa-agent task operation review ... --approve --confirmed-by <human>, then qa-agent test for a real replay. Only validated OperationPlans enter formal RegressionSuites and archive gates.
8. Use qa-agent archive only after all validated regression, Runtime report, screenshot, assertion, cleanup, and memory gates pass.
9. Never write a manual formal report, bypass a blocking Gate, fabricate evidence, or claim PASS before Runtime completion.
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
