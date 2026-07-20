import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostConfig, type HostConfigurator } from './registry.ts';
import { copySkill, detected, managedTemplate, requireProjectPath, sharedGuidance } from './shared.ts';

export const agentsConfigurator: HostConfigurator = {
  configure(options) {
    const project = options.scope === 'user' ? undefined : requireProjectPath(options.projectPath);
    const destination = options.scope === 'user' ? join(homedir(), '.agents', 'skills', 'qa-agent') : join(project!, '.agents', 'skills', 'qa-agent');
    copySkill(destination, Boolean(options.force));
    return { host: 'agents', paths: [destination], message: 'Installed portable Agent Skills QA package.' };
  },
  collectManagedTemplates() { return managedTemplate(hostConfig('agents'), sharedGuidance); },
  detect(projectRoot) { return detected(hostConfig('agents'), projectRoot); },
};
