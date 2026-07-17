import { qaPath } from './project.ts';
import { readJson } from './store.ts';
import type { CapabilityStatus, ExecutionSnapshot, PermissionStatus } from './types.ts';

type HostConnection = { id: string; status: 'available' | 'unavailable'; capabilities: string[]; version?: string; permissionStatus?: PermissionStatus };

export function availableCapabilities(root: string): string[] {
  const connections = readJson<{ connections?: HostConnection[] }>(qaPath(root, 'mcp.json')).connections ?? [];
  const attested = connections.filter(item => item.status === 'available').flatMap(item => item.capabilities ?? []);
  return [...new Set(attested)].sort();
}

export function checkCapabilities(root: string, required: string[], optional: string[] = []): CapabilityStatus {
  const available = availableCapabilities(root);
  const missing = required.filter(item => !available.includes(item));
  return { available, missing, optionalMissing: optional.filter(item => !available.includes(item)) };
}

export function capabilitySnapshot(root: string, platform: string): Pick<ExecutionSnapshot, 'mcpSnapshot' | 'permissionSnapshot'> {
  const connections = readJson<{ connections?: HostConnection[] }>(qaPath(root, 'mcp.json')).connections ?? [];
  const mcpSnapshot = connections.map(item => ({ id: item.id, status: item.status, capabilities: item.capabilities ?? [], version: item.version, permissionStatus: item.permissionStatus ?? 'unknown' as PermissionStatus }));
  const required = platformCapabilities(platform);
  const relevant = mcpSnapshot.filter(item => item.status === 'available' && required.some(capability => item.capabilities.includes(capability)));
  const permissionStatus: PermissionStatus = relevant.length === 0 ? 'unknown' : relevant.every(item => item.permissionStatus === 'verified') ? 'verified' : relevant.some(item => item.permissionStatus === 'missing') ? 'missing' : 'unknown';
  return { mcpSnapshot, permissionSnapshot: { status: permissionStatus, permissions: [
    { name: 'Screen Recording', status: permissionStatus, detail: 'Required for screenshots and visual evidence.' },
    { name: 'Accessibility', status: permissionStatus, detail: 'Required for UI interaction and simulator control.' },
    ...(platform === 'ios' ? [{ name: 'iOS Simulator automation', status: permissionStatus, detail: 'Required for iOS simulator interaction.' }] : []),
  ] } };
}

export function capabilityAdvice(missing: string[]): string[] {
  return missing.map(capability => {
    if (capability.startsWith('browser.')) return `${capability}: have the host Agent attach a browser-tool capability snapshot.`;
    if (capability === 'android.adb' || capability === 'android.screenshot') return `${capability}: have the host Agent attach an Android emulator/device capability snapshot after user approval.`;
    if (capability.startsWith('ios.')) return `${capability}: have the host Agent attach an iOS Simulator/Appium capability snapshot after user approval.`;
    return `${capability}: have the host Agent attach an available capability snapshot.`;
  });
}

export function platformCapabilities(platform: string): string[] {
  if (platform === 'android') return ['android.adb', 'android.screenshot'];
  if (platform === 'ios') return ['ios.simulator.interact', 'ios.screenshot'];
  return platform === 'web' ? ['browser.interact', 'browser.inspect'] : [];
}

export function hostCapabilityDiagnosis(root: string, platform: string): object {
  if (!['android', 'ios'].includes(platform)) throw new Error('--platform must be android or ios.');
  const required = platformCapabilities(platform);
  const status = checkCapabilities(root, required);
  const snapshot = capabilitySnapshot(root, platform);
  const permissionStatus = snapshot.permissionSnapshot.status;
  return {
    platform, ready: status.missing.length === 0 && permissionStatus === 'verified', requiredCapabilities: required, available: status.available, missing: status.missing, permissionStatus,
    userDecisionRequired: status.missing.length > 0 || permissionStatus !== 'verified',
    macOSPermissions: ['Screen Recording (for screenshots/visual evidence)', 'Accessibility (for UI interaction)', ...(platform === 'ios' ? ['Developer Mode / Simulator automation where required'] : [])],
    permissionNote: 'The runtime cannot grant or verify macOS permissions. The host Agent must submit a fresh capability snapshot after the user grants them.',
    requestToUser: status.missing.length || permissionStatus !== 'verified' ? `APP testing needs an approved least-privilege ${platform === 'android' ? 'Android Emulator/ADB' : 'iOS Simulator/Appium'} MCP with interaction and screenshot access, plus verified macOS permissions.` : undefined,
    nextSteps: status.missing.length || permissionStatus !== 'verified' ? [`Ask the user to approve connecting or installing the MCP.`, `Ask the user to grant Screen Recording and Accessibility permissions in macOS System Settings → Privacy & Security.`, `Have the host Agent import its fresh capability snapshot with qa-agent host import --file <snapshot.json>.`, `qa-agent host doctor --platform ${platform}`] : ['Mobile capability preflight passed; start an Agent-guided Run.'],
  };
}
