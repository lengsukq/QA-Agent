import { existsSync } from 'node:fs';
import { qaPath } from './project.ts';
import { readJson } from './store.ts';
import type { CapabilityStatus } from './types.ts';

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
  return {
    platform, ready: status.missing.length === 0, requiredCapabilities: required, available: status.available, missing: status.missing,
    userDecisionRequired: status.missing.length > 0,
    requestToUser: status.missing.length ? `APP testing needs an approved least-privilege ${platform === 'android' ? 'Android Emulator/ADB' : 'iOS Simulator/Appium'} MCP with interaction and screenshot access.` : undefined,
    nextSteps: status.missing.length ? [`Ask the user to approve connecting or installing the MCP.`, connectionExample, `qa-agent mcp activate ${platform === 'android' ? 'android-emulator' : 'ios-simulator'}`, `qa-agent mobile doctor --platform ${platform}`] : ['Mobile capability preflight passed; start an Agent-guided Run.'],
  };
}
