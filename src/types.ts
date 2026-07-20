export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type TaskStatus = 'draft' | 'ready' | 'active' | 'blocked' | 'needs_review' | 'deprecated' | 'archived';
export type RunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'paused' | 'inconclusive' | 'not_applicable' | 'needs_confirmation' | 'adapted';
export type ReplayStatus = 'not_replay' | 'replayed' | 'adapted';
export type VisualInspectionStatus = 'performed' | 'not-required' | 'not-applicable' | 'skipped';
export type ReplayStage = 'idle' | 'ready' | 'preflight_passed' | 'step_pending' | 'executing' | 'screenshot_captured' | 'visual_check_optional' | 'assertion_checked' | 'next_step' | 'completed' | 'blocked' | 'needs_confirmation';
export type KnowledgeLevel = 'confirmed' | 'observed' | 'inferred' | 'suspected' | 'deprecated';
export type OperationAction = 'launch' | 'navigate' | 'click' | 'input' | 'fill' | 'swipe' | 'back' | 'wait' | 'assert' | 'screenshot' | 'reset' | 'restart-app';
export type StepExecutionMode = 'host-automated' | 'user-assisted' | 'system-component-blocked' | 'preseeded-test-data';
export type LocatorStrategy = 'test-id' | 'accessibility' | 'role' | 'label' | 'text' | 'css' | 'xpath' | 'coordinate' | 'semantic' | 'none';
export type ScreenshotPolicy = 'after-action' | 'on-state-change' | 'none';
export type VisualInspectionPolicy = 'required' | 'adaptive' | 'not-required';
export type PermissionStatus = 'verified' | 'missing' | 'unknown';
export type TestPriority = 'p0' | 'p1' | 'p2' | 'p3';
export type RegressionFrequency = 'every-change' | 'every-release' | 'scheduled' | 'manual';
export type RegressionProfile = 'fast' | 'normal' | 'full';
export type RegressionSuiteScope = 'task' | 'module' | 'release';
export type RegressionSuiteStatus = 'draft' | 'active' | 'stale' | 'superseded';
export type RegressionSelectionPolicy = 'all-active-operation-plans' | 'priority-filtered' | 'impact-filtered' | 'release-gate-plus-impact';
export type WorkflowStatus = 'setup_required' | 'approval_required' | 'ready_to_run' | 'running' | 'completed' | 'blocked';
export type WorkflowTodoStatus = 'pending' | 'in_progress' | 'blocked' | 'completed';

export interface WorkflowTodo { id: string; title: string; status: WorkflowTodoStatus; blocking?: boolean; }

export interface QaWorkflowState {
  apiVersion: 'qa-agent/v2';
  kind: 'WorkflowState';
  request?: string;
  moduleId: string;
  taskId: string;
  taskDirectory?: string;
  workflowStatus: WorkflowStatus;
  uiExecutionAllowed: boolean;
  runId?: string;
  plan?: object;
  promptBundle: { bundleHash: string; current: boolean; missing: string[]; stale: string[] };
  todoList: WorkflowTodo[];
  nextAllowedAction: string;
}

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

export interface ModuleSnapshot {
  $schema: string;
  apiVersion: 'qa-agent/v2';
  kind: 'ModuleSnapshot';
  moduleId: string;
  moduleName: string;
  moduleRevision: number;
  snapshotHash: string;
  platforms: string[];
  roles: string[];
  businessGoals: string[];
  coreFlows: string[];
  businessRules: string[];
  keyStates: string[];
  regressionFocus: string[];
  capturedAt: string;
}

export interface TestRequirements {
  $schema: string;
  apiVersion: 'qa-agent/v2';
  kind: 'TestRequirements';
  taskId: string;
  moduleId: string;
  businessGoals: string[];
  actors: string[];
  flows: string[];
  rules: Array<{ id: string; statement: string; knowledgeLevel: KnowledgeLevel; source?: string }>;
  scope: { included: string[]; excluded: string[] };
  preconditions: string[];
  testDataRefs: string[];
  environments: string[];
  sourceRefs: string[];
  risks: string[];
  userQuestions: string[];
  confirmedDecisions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TestPlan {
  $schema: string;
  apiVersion: 'qa-agent/v2';
  kind: 'TestPlan';
  taskId: string;
  moduleId: string;
  version: number;
  planHash: string;
  scenarioRefs: string[];
  requiredSkills: string[];
  capabilities: { required: string[]; optional: string[] };
  safety: { safeMode: boolean; stopBefore: string[] };
  evidencePolicy: EvidencePolicy;
  recoveryPolicy: { maxRetries: number; maxRecoveryAttempts: number; allowSandboxDataReset: boolean };
  status: 'draft' | 'awaiting_confirmation' | 'approved' | 'superseded';
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
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
  executionMode?: StepExecutionMode;
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
  source: { mode: 'host-provided'; root: string };
  storage: { format: 'json'; runIndexFormat: 'jsonl' };
  createdAt: string;
  updatedAt: string;
}

export interface QaModule {
  $schema: string;
  version: 1;
  id: string;
  revision: number;
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
  visualAssertions?: VisualAssertion[];
}

export interface TestTask {
  $schema: string;
  apiVersion: 'qa-agent/v2';
  kind: 'TestTask';
  metadata: {
    id: string; name: string; moduleId: string; version: number; status: TaskStatus;
    priority: TestPriority; tags: string[];
    frequency?: RegressionFrequency; releaseGate?: boolean; estimatedDurationMinutes?: number;
    approval?: { confirmedBy: string; confirmedAt: string; confirmationSource: 'current-chat-explicit-approval' | 'external-review-record'; statement: string; planHash: string };
  };
  moduleSnapshotRef: string;
  requirementsRef: string;
  testPlanRef: string;
  scenarioRefs: string[];
  regressionSuiteRef: string;
  reportIndexRef: string;
  runRefs: string[];
  moduleSnapshot?: ModuleSnapshot;
  requirements?: TestRequirements;
  testPlan?: TestPlan;
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

export interface RegressionSuiteMember {
  taskId: string;
  moduleId: string;
  scenarioId: string;
  operationPlanId: string;
  operationPlanRef: string;
  operationVersion: number;
  taskPlanHash: string;
  priority: TestPriority;
  frequency: RegressionFrequency;
  releaseGate: boolean;
  estimatedDurationMinutes: number;
  tags: string[];
  selectionReason?: string;
  order: number;
}

export interface RegressionSuite {
  $schema: string;
  apiVersion: 'qa-agent/v2';
  kind: 'RegressionSuite';
  id: string;
  version: number;
  scope: RegressionSuiteScope;
  name: string;
  purpose: string;
  moduleId: string;
  moduleIds: string[];
  taskId?: string;
  members: RegressionSuiteMember[];
  selectionPolicy: RegressionSelectionPolicy;
  priorityThreshold: TestPriority;
  releaseGate: boolean;
  estimatedDurationMinutes: number;
  impactedModules?: string[];
  selectionReasons?: string[];
  requiredAssetGaps?: Array<{ moduleId: string; taskId: string; priority: TestPriority; releaseGate: boolean; goldenPath: boolean; reason: string }>;
  failurePolicy: 'continue-independent';
  contextPolicy: 'current-context';
  suiteHash: string;
  status: RegressionSuiteStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RegressionRun {
  $schema: string;
  apiVersion: 'qa-agent/v2';
  kind: 'RegressionRun';
  id: string;
  suiteId: string;
  suiteName: string;
  suiteScope: RegressionSuiteScope;
  suiteVersion: number;
  suiteHash: string;
  moduleId: string;
  moduleIds: string[];
  priorityThreshold: TestPriority;
  releaseGate: boolean;
  context: ExecutionSnapshot;
  status: RunStatus;
  childRuns: Array<{ runId: string; taskId: string; moduleId: string; scenarioId: string; operationPlanId: string; priority: TestPriority; releaseGate: boolean; status: RunStatus; reportPath?: string; detail?: string }>;
  failurePolicy: 'continue-independent';
  startedAt: string;
  completedAt?: string;
  reportPath?: string;
}

export interface ImpactAnalysis {
  $schema: string;
  apiVersion: 'qa-agent/v2';
  kind: 'ImpactAnalysis';
  id: string;
  base?: string;
  head?: string;
  changedFiles: string[];
  impactedModules: Array<{ moduleId: string; score: number; reasons: string[]; changedFiles: string[] }>;
  selectedTasks: Array<{ moduleId: string; taskId: string; priority: TestPriority; reasons: string[] }>;
  unmatchedFiles: string[];
  generatedAt: string;
}

export interface ReleaseCheck {
  $schema: string;
  apiVersion: 'qa-agent/v2';
  kind: 'ReleaseCheck';
  id: string;
  version: number;
  name: string;
  profile: RegressionProfile;
  base?: string;
  head?: string;
  priorityThreshold: TestPriority;
  impactAnalysis: ImpactAnalysis;
  suite: RegressionSuite;
  regressionRunId?: string;
  status: 'planned' | 'running' | 'passed' | 'failed' | 'blocked' | 'needs_confirmation' | 'review';
  releaseDecision: 'pending' | 'go' | 'no-go' | 'review';
  blockers: Array<{ moduleId: string; taskId: string; scenarioId: string; status: RunStatus; detail?: string }>;
  requiredAssetGaps: Array<{ moduleId: string; taskId: string; priority: TestPriority; releaseGate: boolean; goldenPath: boolean; reason: string }>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  reportPath?: string;
}

export interface ProjectMemory {
  $schema: string;
  id: string;
  moduleId?: string;
  taskId?: string;
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
  steps: Array<{ id: string; action: string; operationAction?: OperationAction; safetyAction?: string; status: RunStatus; detail: string; at: string; scenarioId?: string; screenshotPath?: string; visualInspection?: VisualInspectionStatus; source?: 'ui' | 'internal' | 'recovery' | 'operation-replay'; executionMode?: StepExecutionMode; operationStepId?: string; locator?: Locator; actualLocator?: Locator; inputRefs?: Record<string, string>; expectedState?: string; actualState?: string; adaptation?: string }>;
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
  cleanupFindings: Array<{ scenarioId: string; cleanup: string; actual: string; status: RunStatus; screenshotPath?: string; at: string }>;
  operationCandidates?: string[];
  operationCandidateIssues?: Array<{ scenarioId: string; reasons: string[] }>;
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
