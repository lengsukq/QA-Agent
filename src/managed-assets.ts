import { cpSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { builtInSkills } from './built-in-skills.ts';
import { schemas } from './schemas.ts';
import { listFiles, now, readJson, writeJsonAtomic } from './store.ts';
import { QA_AGENT_VERSION } from './version.ts';

export interface ManagedAssetSyncResult {
  synchronizedSchemas: number;
  synchronizedBuiltInSkills: number;
  synchronizedRunner: boolean;
  updatedProjectVersion: number;
}

function skillFileName(name: string): string {
  return `${name.replace(/\./g, '-')}.json`;
}

function skillIndexEntries(): Array<Record<string, unknown>> {
  return builtInSkills.map(skill => ({
    name: skill.metadata.name,
    version: skill.metadata.version,
    description: skill.metadata.description,
    lifecycle: skill.metadata.lifecycle,
    path: `skills/built-in/${skillFileName(skill.metadata.name)}`,
    capabilities: skill.requirements.capabilities,
  }));
}

export function assertManagedRuntimeVersion(qaRoot: string): { initializedAt?: string; version?: string } | undefined {
  const versionPath = join(qaRoot, '.version');
  const existing = existsSync(versionPath) ? readJson<{ initializedAt?: string; version?: string }>(versionPath) : undefined;
  if (existing?.version && existing.version !== QA_AGENT_VERSION) {
    throw new Error(`Project Runtime version ${existing.version} is not supported by ${QA_AGENT_VERSION}. Remove .qa-agent and run qa-agent init to create a fresh project.`);
  }
  return existing;
}

export function syncManagedRuntimeAssets(qaRoot: string): ManagedAssetSyncResult {
  const existing = assertManagedRuntimeVersion(qaRoot);
  const result: ManagedAssetSyncResult = {
    synchronizedSchemas: 0,
    synchronizedBuiltInSkills: 0,
    synchronizedRunner: false,
    updatedProjectVersion: existing?.version === QA_AGENT_VERSION ? 0 : 1,
  };

  const schemaDirectory = join(qaRoot, 'schemas');
  for (const [name, schema] of Object.entries(schemas)) {
    writeJsonAtomic(join(schemaDirectory, name), schema);
    result.synchronizedSchemas += 1;
  }

  const skillDirectory = join(qaRoot, 'skills', 'built-in');
  for (const skill of builtInSkills) {
    writeJsonAtomic(join(skillDirectory, skillFileName(skill.metadata.name)), skill);
    result.synchronizedBuiltInSkills += 1;
  }

  writeJsonAtomic(join(qaRoot, 'index', 'skills.json'), {
    version: 1,
    updatedAt: now(),
    skills: skillIndexEntries(),
  });
  writeJsonAtomic(join(qaRoot, '.version'), {
    version: QA_AGENT_VERSION,
    initializedAt: existing?.initializedAt ?? now(),
    updatedAt: now(),
  });

  // Sync runner directory if available
  result.synchronizedRunner = syncRunnerAssets(qaRoot);

  return result;
}

function syncRunnerAssets(qaRoot: string): boolean {
  // Find runner source: either bundled with npm package or dev layout
  const packageRoot = resolve(qaRoot, '..');
  const devRunner = join(packageRoot, 'runner');
  const bundledRunner = join(packageRoot, 'runner'); // same in dev
  const source = existsSync(join(devRunner, 'qa_agent_runner')) ? devRunner : undefined;
  if (!source) return false;

  const target = join(qaRoot, 'runner');
  try {
    cpSync(source, target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function inspectManagedRuntimeAssets(qaRoot: string): string[] {
  const errors: string[] = [];
  const versionPath = join(qaRoot, '.version');
  if (!existsSync(versionPath)) errors.push(`${versionPath}: missing managed version file.`);
  else {
    try {
      const version = readJson<{ version?: string }>(versionPath).version;
      if (version !== QA_AGENT_VERSION) errors.push(`${versionPath}: project Runtime version ${version ?? 'missing'} is not supported by ${QA_AGENT_VERSION}; remove .qa-agent and run qa-agent init.`);
    } catch (error) {
      errors.push(`${versionPath}: ${(error as Error).message}`);
    }
  }

  const schemaDirectory = join(qaRoot, 'schemas');
  const expectedSchemas = new Set(Object.keys(schemas));
  for (const [name, schema] of Object.entries(schemas)) {
    const path = join(schemaDirectory, name);
    if (!existsSync(path)) errors.push(`${path}: managed Schema is missing.`);
    else {
      try { if (!sameJson(readJson<unknown>(path), schema)) errors.push(`${path}: managed Schema is stale; run qa-agent update.`); }
      catch (error) { errors.push(`${path}: ${(error as Error).message}`); }
    }
  }
  for (const path of listFiles(schemaDirectory, item => item.endsWith('.json'))) {
    if (!expectedSchemas.has(basename(path))) errors.push(`${path}: unsupported managed Schema is present; create a fresh .qa-agent project.`);
  }

  const skillDirectory = join(qaRoot, 'skills', 'built-in');
  const expectedSkills = new Set(builtInSkills.map(skill => skillFileName(skill.metadata.name)));
  for (const skill of builtInSkills) {
    const path = join(skillDirectory, skillFileName(skill.metadata.name));
    if (!existsSync(path)) errors.push(`${path}: managed built-in Skill is missing.`);
    else {
      try { if (!sameJson(readJson<unknown>(path), skill)) errors.push(`${path}: managed built-in Skill is stale; run qa-agent update.`); }
      catch (error) { errors.push(`${path}: ${(error as Error).message}`); }
    }
  }
  for (const path of listFiles(skillDirectory, item => item.endsWith('.json'))) {
    if (!expectedSkills.has(basename(path))) errors.push(`${path}: unsupported managed built-in Skill is present; create a fresh .qa-agent project.`);
  }

  const indexPath = join(qaRoot, 'index', 'skills.json');
  if (!existsSync(indexPath)) errors.push(`${indexPath}: managed Skill index is missing.`);
  else {
    try {
      const actual = readJson<{ skills?: Array<Record<string, unknown>> }>(indexPath).skills ?? [];
      const byName = (items: Array<Record<string, unknown>>): Array<Record<string, unknown>> => [...items].sort((left, right) => String(left.name).localeCompare(String(right.name)));
      if (!sameJson(byName(actual), byName(skillIndexEntries()))) errors.push(`${indexPath}: managed Skill index is stale; run qa-agent update.`);
    } catch (error) {
      errors.push(`${indexPath}: ${(error as Error).message}`);
    }
  }
  return errors;
}
