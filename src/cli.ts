#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { availableCapabilities, capabilityAdvice } from './capabilities.ts';
import { beginAgentGuidedRun, completeAgentGuidedRun, configurePlaywrightAdapter, executeTask, recordAgentStep, recordVisualFinding } from './engine.ts';
import { readIndex, rebuildIndexes } from './indexer.ts';
import { createTaskSkeleton, planModule, taskPlan } from './planning.ts';
import { createModule, findProjectRoot, initializeProject, modulePath, qaPath, readModule, readTask, requireProjectRoot, saveTask } from './project.ts';
import { readProject } from './project.ts';
import { assertSafeId, now, readJson, writeJsonAtomic } from './store.ts';
import type { ProjectMemory, RunStatus } from './types.ts';
import { validateProject, validateSkill } from './validation.ts';
import { createMemoryCandidate, reviewMemory } from './memory.ts';
import { diagnoseSource, searchSource } from './source-verifier.ts';
import { installHostIntegration, supportedHosts } from './host-adapters.ts';
import { invalidateApproval, testPlanHash } from './approval.ts';
import { mobileCapabilityDiagnosis } from './capabilities.ts';

const args = process.argv.slice(2);
const usage = `qa-agent — local-first QA Agent MVP

Commands:
  init [--id ID] [--name NAME] [--description TEXT] [--platforms web,android,ios]
  install-skill [--path SKILLS_DIRECTORY] [--force]   (Codex compatibility alias)
  install-host <codex|claude|cursor|opencode|copilot|gemini|agents> [--scope project|user] [--project PROJECT_DIRECTORY] [--path SKILLS_DIRECTORY] [--force]
  doctor | validate | index rebuild
  capability list | capability declare NAME | capability remove NAME
  mcp list | mcp add ID --capabilities CAPABILITY[,CAPABILITY...] [--readonly] | mcp activate ID | mcp doctor
  mobile doctor --platform android|ios
  context module MODULE
  module list | module create ID --name NAME [--description TEXT] [--platforms web,android,ios] | module update ID [--name NAME] [--description TEXT] [--risk LEVEL] | module archive ID | module plan ID | module coverage ID
  task list | task create ID --module MODULE [--name NAME] | task plan ID --module MODULE | task runbook ID --module MODULE --file FILE [--scenario ID] | task review ID --module MODULE --approve --confirmed-by USER | task archive ID --module MODULE | task run ID --module MODULE
  memory list | memory search TEXT | memory add ID --module MODULE --title TEXT --content TEXT | memory review ID --module MODULE --approve|--reject
  adapter playwright --base-url URL
  source search TEXT | source diagnose --module MODULE --query TEXT
  run start TASK --module MODULE [--environment ENV] [--platform PLATFORM] [--role ROLE]
  run step RUN --action TEXT --detail TEXT [--status passed|failed|paused|blocked]
  run observe RUN --scenario ID --assertion ID --expected TEXT --actual TEXT --status passed|failed|paused|blocked [--screenshot PATH]
  run complete RUN | run show RUN | run report RUN | run retry RUN
  skill list | skill validate
`;

function flag(name: string): string | undefined { const position = args.indexOf(name); return position === -1 ? undefined : args[position + 1]; }
function requiredFlag(name: string): string { const value = flag(name); if (!value || value.startsWith('--')) throw new Error(`${name} is required.`); return value; }
function listFlag(name: string): string[] | undefined { const value = flag(name); return value ? [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))] : undefined; }
function output(value: unknown): void { console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }

function addMemory(root: string, id: string, moduleId: string, title: string, content: string): ProjectMemory {
  assertSafeId(id, 'memory id');
  readModule(root, moduleId);
  const result = createMemoryCandidate(root, {
    id, moduleId, type: flag('--type') ?? 'business_rule', title, content,
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
  if (group === 'capability') {
    const projectRoot = root();
    const configPath = qaPath(projectRoot, 'capabilities.json');
    const config = readJson<{ version: number; capabilities: string[]; updatedAt?: string }>(configPath);
    if (action === 'list') { output({ declared: config.capabilities, available: availableCapabilities(projectRoot) }); return; }
    if (!subject) throw new Error('capability name is required.');
    if (action === 'declare') config.capabilities = [...new Set([...config.capabilities, subject])].sort();
    else if (action === 'remove') config.capabilities = config.capabilities.filter(item => item !== subject);
    else throw new Error('Unsupported capability command.');
    config.updatedAt = now(); writeJsonAtomic(configPath, config); output(config); return;
  }
  if (group === 'mcp') {
    const projectRoot = root(); const path = qaPath(projectRoot, 'mcp.json');
    const config = readJson<{ version: number; connections: Array<{ id: string; capabilities: string[]; scope: string; status: string; readOnly: boolean }> }>(path);
    if (action === 'list') { output(config.connections); return; }
    if (action === 'doctor') {
      const checks = config.connections.map(connection => ({ id: connection.id, status: connection.status, healthy: connection.status === 'connected' && connection.capabilities.length > 0, issue: connection.status !== 'connected' ? 'not connected' : connection.capabilities.length ? undefined : 'no capabilities declared' }));
      output({ healthy: checks.every(check => check.healthy), connections: checks }); return;
    }
    if (!subject) throw new Error('MCP id is required.');
    if (action === 'add') {
      assertSafeId(subject, 'MCP id'); if (config.connections.some(connection => connection.id === subject)) throw new Error(`MCP ${subject} already exists.`);
      const capabilities = requiredFlag('--capabilities').split(',').map(item => item.trim()).filter(Boolean); if (!capabilities.length) throw new Error('At least one capability is required.');
      config.connections.push({ id: subject, capabilities, scope: 'project', status: 'configured', readOnly: args.includes('--readonly') });
    } else if (action === 'activate') {
      const connection = config.connections.find(item => item.id === subject); if (!connection) throw new Error(`MCP ${subject} was not found.`); connection.status = 'connected';
    } else throw new Error('Unsupported MCP command.');
    writeJsonAtomic(path, config); output(config); return;
  }
  if (group === 'mobile' && action === 'doctor') { output(mobileCapabilityDiagnosis(root(), requiredFlag('--platform'))); return; }
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
      module.updatedAt = now(); writeJsonAtomic(join(modulePath(projectRoot, subject), 'module.json'), module); rebuildIndexes(projectRoot); output(module); return;
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
    const task = readTask(projectRoot, moduleId, subject);
    if (action === 'plan') return output(taskPlan(task));
    if (action === 'runbook') {
      const raw = JSON.parse(readFileSync(requiredFlag('--file'), 'utf8')) as { startPath?: string; steps?: unknown } | unknown[];
      const runbook = Array.isArray(raw) ? { steps: raw } : raw;
      if (!runbook || typeof runbook !== 'object' || !Array.isArray((runbook as { steps?: unknown }).steps)) throw new Error('Runbook file must be a JSON array of steps or an object with steps.');
      const scenarioId = flag('--scenario') ?? task.scenarios[0]?.id;
      const scenario = task.scenarios.find(item => item.id === scenarioId);
      if (!scenario) throw new Error(`Scenario ${scenarioId} was not found.`);
      scenario.execution = runbook as typeof scenario.execution;
      const invalidated = invalidateApproval(task);
      task.updatedAt = now(); saveTask(projectRoot, task); rebuildIndexes(projectRoot); output({ taskId: task.metadata.id, scenarioId, runbook: scenario.execution, approvalInvalidated: invalidated, message: invalidated ? 'Execution plan changed; present the updated test cases and obtain user confirmation again.' : undefined }); return;
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
    if (action === 'run') { const run = await executeTask(projectRoot, task, { environment: flag('--environment'), platform: flag('--platform'), role: flag('--role') }); rebuildIndexes(projectRoot); output(run); return; }
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
      const memory = reviewMemory(projectRoot, requiredFlag('--module'), subject, approve ? 'approve' : 'reject', (flag('--knowledge-level') as ProjectMemory['knowledgeLevel'] | undefined) ?? 'confirmed');
      rebuildIndexes(projectRoot); output(memory); return;
    }
  }
  if (group === 'adapter' && action === 'playwright') { configurePlaywrightAdapter(root(), requiredFlag('--base-url')); output({ message: 'Playwright adapter configuration saved. Add a deterministic task runbook before executing UI actions.' }); return; }
  if (group === 'source') {
    const projectRoot = root();
    if (action === 'search') { if (!subject) throw new Error('search text is required.'); output(searchSource(projectRoot, subject)); return; }
    if (action === 'diagnose') { output(diagnoseSource(projectRoot, requiredFlag('--module'), requiredFlag('--query'))); return; }
  }
  if (group === 'run') {
    const projectRoot = root();
    if (!subject) throw new Error('run id is required.');
    if (action === 'start') {
      const task = readTask(projectRoot, requiredFlag('--module'), subject);
      const started = beginAgentGuidedRun(projectRoot, task, { environment: flag('--environment'), platform: flag('--platform'), role: flag('--role') });
      rebuildIndexes(projectRoot); output(started); return;
    }
    const run = readJson(qaPath(projectRoot, 'runs', `${subject}.json`));
    if (action === 'show') return output(run);
    if (action === 'report') return output(qaPath(projectRoot, 'reports', `${subject}.md`));
    if (action === 'step') {
      const updated = recordAgentStep(projectRoot, subject, { action: requiredFlag('--action'), detail: requiredFlag('--detail'), status: (flag('--status') as RunStatus | undefined) ?? 'passed' });
      output(updated); return;
    }
    if (action === 'observe') {
      const updated = recordVisualFinding(projectRoot, subject, { scenarioId: requiredFlag('--scenario'), assertionId: requiredFlag('--assertion'), expected: requiredFlag('--expected'), actual: requiredFlag('--actual'), status: requiredFlag('--status') as RunStatus, screenshotPath: flag('--screenshot') });
      output(updated); return;
    }
    if (action === 'complete') {
      const updated = completeAgentGuidedRun(projectRoot, readTask(projectRoot, (run as { moduleId: string }).moduleId, (run as { taskId: string }).taskId), subject);
      rebuildIndexes(projectRoot); output(updated); return;
    }
    if (action === 'retry') {
      const previous = run as { taskId: string; moduleId: string; context: { environment: string; platform: string; role: string } };
      const retried = await executeTask(projectRoot, readTask(projectRoot, previous.moduleId, previous.taskId), previous.context, subject);
      rebuildIndexes(projectRoot); output(retried); return;
    }
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
