import { spawnSync } from 'node:child_process';
import { qaPath, readProject } from './project.ts';
import { readJson } from './store.ts';
import type { PermissionStatus } from './types.ts';

export type RecommendationLevel = 'recommended' | 'optional';
export type RecommendationStatus = 'available' | 'missing' | 'incompatible' | 'unknown';

export interface CommandProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export type CommandProbe = (command: string, args: string[]) => CommandProbeResult;

export interface RecommendedToolCheck {
  id: string;
  name: string;
  level: RecommendationLevel;
  status: RecommendationStatus;
  version?: string;
  purpose: string;
  installHint?: string;
  detail?: string;
}

export interface RecommendedPlatformStack {
  platform: 'web' | 'ios';
  title: string;
  mandatory: false;
  recommendedReady: boolean;
  tools: RecommendedToolCheck[];
  setupCommands: string[];
  outputContract: string[];
}

export interface RecommendedRegressionStackDiagnosis {
  policy: 'recommended-not-required';
  message: string;
  platforms: RecommendedPlatformStack[];
  unifiedOutput: string[];
  reference: string;
}

type HostConnection = {
  id: string;
  status: 'available' | 'unavailable';
  capabilities: string[];
  version?: string;
  host?: string;
  permissionStatus?: PermissionStatus;
};

const defaultProbe: CommandProbe = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 8000 });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? result.error?.message ?? '',
    exitCode: result.status ?? undefined,
  };
};

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/).map(line => line.trim()).find(Boolean);
}

function commandPath(command: string, probe: CommandProbe): string | undefined {
  const result = probe(process.platform === 'win32' ? 'where' : 'which', [command]);
  return result.ok ? firstLine(result.stdout) : undefined;
}

function commandCheck(input: {
  id: string;
  name: string;
  command: string;
  args?: string[];
  level?: RecommendationLevel;
  purpose: string;
  installHint?: string;
  probe: CommandProbe;
  existenceOnly?: boolean;
}): RecommendedToolCheck {
  const path = commandPath(input.command, input.probe);
  if (!path) return { id: input.id, name: input.name, level: input.level ?? 'recommended', status: 'missing', purpose: input.purpose, installHint: input.installHint };
  if (input.existenceOnly) return { id: input.id, name: input.name, level: input.level ?? 'recommended', status: 'available', purpose: input.purpose, installHint: input.installHint, detail: path };
  const result = input.probe(input.command, input.args ?? ['--version']);
  const version = firstLine(result.stdout || result.stderr);
  return {
    id: input.id,
    name: input.name,
    level: input.level ?? 'recommended',
    status: result.ok ? 'available' : 'unknown',
    version,
    purpose: input.purpose,
    installHint: input.installHint,
    detail: result.ok ? path : result.stderr || `Found at ${path}, but the probe command did not complete successfully.`,
  };
}

function pythonCheck(probe: CommandProbe): { tool: RecommendedToolCheck; command?: string } {
  const candidates = [...new Set([process.env.QA_AGENT_PYTHON, 'python3.12', 'python3'].filter((item): item is string => Boolean(item)))];
  for (const command of candidates) {
    if (!commandPath(command, probe)) continue;
    const result = probe(command, ['--version']);
    const version = firstLine(result.stdout || result.stderr);
    const match = version?.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
    if (!match) {
      return {
        command,
        tool: { id: 'python-3-12', name: 'Python 3.12+', level: 'recommended', status: 'unknown', version, purpose: 'Shared runtime for pytest-based Web and iOS regression scripts.', installHint: 'Install Python 3.12 or newer and make it available as python3.12.', detail: `Detected ${command}, but its version could not be parsed.` },
      };
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const compatible = major > 3 || (major === 3 && minor >= 12);
    return {
      command,
      tool: {
        id: 'python-3-12',
        name: 'Python 3.12+',
        level: 'recommended',
        status: compatible ? 'available' : 'incompatible',
        version,
        purpose: 'Shared runtime for pytest-based Web and iOS regression scripts.',
        installHint: 'Install Python 3.12 or newer and make it available as python3.12.',
        detail: compatible ? command : `${command} is available, but the recommended baseline is Python 3.12 or newer.`,
      },
    };
  }
  return {
    tool: { id: 'python-3-12', name: 'Python 3.12+', level: 'recommended', status: 'missing', purpose: 'Shared runtime for pytest-based Web and iOS regression scripts.', installHint: 'Install Python 3.12 or newer and make it available as python3.12.' },
  };
}

function pythonModuleCheck(input: { python?: string; module: string; id: string; name: string; purpose: string; installHint: string; level?: RecommendationLevel; probe: CommandProbe; args?: string[] }): RecommendedToolCheck {
  if (!input.python) return { id: input.id, name: input.name, level: input.level ?? 'recommended', status: 'unknown', purpose: input.purpose, installHint: input.installHint, detail: 'Python was not detected, so the module could not be checked.' };
  const result = input.probe(input.python, ['-m', input.module, ...(input.args ?? ['--version'])]);
  return {
    id: input.id,
    name: input.name,
    level: input.level ?? 'recommended',
    status: result.ok ? 'available' : 'missing',
    version: firstLine(result.stdout || result.stderr),
    purpose: input.purpose,
    installHint: input.installHint,
    detail: result.ok ? `${input.python} -m ${input.module}` : undefined,
  };
}

function pythonPackageCheck(input: { python?: string; packageName: string; id: string; name: string; purpose: string; installHint: string; level?: RecommendationLevel; probe: CommandProbe }): RecommendedToolCheck {
  if (!input.python) return { id: input.id, name: input.name, level: input.level ?? 'recommended', status: 'unknown', purpose: input.purpose, installHint: input.installHint, detail: 'Python was not detected, so the package could not be checked.' };
  const result = input.probe(input.python, ['-m', 'pip', 'show', input.packageName]);
  const version = result.stdout.match(/^Version:\s*(.+)$/m)?.[1];
  return { id: input.id, name: input.name, level: input.level ?? 'recommended', status: result.ok ? 'available' : 'missing', version, purpose: input.purpose, installHint: input.installHint };
}

function playwrightBrowsersCheck(python: string | undefined, probe: CommandProbe): RecommendedToolCheck {
  if (!python) return { id: 'playwright-browsers', name: 'Playwright browser runtime', level: 'recommended', status: 'unknown', purpose: 'Provides the Chromium/WebKit/Firefox binaries used by Playwright.', installHint: 'python3.12 -m playwright install chromium', detail: 'Python was not detected, so browser installation could not be checked.' };
  const result = probe(python, ['-m', 'playwright', 'install', '--list']);
  const installed = result.ok && Boolean(result.stdout.trim());
  return {
    id: 'playwright-browsers',
    name: 'Playwright browser runtime',
    level: 'recommended',
    status: installed ? 'available' : result.ok ? 'missing' : 'unknown',
    version: installed ? firstLine(result.stdout) : undefined,
    purpose: 'Provides the Chromium/WebKit/Firefox binaries used by Playwright.',
    installHint: 'python3.12 -m playwright install chromium',
    detail: result.ok && !installed ? 'Playwright is available, but no installed browser was reported.' : result.stderr || undefined,
  };
}

function iosMcpCheck(root: string): RecommendedToolCheck {
  const connections = readJson<{ connections?: HostConnection[] }>(qaPath(root, 'mcp.json')).connections ?? [];
  const connection = connections.find(item => item.status === 'available' && /ios[-_. ]?simulator/i.test(`${item.id} ${item.host ?? ''}`));
  return {
    id: 'ios-simulator-mcp',
    name: 'ios-simulator-mcp',
    level: 'optional',
    status: connection ? 'available' : 'missing',
    version: connection?.version,
    purpose: 'Agent-assisted first-run exploration and screenshots; not the formal regression runner.',
    installHint: 'Configure ios-simulator-mcp in the Agent host and import its capability snapshot.',
    detail: connection ? `Detected host connection ${connection.id}.` : undefined,
  };
}

function webStack(python: ReturnType<typeof pythonCheck>, probe: CommandProbe): RecommendedPlatformStack {
  const tools = [
    python.tool,
    pythonModuleCheck({ python: python.command, module: 'pytest', id: 'pytest', name: 'pytest', purpose: 'Test collection, fixtures, assertions, parameterization, and cleanup.', installHint: 'python3.12 -m pip install pytest', probe }),
    pythonPackageCheck({ python: python.command, packageName: 'pytest-playwright', id: 'pytest-playwright', name: 'pytest-playwright', purpose: 'Official pytest integration for Playwright fixtures, browser isolation, locators, actions, and screenshots.', installHint: 'python3.12 -m pip install pytest-playwright', probe }),
    playwrightBrowsersCheck(python.command, probe),
  ];
  return {
    platform: 'web',
    title: 'Recommended Web regression stack',
    mandatory: false,
    recommendedReady: tools.filter(item => item.level === 'recommended').every(item => item.status === 'available'),
    tools,
    setupCommands: ['python3.12 -m pip install pytest pytest-playwright', 'python3.12 -m playwright install chromium'],
    outputContract: ['result.json', 'report.md', 'screenshots/', 'stdout.log', 'stderr.log', 'evidence/ (optional)'],
  };
}

function iosStack(root: string, python: ReturnType<typeof pythonCheck>, probe: CommandProbe): RecommendedPlatformStack {
  const tools = [
    python.tool,
    pythonModuleCheck({ python: python.command, module: 'pytest', id: 'pytest', name: 'pytest', purpose: 'Test collection, fixtures, assertions, parameterization, and cleanup.', installHint: 'python3.12 -m pip install pytest', probe }),
    commandCheck({ id: 'xcrun-simctl', name: 'xcrun simctl', command: 'xcrun', args: ['simctl', 'help'], purpose: 'Simulator lifecycle, app install/launch, permissions, and screenshots.', installHint: 'Install the full Xcode application and select its developer directory.', probe }),
    commandCheck({ id: 'fb-idb', name: 'fb-idb CLI', command: 'idb', args: ['-h'], purpose: 'Python-accessible iOS simulator UI and app automation client.', installHint: 'python3.12 -m pip install fb-idb', probe }),
    commandCheck({ id: 'idb-companion', name: 'idb_companion', command: 'idb_companion', purpose: 'Native companion process used by fb-idb to communicate with the simulator.', installHint: 'brew tap facebook/fb && brew install idb-companion', probe, existenceOnly: true }),
    iosMcpCheck(root),
  ];
  return {
    platform: 'ios',
    title: 'Recommended iOS Simulator regression stack',
    mandatory: false,
    recommendedReady: tools.filter(item => item.level === 'recommended').every(item => item.status === 'available'),
    tools,
    setupCommands: ['python3.12 -m pip install pytest fb-idb', 'brew tap facebook/fb', 'brew install idb-companion'],
    outputContract: ['result.json', 'report.md', 'screenshots/', 'stdout.log', 'stderr.log', 'evidence/ (optional)'],
  };
}

export function recommendedRegressionStackDiagnosis(root: string, requestedPlatforms?: string[], probe: CommandProbe = defaultProbe): RecommendedRegressionStackDiagnosis {
  const configured = requestedPlatforms?.length ? requestedPlatforms : readProject(root).platforms;
  const platforms = [...new Set(configured.filter(platform => platform === 'web' || platform === 'ios'))] as Array<'web' | 'ios'>;
  const python = pythonCheck(probe);
  return {
    policy: 'recommended-not-required',
    message: platforms.length ? 'These tools are the recommended regression stack. Missing recommended or optional tools do not block QA Agent when another approved Host Bridge and the result contract are available.' : 'No Web or iOS platform is configured, so no platform-specific regression stack is recommended. Existing approved adapters may continue to use the result contract.',
    platforms: platforms.map(platform => platform === 'ios' ? iosStack(root, python, probe) : webStack(python, probe)),
    unifiedOutput: ['result.json', 'report.md', 'screenshots/', 'stdout.log', 'stderr.log', 'evidence/ (optional)'],
    reference: 'references/recommended-regression-stack.md',
  };
}
