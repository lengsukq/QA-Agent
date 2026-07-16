export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type TaskStatus = 'draft' | 'ready' | 'active' | 'blocked' | 'needs_review' | 'deprecated' | 'archived';
export type RunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'paused' | 'inconclusive' | 'not_applicable' | 'needs_confirmation' | 'adapted';
export type ReplayStatus = 'not_replay' | 'replayed' | 'adapted';
export type VisualInspectionStatus = 'performed' | 'not-required' | 'not-applicable' | 'skipped';
export type ReplayStage = 'idle' | 'ready' | 'preflight_passed' | 'step_pending' | 'executing' | 'screenshot_captured' | 'visual_check_optional' | 'assertion_checked' | 'next_step' | 'completed' | 'blocked' | 'needs_confirmation';
export type KnowledgeLevel = 'confirmed' | 'observed' | 'inferred' | 'suspected' | 'deprecated';
export type BrowserAction = 'navigate' | 'click' | 'fill' | 'assert-visible' | 'assert-hidden' | 'assert-text' | 'assert-url' | 'wait-for' | 'screenshot';
export type OperationAction = 'launch' | 'navigate' | 'click' | 'input' | 'fill' | 'swipe' | 'back' | 'wait' | 'assert' | 'screenshot' | 'reset' | 'restart-app';
export type LocatorStrategy = 'test-id' | 'accessibility' | 'role' | 'label' | 'text' | 'css' | 'xpath' | 'coordinate' | 'semantic' | 'none';
export type ScreenshotPolicy = 'after-action' | 'on-state-change' | 'none';
export type VisualInspectionPolicy = 'required' | 'adaptive' | 'not-required';
export type PermissionStatus = 'verified' | 'missing' | 'unknown';

export interface Locator {
  strategy: LocatorStrategy;
  value?: string;
  fallbacks?: Locator[];
}

export interface ExecutionSnapshot {
  environment: string;
  platform: string;
  role: string;
  scenarioId?: string;
  device?: string;
  deviceModel?: string;
  osVersion?: string;
  appVersion?: string;
  webBuild?: string;
  testDataFingerprint?: string;
  mcpSnapshot: Array<{ id: string; status: string; capabilities: string[]; version?: string; permissionStatus: PermissionStatus }>;
  permissionSnapshot: { status: PermissionStatus; permissions: Array<{ name: string; status: PermissionStatus; detail?: string }> };
}

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

export interface EvidencePolicy {
  capture: 'every-action' | 'action-and-key-state';
  visual: 'adaptive' | 'strict' | 'minimal';
  required: string[];
}

export interface OperationStep {
  id: string;
  scenarioId: string;
  action: OperationAction;
  intent: string;
  preconditions: string[];
  locator?: Locator;
  fallbackLocators?: Locator[];
  inputRefs?: Record<string, string>;
  expectedState?: string;
  assertionRefs?: string[];
  screenshotPolicy: ScreenshotPolicy;
  visualInspectionPolicy: VisualInspectionPolicy;
  safetyAction?: string;
  checkpoint?: boolean;
}

export interface OperationPlan {
  $schema: string;
  apiVersion: 'qa-agent/v2';
  kind: 'OperationPlan';
  id: string;
  version: number;
  status: 'candidate' | 'active' | 'superseded' | 'deprecated';
  taskId: string;
  moduleId: string;
  scenarioId: string;
  executionSnapshot: ExecutionSnapshot;
  planHash: string;
  steps: OperationStep[];
  preconditions: string[];
  cleanup: string[];
  capabilities: string[];
  sourceRunId: string;
  successfulRuns: number;
  supersedes?: string;
  adaptationHistory?: Array<{ runId: string; detail: string; at: string }>;
  createdAt: string;
  updatedAt: string;
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
  apiVersion: 'qa-agent/v2';
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
  evidencePolicy: EvidencePolicy;
  operationPlanRefs: string[];
  recoveryPolicy: { maxRetries: number; maxRecoveryAttempts: number; allowSandboxDataReset: boolean };
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
  context: ExecutionSnapshot;
  git: { branch?: string; commit?: string; dirtyWorkspace: boolean; changedFiles: string[] };
  status: RunStatus;
  safeMode: boolean;
  steps: Array<{ id: string; action: string; operationAction?: OperationAction; safetyAction?: string; status: RunStatus; detail: string; at: string; scenarioId?: string; screenshotPath?: string; visualInspection?: VisualInspectionStatus; source?: 'ui' | 'internal' | 'recovery' | 'operation-replay'; operationStepId?: string; locator?: Locator; actualLocator?: Locator; inputRefs?: Record<string, string>; expectedState?: string; actualState?: string; adaptation?: string }>;
  scenarioResults: Array<{ scenarioId: string; status: RunStatus; detail?: string }>;
  evidence: Array<{ type: string; path?: string; summary: string }>;
  conclusion?: string;
  reportPath?: string;
  retryOf?: string;
  replayStatus: ReplayStatus;
  replayStage: ReplayStage;
  operationPlanId?: string;
  operationVersion?: number;
  scenarioId?: string;
  replayCursor?: number;
  screenshots: Array<{ stepId: string; path: string; capturedAt: string; visualInspection: VisualInspectionStatus; summary: string }>;
  recoveryAttempts: Array<{ id: string; reason: string; action: string; outcome: 'continued' | 'blocked' | 'paused' | 'failed'; detail: string; failedStepId?: string; at: string }>;
  operationCandidates?: string[];
  memoryCandidates?: string[];
  visualFindings: Array<{ scenarioId: string; assertionId: string; expected: string; actual: string; status: RunStatus; screenshotPath?: string; visualInspection: 'performed'; inspectionProvider?: string; at: string }>;
  startedAt: string;
  completedAt?: string;
}

export interface CapabilityStatus {
  available: string[];
  missing: string[];
  optionalMissing: string[];
}
