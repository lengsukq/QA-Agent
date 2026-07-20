import { existsSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listFiles, readJson, writeJsonAtomic } from './store.ts';
import { HOST_PLATFORMS, supportedHosts, type HostId, type InstallScope } from './host-configurators/registry.ts';
import { agentsConfigurator } from './host-configurators/agents.ts';
import { claudeConfigurator } from './host-configurators/claude.ts';
import { codexConfigurator } from './host-configurators/codex.ts';
import { copilotConfigurator } from './host-configurators/copilot.ts';
import { cursorConfigurator } from './host-configurators/cursor.ts';
import { geminiConfigurator } from './host-configurators/gemini.ts';
import { opencodeConfigurator } from './host-configurators/opencode.ts';

export type { HostId, InstallScope } from './host-configurators/registry.ts';

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

export interface ConfiguredHostRecord { host: HostId; paths: string[]; hashes: Record<string, string>; updatedAt: string }

export { HOST_PLATFORMS, supportedHosts };

export const HOST_CONFIGURATORS = {
  codex: codexConfigurator,
  cursor: cursorConfigurator,
  claude: claudeConfigurator,
  opencode: opencodeConfigurator,
  copilot: copilotConfigurator,
  gemini: geminiConfigurator,
  agents: agentsConfigurator,
} as const;

function hashPath(path: string): string {
  const hash = createHash('sha256');
  if (existsSync(path) && statSync(path).isDirectory()) for (const file of listFiles(path, () => true).sort()) hash.update(file.slice(path.length)).update(readFileSync(file));
  else if (existsSync(path)) hash.update(readFileSync(path));
  return hash.digest('hex');
}

export function recordHostInstall(projectRoot: string, result: HostInstallResult): ConfiguredHostRecord {
  const path = join(projectRoot, '.qa-agent', '.configured-hosts.json');
  const records = existsSync(path) ? readJson<Record<string, ConfiguredHostRecord>>(path) : {};
  const record = { host: result.host, paths: result.paths, hashes: Object.fromEntries(result.paths.map(item => [item, hashPath(item)])), updatedAt: new Date().toISOString() };
  records[result.host] = record; writeJsonAtomic(path, records);
  const templatePath = join(projectRoot, '.qa-agent', '.template-hashes.json');
  const templates = existsSync(templatePath) ? readJson<{ version: number; hashes: Record<string, string> }>(templatePath) : { version: 1, hashes: {} };
  templates.hashes = { ...templates.hashes, ...record.hashes };
  writeJsonAtomic(templatePath, templates);
  return record;
}

export function configuredHostRecords(projectRoot: string): Record<string, ConfiguredHostRecord> {
  const path = join(projectRoot, '.qa-agent', '.configured-hosts.json');
  return existsSync(path) ? readJson<Record<string, ConfiguredHostRecord>>(path) : {};
}

export function updateHostIntegrations(projectRoot: string, options: { force?: boolean; migrate?: boolean } = {}): { updated: string[]; conflicts: Array<{ host: string; paths: string[] }>; skipped: string[] } {
  const records = configuredHostRecords(projectRoot); const updated: string[] = []; const conflicts: Array<{ host: string; paths: string[] }> = []; const skipped: string[] = [];
  for (const [host, record] of Object.entries(records)) {
    const changed = record.paths.filter(path => existsSync(path) && hashPath(path) !== record.hashes[path]);
    if (changed.length && !options.force) { conflicts.push({ host, paths: changed }); continue; }
    if (!supportedHosts.includes(host as HostId)) { skipped.push(host); continue; }
    const result = installHostIntegration({ host: host as HostId, projectPath: projectRoot, scope: 'project', force: true });
    recordHostInstall(projectRoot, result); updated.push(host);
  }
  return { updated, conflicts, skipped };
}

/** Install only host-facing prompts. The QA runtime and data remain host-neutral. */
export function installHostIntegration(options: HostInstallOptions): HostInstallResult {
  return HOST_CONFIGURATORS[options.host].configure(options);
}
