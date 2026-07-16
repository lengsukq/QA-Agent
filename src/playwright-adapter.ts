import { join } from 'node:path';
import { ensureDir, now, writeJsonAtomic } from './store.ts';
import type { BrowserStep, TestRun, TestScenario } from './types.ts';

export class SafetyStopError extends Error {
  constructor(message: string) { super(message); this.name = 'SafetyStopError'; }
}

export interface PlaywrightAdapterConfig { version: 1; kind: 'playwright'; baseUrl: string; headless: boolean; configuredAt: string; capabilities: string[]; }

export interface BrowserScenarioResult {
  evidence: TestRun['evidence'];
  steps: TestRun['steps'];
  url: string;
  title: string;
  visibleText: string;
}

function redact(value: string): string {
  return value.replace(/(authorization|cookie|password|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function destination(baseUrl: string, value: string): string { return new URL(value, baseUrl).toString(); }

export async function executeBrowserScenario(input: {
  root: string; runId: string; scenario: TestScenario; config: PlaywrightAdapterConfig; stopBefore: string[]; prohibitedActions: string[];
}): Promise<BrowserScenarioResult> {
  let playwright: any;
  try { playwright = await import('playwright'); }
  catch { throw new Error('Playwright package is unavailable. Install the project dependency before running browser tasks.'); }
  const evidenceDir = join(input.root, '.qa-agent', 'evidence', input.runId, input.scenario.id);
  ensureDir(evidenceDir);
  const evidence: TestRun['evidence'] = [];
  const steps: TestRun['steps'] = [];
  const consoleMessages: Array<{ type: string; text: string; at: string }> = [];
  const networkFailures: Array<{ url: string; failure: string | null; at: string }> = [];
  const browser = await playwright.chromium.launch({ headless: input.config.headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (message: any) => { if (message.type() === 'error' || message.type() === 'warning') consoleMessages.push({ type: message.type(), text: redact(message.text()), at: now() }); });
  page.on('requestfailed', (request: any) => networkFailures.push({ url: request.url(), failure: request.failure()?.errorText ?? null, at: now() }));
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  try {
    if (input.scenario.execution?.startPath) await page.goto(destination(input.config.baseUrl, input.scenario.execution.startPath), { waitUntil: 'domcontentloaded' });
    for (const step of input.scenario.execution?.steps ?? []) await executeStep(page, step, input, steps, evidence, evidenceDir);
    const screenshot = join(evidenceDir, 'final.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    evidence.push({ type: 'screenshot', path: relativeEvidence(input.root, screenshot), summary: 'Final scenario screenshot.' });
    const url = page.url(); const title = await page.title(); const visibleText = redact((await page.locator('body').innerText()).slice(0, 4000));
    const pageState = join(evidenceDir, 'page-state.json');
    writeJsonAtomic(pageState, { url, title, visibleText, capturedAt: now() });
    evidence.push({ type: 'page-state', path: relativeEvidence(input.root, pageState), summary: `${title} — ${url}` });
    return { evidence, steps, url, title, visibleText };
  } catch (error) {
    const failureScreenshot = join(evidenceDir, 'failure.png');
    try { await page.screenshot({ path: failureScreenshot, fullPage: true }); evidence.push({ type: 'screenshot', path: relativeEvidence(input.root, failureScreenshot), summary: 'Failure screenshot.' }); } catch { /* Preserve original failure. */ }
    throw Object.assign(error as Error, { qaEvidence: evidence, qaSteps: steps });
  } finally {
    const consolePath = join(evidenceDir, 'console.json');
    const networkPath = join(evidenceDir, 'network-failures.json');
    writeJsonAtomic(consolePath, consoleMessages);
    writeJsonAtomic(networkPath, networkFailures);
    evidence.push({ type: 'console', path: relativeEvidence(input.root, consolePath), summary: `${consoleMessages.length} warning/error messages.` });
    evidence.push({ type: 'network-failures', path: relativeEvidence(input.root, networkPath), summary: `${networkFailures.length} failed requests.` });
    const tracePath = join(evidenceDir, 'trace.zip');
    try { await context.tracing.stop({ path: tracePath }); evidence.push({ type: 'trace', path: relativeEvidence(input.root, tracePath), summary: 'Playwright trace.' }); } finally { await browser.close(); }
  }
}

async function executeStep(page: any, step: BrowserStep, input: { root: string; runId: string; scenario: TestScenario; config: PlaywrightAdapterConfig; stopBefore: string[]; prohibitedActions: string[] }, steps: TestRun['steps'], evidence: TestRun['evidence'], evidenceDir: string): Promise<void> {
  const started = now();
  if (step.safetyAction && input.prohibitedActions.includes(step.safetyAction)) throw new SafetyStopError(`Prohibited action: ${step.safetyAction}.`);
  if (step.safetyAction && input.stopBefore.includes(step.safetyAction)) throw new SafetyStopError(`Approval required before: ${step.safetyAction}.`);
  const timeout = step.timeoutMs ?? 10_000;
  const locator = step.locator ? page.locator(step.locator) : undefined;
  switch (step.action) {
    case 'navigate': if (!step.value) throw new Error(`${step.id}: navigate needs value.`); await page.goto(destination(input.config.baseUrl, step.value), { waitUntil: 'domcontentloaded', timeout }); break;
    case 'click': if (!locator) throw new Error(`${step.id}: click needs locator.`); await locator.click({ timeout }); break;
    case 'fill': if (!locator || step.value === undefined) throw new Error(`${step.id}: fill needs locator and value.`); await locator.fill(step.value, { timeout }); break;
    case 'assert-visible': if (!locator || !await locator.isVisible({ timeout })) throw new Error(`${step.id}: expected visible element ${step.locator}.`); break;
    case 'assert-hidden': if (!locator) throw new Error(`${step.id}: assert-hidden needs locator.`); if (await locator.count() && await locator.isVisible({ timeout })) throw new Error(`${step.id}: expected hidden element ${step.locator}.`); break;
    case 'assert-text': {
      if (!locator || step.expected === undefined) throw new Error(`${step.id}: assert-text needs locator and expected.`);
      const actual = await locator.innerText({ timeout }); if (!actual.includes(step.expected)) throw new Error(`${step.id}: expected text ${JSON.stringify(step.expected)}, got ${JSON.stringify(redact(actual))}.`); break;
    }
    case 'assert-url': if (!step.expected) throw new Error(`${step.id}: assert-url needs expected.`); if (!page.url().includes(step.expected)) throw new Error(`${step.id}: expected URL containing ${step.expected}, got ${page.url()}.`); break;
    case 'wait-for': if (!locator) throw new Error(`${step.id}: wait-for needs locator.`); await locator.waitFor({ state: 'visible', timeout }); break;
    case 'screenshot': { const screenshot = join(evidenceDir, `${step.id}.png`); await page.screenshot({ path: screenshot, fullPage: true }); evidence.push({ type: 'screenshot', path: relativeEvidence(input.root, screenshot), summary: step.description ?? step.id }); break; }
    default: throw new Error(`${step.id}: unsupported action ${(step as BrowserStep).action}.`);
  }
  steps.push({ id: step.id, action: step.action, status: 'passed', detail: step.description ?? 'Completed.', at: started });
}

function relativeEvidence(root: string, path: string): string { return path.slice(join(root, '.qa-agent').length + 1); }
