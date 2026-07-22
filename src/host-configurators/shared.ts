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

  // Clean up nested subskills produced by older installations.
  const legacySubskills = join(destination, 'skills');
  if (existsSync(legacySubskills)) rmSync(legacySubskills, { recursive: true, force: true });
}

export const QA_SUBSKILLS = ['plan', 'regression-test'] as const;
const LEGACY_PHASE_SUBSKILLS = ['quick', 'start', 'review', 'test', 'result', 'finish', 'operation', 'recovery', 'archive', 'regression'] as const;

export function copySubSkills(parent: string, force: boolean): string[] {
  const sourceRoot = skillSource();
  for (const name of LEGACY_PHASE_SUBSKILLS) {
    const legacy = join(parent, `qa-agent-${name}`);
    const manifest = join(legacy, 'SKILL.md');
    if (existsSync(manifest) && new RegExp(`^---\\nname: qa-agent-${name}\\n`, 's').test(readFileSync(manifest, 'utf8'))) rmSync(legacy, { recursive: true, force: true });
  }
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

Load the installed qa-agent Skill and references/workflow.md before acting.

- Answer informational questions directly. Before a new ordinary test, inspect, present a concise business flow, and wait for user approval.
- Runtime is the only state, evidence, report, approval, script-publication, and regression-result owner. Never edit Runtime JSON or write a competing report.
- On later turns call qa-agent continue. Use UI tools only when uiExecutionAllowed=true, mustStop=false, and runId exists. Pass --session or QA_AGENT_SESSION_KEY when available.
- After an eligible real report, offer Python from the exact executed flow. The first confirmation permits a draft only.
- Generate the draft as the Agent, save it with qa-agent regression draft, show the complete script or diff, and publish only after a second explicit approval. Runtime never authors Python.
- For an already published Python script, load qa-agent-regression-test. It runs the existing script and reviews the Runtime report without generating, editing, approving, or publishing code.
- Use qa-agent-plan only for strict pre-execution planning. Task, Module, and Release regression select validated Python scripts directly.
- Ask at most one question per turn, infer internal IDs, and use the user's language.
- Call qa-agent finish only on explicit session closure. Hide protocol unless troubleshooting.
- Never bypass safety or approval checks, and never fabricate evidence or results.
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
