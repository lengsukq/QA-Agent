#!/usr/bin/env node
import { join } from 'node:path';
import { availableCapabilities, capabilityAdvice } from './capabilities.ts';
import { beginAgentGuidedRun, beginRegressionRun, buildExecutionSnapshot, completeAgentGuidedRun, completeRegressionRun, recordAgentStep, recordHostEvidence, recordRecoveryAttempt, recordVisualFinding } from './engine.ts';
import { readIndex, rebuildIndexes } from './indexer.ts';
import { createTaskSkeleton, planModule, taskPlan } from './planning.ts';
import { createModule, findProjectRoot, initializeProject, modulePath, qaPath, readModule, readRunById, readTask, requireProjectRoot, saveTask, taskReportDirectory } from './project.ts';
import { readProject } from './project.ts';
import { assertSafeId, now, readJson, writeJsonAtomic } from './store.ts';
import type { ExecutionSnapshot, Locator, PermissionStatus, ProjectMemory, RunStatus } from './types.ts';
import { validateProject, validateSkill } from './validation.ts';
import { createMemoryCandidate, reviewMemory } from './memory.ts';
import { installHostIntegration, supportedHosts } from './host-adapters.ts';
import { testPlanHash } from './approval.ts';
import { hostCapabilityDiagnosis } from './capabilities.ts';
import { operationSummary, readOperation, reviewOperation } from './operations.ts';
import { readModuleRegressionSuite, readTaskRegressionSuite, syncModuleRegressionSuite, syncTaskRegressionSuite } from './regression.ts';

const args = process.argv.slice(2);
const usage = `qa-agent — local-first QA Agent MVP

Commands:
  init [--id ID] [--name NAME] [--description TEXT] [--platforms web,android,ios]
  install-skill [--path SKILLS_DIRECTORY] [--force]   (Codex compatibility alias)
  install-host <codex|claude|cursor|opencode|copilot|gemini|agents> [--scope project|user] [--project PROJECT_DIRECTORY] [--path SKILLS_DIRECTORY] [--force]
  doctor | validate | index rebuild
  host list | host import --file HOST_CAPABILITIES.json | host doctor [--platform android|ios]
  context module MODULE
  module list | module create ID --name NAME [--description TEXT] [--platforms web,android,ios] | module update ID [--name NAME] [--description TEXT] [--risk LEVEL] | module archive ID | module plan ID | module coverage ID
  task list | task create ID --module MODULE [--name NAME] | task plan ID --module MODULE | task run ID --module MODULE [--operation OPERATION_ID] [--scenario SCENARIO] [--environment ENV] [--platform PLATFORM] [--role ROLE] [--device DEVICE] [--device-model MODEL] [--os-version VERSION] [--app-version VERSION] [--web-build BUILD] [--test-data-fingerprint FINGERPRINT] | task operation list|show|review ID --module MODULE [--approve|--reject] | task regression sync|show|run ID --module MODULE | task review ID --module MODULE --approve --confirmed-by USER | task archive ID --module MODULE
  module regression sync|show|run MODULE
  memory list | memory search TEXT | memory add ID --module MODULE [--task TASK] --title TEXT --content TEXT | memory review ID --module MODULE [--task TASK] --approve|--reject
  run step RUN --action TEXT --detail TEXT --screenshot PATH [--operation-action launch|navigate|click|input|fill|swipe|back|wait|assert|screenshot|reset|restart-app] [--safety-action ACTION] [--scenario SCENARIO] [--status passed|failed|paused|blocked|adapted] [--visual-inspection performed|not-required|skipped] [--operation-step STEP] [--locator-strategy STRATEGY] [--locator-value VALUE] [--actual-locator-strategy STRATEGY] [--actual-locator-value VALUE] [--adaptation TEXT]
  run evidence RUN --type TYPE --summary TEXT [--file PATH]
  run recover RUN --action wait|refresh|back|restart-app|reset-sandbox-data|reconnect-mcp|fallback-locator|resume-checkpoint --reason TEXT --detail TEXT --outcome continued|blocked|paused|failed [--failed-step STEP]
  run observe RUN --scenario ID --assertion ID --expected TEXT --actual TEXT --status passed|failed|paused|blocked [--screenshot PATH]
  run complete RUN | run show RUN | run report RUN
  skill list | skill validate
`;

function flag(name: string): string | undefined { const position = args.indexOf(name); return position === -1 ? undefined : args[position + 1]; }
function requiredFlag(name: string): string { const value = flag(name); if (!value || value.startsWith('--')) throw new Error(`${name} is required.`); return value; }
function listFlag(name: string): string[] | undefined { const value = flag(name); return value ? [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))] : undefined; }
function output(value: unknown): void { console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
function locatorFromFlags(prefix = ''): Locator | undefined {
  const strategy = flag(`--${prefix}locator-strategy`); const value = flag(`--${prefix}locator-value`);
  if (!strategy && !value) return undefined;
  if (!strategy) throw new Error(`--${prefix}locator-strategy is required when a locator value is supplied.`);
  return { strategy: strategy as Locator['strategy'], value };
}

function runContextFromFlags(): Partial<ExecutionSnapshot> & { operationId?: string } {
  return { environment: flag('--environment'), platform: flag('--platform'), role: flag('--role'), scenarioId: flag('--scenario'), operationId: flag('--operation'), device: flag('--device'), deviceModel: flag('--device-model'), osVersion: flag('--os-version'), appVersion: flag('--app-version'), webBuild: flag('--web-build'), testDataFingerprint: flag('--test-data-fingerprint') };
}

function addMemory(root: string, id: string, moduleId: string, title: string, content: string): ProjectMemory {
  assertSafeId(id, 'memory id');
  readModule(root, moduleId);
  const taskId = flag('--task'); if (taskId) readTask(root, moduleId, taskId);
  const result = createMemoryCandidate(root, {
    id, moduleId, taskId, type: flag('--type') ?? 'business_rule', title, content,
    scope: { environments: ['local'], platforms: ['web'], roles: ['default'] }, knowledgeLevel: 'observed', confidence: 0.7,
    importance: 'medium', source: { type: 'user_input', reference: 'qa-agent memory add' },
  });
  if (result.conflicts.length) console.error(`qa-agent: candidate conflicts with active memory: ${result.conflicts.join(', ')}`);
  return result.memory;
}

function root(): string { return requireProjectRoot(); }

async function main(): Promise<void> {
  const [group, action, subject] = args;
  if (!group || group === '--help' || group === '-h' || group === 'help') return output(usage);
  if (group === 'init') {
    const project = initializeProject(process.cwd(), { id: flag('--id'), name: flag('--name'), description: flag('--description'), platforms: listFlag('--platforms') });
    output({ message: 'Initialized .qa-agent', project: project.project, path: qaPath(process.cwd()) }); return;
  }
  if (group === 'install-skill') {
    const result = installHostIntegration({ host: 'codex', path: flag('--path'), force: args.includes('--force') });
    output({ message: result.message, path: result.paths[0] }); return;
  }
  if (group === 'install-host') {
    if (!action || !supportedHosts.includes(action as typeof supportedHosts[number])) throw new Error(`Host is required and must be one of: ${supportedHosts.join(', ')}.`);
    const scope = flag('--scope');
    if (scope && scope !== 'project' && scope !== 'user') throw new Error('--scope must be project or user.');
    const result = installHostIntegration({ host: action as typeof supportedHosts[number], projectPath: flag('--project'), path: flag('--path'), scope: scope as 'project' | 'user' | undefined, force: args.includes('--force') });
    output(result); return;
  }
  if (group === 'doctor') {
    const projectRoot = findProjectRoot();
    if (!projectRoot) return output({ ok: false, message: 'No QA project found. Run qa-agent init.' });
    const available = availableCapabilities(projectRoot);
    output({ ok: true, projectRoot, availableCapabilities: available, notes: available.includes('browser.interact') ? [] : capabilityAdvice(['browser.interact']) }); return;
  }
  if (group === 'host') {
    const projectRoot = root(); const path = qaPath(projectRoot, 'mcp.json');
    const config = readJson<{ version: number; connections: Array<{ id: string; capabilities: string[]; status: 'available' | 'unavailable'; permissionStatus?: PermissionStatus; version?: string; host?: string; attestedAt?: string }> }>(path);
    if (action === 'list') { output(config.connections); return; }
    if (action === 'doctor') {
      if (flag('--platform')) { output(hostCapabilityDiagnosis(projectRoot, requiredFlag('--platform'))); return; }
      const checks = config.connections.map(connection => ({ id: connection.id, status: connection.status, permissionStatus: connection.permissionStatus ?? 'unknown', attestedAt: connection.attestedAt, healthy: connection.status === 'available' && connection.capabilities.length > 0 && connection.permissionStatus === 'verified', issue: connection.status !== 'available' ? 'host did not attest this tool as available' : !connection.capabilities.length ? 'no capabilities declared by host' : connection.permissionStatus !== 'verified' ? 'host did not attest required permissions as verified' : undefined }));
      output({ healthy: checks.every(check => check.healthy), connections: checks }); return;
    }
    if (action !== 'import') throw new Error('Host command must be list, import, or doctor.');
    const snapshot = readJson<{ host?: string; collectedAt?: string; connections?: Array<{ id: string; capabilities: string[]; status?: 'available' | 'unavailable'; permissionStatus?: PermissionStatus; version?: string }> }>(requiredFlag('--file'));
    if (!Array.isArray(snapshot.connections) || snapshot.connections.some(connection => !connection.id || !Array.isArray(connection.capabilities))) throw new Error('Host capability snapshot requires a connections array with id and capabilities.');
    config.connections = snapshot.connections.map(connection => ({ id: connection.id, capabilities: [...new Set(connection.capabilities)], status: connection.status ?? 'available', permissionStatus: connection.permissionStatus ?? 'unknown', version: connection.version, host: snapshot.host, attestedAt: snapshot.collectedAt ?? now() }));
    writeJsonAtomic(path, config); output(config); return;
  }
  if (group === 'validate') {
    const result = validateProject(root()); output(result); if (!result.valid) process.exitCode = 1; return;
  }
  if (group === 'context' && action === 'module') {
    if (!subject) throw new Error('module id is required.');
    const projectRoot = root();
    const module = readModule(projectRoot, subject);
    const memories = readIndex<ProjectMemory>(projectRoot, 'memories').filter(memory => !memory.moduleId || memory.moduleId === subject).filter(memory => memory.status === 'active');
    const tasks = readIndex<{ moduleId: string }>(projectRoot, 'tasks').filter(task => task.moduleId === subject);
    output({ project: readProject(projectRoot), module, memories, tasks, skills: readIndex(projectRoot, 'skills'), capabilities: availableCapabilities(projectRoot), policy: readJson(qaPath(projectRoot, 'policies.json')) }); return;
  }
  if (group === 'index' && action === 'rebuild') { output(rebuildIndexes(root())); return; }
  if (group === 'module') {
    const projectRoot = root();
    if (action === 'list') return output(readIndex(projectRoot, 'modules'));
    if (action === 'create') {
      if (!subject) throw new Error('module id is required.');
      const module = createModule(projectRoot, { id: subject, name: requiredFlag('--name'), description: flag('--description') ?? '', platforms: listFlag('--platforms'), riskLevel: (flag('--risk') as 'low' | 'medium' | 'high' | 'critical' | undefined) });
      rebuildIndexes(projectRoot); output(module); return;
    }
    if (action === 'plan') {
      if (!subject) throw new Error('module id is required.');
      const planned = planModule(readModule(projectRoot, subject), readIndex<{ id: string; moduleId: string }>(projectRoot, 'tasks').filter(task => task.moduleId === subject).map(task => task.id), readIndex<ProjectMemory>(projectRoot, 'memories').filter(memory => memory.moduleId === subject));
      output({ moduleId: subject, suggestions: planned, note: 'Planning is non-mutating. Create reviewed tasks explicitly.' }); return;
    }
    if (action === 'coverage') {
      if (!subject) throw new Error('module id is required.');
      const tasks = readIndex<{ id: string; moduleId: string }>(projectRoot, 'tasks').filter(task => task.moduleId === subject);
      const memories = readIndex<ProjectMemory>(projectRoot, 'memories').filter(memory => memory.moduleId === subject);
      const dimensions = planModule(readModule(projectRoot, subject), tasks.map(task => task.id), memories).map(item => ({ dimension: item.dimension, taskId: item.id, status: item.exists ? 'covered' : 'not_covered', reason: item.reason }));
      output({ moduleId: subject, coverage: dimensions, summary: { covered: dimensions.filter(item => item.status === 'covered').length, total: dimensions.length } }); return;
    }
    if (action === 'update' || action === 'archive') {
      if (!subject) throw new Error('module id is required.');
      const module = readModule(projectRoot, subject);
      if (action === 'update') {
        module.name = flag('--name') ?? module.name; module.description = flag('--description') ?? module.description;
        const risk = flag('--risk'); if (risk) { if (!['low', 'medium', 'high', 'critical'].includes(risk)) throw new Error('--risk must be low, medium, high, or critical.'); module.riskLevel = risk as typeof module.riskLevel; }
      } else module.status = 'archived';
      module.revision = (module.revision ?? 1) + 1; module.updatedAt = now(); writeJsonAtomic(join(modulePath(projectRoot, subject), 'module.json'), module); rebuildIndexes(projectRoot); output(module); return;
    }
  }
  if (group === 'task') {
    const projectRoot = root();
    if (action === 'list') return output(readIndex(projectRoot, 'tasks'));
    const moduleId = requiredFlag('--module');
    if (!subject) throw new Error('task id is required.');
    if (action === 'create') {
      const task = createTaskSkeleton(readModule(projectRoot, moduleId), subject, flag('--name'));
      saveTask(projectRoot, task); rebuildIndexes(projectRoot); output(task); return;
    }
    const nestedAction = action === 'operation' || action === 'regression' ? subject : undefined;
    const taskId = nestedAction ? (flag('--task') ?? args[3]) : subject;
    if (!taskId || taskId.startsWith('--')) throw new Error('task id is required for operation/regression commands.');
    const task = readTask(projectRoot, moduleId, taskId);
    if (action === 'plan') return output(taskPlan(task));
    if (action === 'operation') {
      const operationAction = ['list', 'show', 'review'].includes(subject ?? '') ? subject : args[3];
      if (operationAction === 'list') return output(operationSummary(projectRoot, task));
      if (operationAction === 'show') return output(readOperation(projectRoot, task, requiredFlag('--operation')));
      if (operationAction === 'review') {
        const approve = args.includes('--approve'); const reject = args.includes('--reject');
        if (approve === reject) throw new Error('Specify exactly one of --approve or --reject.');
        const reviewed = reviewOperation(projectRoot, task, requiredFlag('--operation'), approve ? 'approve' : 'reject'); if (approve) syncTaskRegressionSuite(projectRoot, task); rebuildIndexes(projectRoot); return output(reviewed);
      }
      throw new Error('Operation action must be list, show, or review.');
    }
    if (action === 'regression') {
      const regressionAction = ['sync', 'show', 'run', 'complete'].includes(subject ?? '') ? subject : args[3];
      if (regressionAction === 'sync') return output(syncTaskRegressionSuite(projectRoot, task));
      if (regressionAction === 'show') return output(readTaskRegressionSuite(projectRoot, task));
      if (regressionAction === 'run') {
        const suite = readTaskRegressionSuite(projectRoot, task); const context = buildExecutionSnapshot(projectRoot, task, { environment: flag('--environment'), platform: flag('--platform'), role: flag('--role'), scenarioId: flag('--scenario'), device: flag('--device'), deviceModel: flag('--device-model'), osVersion: flag('--os-version'), appVersion: flag('--app-version'), webBuild: flag('--web-build'), testDataFingerprint: flag('--test-data-fingerprint') });
        const started = beginRegressionRun(projectRoot, suite, context); rebuildIndexes(projectRoot); return output(started);
      }
      if (regressionAction === 'complete') { const regressionRun = readJson(qaPath(projectRoot, 'regression-runs', `${requiredFlag('--run')}.json`)); const completed = completeRegressionRun(projectRoot, regressionRun); rebuildIndexes(projectRoot); return output(completed); }
      throw new Error('Regression action must be sync, show, or run.');
    }
    if (action === 'review') {
      if (!args.includes('--approve')) throw new Error('Task review requires --approve after verifying scope, business logic, scenarios, evidence, and safety stops.');
      const confirmedBy = requiredFlag('--confirmed-by');
      if (!task.scenarios.length) throw new Error('A task needs at least one scenario before approval.');
      if (task.scenarios.some(scenario => !scenario.intent || !Object.keys(scenario.expected ?? {}).length || !(scenario.visualAssertions?.length))) throw new Error('Task review requires every Scenario to declare business intent, expected result, and visual assertions.');
      task.metadata.status = 'ready'; task.metadata.approval = { confirmedBy, confirmedAt: now(), statement: 'User confirmed the generated test cases and business logic before execution.', planHash: testPlanHash(task) }; task.metadata.version += 1; task.updatedAt = now(); saveTask(projectRoot, task); rebuildIndexes(projectRoot); output(task); return;
    }
    if (action === 'archive') {
      task.metadata.status = 'archived'; task.metadata.version += 1; task.updatedAt = now(); saveTask(projectRoot, task); rebuildIndexes(projectRoot); output(task); return;
    }
    if (action === 'run') {
      const started = beginAgentGuidedRun(projectRoot, task, runContextFromFlags());
      rebuildIndexes(projectRoot);
      output({ ...started, next: 'Host Agent should now operate its approved tools and record run step, run evidence, run observe, and run complete internally.' });
      return;
    }
  }
  if (group === 'memory') {
    const projectRoot = root();
    if (action === 'list') return output(readIndex(projectRoot, 'memories'));
    if (action === 'search') {
      if (!subject) throw new Error('search text is required.');
      const query = subject.toLowerCase(); return output(readIndex<Record<string, unknown>>(projectRoot, 'memories').filter(item => JSON.stringify(item).toLowerCase().includes(query)));
    }
    if (action === 'add') {
      if (!subject) throw new Error('memory id is required.');
      const memory = addMemory(projectRoot, subject, requiredFlag('--module'), requiredFlag('--title'), requiredFlag('--content'));
      rebuildIndexes(projectRoot); output(memory); return;
    }
    if (action === 'review') {
      if (!subject) throw new Error('memory id is required.');
      const approve = args.includes('--approve'); const reject = args.includes('--reject');
      if (approve === reject) throw new Error('Specify exactly one of --approve or --reject.');
      const memory = reviewMemory(projectRoot, requiredFlag('--module'), subject, approve ? 'approve' : 'reject', (flag('--knowledge-level') as ProjectMemory['knowledgeLevel'] | undefined) ?? 'confirmed', flag('--task'));
      rebuildIndexes(projectRoot); output(memory); return;
    }
  }
  if (group === 'run') {
    if (!['show', 'report', 'step', 'evidence', 'recover', 'observe', 'complete'].includes(action ?? '')) throw new Error(`Unsupported command.\n\n${usage}`);
    const projectRoot = root();
    if (!subject) throw new Error('run id is required. Start a Task with task run TASK --module MODULE.');
    const run = readRunById(projectRoot, subject);
    if (action === 'show') return output(run);
    if (action === 'report') return output(join(taskReportDirectory(projectRoot, run.moduleId, run.taskId), `${subject}.md`));
    if (action === 'step') {
      const updated = recordAgentStep(projectRoot, subject, { action: requiredFlag('--action'), operationAction: flag('--operation-action') as 'launch' | 'navigate' | 'click' | 'input' | 'fill' | 'swipe' | 'back' | 'wait' | 'assert' | 'screenshot' | 'reset' | 'restart-app' | undefined, safetyAction: flag('--safety-action'), detail: requiredFlag('--detail'), screenshotPath: requiredFlag('--screenshot'), status: (flag('--status') as RunStatus | undefined) ?? 'passed', visualInspection: (flag('--visual-inspection') as 'performed' | 'not-required' | 'not-applicable' | 'skipped' | undefined) ?? 'not-required', operationStepId: flag('--operation-step'), scenarioId: flag('--scenario'), locator: locatorFromFlags(), actualLocator: locatorFromFlags('actual-'), adaptation: flag('--adaptation') });
      output(updated); return;
    }
    if (action === 'evidence') {
      const updated = recordHostEvidence(projectRoot, subject, { type: requiredFlag('--type'), summary: requiredFlag('--summary'), artifactPath: flag('--file') });
      output(updated); return;
    }
    if (action === 'recover') {
      const updated = recordRecoveryAttempt(projectRoot, subject, { action: requiredFlag('--action'), reason: requiredFlag('--reason'), detail: requiredFlag('--detail'), outcome: requiredFlag('--outcome') as 'continued' | 'blocked' | 'paused' | 'failed', failedStepId: flag('--failed-step') });
      output(updated); return;
    }
    if (action === 'observe') {
      const updated = recordVisualFinding(projectRoot, subject, { scenarioId: requiredFlag('--scenario'), assertionId: requiredFlag('--assertion'), expected: requiredFlag('--expected'), actual: requiredFlag('--actual'), status: requiredFlag('--status') as RunStatus, screenshotPath: flag('--screenshot'), inspectionProvider: flag('--inspection-provider') });
      output(updated); return;
    }
    if (action === 'complete') {
      const updated = completeAgentGuidedRun(projectRoot, readTask(projectRoot, (run as { moduleId: string }).moduleId, (run as { taskId: string }).taskId), subject);
      rebuildIndexes(projectRoot); output(updated); return;
    }
  }
  if (group === 'module' && action === 'regression') {
    const projectRoot = root();
    const regressionAction = ['sync', 'show', 'run', 'complete'].includes(subject ?? '') ? subject : args[3];
    const moduleId = regressionAction === subject ? args[3] : subject;
    if (!moduleId || moduleId.startsWith('--')) throw new Error('module id is required.');
    if (regressionAction === 'sync') return output(syncModuleRegressionSuite(projectRoot, moduleId));
    if (regressionAction === 'show') return output(readModuleRegressionSuite(projectRoot, moduleId));
    if (regressionAction === 'run') {
      const suite = readModuleRegressionSuite(projectRoot, moduleId); const first = suite.members[0]; if (!first) throw new Error(`Module ${moduleId} has no active OperationPlan.`);
      const task = readTask(projectRoot, moduleId, first.taskId); const context = buildExecutionSnapshot(projectRoot, task, { environment: flag('--environment'), platform: flag('--platform'), role: flag('--role'), device: flag('--device'), deviceModel: flag('--device-model'), osVersion: flag('--os-version'), appVersion: flag('--app-version'), webBuild: flag('--web-build'), testDataFingerprint: flag('--test-data-fingerprint') });
      const started = beginRegressionRun(projectRoot, suite, context); rebuildIndexes(projectRoot); return output(started);
    }
    if (regressionAction === 'complete') { const regressionRun = readJson(qaPath(projectRoot, 'regression-runs', `${requiredFlag('--run')}.json`)); const completed = completeRegressionRun(projectRoot, regressionRun); rebuildIndexes(projectRoot); return output(completed); }
    throw new Error('Module regression action must be sync, show, or run.');
  }
  if (group === 'skill') {
    const skillRoot = join(process.cwd(), 'skill', 'qa-agent');
    const projectRoot = findProjectRoot();
    if (action === 'list') return output(projectRoot ? readIndex(projectRoot, 'skills') : [{ name: 'qa-agent', path: skillRoot }]);
    if (action === 'validate') { const result = validateSkill(skillRoot); output(result); if (!result.valid) process.exitCode = 1; return; }
  }
  throw new Error(`Unsupported command.\n\n${usage}`);
}

main().catch(error => { console.error(`qa-agent: ${(error as Error).message}`); process.exitCode = 1; });
