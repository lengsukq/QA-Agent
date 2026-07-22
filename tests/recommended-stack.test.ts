import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeProject } from '../src/project.ts';
import { recommendedRegressionStackDiagnosis, type CommandProbe } from '../src/recommended-stack.ts';

function probeFrom(entries: Record<string, { ok?: boolean; stdout?: string; stderr?: string }>): CommandProbe {
  return (command, args) => {
    const key = [command, ...args].join(' ');
    const entry = entries[key];
    return entry
      ? { ok: entry.ok ?? true, stdout: entry.stdout ?? '', stderr: entry.stderr ?? '', exitCode: entry.ok === false ? 1 : 0 }
      : { ok: false, stdout: '', stderr: `missing probe: ${key}`, exitCode: 1 };
  };
}

test('diagnoses the recommended Web stack without making it mandatory', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-stack-web-'));
  initializeProject(root, { id: 'stack-web', platforms: ['web'] });
  const probe = probeFrom({
    'which python3.12': { stdout: '/usr/local/bin/python3.12' },
    'python3.12 --version': { stdout: 'Python 3.12.8' },
    'python3.12 -m pytest --version': { stdout: 'pytest 8.4.0' },
    'python3.12 -m pip show pytest-playwright': { stdout: 'Name: pytest-playwright\nVersion: 0.7.1' },
    'python3.12 -m playwright install --list': { stdout: 'chromium-1187' },
    'python3.12 -m pip show allure-pytest': { stdout: 'Name: allure-pytest\nVersion: 2.15.0' },
  });
  const diagnosis = recommendedRegressionStackDiagnosis(root, undefined, probe);
  assert.equal(diagnosis.policy, 'recommended-not-required');
  assert.equal(diagnosis.platforms.length, 1);
  const web = diagnosis.platforms[0]!;
  assert.equal(web.platform, 'web');
  assert.equal(web.mandatory, false);
  assert.equal(web.recommendedReady, true);
  assert.equal(web.tools.find(item => item.id === 'python-3-12')?.status, 'available');
  assert.equal(web.tools.find(item => item.id === 'pytest-playwright')?.status, 'available');
  assert.equal(web.tools.find(item => item.id === 'playwright-browsers')?.status, 'available');
  assert.equal(web.tools.find(item => item.id === 'allure-pytest')?.level, 'optional');
  assert.ok(diagnosis.unifiedOutput.includes('junit.xml'));
});

test('diagnoses iOS recommendations and keeps optional exploration non-blocking', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-stack-ios-'));
  initializeProject(root, { id: 'stack-ios', platforms: ['ios'] });
  const probe = probeFrom({
    'which python3.12': { stdout: '/opt/homebrew/bin/python3.12' },
    'python3.12 --version': { stdout: 'Python 3.12.6' },
    'python3.12 -m pytest --version': { stdout: 'pytest 8.4.0' },
    'python3.12 -m pip show allure-pytest': { ok: false, stderr: 'not installed' },
    'which xcrun': { stdout: '/usr/bin/xcrun' },
    'xcrun simctl help': { stdout: 'usage: simctl' },
    'which idb': { stdout: '/opt/homebrew/bin/idb' },
    'idb -h': { stdout: 'usage: idb' },
    'which idb_companion': { stdout: '/opt/homebrew/bin/idb_companion' },
    'idb_companion --help': { stdout: 'usage: idb_companion' },
  });
  const diagnosis = recommendedRegressionStackDiagnosis(root, undefined, probe);
  const ios = diagnosis.platforms[0]!;
  assert.equal(ios.platform, 'ios');
  assert.equal(ios.recommendedReady, true);
  assert.equal(ios.tools.find(item => item.id === 'xcrun-simctl')?.status, 'available');
  assert.equal(ios.tools.find(item => item.id === 'fb-idb')?.status, 'available');
  assert.equal(ios.tools.find(item => item.id === 'idb-companion')?.status, 'available');
  assert.equal(ios.tools.find(item => item.id === 'ios-simulator-mcp')?.status, 'missing');
  assert.equal(ios.tools.find(item => item.id === 'ios-simulator-mcp')?.level, 'optional');
  assert.equal(ios.tools.find(item => item.id === 'allure-pytest')?.status, 'missing');
  assert.equal(ios.recommendedReady, true);
});

test('reports an incompatible Python baseline and missing adapters as advisory', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-stack-old-python-'));
  initializeProject(root, { id: 'stack-old-python', platforms: ['web', 'ios'] });
  const probe = probeFrom({
    'which python3.12': { ok: false },
    'which python3': { stdout: '/usr/bin/python3' },
    'python3 --version': { stdout: 'Python 3.11.9' },
  });
  const diagnosis = recommendedRegressionStackDiagnosis(root, undefined, probe);
  assert.equal(diagnosis.platforms.length, 2);
  for (const platform of diagnosis.platforms) {
    assert.equal(platform.mandatory, false);
    assert.equal(platform.recommendedReady, false);
    assert.equal(platform.tools.find(item => item.id === 'python-3-12')?.status, 'incompatible');
  }
  assert.match(diagnosis.message, /do not block QA Agent/i);
});

test('does not recommend the Web stack for an Android-only project', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-agent-stack-android-'));
  initializeProject(root, { id: 'stack-android', platforms: ['android'] });
  const diagnosis = recommendedRegressionStackDiagnosis(root, undefined, probeFrom({}));
  assert.equal(diagnosis.platforms.length, 0);
  assert.match(diagnosis.message, /No Web or iOS platform/i);
});
