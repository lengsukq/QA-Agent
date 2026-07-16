export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type TaskStatus = 'draft' | 'ready' | 'active' | 'blocked' | 'needs_review' | 'deprecated' | 'archived';
export type RunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'paused' | 'inconclusive' | 'not_applicable' | 'needs_confirmation';
export type KnowledgeLevel = 'confirmed' | 'observed' | 'inferred' | 'suspected' | 'deprecated';
export type BrowserAction = 'navigate' | 'click' | 'fill' | 'assert-visible' | 'assert-hidden' | 'assert-text' | 'assert-url' | 'wait-for' | 'screenshot';

export interface BrowserStep {
  id: string;
  action: BrowserAction;
  locator?: string;
  value?: string;
  expected?: string;
  timeoutMs?: number;
  safetyAction?: string;
  description?: string;
}

export interface VisualAssertion {
  id: string;
  expected: string;
  businessRuleRef?: string;
  importance: RiskLevel;
}

export interface ProjectConfig {
  $schema: string;
  version: 1;
  project: { id: string; name: string; description: string; businessGoals?: string[]; crossModuleFlows?: string[] };
  platforms: string[];
  environments?: string[];
  roles?: string[];
  defaultContext: { environment: string; platform: string; role: string };
  source: { mode: 'local-readonly'; root: string };
  storage: { format: 'json'; runIndexFormat: 'jsonl' };
  createdAt: string;
  updatedAt: string;
}

export interface QaModule {
  $schema: string;
  version: 1;
  id: string;
  name: string;
  description: string;
  status: 'active' | 'deprecated' | 'archived';
  riskLevel: RiskLevel;
  platforms: string[];
  roles: string[];
  dependencies: string[];
  businessGoals: string[];
  sourceHints: string[];
  entryPoints?: string[];
  coreFlows?: string[];
  businessRules?: string[];
  keyStates?: string[];
  regressionFocus?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TestScenario {
  id: string;
  title: string;
  input: Record<string, unknown>;
  preconditions: string[];
  intent: string;
  expected: Record<string, unknown>;
  evidence: string[];
  cleanup: string[];
  risk: RiskLevel;
  execution?: { startPath?: string; steps: BrowserStep[] };
  visualAssertions?: VisualAssertion[];
}

export interface TestTask {
  $schema: string;
  apiVersion: 'qa-agent/v1';
  kind: 'TestTask';
  metadata: {
    id: string; name: string; moduleId: string; version: number; status: TaskStatus;
    priority: 'p0' | 'p1' | 'p2' | 'p3'; tags: string[];
    approval?: { confirmedBy: string; confirmedAt: string; statement: string; planHash: string };
  };
  description: string;
  objectives: string[];
  scope: { platforms: string[]; environments: string[]; roles: string[] };
  preconditions: string[];
  memoryRefs: string[];
  scenarios: TestScenario[];
  requiredSkills: string[];
  capabilities: { required: string[]; optional: string[] };
  safety: { safeMode: boolean; stopBefore: string[] };
  evidence: { required: string[] };
  regression: { triggers: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMemory {
  $schema: string;
  id: string;
  moduleId?: string;
  type: string;
  title: string;
  content: string;
  structuredRule?: Record<string, unknown>;
  scope: { environments: string[]; platforms: string[]; roles: string[] };
  knowledgeLevel: KnowledgeLevel;
  confidence: number;
  importance: RiskLevel;
  status: 'candidate' | 'active' | 'superseded' | 'deprecated';
  version: number;
  supersedes?: string;
  source: { type: string; reference: string };
  createdAt: string;
  updatedAt: string;
}

export interface TestRun {
  $schema: string;
  id: string;
  taskId: string;
  moduleId: string;
  context: { environment: string; platform: string; role: string };
  git: { branch?: string; commit?: string; dirtyWorkspace: boolean; changedFiles: string[] };
  status: RunStatus;
  safeMode: boolean;
  steps: Array<{ id: string; action: string; status: RunStatus; detail: string; at: string }>;
  scenarioResults: Array<{ scenarioId: string; status: RunStatus; detail?: string }>;
  evidence: Array<{ type: string; path?: string; summary: string }>;
  conclusion?: string;
  reportPath?: string;
  retryOf?: string;
  memoryCandidates?: string[];
  visualFindings: Array<{ scenarioId: string; assertionId: string; expected: string; actual: string; status: RunStatus; screenshotPath?: string; at: string }>;
  startedAt: string;
  completedAt?: string;
}

export interface CapabilityStatus {
  available: string[];
  missing: string[];
  optionalMissing: string[];
}
