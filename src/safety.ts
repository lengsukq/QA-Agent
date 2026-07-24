import { qaPath } from './project.ts';
import { readJson } from './store.ts';

export const allowedRecoveryActions = ['wait', 'refresh', 'back', 'restart-app', 'reset-sandbox-data', 'fallback-locator', 'resume-checkpoint'] as const;
export type RecoveryAction = typeof allowedRecoveryActions[number];

export function assertSafeAction(root: string, action: string, safetyAction?: string): void {
  const policy = readJson<{ prohibitedActions?: string[] }>(qaPath(root, 'policies.json'));
  const prohibited = policy.prohibitedActions ?? [];
  if (safetyAction && prohibited.includes(safetyAction)) throw new Error(`Safety policy blocks action ${safetyAction}.`);
  if (prohibited.some(item => action.toLowerCase().includes(item.toLowerCase()))) throw new Error(`Safety policy blocks UI action containing ${prohibited.find(item => action.toLowerCase().includes(item.toLowerCase()))}.`);
}

export function assertRecoveryAction(action: string): asserts action is RecoveryAction {
  if (!allowedRecoveryActions.includes(action as RecoveryAction)) throw new Error(`Recovery action ${action} is not allowed. Use one of: ${allowedRecoveryActions.join(', ')}.`);
}
