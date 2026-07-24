import { join } from 'node:path';
import { type DriverResult, initDriver, isDriverAlive, ensureDriver, sendCommand, killDriver } from './driver.ts';
import { recordAgentStep } from './engine.ts';
import { readRunById, taskSourceRunDirectory } from './project.ts';
import type { Locator, TestRun, UiAction } from './types.ts';
import { isSupportedPlatform } from './platform.ts';

const PLATFORM_COMMANDS: Record<'web' | 'ios', Set<string>> = {
  web: new Set(['navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'assert-text', 'assert-visible', 'assert-value', 'assert-not-visible', 'assert-attribute', 'assert-count', 'get-text', 'accept-dialog', 'dismiss-dialog', 'upload', 'wait', 'screenshot', 'scroll', 'hover', 'key']),
  ios: new Set(['launch', 'terminate', 'install', 'tap', 'type-text', 'fill', 'clear', 'toggle', 'swipe', 'scroll', 'back', 'home', 'assert-visible', 'assert-text', 'assert-value', 'assert-not-visible', 'assert-attribute', 'assert-count', 'get-text', 'accept-dialog', 'dismiss-dialog', 'wait', 'screenshot', 'describe', 'key']),
};

function platformCommandError(platform: 'web' | 'ios', command: string): string | undefined {
  if (PLATFORM_COMMANDS[platform].has(command)) return undefined;
  const supported = [...PLATFORM_COMMANDS[platform]].join(', ');
  const otherPlatform = platform === 'web' ? 'ios' : 'web';
  return `Command ${command} is not available for the ${platform} Runner. Current Run platform is ${platform}; use one of: ${supported}. If the Task should run on ${otherPlatform}, stop and run qa-agent doctor --platforms ${otherPlatform}, reapply the PlanDraft with the correct platform, and start a new approved Run. Do not call MCP or any direct UI tool.`;
}

/**
 * Parse a locator string like "role=button:登录" into { strategy: "role", value: "button:登录" }.
 * Also supports "css=.class", "text=Hello", "xpath=//div", "test-id=my-id", etc.
 */
export function parseLocator(raw: string): Locator {
  const separatorIndex = raw.indexOf('=');
  if (separatorIndex <= 0) {
    // No strategy prefix, default to css
    return { strategy: 'css', value: raw };
  }
  const strategy = raw.slice(0, separatorIndex) as Locator['strategy'];
  const value = raw.slice(separatorIndex + 1);
  const validStrategies = ['css', 'xpath', 'text', 'test-id', 'role', 'label', 'placeholder', 'accessibility', 'coordinate', 'type', 'value'];
  if (!validStrategies.includes(strategy)) {
    // Not a known strategy, treat entire string as css selector
    return { strategy: 'css', value: raw };
  }
  return { strategy, value };
}

/** Map act command names to uiAction values for step recording */
const CMD_TO_UI_ACTION: Record<string, UiAction> = {
  navigate: 'navigate',
  click: 'click',
  fill: 'fill',
  select: 'input',
  'assert-text': 'assert',
  'assert-visible': 'assert',
  'assert-value': 'assert',
  'assert-not-visible': 'assert',
  'assert-attribute': 'assert',
  'assert-count': 'assert',
  'get-text': 'assert',
  'accept-dialog': 'click',
  'dismiss-dialog': 'click',
  check: 'click',
  uncheck: 'click',
  toggle: 'click',
  upload: 'input',
  tap: 'click',
  'type-text': 'input',
  clear: 'input',
  swipe: 'swipe',
  scroll: 'swipe',
  launch: 'launch',
  wait: 'wait',
  screenshot: 'screenshot',
  hover: 'click',
  home: 'back',
  back: 'back',
  describe: 'assert',
  key: 'input',
};

export interface ActOptions {
  run: string;
  locator?: string;
  url?: string;
  inputRef?: string;
  value?: string;
  expected?: string;
  text?: string;
  x?: string;
  y?: string;
  x1?: string;
  y1?: string;
  x2?: string;
  y2?: string;
  direction?: string;
  ms?: string;
  name?: string;
  bundleId?: string;
  appPath?: string;
  keycode?: string;
  maxChars?: string;
  exact?: string;
  filePath?: string;
  checked?: string;
  scenario?: string;
  platform?: string;
  deviceUdid?: string;
}

/**
 * Execute an act command: send to driver, record step, return result.
 */
export async function executeAct(root: string, command: string, options: ActOptions): Promise<Record<string, unknown>> {
  const run = readRunById(root, options.run);
  if (run.status !== 'running') throw new Error(`Run ${run.id} is not running (status: ${run.status}). Cannot execute act commands.`);

  const requestedPlatform = options.platform ?? run.context?.platform ?? 'web';
  if (!isSupportedPlatform(requestedPlatform)) return { ok: false, blocked: true, command, runId: run.id, error: `Unsupported act platform ${requestedPlatform}. QA Agent supports only Web and iOS Simulator. Run qa-agent doctor --platforms web or ios. Do not call MCP or any direct UI tool.` };
  if (options.platform && options.platform !== run.context.platform) return { ok: false, blocked: true, command, runId: run.id, error: `Act platform ${options.platform} does not match Run platform ${run.context.platform}. Stop and reapply the correct PlanDraft after running qa-agent doctor --platforms ${options.platform}. Do not call MCP or any direct UI tool.` };
  const platform = requestedPlatform;
  const commandError = platformCommandError(platform, command);
  if (commandError) return { ok: false, blocked: true, platform, command, runId: run.id, error: commandError, next: `qa-agent doctor --platforms ${platform}` };

  // Build driver command
  const driverCmd = buildDriverCommand(command, options);

  // Get or start driver
  let result: DriverResult;
  if (isDriverAlive(run.id)) {
    const handle = ensureDriver(root, run, platform, { deviceUdid: options.deviceUdid });
    result = await sendCommand(handle, driverCmd);
  } else {
    const handle = await initDriver(root, run, platform, { deviceUdid: options.deviceUdid });
    result = await sendCommand(handle, driverCmd);
  }

  if (!result.ok) {
    return { ok: false, error: result.error, command, runId: run.id };
  }

  // Build screenshot absolute path for recordAgentStep
  const screenshotPath = result.screenshot
    ? join(taskSourceRunDirectory(root, run.moduleId, run.taskId), 'screenshots', 'steps', result.screenshot)
    : undefined;

  // Build locator for step recording
  const locator = options.locator ? parseLocator(options.locator) : undefined;
  const actualLocator = result.resolvedLocator ? parseLocator(`${result.resolvedLocator.strategy}=${result.resolvedLocator.value ?? ''}`) : undefined;
  const actualText = formatDriverActual(result.actual);

  // Determine action description
  const actionDescription = buildActionDescription(command, options, result);

  // Record the step via engine
  const uiAction = CMD_TO_UI_ACTION[command] ?? 'click';
  const updated = recordAgentStep(root, run.id, {
    action: actionDescription,
    uiAction,
    detail: actualText || actionDescription,
    screenshotPath,
    status: 'passed',
    visualInspection: 'not-required',
    executionMode: 'host-automated',
    scenarioId: options.scenario,
    locator,
    actualLocator,
    actualState: actualText || undefined,
    inputRefs: options.inputRef ? { value: `env:${options.inputRef}` } : undefined,
    driverCommand: command,
    driverParams: recordedDriverParams(command, driverCmd),
  });

  return {
    ok: true,
    command,
    runId: run.id,
    stepId: result.stepId,
    screenshot: result.screenshot,
    actual: result.actual,
    resolvedLocator: result.resolvedLocator,
    stepsRecorded: updated.steps.length,
  };
}

function buildDriverCommand(command: string, options: ActOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  // Map CLI command names to driver command names
  const cmdNameMap: Record<string, string> = {
    'assert-text': 'assert_text',
    'assert-visible': 'assert_visible',
    'type-text': 'type_text',
    key: 'key',
  };
  const driverName = cmdNameMap[command] ?? command;

  if (options.locator) params.locator = parseLocator(options.locator);
  if (options.url) params.url = options.url;
  if (options.inputRef) params.inputRef = options.inputRef;
  if (options.value) params.value = options.value;
  if (options.expected !== undefined) params.expected = options.expected;
  if (options.text) params.text = options.text;
  if (options.x) params.x = parseInt(options.x, 10);
  if (options.y) params.y = parseInt(options.y, 10);
  if (options.x1) params.x1 = parseInt(options.x1, 10);
  if (options.y1) params.y1 = parseInt(options.y1, 10);
  if (options.x2) params.x2 = parseInt(options.x2, 10);
  if (options.y2) params.y2 = parseInt(options.y2, 10);
  if (options.direction) params.direction = options.direction;
  if (options.ms) params.ms = parseInt(options.ms, 10);
  if (options.name) params.name = options.name;
  if (options.bundleId) params.bundleId = options.bundleId;
  if (options.appPath) params.appPath = options.appPath;
  if (options.maxChars) params.maxChars = parseInt(options.maxChars, 10);
  if (options.exact !== undefined) params.exact = options.exact !== 'false';
  if (options.keycode) {
    params.keycode = options.keycode;
    params.key = options.keycode;
  }
  if (options.filePath) params.filePath = options.filePath;
  if (options.checked !== undefined) params.checked = options.checked !== 'false';

  return { cmd: driverName, params };
}

function formatDriverActual(actual: unknown): string {
  if (actual === undefined || actual === null) return '';
  if (typeof actual === 'string') return actual;
  try { return JSON.stringify(actual); } catch { return String(actual); }
}

function recordedDriverParams(command: string, driverCommand: Record<string, unknown>): Record<string, unknown> {
  const params = { ...((driverCommand.params ?? {}) as Record<string, unknown>) };
  // Never persist direct input values. Replayable input must use inputRef.
  if ((command === 'type-text' || command === 'fill') && !params.inputRef) {
    delete params.text;
    delete params.value;
  }
  return params;
}

function buildActionDescription(command: string, options: ActOptions, result: DriverResult): string {
  switch (command) {
    case 'navigate': return `Navigate to ${options.url}`;
    case 'click': return `Click ${options.locator}`;
    case 'fill': return `Fill ${options.locator ?? 'field'}`;
    case 'select': return `Select '${options.value}' in ${options.locator}`;
    case 'assert-text': return `Assert text '${options.expected}' in ${options.locator}`;
    case 'assert-visible': return `Assert visible: ${options.locator}`;
    case 'assert-value': return `Assert value '${options.expected}' in ${options.locator}`;
    case 'assert-not-visible': return `Assert not visible: ${options.locator}`;
    case 'assert-attribute': return `Assert ${options.locator} attribute`;
    case 'assert-count': return `Assert count for ${options.locator}`;
    case 'get-text': return `Get text from ${options.locator}`;
    case 'check': return `Check ${options.locator}`;
    case 'uncheck': return `Uncheck ${options.locator}`;
    case 'toggle': return `Toggle ${options.locator}`;
    case 'accept-dialog': return 'Accept dialog';
    case 'dismiss-dialog': return 'Dismiss dialog';
    case 'upload': return `Upload ${options.filePath}`;
    case 'tap': return `Tap (${options.x}, ${options.y})`;
    case 'type-text': return `Type text`;
    case 'swipe': return `Swipe ${options.direction ?? `(${options.x1},${options.y1})→(${options.x2},${options.y2})`}`;
    case 'launch': return `Launch ${options.bundleId}`;
    case 'wait': return options.ms ? `Wait ${options.ms}ms` : `Wait for ${options.locator}`;
    case 'screenshot': return `Screenshot: ${options.name ?? 'capture'}`;
    case 'scroll': return `Scroll ${options.direction ?? 'down'}`;
    case 'hover': return `Hover ${options.locator}`;
    case 'home': return 'Press home';
    case 'back': return 'Navigate back';
    case 'describe': return 'Describe screen elements';
    case 'key': return `Press key ${options.keycode}`;
    default: return `${command}: ${formatDriverActual(result.actual)}`;
  }
}

/**
 * Kill the driver associated with a run (called during run complete).
 */
export { killDriver };
