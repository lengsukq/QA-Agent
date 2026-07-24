import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { qaPath } from './project.ts';
import { resolveRunner, resolvePython } from './runner-path.ts';
import { assertSupportedPlatform, isSupportedPlatform, platformMismatchAdvice, SUPPORTED_PLATFORMS, type SupportedPlatform } from './platform.ts';
import { readJson } from './store.ts';
import type { CapabilityStatus, ExecutionSnapshot, PermissionStatus } from './types.ts';

type HostConnection = { id: string; status: 'available' | 'unavailable'; capabilities: string[]; version?: string; permissionStatus?: PermissionStatus };
export { assertSupportedPlatform, isSupportedPlatform, platformMismatchAdvice, SUPPORTED_PLATFORMS } from './platform.ts';
export type { SupportedPlatform } from './platform.ts';

function localRunnerCapabilities(root: string): string[] {
  const diagnosis = runnerDiagnosis(root);
  const capabilities: string[] = [];
  if (diagnosis.adapters.web.available) capabilities.push('browser.interact', 'browser.inspect');
  if (diagnosis.adapters.ios.available) capabilities.push('ios.simulator.interact', 'ios.screenshot');
  return capabilities;
}

export function availableCapabilities(root: string): string[] {
  // mcp.json is retained as compatibility data only. It must never satisfy
  // an execution capability or allow a UI run to bypass the local Runner.
  return [...new Set(localRunnerCapabilities(root))].sort();
}

export function checkCapabilities(root: string, required: string[], optional: string[] = []): CapabilityStatus {
  const available = availableCapabilities(root);
  const missing = required.filter(item => !available.includes(item));
  return { available, missing, optionalMissing: optional.filter(item => !available.includes(item)) };
}

export function capabilitySnapshot(root: string, platform: string): Pick<ExecutionSnapshot, 'mcpSnapshot' | 'permissionSnapshot'> {
  assertSupportedPlatform(platform);
  const connections = readJson<{ connections?: HostConnection[] }>(qaPath(root, 'mcp.json')).connections ?? [];
  const mcpSnapshot = connections.map(item => ({ id: item.id, status: item.status, capabilities: item.capabilities ?? [], version: item.version, permissionStatus: item.permissionStatus ?? 'unknown' as PermissionStatus }));
  const required = platformCapabilities(platform);
  const localReady = localRunnerCapabilities(root).some(capability => required.includes(capability));
  const permissionStatus: PermissionStatus = localReady ? 'verified' : 'missing';
  return { mcpSnapshot, permissionSnapshot: { status: permissionStatus, permissions: [
    { name: 'Screen Recording', status: permissionStatus, detail: 'Required for screenshots and visual evidence.' },
    { name: 'Accessibility', status: permissionStatus, detail: 'Required for UI interaction and simulator control.' },
    ...(platform === 'ios' ? [{ name: 'iOS Simulator automation', status: permissionStatus, detail: 'Required for iOS simulator interaction.' }] : []),
  ] } };
}

export function capabilityAdvice(missing: string[]): string[] {
  return missing.map(capability => {
    if (capability.startsWith('browser.')) return `${capability}: install Python Playwright and ensure the packaged QA Agent Runner is available; execute through qa-agent act.`;
    if (capability.startsWith('ios.')) return `${capability}: ensure Python, xcrun simctl, idb, a booted iOS Simulator, and the packaged QA Agent Runner are available; execute through qa-agent act.`;
    return `${capability}: this capability is not supported by the built-in Web/iOS Runner.`;
  });
}

export function platformCapabilities(platform: string): string[] {
  if (platform === 'ios') return ['ios.simulator.interact', 'ios.screenshot'];
  if (platform === 'web') return ['browser.interact', 'browser.inspect'];
  return [];
}

export function hostCapabilityDiagnosis(root: string, platform: string): object {
  assertSupportedPlatform(platform);
  const required = platformCapabilities(platform);
  const status = checkCapabilities(root, required);
  const snapshot = capabilitySnapshot(root, platform);
  const permissionStatus = snapshot.permissionSnapshot.status;
  return {
    platform, ready: status.missing.length === 0 && permissionStatus === 'verified', requiredCapabilities: required, available: status.available, missing: status.missing, permissionStatus,
    userDecisionRequired: status.missing.length > 0 || permissionStatus !== 'verified',
    macOSPermissions: platform === 'ios' ? ['Developer Mode / Simulator automation where required'] : [],
    permissionNote: 'The built-in Runner owns UI execution. Resolve local simulator/browser permissions and rerun Doctor; do not attach an MCP or call external UI tools.',
    requestToUser: status.missing.length || permissionStatus !== 'verified' ? `${platform} execution requires the built-in QA Agent Runner and its local adapter prerequisites.` : undefined,
    nextSteps: status.missing.length || permissionStatus !== 'verified' ? [`Run qa-agent doctor --platforms ${platform}.`, `Install or enable only the missing local Runner prerequisite reported by Doctor.`, `Rerun qa-agent doctor --platforms ${platform}.`] : ['Built-in Runner preflight passed; start qa-agent test and use qa-agent act for every UI action.'],
  };
}

export interface RunnerDiagnosis {
  python3: { available: boolean; version?: string };
  playwright: { available: boolean };
  xcrun: { available: boolean };
  simctl: { available: boolean; booted: boolean };
  idb: { available: boolean };
  idbCompanion: { available: boolean };
  runnerDir: { available: boolean; path?: string; source?: string; error?: string };
  adapters: { web: { available: boolean; missing: string[] }; ios: { available: boolean; missing: string[] } };
}

/**
 * Check local runner environment: python3, playwright, idb, runner directory.
 */
export function runnerDiagnosis(root: string): RunnerDiagnosis {
  const check = (cmd: string, args: string[]): string | undefined => {
    try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return undefined; }
  };
  const command = process.platform === 'win32' ? 'where' : 'which';

  const python = resolvePython(root);
  const pythonVersion = check(python, ['--version']);
  const playwrightCheck = check(python, ['-c', 'import playwright; print(getattr(playwright, "__version__", "available"))']);
  const xcrunCheck = check('xcrun', ['--find', 'simctl']);
  const idbCheck = check(command, ['idb']);
  const idbCompanionCheck = check(command, ['idb_companion']);
  const simctlDevices = xcrunCheck ? check('xcrun', ['simctl', 'list', 'devices', '--json']) : undefined;
  const runner = resolveRunner(root);
  const webMissing = [!runner.available ? 'runner' : '', !pythonVersion ? 'python3' : '', !playwrightCheck ? 'playwright' : ''].filter(Boolean);
  const simctlBooted = Boolean(simctlDevices && /"state"\s*:\s*"Booted"/i.test(simctlDevices));
  const iosMissing = [!runner.available ? 'runner' : '', !pythonVersion ? 'python3' : '', !xcrunCheck ? 'xcrun simctl' : '', !idbCheck ? 'idb' : '', !idbCompanionCheck ? 'idb_companion' : '', !simctlBooted ? 'booted-simulator' : ''].filter(Boolean);

  return {
    python3: { available: !!pythonVersion, version: pythonVersion?.replace('Python ', '') },
    playwright: { available: !!playwrightCheck },
    xcrun: { available: !!xcrunCheck },
    simctl: { available: !!simctlDevices, booted: simctlBooted },
    idb: { available: !!idbCheck },
    idbCompanion: { available: !!idbCompanionCheck },
    runnerDir: { available: runner.available, path: runner.path, source: runner.source, error: runner.error },
    adapters: { web: { available: webMissing.length === 0, missing: webMissing }, ios: { available: iosMissing.length === 0, missing: iosMissing } },
  };
}
