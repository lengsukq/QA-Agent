import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve the runner shipped with the current source or compiled package. */
export function bundledRunnerDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runner');
}

/**
 * Resolve the runner used by an initialized project.
 *
 * The managed copy is authoritative after `qa-agent init` or `update`.
 * The project-root fallback exists only for repository development and tests.
 */
export function projectRunnerDir(root: string): string {
  const managed = join(root, '.qa-agent', 'runner');
  if (existsSync(join(managed, 'qa_agent_runner'))) return managed;

  const development = join(root, 'runner');
  if (resolve(development) === resolve(bundledRunnerDir()) && existsSync(join(development, 'qa_agent_runner'))) return development;

  return managed;
}
