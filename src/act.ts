import { join } from 'node:path';
import { type DriverResult, initDriver, isDriverAlive, ensureDriver, sendCommand, killDriver } from './driver.ts';
import { recordAgentStep } from './engine.ts';
import { readRunById, taskSourceRunDirectory } from './project.ts';
import type { Locator, TestRun, UiAction } from './types.ts';

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
  const validStrategies = ['css', 'xpath', 'text', 'test-id', 'role', 'label', 'placeholder', 'accessibility', 'coordinate'];
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
  tap: 'click',
  'type-text': 'input',
  swipe: 'swipe',
  launch: 'launch',
  wait: 'wait',
  screenshot: 'screenshot',
  scroll: 'swipe',
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
  keycode?: string;
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

  const platform = (options.platform ?? run.context?.platform ?? 'web') as 'web' | 'ios';

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

  // Determine action description
  const actionDescription = buildActionDescription(command, options, result);

  // Record the step via engine
  const uiAction = CMD_TO_UI_ACTION[command] ?? 'click';
  const updated = recordAgentStep(root, run.id, {
    action: actionDescription,
    uiAction,
    detail: result.actual ?? actionDescription,
    screenshotPath,
    status: 'passed',
    visualInspection: 'not-required',
    executionMode: 'host-automated',
    scenarioId: options.scenario,
    locator,
    actualState: result.actual,
    inputRefs: options.inputRef ? { value: `env:${options.inputRef}` } : undefined,
  });

  return {
    ok: true,
    command,
    runId: run.id,
    stepId: result.stepId,
    screenshot: result.screenshot,
    actual: result.actual,
    stepsRecorded: updated.steps.length,
  };
}

function buildDriverCommand(command: string, options: ActOptions): Record<string, unknown> {
  const cmd: Record<string, unknown> = { cmd: command.replace(/-/g, '_') };

  // Map CLI command names to driver command names
  const cmdNameMap: Record<string, string> = {
    'assert-text': 'assert_text',
    'assert-visible': 'assert_visible',
    'type-text': 'type_text',
  };
  cmd.cmd = cmdNameMap[command] ?? command;

  if (options.locator) cmd.locator = parseLocator(options.locator);
  if (options.url) cmd.url = options.url;
  if (options.inputRef) cmd.inputRef = options.inputRef;
  if (options.value) cmd.value = options.value;
  if (options.expected) cmd.expected = options.expected;
  if (options.text) cmd.text = options.text;
  if (options.x) cmd.x = parseInt(options.x, 10);
  if (options.y) cmd.y = parseInt(options.y, 10);
  if (options.x1) cmd.x1 = parseInt(options.x1, 10);
  if (options.y1) cmd.y1 = parseInt(options.y1, 10);
  if (options.x2) cmd.x2 = parseInt(options.x2, 10);
  if (options.y2) cmd.y2 = parseInt(options.y2, 10);
  if (options.direction) cmd.direction = options.direction;
  if (options.ms) cmd.ms = parseInt(options.ms, 10);
  if (options.name) cmd.name = options.name;
  if (options.bundleId) cmd.bundleId = options.bundleId;
  if (options.keycode) cmd.keycode = options.keycode;

  return cmd;
}

function buildActionDescription(command: string, options: ActOptions, result: DriverResult): string {
  switch (command) {
    case 'navigate': return `Navigate to ${options.url}`;
    case 'click': return `Click ${options.locator}`;
    case 'fill': return `Fill ${options.locator ?? 'field'}`;
    case 'select': return `Select '${options.value}' in ${options.locator}`;
    case 'assert-text': return `Assert text '${options.expected}' in ${options.locator}`;
    case 'assert-visible': return `Assert visible: ${options.locator}`;
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
    default: return `${command}: ${result.actual ?? ''}`;
  }
}

/**
 * Kill the driver associated with a run (called during run complete).
 */
export { killDriver };
