import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RunnerSource = 'environment' | 'package' | 'project' | 'development';

export interface RunnerResolution {
  available: boolean;
  path?: string;
  source?: RunnerSource;
  error?: string;
}

function isRunnerDir(path: string): boolean {
  return existsSync(join(path, 'qa_agent_runner'));
}

/** Resolve the runner shipped with the current source or compiled package. */
export function bundledRunnerDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runner');
}

/**
 * Resolve the Python interpreter for the unified Runner.
 * Priority: QA_AGENT_PYTHON env > .qa-agent/venv/bin/python > python3
 */
export function resolvePython(root: string): string {
  const configured = process.env.QA_AGENT_PYTHON?.trim();
  if (configured) return configured;
  const venvPython = join(root, '.qa-agent', 'venv', 'bin', 'python');
  if (existsSync(venvPython)) return venvPython;
  return 'python3';
}

/** Resolve the Runner once for all UI and replay entry points. */
export function resolveRunner(root: string): RunnerResolution {
  const configured = process.env.QA_AGENT_RUNNER_DIR?.trim();
  if (configured) {
    const path = resolve(configured);
    return isRunnerDir(path)
      ? { available: true, path, source: 'environment' }
      : { available: false, path, source: 'environment', error: `QA_AGENT_RUNNER_DIR does not contain qa_agent_runner: ${path}` };
  }

  const bundled = bundledRunnerDir();
  if (isRunnerDir(bundled)) return { available: true, path: bundled, source: 'package' };

  const managed = join(root, '.qa-agent', 'runner');
  if (isRunnerDir(managed)) return { available: true, path: managed, source: 'project' };

  const development = join(root, 'runner');
  if (resolve(development) === resolve(bundled) && isRunnerDir(development)) return { available: true, path: development, source: 'development' };

  return { available: false, path: bundled, error: `Unified Runner is missing. Install qa-agent with the bundled runner or set QA_AGENT_RUNNER_DIR.` };
}

/**
 * Resolve the runner used by an initialized project.
 *
 * The npm package is authoritative. Existing project copies are retained only
 * as a fallback for local development and explicitly managed project layouts.
 */
export function projectRunnerDir(root: string): string {
  const resolution = resolveRunner(root);
  if (!resolution.available || !resolution.path) throw new Error(resolution.error ?? 'Unified Runner is unavailable.');
  return resolution.path;
}
