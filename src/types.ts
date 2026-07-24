export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type TaskLifecycleState = 'draft' | 'planning' | 'awaiting_approval' | 'ready' | 'running' | 'reviewing_result' | 'completed' | 'archived' | 'blocked' | 'paused' | 'retired';
export type RunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'paused' | 'inconclusive' | 'not_applicable' | 'adapted';
export type RunMode = 'explore';
export type VisualInspectionStatus = 'performed' | 'not-required' | 'not-applicable' | 'skipped';
export type KnowledgeLevel = 'confirmed' | 'observed' | 'inferred' | 'suspected' | 'deprecated';
export type UiAction = 'launch' | 'navigate' | 'click' | 'input' | 'fill' | 'swipe' | 'back' | 'wait' | 'assert' | 'screenshot' | 'reset' | 'restart-app';
export type StepExecutionMode = 'host-automated' | 'user-assisted' | 'system-component-blocked' | 'preseeded-test-data';
export type LocatorStrategy = 'test-id' | 'accessibility' | 'role' | 'label' | 'text' | 'css' | 'xpath' | 'coordinate' | 'semantic' | 'none';
export type ScreenshotPolicy = 'after-action' | 'on-state-change' | 'none';
export type VisualInspectionPolicy = 'required' | 'adaptive' | 'not-required';
export type PermissionStatus = 'verified' | 'missing' | 'unknown';
export type TestPriority = 'p0' | 'p1' | 'p2' | 'p3';
export type RegressionFrequency = 'every-change' | 'every-release' | 'scheduled' | 'manual';
export type RegressionProfile = 'fast' | 'normal' | 'full';
export type QaMode = 'quick' | 'guided' | 'regression';
export type ApprovalPolicy = 'test-plan-and-side-effects';
export type RegressionSelectionScope = 'task' | 'module' | 'release';
export type RegressionSelectionPolicy = 'all-validated-python-regressions' | 'priority-filtered' | 'release-gate-plus-impact';
export type PythonRegressionStatus = 'approved_unverified' | 'validated' | 'stale' | 'deprecated';
export type PythonRegressionBusinessStatus = 'passed' | 'failed' | 'blocked' | 'inconclusive';
export type PythonRegressionContractStatus = 'completed' | 'blocked' | 'invalid_result' | 'failed_to_start';
export type WorkflowStatus = 'setup_required' | 'approval_required' | 'ready_to_run' | 'running' | 'result_ready' | 'completed' | 'blocked';
export type WorkflowPhase = 'intake' | 'discovery' | 'planning' | 'approval' | 'preflight' | 'execution' | 'assertion' | 'result_review' | 'regression' | 'recovery' | 'archive';
export type WorkflowGateStatus = 'satisfied' | 'blocking' | 'not_required';
export interface WorkflowGate { id: string; status: WorkflowGateStatus; reasonCode?: string; requiredActor?: 'agent' | 'human' | 'runtime' | 'host'; artifactHash?: string; }
export interface NextAction { id: string; description: string; command?: string; requiresHuman: boolean; requiredActor?: 'agent' | 'human' | 'runtime' | 'host'; blockingGate?: string; }
export type WorkflowTodoStatus = 'pending' | 'in_progress' | 'blocked' | 'completed';

export interface WorkflowTodo { id: string; title: string; status: WorkflowTodoStatus; blocking?: boolean; }

export interface QaSessionBinding {
  apiVersion: 'qa-agent/session/v1';
  sessionKey: string;
  storageKey: string;
  host?: string;
  moduleId: string;
  taskId: string;
  runId?: string;
  boundAt: string;
  lastActiveAt: string;
}

export interface QaSessionClosure {
  apiVersion: 'qa-agent/session-closure/v1';
  sessionKey: string;
  storageKey: string;
  host?: string;
  moduleId: string;
  taskId: string;
  runId?: string;
  reason: 'finish';
  closedAt: string;
}

export interface SessionTaskCandidate {
  moduleId: string;
  taskId: string;
  title: string;
  taskState: TaskLifecycleState;
  mode?: QaMode;
  updatedAt: string;
}

export type ContinueStatus = 'action_ready' | 'human_decision_required' | 'blocked' | 'result_ready' | 'completed' | 'no_active_task' | 'task_selection_required';

export type FinishStatus = 'finished' | 'task_preserved' | 'blocked' | 'no_active_task' | 'task_selection_required';

export type UserFacingArtifactKind = 'task-prd' | 'source-run-report' | 'source-run-diagnostic' | 'python-regression-report' | 'python-regression-diagnostic' | 'scenario-regression-draft';

export interface UserFacingArtifact {
  kind: UserFacingArtifactKind;
  label: string;
  path: string;
  workspacePath: string;
  fileUrl: string;
  markdownLink: string;
  absoluteMarkdownLink: string;
}

export interface FinishResult {
  apiVersion: 'qa-agent/finish/v1';
  kind: 'FinishResult';
  status: FinishStatus;
  session?: QaSessionBinding;
  closure?: QaSessionClosure;
  task?: SessionTaskCandidate;
  candidates?: SessionTaskCandidate[];
  workflow?: QaWorkflowState;
  finalization?: TaskFinalizationResult;
  userFacingArtifacts?: UserFacingArtifact[];
  userMessage: string;
}

export interface TaskFinalizationState {
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  sourceRunId: string;
  prdRef: 'prd.md';
  startedAt?: string;
  finalizedAt?: string;
  updatedAt: string;
  artifactHash?: string;
  error?: string;
}

export interface TaskFinalizationResult {
  apiVersion: 'qa-agent/task-finalization/v1';
  kind: 'TaskFinalizationResult';
  status: 'completed' | 'failed';
  moduleId: string;
  taskId: string;
  sourceRunId: string;
  prdPath?: string;
  artifactHash?: string;
  error?: string;
}

export interface PythonRegressionDraft {
  apiVersion: 'qa-agent/python-regression-draft/v2';
  kind: 'PythonRegressionDraft';
  id: string;
  moduleId: string;
  taskId: string;
  sessionKey: string;
  sourceRunId: string;
  sourceReportRef: string;
  sourcePlanHash: string;
  sourceStepIds: string[];
  scenarioIds: string[];
  sourceFlowHash: string;
  scriptRef: string;
  scriptHash: string;
  status: 'draft';
  createdBy: 'agent';
  createdAt: string;
  updatedAt: string;
}

export interface PythonRegressionManifest {
  apiVersion: 'qa-agent/python-regression/v2';
  kind: 'PythonRegression';
  id: string;
  version: number;
  name: string;
  moduleId: string;
  taskId: string;
  scriptRef: string;
  sourceRunId: string;
  sourceReportRef: string;
  sourcePlanHash: string;
  sourceStepIds: string[];
  scenarioIds: string[];
  sourceFlowHash: string;
  scriptHash: string;
  status: PythonRegressionStatus;
  approvedBy: string;
  approvalSource: 'current-chat-explicit-approval' | 'external-review-record';
  approvedAt: string;
  validatedByRunId?: string;
  validatedAt?: string;
  lastRunId?: string;
  lastRunStatus?: PythonRegressionBusinessStatus;
  staleReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PythonRegressionScriptResult {
  apiVersion: 'qa-agent/python-regression-result/v1';
  status: PythonRegressionBusinessStatus;
  contractStatus: 'completed' | 'blocked';
  conclusion: string;
  steps: Array<{
    id: string;
    name: string;
    status: PythonRegressionBusinessStatus;
    expected?: string;
    actual?: string;
    screenshot?: string;
  }>;
  cleanup?: Array<{
    name: string;
    status: PythonRegressionBusinessStatus;
    actual?: string;
    screenshot?: string;
  }>;
  evidence?: Array<{ type: string; path?: string; summary: string }>;
}

export interface PythonRegressionRun {
  apiVersion: 'qa-agent/python-regression-run/v1';
  kind: 'PythonRegressionRun';
  id: string;
  regressionId: string;
  moduleId: string;
  taskId: string;
  scriptRef: string;
  scriptHash: string;
  sourceRunId: string;
  status: PythonRegressionBusinessStatus;
  contractStatus: PythonRegressionContractStatus;
  exitCode?: number;
  resultRef?: string;
  reportRef: string;
  stdoutRef: string;
  stderrRef: string;
  screenshots: string[];
  conclusion: string;
  startedAt: string;
  completedAt: string;
}

export interface ContinueResult {
  apiVersion: 'qa-agent/continue/v1';
  kind: 'ContinueResult';
  status: ContinueStatus;
  session?: QaSessionBinding;
  task?: SessionTaskCandidate;
  candidates?: SessionTaskCandidate[];
  workflow?: QaWorkflowState;
  finalization?: TaskFinalizationResult;
  userFacingArtifacts?: UserFacingArtifact[];
  nextAction?: {
    id: string;
    owner: 'runtime' | 'agent' | 'host' | 'human';
    description: string;
    command?: string;
  };
  userMessage: string;
}

export interface QaWorkflowState {
  apiVersion: 'qa-agent/v3';
  kind: 'WorkflowState';
  request?: string;
  moduleId: string;
  taskId: string;
  taskDirectory?: string;
  taskDirectoryAbsolute?: string;
  taskAssetsReady: boolean;
  workflowStatus: WorkflowStatus;
  taskState: TaskLifecycleState;
  workflowPhase: WorkflowPhase;
  reasonCode: string;
  gates: WorkflowGate[];
  uiExecutionAllowed: boolean;
  mustStop: boolean;
  manualReportAllowed: false;
  runId?: string;
  plan?: object;
  todoList: WorkflowTodo[];
  allowedActions: string[];
  forbiddenActions: string[];
  /** Compatibility field; prefer nextActions. */
  nextAllowedAction: string;
  nextActions: NextAction[];
  breadcrumb: string;
  resumeToken?: string;
  contextHash: string;
  bootstrap?: { moduleCreated: boolean; taskCreated: boolean; taskDirectory: string; taskAssets: string[] };
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
  requirementTrace?: RequirementTrace[];
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
  recoveryPolicy: { maxRecoveryAttempts: number; allowSandboxDataReset: boolean };
  status: 'draft' | 'awaiting_confirmation' | 'approved' | 'superseded';
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementTrace {
  requirementId: string;
  scenarioIds: string[];
  assertionIds: string[];
  sourceRefs: string[];
  status: 'covered' | 'partial' | 'not_covered' | 'deferred';
}

export interface VisualAssertion {
  id: string;
  expected: string;
  businessRuleRef?: string;
  importance: RiskLevel;
}

export interface PlannedTestStep {
  id: string;
  action: string;
  expected: string;
}

export interface EvidencePolicy {
  capture: 'every-action' | 'action-and-key-state';
  visual: 'adaptive' | 'strict' | 'minimal';
  required: string[];
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
  storage: { format: 'json' };
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

export type ScenarioPlanningStatus = 'applicable' | 'not_applicable' | 'deferred' | 'needs_user_decision';

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
  planningStatus?: ScenarioPlanningStatus;
  priority?: TestPriority;
  requirementRefs?: string[];
  sourceRefs?: string[];
  deferredReason?: string;
  plannedSteps: PlannedTestStep[];
  visualAssertions?: VisualAssertion[];
}

export interface PlanDraftAssertion {
  id?: string;
  expected: string;
  importance?: RiskLevel;
  businessRuleRef?: string;
}

export interface PlanDraftStep {
  id?: string;
  action: string;
  expected: string;
}

export interface PlanDraftScenario {
  id?: string;
  title: string;
  intent: string;
  input?: Record<string, unknown>;
  preconditions?: string[];
  expected: Record<string, unknown> | string;
  evidence?: string[];
  cleanup?: string[];
  risk?: RiskLevel;
  planningStatus?: ScenarioPlanningStatus;
  priority?: TestPriority;
  requirementRefs?: string[];
  sourceRefs?: string[];
  steps: PlanDraftStep[];
  visualAssertions?: PlanDraftAssertion[];
}

export interface PlanDraft {
  apiVersion: 'qa-agent/plan-draft/v1';
  moduleId: string;
  taskId: string;
  taskName?: string;
  description: string;
  objectives: string[];
  scope?: {
    platforms?: string[];
    environments?: string[];
    roles?: string[];
    included?: string[];
    excluded?: string[];
  };
  preconditions?: string[];
  testDataRefs?: string[];
  sourceRefs?: string[];
  risks?: string[];
  userQuestions?: string[];
  confirmedDecisions?: string[];
  scenarios: PlanDraftScenario[];
}

export interface TestTask {
  $schema: string;
  apiVersion: 'qa-agent/v2';
  kind: 'TestTask';
  metadata: {
    id: string; name: string; moduleId: string; version: number; status: TaskLifecycleState;
    priority: TestPriority; tags: string[];
    mode?: QaMode;
    approvalPolicy?: ApprovalPolicy;
    frequency?: RegressionFrequency; releaseGate?: boolean; estimatedDurationMinutes?: number;
    planReview?: { confirmedBy: string; confirmedAt: string; confirmationSource: 'current-chat-explicit-approval' | 'external-review-record'; statement: string; planHash: string };
    approval?: { confirmedBy: string; confirmedAt: string; confirmationSource: 'current-chat-explicit-approval' | 'external-review-record'; statement: string; planHash: string };
  };
  moduleSnapshotRef: string;
  requirementsRef: string;
  testPlanRef: string;
  scenarioRefs: string[];
  prdRef?: 'prd.md';
  finalization?: TaskFinalizationState;
  pythonRegressionRefs?: string[];
  sourceRunRef?: 'source-run/run.json';
  sourceReportRef?: 'source-run/report.md';
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
  recoveryPolicy: { maxRecoveryAttempts: number; allowSandboxDataReset: boolean };
  regression: { triggers: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface PythonRegressionSelectionMember {
  taskId: string;
  moduleId: string;
  regressionId: string;
  scriptRef: string;
  scriptHash: string;
  sourcePlanHash: string;
  scenarioIds: string[];
  priority: TestPriority;
  frequency: RegressionFrequency;
  releaseGate: boolean;
  estimatedDurationMinutes: number;
  tags: string[];
  selectionReason?: string;
  order: number;
}

export interface PythonRegressionSelection {
  apiVersion: 'qa-agent/python-regression-selection/v1';
  kind: 'PythonRegressionSelection';
  id: string;
  scope: RegressionSelectionScope;
  name: string;
  purpose: string;
  moduleId: string;
  moduleIds: string[];
  taskId?: string;
  members: PythonRegressionSelectionMember[];
  selectionPolicy: RegressionSelectionPolicy;
  priorityThreshold: TestPriority;
  releaseGate: boolean;
  estimatedDurationMinutes: number;
  impactedModules?: string[];
  selectionReasons?: string[];
  requiredAssetGaps?: Array<{ moduleId: string; taskId: string; priority: TestPriority; releaseGate: boolean; goldenPath: boolean; reason: string }>;
  selectionHash: string;
  status: 'ready' | 'blocked';
  generatedAt: string;
}

export interface RegressionRun {
  apiVersion: 'qa-agent/python-regression-batch-run/v1';
  kind: 'PythonRegressionBatchRun';
  id: string;
  selectionId: string;
  selectionName: string;
  selectionScope: RegressionSelectionScope;
  selectionHash: string;
  moduleId: string;
  moduleIds: string[];
  priorityThreshold: TestPriority;
  releaseGate: boolean;
  status: PythonRegressionBusinessStatus;
  childRuns: Array<{
    regressionRunId?: string;
    regressionId: string;
    taskId: string;
    moduleId: string;
    scenarioIds: string[];
    priority: TestPriority;
    releaseGate: boolean;
    status: PythonRegressionBusinessStatus;
    contractStatus: PythonRegressionContractStatus;
    reportPath?: string;
    detail?: string;
  }>;
  failurePolicy: 'continue-independent';
  startedAt: string;
  completedAt: string;
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
  selection: PythonRegressionSelection;
  regressionRunId?: string;
  status: 'planned' | 'running' | 'passed' | 'failed' | 'blocked' | 'review';
  releaseDecision: 'pending' | 'go' | 'no-go' | 'review';
  blockers: Array<{ moduleId: string; taskId: string; regressionId: string; scenarioIds: string[]; status: PythonRegressionBusinessStatus; detail?: string }>;
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

export interface HumanStepApproval {
  id: string;
  confirmedBy: string;
  confirmationSource: 'current-chat-explicit-approval' | 'external-review-record';
  statement: string;
  confirmedAt: string;
}

export type GuidedPendingInteraction =
  | { type: 'execute_action'; scenarioId: string; plannedStepId?: string; action: string; expected: string; approval: HumanStepApproval }
  | { type: 'result_verdict'; stepId: string };

export interface ScenarioRegressionDraft {
  scenarioId: string;
  scriptId: string;
  scriptRef: string;
  manifestRef: string;
  sourceStepIds: string[];
  sourceFlowHash: string;
  scriptHash: string;
  generatedAt: string;
}

export interface TestRun {
  $schema: string;
  id: string;
  taskId: string;
  moduleId: string;
  planHash?: string;
  context: ExecutionSnapshot;
  git: { branch?: string; commit?: string; dirtyWorkspace: boolean; changedFiles: string[] };
  status: RunStatus;
  blockActor?: 'human' | 'host' | 'agent';
  safeMode: boolean;
  mode: 'explore';
  guidedPending?: GuidedPendingInteraction;
  steps: Array<{ id: string; plannedStepId?: string; action: string; uiAction?: UiAction; safetyAction?: string; status: RunStatus; detail: string; at: string; scenarioId?: string; screenshotPath?: string; visualInspection?: VisualInspectionStatus; source?: 'ui' | 'internal' | 'recovery'; executionMode?: StepExecutionMode; locator?: Locator; actualLocator?: Locator; inputRefs?: Record<string, string>; expectedState?: string; actualState?: string; adaptation?: string; humanApproval?: HumanStepApproval; humanVerdict?: { status: RunStatus; confirmedBy: string; confirmationSource?: 'current-chat-explicit-approval' | 'external-review-record'; statement: string; note?: string; confirmedAt: string } }>;
  scenarioResults: Array<{ scenarioId: string; status: RunStatus; detail?: string }>;
  evidence: Array<{ type: string; path?: string; summary: string }>;
  conclusion?: string;
  reportPath?: string;
  reportGeneratedBy?: 'qa-agent-runtime';
  reportGeneratedAt?: string;
  retryOf?: string;
  scenarioId?: string;
  screenshots: Array<{ stepId: string; path: string; capturedAt: string; visualInspection: VisualInspectionStatus; summary: string }>;
  recoveryAttempts: Array<{ id: string; reason: string; action: string; outcome: 'continued' | 'blocked' | 'paused' | 'failed'; detail: string; failedStepId?: string; at: string }>;
  cleanupFindings: Array<{ scenarioId: string; cleanup: string; actual: string; status: RunStatus; screenshotPath?: string; at: string }>;
  pythonRegressionEligibility?: { eligible: boolean; sourceStepIds: string[]; scenarioIds: string[]; flowHash?: string; issues: Array<{ scenarioId: string; reasons: string[] }> };
  scenarioRegressionDrafts?: ScenarioRegressionDraft[];
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
