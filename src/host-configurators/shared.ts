import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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

/** Keep the main skill separate from the flat subskills so each subskill is
 * represented by exactly one discoverable SKILL.md. */
export function copyMainSkill(destination: string, force: boolean): void {
  const source = join(skillSource(), 'SKILL.md');
  const target = join(destination, 'SKILL.md');
  if (existsSync(target) && !force && readFileSync(target, 'utf8') !== readFileSync(source, 'utf8')) {
    throw new Error(`Host integration already exists at ${target}. Use --force only if replacing it is intended.`);
  }
  mkdirSync(destination, { recursive: true });
  if (!existsSync(target) || force) cpSync(source, target, { force });

  const sourceReferences = join(skillSource(), 'references');
  const targetReferences = join(destination, 'references');
  if (existsSync(targetReferences) && !force && contentHash(targetReferences) !== contentHash(sourceReferences)) {
    throw new Error(`Host Skill references already exist at ${targetReferences}. Use --force only if replacing them is intended.`);
  }
  if (force && existsSync(targetReferences)) rmSync(targetReferences, { recursive: true, force: true });
  if (!existsSync(targetReferences) || force) cpSync(sourceReferences, targetReferences, { recursive: true, force, errorOnExist: !force });

}

export const QA_SUBSKILLS = ['guided', 'regression-test'] as const;

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

Load the installed qa-agent Skill and references/workflow.md.

- check/start creates planning assets only. Inspect the project, apply ordered Scenario steps, and present Task prd.md through its clickable userFacingArtifacts markdownLink.
- Resolve every requirement, environment, account, expected-result, and safety question with the QA. Persist confirmedDecisions and reapply the plan.
- Require exact “确认测试方案” through plan review, then a separate exact “确认开始测试” through review. Vague approval never authorizes UI.
- Runtime owns state, evidence, reports, approvals, publication, and results. Never edit its JSON or write competing reports. Formal reports embed screenshots in Markdown; paths alone are invalid. Completion replies link the report, plus PRD for Source Runs.
- Load qa-agent-guided for user-led testing. Runtime keeps one pending interaction at a time: one approved action, one screenshot-backed UI operation, then one QA verdict. Completed approvals and verdicts live on the Step.
- Use qa-agent continue after interruption. Use UI tools only with uiExecutionAllowed=true, mustStop=false, and runId. Pass QA_AGENT_SESSION_KEY when available.
- After an eligible AI-led report, consent exports one full-flow regression-steps draft (steps.json) only. User-led completion creates one independent steps draft per Scenario automatically. Show the relevant steps or diff and publish only after separate approval; publication freezes the Source Run.
- Load qa-agent-regression-test for later regression-runs. Strict matrices and release planning stay in the main Skill.
- Ask at most one user-owned question per turn. Never bypass safety or fabricate evidence, decisions, or results.
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
