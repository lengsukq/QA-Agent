export interface QaSkillManifest {
  apiVersion: 'qa-agent/v2';
  kind: 'Skill';
  metadata: { name: string; version: string; description: string; lifecycle: 'active' };
  requirements: { capabilities: { required: string[]; optional: string[] } };
  safety: { riskLevel: 'low' | 'medium'; writeAccess: false };
  outputs: { type: 'object'; properties: Record<string, unknown> };
}

export const builtInSkills: QaSkillManifest[] = [
  { apiVersion: 'qa-agent/v2', kind: 'Skill', metadata: { name: 'execution.contract', version: '3.0.0', description: 'Validate built-in Runner UI results against the approved test plan and safety policy.', lifecycle: 'active' }, requirements: { capabilities: { required: [], optional: ['browser.interact', 'ios.simulator.interact'] } }, safety: { riskLevel: 'medium', writeAccess: false }, outputs: { type: 'object', properties: { acceptedSteps: { type: 'array' } } } },
  { apiVersion: 'qa-agent/v2', kind: 'Skill', metadata: { name: 'evidence.record', version: '3.0.0', description: 'Import screenshots, useful logs, source findings, and other necessary evidence produced by host tools.', lifecycle: 'active' }, requirements: { capabilities: { required: [], optional: ['browser.inspect', 'network.read', 'logs.read', 'source.readonly'] } }, safety: { riskLevel: 'low', writeAccess: false }, outputs: { type: 'object', properties: { evidence: { type: 'array' } } } },
  { apiVersion: 'qa-agent/v2', kind: 'Skill', metadata: { name: 'python.regression', version: '1.0.0', description: 'Validate, publish, run, and report user-reviewed Runner step JSON regression assets.', lifecycle: 'active' }, requirements: { capabilities: { required: [], optional: ['browser.interact', 'ios.simulator.interact'] } }, safety: { riskLevel: 'medium', writeAccess: false }, outputs: { type: 'object', properties: { scriptId: { type: 'string' }, runId: { type: 'string' }, reportPath: { type: 'string' } } } },
  { apiVersion: 'qa-agent/v2', kind: 'Skill', metadata: { name: 'report.generate', version: '3.0.0', description: 'Generate a Markdown QA report from the Run, assertions, screenshots, and evidence.', lifecycle: 'active' }, requirements: { capabilities: { required: [], optional: [] } }, safety: { riskLevel: 'low', writeAccess: false }, outputs: { type: 'object', properties: { reportPath: { type: 'string' } } } },
  { apiVersion: 'qa-agent/v2', kind: 'Skill', metadata: { name: 'memory.curate', version: '3.0.0', description: 'Distill run outcomes into candidate project memory after review.', lifecycle: 'active' }, requirements: { capabilities: { required: [], optional: [] } }, safety: { riskLevel: 'low', writeAccess: false }, outputs: { type: 'object', properties: { candidateIds: { type: 'array' } } } },
];
