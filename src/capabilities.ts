import { existsSync } from 'node:fs';
import { qaPath } from './project.ts';
import { readJson } from './store.ts';
import type { CapabilityStatus, ExecutionSnapshot, PermissionStatus } from './types.ts';

export function availableCapabilities(root: string): string[] {
  const configured = readJson<{ capabilities?: string[] }>(qaPath(root, 'capabilities.json')).capabilities ?? [];
  const mcp = readJson<{ connections?: Array<{ status?: string; capabilities?: string[] }> }>(qaPath(root, 'mcp.json')).connections ?? [];
  const connected = mcp.filter(item => item.status === 'connected').flatMap(item => item.capabilities ?? []);
  const local = existsSync(qaPath(root, 'adapters', 'playwright.json')) ? ['browser.interact', 'browser.inspect'] : [];
  return [...new Set([...configured, ...connected, ...local])].sort();
}

export function checkCapabilities(root: string, required: string[], optional: string[] = []): CapabilityStatus {
  const available = availableCapabilities(root);
  const missing = required.filter(item => !available.includes(item));
  return { available, missing, optionalMissing: optional.filter(item => !available.includes(item)) };
}

export function capabilitySnapshot(root: string, platform: string): Pick<ExecutionSnapshot, 'mcpSnapshot' | 'permissionSnapshot'> {
  const configured = readJson<{ capabilities?: string[] }>(qaPath(root, 'capabilities.json')).capabilities ?? [];
  const connections = readJson<{ connections?: Array<{ id: string; status: string; capabilities: string[]; version?: string; permissionStatus?: PermissionStatus }> }>(qaPath(root, 'mcp.json')).connections ?? [];
  const localAdapter = existsSync(qaPath(root, 'adapters', 'playwright.json'));
  const mcpSnapshot = connections.map(item => ({ id: item.id, status: item.status, capabilities: item.capabilities ?? [], version: item.version, permissionStatus: item.permissionStatus ?? 'unknown' as PermissionStatus }));
  if (localAdapter) mcpSnapshot.push({ id: 'local-playwright', status: 'connected', capabilities: ['browser.interact', 'browser.inspect'], version: 'local', permissionStatus: 'verified' });
  const required = platformCapabilities(platform);
  const relevant = mcpSnapshot.filter(item => item.status === 'connected' && required.some(capability => item.capabilities.includes(capability)));
  const permissionStatus: PermissionStatus = platform === 'web' && localAdapter ? 'verified' : relevant.length === 0 ? 'unknown' : relevant.every(item => item.permissionStatus === 'verified') ? 'verified' : relevant.some(item => item.permissionStatus === 'missing') ? 'missing' : 'unknown';
  return { mcpSnapshot, permissionSnapshot: { status: permissionStatus, permissions: [
    { name: 'Screen Recording', status: permissionStatus, detail: 'Required for screenshots and visual evidence.' },
    { name: 'Accessibility', status: permissionStatus, detail: 'Required for UI interaction and simulator control.' },
    ...(platform === 'ios' ? [{ name: 'iOS Simulator automation', status: permissionStatus, detail: 'Required for iOS simulator interaction.' }] : []),
  ] } };
}

export function capabilityAdvice(missing: string[]): string[] {
  return missing.map(capability => {
    if (capability.startsWith('browser.')) return `${capability}: connect Playwright/browser MCP or configure a project browser adapter.`;
    if (capability === 'android.adb' || capability === 'android.screenshot') return `${capability}: APP testing requires an Android emulator/device MCP with ADB interaction and screenshot capture. Ask the user to approve connecting or installing the least-privilege Android MCP; do not install automatically.`;
    if (capability.startsWith('ios.')) return `${capability}: APP testing requires an iOS Simulator/Appium MCP with interaction and screenshot capture. Ask the user to approve connecting or installing the least-privilege iOS MCP; do not install automatically.`;
    return `${capability}: connect a least-privilege project MCP or local adapter.`;
  });
}

export function platformCapabilities(platform: string): string[] {
  if (platform === 'android') return ['android.adb', 'android.screenshot'];
  if (platform === 'ios') return ['ios.simulator.interact', 'ios.screenshot'];
  return platform === 'web' ? ['browser.interact', 'browser.inspect'] : [];
}

export function mobileCapabilityDiagnosis(root: string, platform: string): object {
  if (!['android', 'ios'].includes(platform)) throw new Error('--platform must be android or ios.');
  const required = platformCapabilities(platform);
  const status = checkCapabilities(root, required);
  const connectionExample = platform === 'android'
    ? 'qa-agent mcp add android-emulator --capabilities android.adb,android.screenshot --readonly'
    : 'qa-agent mcp add ios-simulator --capabilities ios.simulator.interact,ios.screenshot --readonly';
  const snapshot = capabilitySnapshot(root, platform);
  const permissionStatus = snapshot.permissionSnapshot.status;
  return {
    platform, ready: status.missing.length === 0 && permissionStatus === 'verified', requiredCapabilities: required, available: status.available, missing: status.missing, permissionStatus,
    userDecisionRequired: status.missing.length > 0 || permissionStatus !== 'verified',
    macOSPermissions: ['Screen Recording (for screenshots/visual evidence)', 'Accessibility (for UI interaction)', ...(platform === 'ios' ? ['Developer Mode / Simulator automation where required'] : [])],
    permissionNote: 'The runtime cannot grant macOS permissions. Ask the user to approve them in System Settings → Privacy & Security, then rerun this doctor check.',
    requestToUser: status.missing.length || permissionStatus !== 'verified' ? `APP testing needs an approved least-privilege ${platform === 'android' ? 'Android Emulator/ADB' : 'iOS Simulator/Appium'} MCP with interaction and screenshot access, plus verified macOS permissions.` : undefined,
    nextSteps: status.missing.length || permissionStatus !== 'verified' ? [`Ask the user to approve connecting or installing the MCP.`, `Ask the user to grant Screen Recording and Accessibility permissions in macOS System Settings → Privacy & Security.`, connectionExample, `qa-agent mcp activate ${platform === 'android' ? 'android-emulator' : 'ios-simulator'} --permissions verified`, `qa-agent mobile doctor --platform ${platform}`] : ['Mobile capability preflight passed; start an Agent-guided Run.'],
  };
}
