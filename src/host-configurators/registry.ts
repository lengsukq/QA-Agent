import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type HostId = 'codex' | 'claude' | 'cursor' | 'opencode' | 'copilot' | 'gemini' | 'agents';
export type InstallScope = 'project' | 'user';
export type InjectionMode = 'skill' | 'rule-command' | 'command' | 'skill-agent';

export interface HostPlatformConfig {
  id: HostId;
  name: string;
  cliFlag: string;
  configDir: string;
  supportsSharedAgentsSkills: boolean;
  managedPaths: string[];
  injectionMode: InjectionMode;
  templateContext: { commandPrefix: string; userActionLabel: string; supportsSubAgents: boolean; supportsHooks: boolean };
}

export interface ConfigureOptions {
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

export interface HostConfigurator {
  configure(options: ConfigureOptions): HostInstallResult;
  collectManagedTemplates(): Map<string, string>;
  detect(projectRoot: string): boolean;
}

export const HOST_PLATFORMS: Record<HostId, HostPlatformConfig> = {
  codex: { id: 'codex', name: 'Codex', cliFlag: 'codex', configDir: '.codex', supportsSharedAgentsSkills: true, managedPaths: ['.codex/skills/qa-agent', '.agents/skills/qa-agent'], injectionMode: 'skill', templateContext: { commandPrefix: '$', userActionLabel: 'Skills', supportsSubAgents: true, supportsHooks: false } },
  cursor: { id: 'cursor', name: 'Cursor', cliFlag: 'cursor', configDir: '.cursor', supportsSharedAgentsSkills: false, managedPaths: ['.cursor/rules/qa-agent.mdc', '.cursor/commands/qa-agent.md', '.cursor/skills/qa-agent'], injectionMode: 'rule-command', templateContext: { commandPrefix: '/qa-agent', userActionLabel: 'Commands', supportsSubAgents: true, supportsHooks: false } },
  claude: { id: 'claude', name: 'Claude Code', cliFlag: 'claude', configDir: '.claude', supportsSharedAgentsSkills: false, managedPaths: ['.claude/skills/qa-agent', '.claude/commands/qa-agent.md'], injectionMode: 'skill-agent', templateContext: { commandPrefix: '/qa-agent', userActionLabel: 'Skills', supportsSubAgents: true, supportsHooks: false } },
  opencode: { id: 'opencode', name: 'OpenCode', cliFlag: 'opencode', configDir: '.opencode', supportsSharedAgentsSkills: false, managedPaths: ['.opencode/skills/qa-agent', '.opencode/commands/qa-agent.md'], injectionMode: 'skill-agent', templateContext: { commandPrefix: '/qa-agent', userActionLabel: 'Skills', supportsSubAgents: true, supportsHooks: false } },
  copilot: { id: 'copilot', name: 'GitHub Copilot', cliFlag: 'copilot', configDir: '.github', supportsSharedAgentsSkills: false, managedPaths: ['.github/skills/qa-agent', '.github/agents/qa-agent.agent.md', '.github/prompts/qa-agent.prompt.md'], injectionMode: 'skill-agent', templateContext: { commandPrefix: '/qa-agent', userActionLabel: 'Custom Agent', supportsSubAgents: true, supportsHooks: false } },
  gemini: { id: 'gemini', name: 'Gemini CLI', cliFlag: 'gemini', configDir: '.gemini', supportsSharedAgentsSkills: true, managedPaths: ['.gemini/commands/qa-agent.toml', '.agents/skills/qa-agent'], injectionMode: 'command', templateContext: { commandPrefix: '/qa-agent', userActionLabel: 'Commands', supportsSubAgents: true, supportsHooks: false } },
  agents: { id: 'agents', name: 'Agent Skills', cliFlag: 'agents', configDir: '.agents', supportsSharedAgentsSkills: true, managedPaths: ['.agents/skills/qa-agent'], injectionMode: 'skill', templateContext: { commandPrefix: '$', userActionLabel: 'Skills', supportsSubAgents: true, supportsHooks: false } },
};

export const supportedHosts = Object.keys(HOST_PLATFORMS) as HostId[];

export function hostConfig(host: HostId): HostPlatformConfig { return HOST_PLATFORMS[host]; }
export function hostsFromFlags(args: string[]): HostId[] { return supportedHosts.filter(host => args.includes(`--${HOST_PLATFORMS[host].cliFlag}`)); }
export function detectConfiguredHosts(projectRoot: string): HostId[] {
  return supportedHosts.filter(host => existsSync(join(projectRoot, HOST_PLATFORMS[host].managedPaths[0]!)));
}
