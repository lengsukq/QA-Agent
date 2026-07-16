export const schemas: Record<string, object> = {
  'project.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['version', 'project', 'platforms', 'defaultContext', 'source', 'storage'] },
  'module.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['version', 'id', 'name', 'status', 'riskLevel', 'platforms', 'roles'] },
  'task.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['apiVersion', 'kind', 'metadata', 'scenarios', 'capabilities', 'safety', 'evidence', 'evidencePolicy', 'operationPlanRefs', 'recoveryPolicy'] },
  'run.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['id', 'taskId', 'moduleId', 'context', 'status', 'steps', 'startedAt'] },
  'memory.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['id', 'type', 'title', 'content', 'knowledgeLevel', 'confidence', 'source'] },
  'policy.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['safeMode', 'prohibitedActions', 'stopBefore'] },
  'capabilities.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['version', 'capabilities'] },
  'mcp.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['version', 'connections'] },
  'skill.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['apiVersion', 'kind', 'metadata'] },
  'operation.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['apiVersion', 'kind', 'id', 'version', 'status', 'taskId', 'moduleId', 'scenarioId', 'planHash', 'executionSnapshot', 'steps'] },
};
