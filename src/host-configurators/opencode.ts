import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostConfig, type HostConfigurator } from './registry.ts';
import { copySkill, detected, managedTemplate, requireProjectPath, sharedGuidance, writeManagedText } from './shared.ts';

export const opencodeConfigurator: HostConfigurator = {
  configure(options) {
    const project = options.scope === 'user' ? undefined : requireProjectPath(options.projectPath);
    const force = Boolean(options.force);
    const skill = options.scope === 'user' ? join(homedir(), '.config', 'opencode', 'skills', 'qa-agent') : join(project!, '.opencode', 'skills', 'qa-agent');
    const command = options.scope === 'user' ? join(homedir(), '.config', 'opencode', 'commands', 'qa-agent.md') : join(project!, '.opencode', 'commands', 'qa-agent.md');
    copySkill(skill, force); writeManagedText(command, sharedGuidance, force);
    return { host: 'opencode', paths: [skill, command], message: 'Installed OpenCode QA Agent skill and command.' };
  },
  collectManagedTemplates() { return managedTemplate(hostConfig('opencode'), sharedGuidance); },
  detect(projectRoot) { return detected(hostConfig('opencode'), projectRoot); },
};
