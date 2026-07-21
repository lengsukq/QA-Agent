import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostConfig, type HostConfigurator } from './registry.ts';
import { copyMainSkill, copySubSkills, detected, managedTemplate, requireProjectPath, sharedGuidance, writeManagedText } from './shared.ts';

export const claudeConfigurator: HostConfigurator = {
  configure(options) {
    const project = options.scope === 'user' ? undefined : requireProjectPath(options.projectPath);
    const force = Boolean(options.force);
    const skill = options.scope === 'user' ? join(homedir(), '.claude', 'skills', 'qa-agent') : join(project!, '.claude', 'skills', 'qa-agent');
    const command = options.scope === 'user' ? join(homedir(), '.claude', 'commands', 'qa-agent.md') : join(project!, '.claude', 'commands', 'qa-agent.md');
    copyMainSkill(skill, force); const subskills = copySubSkills(join(skill, '..'), force); writeManagedText(command, sharedGuidance, force);
    return { host: 'claude', paths: [skill, ...subskills, command], message: 'Installed Claude Code-compatible QA Agent skill, subskills, and command.' };
  },
  collectManagedTemplates() { return managedTemplate(hostConfig('claude'), sharedGuidance); },
  detect(projectRoot) { return detected(hostConfig('claude'), projectRoot); },
};
