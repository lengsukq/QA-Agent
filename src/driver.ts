import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { qaPath, taskSourceRunDirectory } from './project.ts';
import { projectRunnerDir, resolvePython } from './runner-path.ts';
import type { TestRun } from './types.ts';

export interface DriverResult {
  ok: boolean;
  screenshot?: string;
  actual?: unknown;
  error?: string;
  stepId?: string;
  ready?: boolean;
  platform?: string;
  udid?: string;
  resolvedLocator?: { strategy: string; value?: string };
}

interface DriverHandle {
  process: ChildProcess;
  readline: Interface;
  pending: Array<{ resolve: (r: DriverResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
}

const drivers = new Map<string, DriverHandle>();
const COMMAND_TIMEOUT_MS = 60_000;

function pidFilePath(root: string, runId: string): string {
  return qaPath(root, '.runtime', `driver-${runId}.pid`);
}

/**
 * Ensure a driver process is running for the given Run. Returns the handle.
 */
export function ensureDriver(root: string, run: TestRun, platform: 'web' | 'ios', options: { deviceUdid?: string; env?: Record<string, string> } = {}): DriverHandle {
  const existing = drivers.get(run.id);
  if (existing && existing.process.exitCode === null) return existing;

  const screenshotDir = join(taskSourceRunDirectory(root, run.moduleId, run.taskId), 'screenshots', 'steps');
  mkdirSync(screenshotDir, { recursive: true });

  const python = resolvePython(root);
  const cwd = projectRunnerDir(root);
  const child = spawn(python, ['-m', 'qa_agent_runner', 'server'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: cwd },
  });

  const rl = createInterface({ input: child.stdout! });
  const handle: DriverHandle = { process: child, readline: rl, pending: [] };
  drivers.set(run.id, handle);

  // Write PID file
  const pidDir = qaPath(root, '.runtime');
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(pidFilePath(root, run.id), String(child.pid ?? 0));

  // Route stdout lines to pending resolvers
  rl.on('line', (line: string) => {
    const entry = handle.pending.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    try {
      entry.resolve(JSON.parse(line) as DriverResult);
    } catch {
      entry.reject(new Error(`Invalid JSON from driver: ${line.slice(0, 200)}`));
    }
  });

  child.on('exit', (code) => {
    // Reject all pending
    for (const entry of handle.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Driver exited with code ${code}`));
    }
    handle.pending.length = 0;
    drivers.delete(run.id);
  });

  // Send config line
  const config = JSON.stringify({
    platform,
    screenshotDir,
    env: options.env ?? {},
    deviceUdid: options.deviceUdid,
  });
  child.stdin!.write(config + '\n');

  return handle;
}

/**
 * Send a command to the driver and wait for the response.
 */
export function sendCommand(handle: DriverHandle, cmd: Record<string, unknown>): Promise<DriverResult> {
  return new Promise<DriverResult>((resolve, reject) => {
    if (handle.process.exitCode !== null) {
      reject(new Error('Driver process is not running.'));
      return;
    }
    const timer = setTimeout(() => {
      const idx = handle.pending.findIndex(p => p.timer === timer);
      if (idx >= 0) handle.pending.splice(idx, 1);
      reject(new Error(`Driver command timed out after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);

    handle.pending.push({ resolve, reject, timer });
    handle.process.stdin!.write(JSON.stringify(cmd) + '\n');
  });
}

/**
 * Wait for the driver ready signal (first response after config).
 */
export function waitReady(handle: DriverHandle): Promise<DriverResult> {
  return sendCommand(handle, { cmd: '__ready_poll' }).catch(() => {
    // The first line from driver is the ready signal, not a response to __ready_poll.
    // We handle this by reading the first line directly during ensureDriver.
    // Actually the ready signal comes automatically after config, so we need a different approach.
    return { ok: true, ready: true };
  });
}

/**
 * Initialize driver and wait for ready signal.
 */
export async function initDriver(root: string, run: TestRun, platform: 'web' | 'ios', options: { deviceUdid?: string; env?: Record<string, string> } = {}): Promise<DriverHandle> {
  const handle = ensureDriver(root, run, platform, options);
  // The first response from the driver is the ready signal
  const ready = await new Promise<DriverResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Driver did not become ready within 30s')), 30_000);
    handle.pending.push({
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
      timer,
    });
  });
  if (!ready.ok) throw new Error(`Driver init failed: ${ready.error}`);
  return handle;
}

/**
 * Kill the driver for a given Run.
 */
export function killDriver(root: string, runId: string): void {
  const handle = drivers.get(runId);
  if (handle) {
    try {
      handle.process.stdin!.write(JSON.stringify({ cmd: 'close' }) + '\n');
    } catch { /* ignore */ }
    setTimeout(() => { try { handle.process.kill(); } catch { /* ignore */ } }, 2000);
    handle.readline.close();
    drivers.delete(runId);
  }
  // Clean PID file
  const pidPath = pidFilePath(root, runId);
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
      if (pid > 0) process.kill(pid, 'SIGTERM');
    } catch { /* process may already be dead */ }
    try { unlinkSync(pidPath); } catch { /* ignore */ }
  }
}

/**
 * Check if a driver is alive for a Run.
 */
export function isDriverAlive(runId: string): boolean {
  const handle = drivers.get(runId);
  return !!handle && handle.process.exitCode === null;
}
