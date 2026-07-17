export interface QaSkillManifest {
  apiVersion: 'qa-agent/v2';
  kind: 'Skill';
  metadata: { name: string; version: string; description: string; lifecycle: 'active' };
  requirements: { capabilities: { required: string[]; optional: string[] } };
  safety: { riskLevel: 'low' | 'medium'; writeAccess: false };
  outputs: { type: 'object'; properties: Record<string, unknown> };
}

export const builtInSkills: QaSkillManifest[] = [
  { apiVersion: 'qa-agent/v2', kind: 'Skill', metadata: { name: 'execution.contract', version: '2.0.0', description: 'Validate host-supplied UI operation results against the approved test plan and safety policy.', lifecycle: 'active' }, requirements: { capabilities: { required: [], optional: ['browser.interact', 'android.adb', 'ios.simulator.interact'] } }, safety: { riskLevel: 'medium', writeAccess: false }, outputs: { type: 'object', properties: { acceptedSteps: { type: 'array' } } } },
  { apiVersion: 'qa-agent/v2', kind: 'Skill', metadata: { name: 'evidence.record', version: '2.0.0', description: 'Import screenshots, logs, traces, source findings, and other artifacts produced by host tools.', lifecycle: 'active' }, requirements: { capabilities: { required: [], optional: ['browser.inspect', 'network.read', 'logs.read', 'source.readonly'] } }, safety: { riskLevel: 'low', writeAccess: false }, outputs: { type: 'object', properties: { evidence: { type: 'array' } } } },
  { apiVersion: 'qa-agent/v2', kind: 'Skill', metadata: { name: 'operation.replay', version: '2.0.0', description: 'Enforce an approved project-local OperationPlan while the host Agent performs each operation.', lifecycle: 'active' }, requirements: { capabilities: { required: [], optional: ['browser.interact', 'android.adb', 'ios.simulator.interact'] } }, safety: { riskLevel: 'medium', writeAccess: false }, outputs: { type: 'object', properties: { replayStatus: { type: 'string' }, operationId: { type: 'string' }, adaptations: { type: 'array' } } } },
  { apiVersion: 'qa-agent/v2', kind: 'Skill', metadata: { name: 'report.generate', version: '2.0.0', description: 'Generate a Markdown QA report from the Run, assertions, and evidence.', lifecycle: 'active' }, requirements: { capabilities: { required: [], optional: [] } }, safety: { riskLevel: 'low', writeAccess: false }, outputs: { type: 'object', properties: { reportPath: { type: 'string' } } } },
  { apiVersion: 'qa-agent/v2', kind: 'Skill', metadata: { name: 'memory.curate', version: '2.0.0', description: 'Distill run outcomes into candidate project memory and update durable knowledge after review.', lifecycle: 'active' }, requirements: { capabilities: { required: [], optional: [] } }, safety: { riskLevel: 'low', writeAccess: false }, outputs: { type: 'object', properties: { candidateIds: { type: 'array' } } } },
];
