import { cpSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextAtomic } from './store.ts';

export type HostId = 'codex' | 'claude' | 'cursor' | 'opencode' | 'copilot' | 'gemini' | 'agents';
export type InstallScope = 'project' | 'user';

export interface HostInstallOptions {
  host: HostId;
  projectPath?: string;
  path?: string;
  scope?: InstallScope;
  force?: boolean;
}

export interface HostInstallResult {
  host: HostId;
  paths: string[];
  message: string;
}

export const supportedHosts: HostId[] = ['codex', 'claude', 'cursor', 'opencode', 'copilot', 'gemini', 'agents'];

function skillSource(): string {
  return fileURLToPath(new URL('../skill/qa-agent', import.meta.url));
}

function requireProjectPath(projectPath: string | undefined): string {
  if (!projectPath) throw new Error('This host requires --project PROJECT_DIRECTORY.');
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) throw new Error(`Project directory does not exist: ${projectPath}`);
  return projectPath;
}

function assertWritableTargets(paths: string[], force: boolean): void {
  const existing = paths.filter(existsSync);
  if (existing.length && !force) throw new Error(`Host integration already exists at ${existing.join(', ')}. Use --force only if replacing it is intended.`);
}

function copySkill(destination: string, force: boolean): void {
  assertWritableTargets([destination], force);
  cpSync(skillSource(), destination, { recursive: true, force, errorOnExist: !force });
}

const sharedGuidance = `# QA Agent\n\nAct as a project QA engineer, not a static test-case runner. Use the local \`qa-agent\` runtime and the project's \`.qa-agent/\` memory. For a requested test, understand the business module and role, operate the real browser, simulator, or device yourself, inspect rendered states, capture a screenshot after every real UI action, invoke visual inspection only at adaptive business checkpoints, record expected versus actual results, collect evidence, and complete the run so it writes the final Markdown report.\n\nA user-level installation contains only reusable instructions. Never write, read, merge, or infer project business memory from a global host or user directory. Keep every business rule, credential reference, task, run, screenshot, evidence artifact, report, Operation JSON, and reviewed memory candidate inside the active project's \`.qa-agent/\` boundary.\n\nFor fast regression, use \`qa-agent run replay\` only after the approved Task hash, active Operation JSON, context/version, MCP health, and macOS Screen Recording/Accessibility permissions pass preflight. If a step fails, recover only by waiting, refresh/back, app restart, sandbox reset, MCP reconnect, safe semantic locator fallback, or checkpoint resume; never modify source code, bypass permissions, or fake a result.\n\nDo not ask the user to click through the app, take screenshots, transcribe steps, decide whether the UI passed, or write the report. Ask only for missing credentials, ambiguous business rules, an unavailable required capability, macOS permission approval, or explicit approval for a risky action. Stop before production writes, payments, refunds, deletion, notifications, or permission changes.\n\nStart from \`qa-agent context module <module-id>\` when a module is known. Use \`qa-agent doctor\` to identify missing integrations. Persist agent-driven runs through \`qa-agent run start\` or \`run replay\`, \`run step\`, \`run observe\`, \`run recover\`, and \`run complete\`; each real UI action needs a screenshot, while reports label whether visual inspection was performed. The runtime is host-neutral: use MCP or the host's browser/device tools for real UI interaction, and let \`qa-agent\` retain evidence, reports, and reviewed project memory.\n`;

function cursorRule(): string {
  return `---\ndescription: Execute project-aware visual QA with the local qa-agent runtime, real browser or simulator interaction, screenshot evidence, and automatic reports.\nalwaysApply: false\n---\n\n${sharedGuidance}`;
}

function copilotAgent(): string {
  return `---\nname: QA Agent\ndescription: Plans and executes project-aware visual QA, captures evidence, and produces a final QA report.\ntools:\n  - read\n  - search\n  - edit\n  - terminal\n---\n\n${sharedGuidance}`;
}

function geminiCommand(): string {
  const prompt = sharedGuidance.replace(/`/g, '\\`').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `description = "Execute project-aware visual QA and return the final report"\nprompt = "${prompt}\n\nUser request: {{args}}"\n`;
}

/** Install only host-facing prompts. The QA runtime and data remain host-neutral. */
export function installHostIntegration(options: HostInstallOptions): HostInstallResult {
  const force = Boolean(options.force);
  const scope = options.scope ?? (options.host === 'codex' ? 'user' : 'project');
  if (options.host === 'codex') {
    if (scope !== 'user') throw new Error('Codex integration is user-scoped. For a portable project Skill, install the agents host with --scope project.');
    const parent = options.path ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills');
    const destination = join(parent, 'qa-agent');
    copySkill(destination, force);
    return { host: options.host, paths: [destination], message: 'Installed Codex QA Agent skill.' };
  }

  if (options.host === 'cursor' && scope === 'user') {
    throw new Error('Cursor user Rules are managed as plain text in Cursor Settings > Rules, not as a file-based Skill. Use --scope project for the generated Rule and Command.');
  }
  const project = scope === 'project' ? requireProjectPath(options.projectPath) : undefined;
  if (options.host === 'claude') {
    const destination = scope === 'user' ? join(homedir(), '.claude', 'skills', 'qa-agent') : join(project!, '.claude', 'skills', 'qa-agent');
    copySkill(destination, force);
    return { host: options.host, paths: [destination], message: 'Installed Claude Code-compatible QA Agent skill.' };
  }
  if (options.host === 'opencode') {
    const destination = scope === 'user' ? join(homedir(), '.config', 'opencode', 'skills', 'qa-agent') : join(project!, '.opencode', 'skills', 'qa-agent');
    copySkill(destination, force);
    return { host: options.host, paths: [destination], message: 'Installed OpenCode QA Agent skill.' };
  }
  if (options.host === 'agents') {
    const destination = scope === 'user' ? join(homedir(), '.agents', 'skills', 'qa-agent') : join(project!, '.agents', 'skills', 'qa-agent');
    copySkill(destination, force);
    return { host: options.host, paths: [destination], message: 'Installed portable Agent Skills QA package.' };
  }
  if (options.host === 'cursor') {
    const rule = join(project!, '.cursor', 'rules', 'qa-agent.mdc');
    const command = join(project!, '.cursor', 'commands', 'qa-agent.md');
    assertWritableTargets([rule, command], force);
    writeTextAtomic(rule, cursorRule());
    writeTextAtomic(command, sharedGuidance);
    return { host: options.host, paths: [rule, command], message: 'Installed Cursor QA Agent rule and slash command.' };
  }
  if (options.host === 'copilot') {
    const skill = scope === 'user' ? join(homedir(), '.copilot', 'skills', 'qa-agent') : join(project!, '.github', 'skills', 'qa-agent');
    const agent = scope === 'user' ? join(homedir(), '.copilot', 'agents', 'qa-agent.agent.md') : join(project!, '.github', 'agents', 'qa-agent.agent.md');
    assertWritableTargets([skill, agent], force);
    copySkill(skill, force);
    writeTextAtomic(agent, copilotAgent());
    return { host: options.host, paths: [skill, agent], message: 'Installed GitHub Copilot QA skill and custom agent.' };
  }
  if (options.host === 'gemini') {
    const command = scope === 'user' ? join(homedir(), '.gemini', 'commands', 'qa-agent.toml') : join(project!, '.gemini', 'commands', 'qa-agent.toml');
    assertWritableTargets([command], force);
    writeTextAtomic(command, geminiCommand());
    return { host: options.host, paths: [command], message: 'Installed Gemini CLI /qa-agent command. Run /commands reload in Gemini CLI.' };
  }
  throw new Error(`Unsupported host: ${options.host}`);
}
